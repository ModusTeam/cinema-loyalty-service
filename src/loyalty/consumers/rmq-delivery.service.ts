import type { RuntimeConfiguration } from '../../config/app.config';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from 'src/prisma/prisma.service';
import type { RmqDeliveryConfig } from 'src/config/rmq-delivery.config';
import { classifyMessageFailure } from './message-failure';

type Operation =
  | 'TicketPurchased'
  | 'UserDateOfBirthSet'
  | 'CustomerFactsChanged'
  | 'SessionCompleted';
interface DeliveryState {
  id: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  lease_active: boolean;
  wait_ms: number;
  completed_at: Date | null;
  quarantined_at: Date | null;
  quarantine_required: boolean;
  error_code: string | null;
}

export function inboundDeliveryId(queue: string, body: Buffer): string {
  return createHash('sha256')
    .update(queue)
    .update('\0')
    .update(body)
    .digest('hex');
}

function correlation(data: unknown): Record<string, string> {
  if (typeof data !== 'object' || data === null) return {};
  const result: Record<string, string> = {};
  for (const key of ['eventId', 'orderId', 'userId', 'sessionId']) {
    const value: unknown = Reflect.get(data, key);
    if (
      typeof value === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    )
      result[key] = value;
  }
  return result;
}

@Injectable()
export class RmqDeliveryService implements OnModuleDestroy {
  private readonly logger = new Logger(RmqDeliveryService.name);
  private readonly shutdown = new AbortController();
  private readonly options: RmqDeliveryConfig;
  private readonly queue: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<RuntimeConfiguration>,
  ) {
    this.options = config.getOrThrow('rmqDelivery', { infer: true });
    this.queue = config.getOrThrow('app.rmqQueue', { infer: true });
  }

  onModuleDestroy() {
    this.shutdown.abort();
  }

  async handle(
    operation: Operation,
    data: unknown,
    ctx: RmqContext,
    work: () => Promise<void>,
  ): Promise<void> {
    // These two casts are confined to the Nest/amqplib transport boundary.
    const channel = ctx.getChannelRef() as Channel;
    const message = ctx.getMessage() as ConsumeMessage;
    const disconnected = new AbortController();
    const onClose = () => disconnected.abort();
    channel.once('close', onClose);
    const signal = AbortSignal.any([this.shutdown.signal, disconnected.signal]);
    const id = inboundDeliveryId(this.queue, message.content);
    const fields = { operation, deliveryId: id, ...correlation(data) };
    let infrastructureFailures = 0;
    let admitted = false;

    try {
      while (!signal.aborted) {
        try {
          if (!admitted) {
            // DOB is a setter and its legacy envelope need not identify an event.
            // A -> B -> A must remain valid. Only a previously successful cycle
            // starts a new budget; failed/exhausted cycles never reset on delivery.
            await this.prisma.$executeRaw`
            INSERT INTO inbound_deliveries (id, operation, source_queue, max_attempts, updated_at)
            VALUES (${id}, ${operation}, ${this.queue}, ${this.options.maxAttempts}, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET attempts = 0, max_attempts = EXCLUDED.max_attempts,
              completed_at = NULL, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE inbound_deliveries.operation = 'UserDateOfBirthSet' AND inbound_deliveries.completed_at IS NOT NULL
          `;
            admitted = true;
          }
          const state = await this.read(id);
          if (state.completed_at || state.quarantined_at) {
            if (!signal.aborted) channel.ack(message);
            return;
          }
          if (
            !state.lease_active &&
            (state.quarantine_required || state.attempts >= state.max_attempts)
          ) {
            const saved = await this.quarantine(id, message);
            if (saved) {
              this.logger.warn(
                JSON.stringify({
                  ...fields,
                  code: state.error_code ?? 'DELIVERY_ATTEMPTS_EXHAUSTED',
                  attempt: state.attempts,
                  outcome: 'quarantined',
                }),
              );
              if (!signal.aborted) channel.ack(message);
              return;
            }
            continue;
          }
          if (state.lease_active || state.wait_ms > 0) {
            await delay(Math.max(50, state.wait_ms), undefined, { signal });
            continue;
          }
          const claimed = await this.claim(id);
          if (!claimed) continue;
          infrastructureFailures = 0;
          this.logger.log(
            JSON.stringify({
              ...fields,
              code: 'PROCESSING_STARTED',
              attempt: claimed.attempts,
            }),
          );
          let failure: ReturnType<typeof classifyMessageFailure> | undefined;
          try {
            await work();
          } catch (error: unknown) {
            failure = classifyMessageFailure(error);
          }

          // A committed business operation must not be rerun just because recording
          // the transport outcome temporarily failed. Broker still owns the unacked copy.
          while (!signal.aborted) {
            try {
              if (failure) {
                const terminal =
                  failure.kind === 'permanent' ||
                  claimed.attempts >= claimed.max_attempts;
                const waitMs = this.backoff(claimed.attempts);
                await this.prisma.$executeRaw`
                  UPDATE inbound_deliveries
                  SET error_code = ${failure.code}, quarantine_required = ${terminal},
                    next_attempt_at = clock_timestamp() + ${waitMs} * interval '1 millisecond',
                    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
                  WHERE id = ${id} AND lease_token = ${claimed.lease_token}::uuid
                    AND lease_expires_at > clock_timestamp() AND completed_at IS NULL AND quarantined_at IS NULL
                `;
                this.logger.warn(
                  JSON.stringify({
                    ...fields,
                    code: failure.code,
                    attempt: claimed.attempts,
                    outcome: terminal
                      ? 'quarantine_required'
                      : 'retry_scheduled',
                  }),
                );
                break;
              }
              await this.prisma.$executeRaw`
                UPDATE inbound_deliveries
                SET completed_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
                WHERE id = ${id} AND lease_token = ${claimed.lease_token}::uuid
                  AND lease_expires_at > clock_timestamp() AND completed_at IS NULL AND quarantined_at IS NULL
              `;
              // Even a stale completion cannot change the successor's state. The
              // known successful business commit independently permits this ACK.
              if (!signal.aborted) channel.ack(message);
              return;
            } catch {
              this.logger.warn(
                JSON.stringify({
                  ...fields,
                  code: 'DELIVERY_STORE_UNAVAILABLE',
                  attempt: claimed.attempts,
                }),
              );
              await delay(this.backoff(++infrastructureFailures), undefined, {
                signal,
              });
            }
          }
        } catch {
          if (signal.aborted) return;
          this.logger.warn(
            JSON.stringify({ ...fields, code: 'DELIVERY_STORE_UNAVAILABLE' }),
          );
          await delay(this.backoff(++infrastructureFailures), undefined, {
            signal,
          });
        }
      }
    } catch (error: unknown) {
      if (!signal.aborted) throw error;
    } finally {
      channel.removeListener('close', onClose);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 16),
    );
  }

  private async read(id: string): Promise<DeliveryState> {
    const rows = await this.prisma.$queryRaw<DeliveryState[]>`
      SELECT id, attempts, max_attempts, lease_token, completed_at, quarantined_at, quarantine_required, error_code,
        COALESCE(lease_expires_at > statement_timestamp(), FALSE) AS lease_active,
        LEAST(${this.options.retryMaxMs}, GREATEST(0,
          EXTRACT(EPOCH FROM (GREATEST(next_attempt_at, COALESCE(lease_expires_at, next_attempt_at)) - statement_timestamp())) * 1000
        ))::integer AS wait_ms
      FROM inbound_deliveries WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) throw new Error('DELIVERY_STATE_MISSING');
    return row;
  }

  private async claim(id: string): Promise<DeliveryState | undefined> {
    const rows = await this.prisma.$queryRaw<DeliveryState[]>`
      UPDATE inbound_deliveries SET attempts = attempts + 1, lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + ${this.options.leaseMs} * interval '1 millisecond', updated_at = clock_timestamp()
      WHERE id = ${id} AND attempts < max_attempts AND NOT quarantine_required
        AND completed_at IS NULL AND quarantined_at IS NULL AND next_attempt_at <= statement_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at <= statement_timestamp())
      RETURNING id, attempts, max_attempts, lease_token
    `;
    return rows[0];
  }

  private async quarantine(
    id: string,
    message: ConsumeMessage,
  ): Promise<boolean> {
    const saved = await this.prisma.$executeRaw`
      UPDATE inbound_deliveries
      SET quarantine_required = TRUE, quarantined_at = clock_timestamp(),
        error_code = COALESCE(error_code, 'DELIVERY_ATTEMPTS_EXHAUSTED'),
        original_body = ${message.content}, original_properties = ${serialize(message.properties)},
        lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE id = ${id} AND completed_at IS NULL AND quarantined_at IS NULL
        AND (quarantine_required OR attempts >= max_attempts)
        AND (lease_expires_at IS NULL OR lease_expires_at <= statement_timestamp())
    `;
    return saved === 1;
  }
}
