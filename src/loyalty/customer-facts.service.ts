import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  lockLoyaltyProfile,
  withTransactionRetry,
} from '../prisma/profile-transaction';
import type {
  Prisma,
  CustomerFactsProjection,
} from '../generated/prisma/client';
import {
  parseCustomerFact,
  type CustomerFact,
} from './dto/customer-facts-changed.dto';
import { PermanentMessageError } from './consumers/message-failure';

const BATCH_SIZE = 50;
const PREDECESSOR_MISMATCH = 'CUSTOMER_FACT_PREDECESSOR_MISMATCH';

@Injectable()
export class CustomerFactsService implements OnModuleDestroy {
  private readonly logger = new Logger(CustomerFactsService.name);
  private recovery: Promise<number> | undefined;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  async ingest(input: unknown): Promise<void> {
    const fact = parseCustomerFact(input);
    try {
      await withTransactionRetry(this.prisma, async (tx) => {
        await lockLoyaltyProfile(tx, fact.userId, true);
        await tx.customerFactsProjection.upsert({
          where: { userId: fact.userId },
          create: { userId: fact.userId },
          update: {},
        });
        const identities = await tx.customerFactReceipt.findMany({
          where: {
            OR: [
              { eventId: fact.eventId },
              { userId: fact.userId, revision: fact.revision },
            ],
          },
        });
        if (identities.length > 0) {
          if (
            identities.some((receipt) => !this.sameFact(receipt.payload, fact))
          )
            throw new PermanentMessageError('CUSTOMER_FACT_IDENTITY_CONFLICT');
          return;
        }
        await tx.customerFactReceipt.create({
          data: {
            eventId: fact.eventId,
            userId: fact.userId,
            revision: fact.revision,
            payload: fact,
            fingerprint: createHash('sha256')
              .update(JSON.stringify(fact))
              .digest('hex'),
          },
        });
        await this.applyContiguous(tx, fact.userId);
      });
    } catch (error: unknown) {
      // Different profiles do not share a lock. The global eventId constraint is
      // their arbiter; inspect committed evidence in a fresh transaction/snapshot.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.customerFactReceipt.findUnique({
          where: { eventId: fact.eventId },
        });
        if (existing && !this.sameFact(existing.payload, fact))
          throw new PermanentMessageError('CUSTOMER_FACT_IDENTITY_CONFLICT');
      }
      throw error;
    }
  }

  private sameFact(payload: unknown, fact: CustomerFact): boolean {
    return JSON.stringify(parseCustomerFact(payload)) === JSON.stringify(fact);
  }

  private predecessorMatches(
    projection: CustomerFactsProjection,
    fact: CustomerFact,
  ): boolean {
    if (projection.appliedRevision === 0) return true; // Explicit unknown root is not inferred registration.
    if (
      fact.kind === 'Registered' ||
      projection.registeredAtUtc?.toISOString() !==
        (fact.registeredAtUtc ?? undefined)
    )
      return false;
    const dob = projection.dateOfBirth?.toISOString().slice(0, 10) ?? null;
    if (fact.kind === 'DateOfBirthSet')
      return dob === null && projection.dobFirstSetAtUtc === null;
    return (
      fact.previousDateOfBirth === dob &&
      (projection.dobFirstSetAtUtc?.toISOString() ?? null) ===
        fact.dobFirstSetAtUtc
    );
  }

  private async applyContiguous(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    let projection = await tx.customerFactsProjection.findUniqueOrThrow({
      where: { userId },
    });
    for (
      let applied = 0;
      applied < BATCH_SIZE && projection.appliedRevision < 2147483647;
      applied++
    ) {
      const receipt = await tx.customerFactReceipt.findUnique({
        where: {
          userId_revision: { userId, revision: projection.appliedRevision + 1 },
        },
      });
      if (!receipt || receipt.state !== 'PENDING') return;
      const fact = parseCustomerFact(receipt.payload);
      if (!this.predecessorMatches(projection, fact)) {
        await tx.customerFactReceipt.update({
          where: { eventId: receipt.eventId },
          data: { state: 'BLOCKED', errorCode: PREDECESSOR_MISMATCH },
        });
        // IDs/codes only. Original private evidence is retained in restricted DB history.
        this.logger.warn(
          JSON.stringify({
            operation: 'CustomerFactsChanged',
            eventId: receipt.eventId,
            userId,
            revision: receipt.revision,
            code: PREDECESSOR_MISMATCH,
          }),
        );
        return;
      }
      const appliedAt = new Date();
      projection = await tx.customerFactsProjection.update({
        where: { userId },
        data: {
          appliedRevision: fact.revision,
          sourceEventId: fact.eventId,
          occurredAtUtc: new Date(fact.occurredAtUtc),
          registeredAtUtc:
            fact.registeredAtUtc === null
              ? null
              : new Date(fact.registeredAtUtc),
          dobFirstSetAtUtc:
            fact.dobFirstSetAtUtc === null
              ? null
              : new Date(fact.dobFirstSetAtUtc),
          dateOfBirth:
            fact.dateOfBirth === null
              ? null
              : new Date(fact.dateOfBirth + 'T00:00:00.000Z'),
          lastAppliedAt: appliedAt,
        },
      });
      await tx.customerFactReceipt.update({
        where: { eventId: receipt.eventId },
        data: { state: 'APPLIED', appliedAt, errorCode: null },
      });
    }
  }

  recoverPending(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (!this.recovery) {
      this.recovery = this.recoverBatch().finally(() => {
        this.recovery = undefined;
      });
    }
    return this.recovery;
  }

  private async recoverBatch(): Promise<number> {
    // Only the next revision is actionable. Missing/BLOCKED predecessors are not
    // polled as ready work. The existing unique tuple supports each next lookup.
    const candidates = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT p.user_id FROM customer_facts_projections p
      JOIN customer_fact_receipts r ON r.user_id = p.user_id
        AND r.revision = p.applied_revision::bigint + 1
      WHERE r.state = 'PENDING'
      ORDER BY p.user_id LIMIT 50
    `;
    for (const { user_id: userId } of candidates) {
      if (this.stopped) break;
      await withTransactionRetry(this.prisma, async (tx) => {
        await lockLoyaltyProfile(tx, userId, true);
        await this.applyContiguous(tx, userId);
      });
    }
    return candidates.length;
  }

  @Interval(10000)
  async recoverTick(): Promise<void> {
    try {
      await this.recoverPending();
    } catch {
      this.logger.error('CUSTOMER_FACT_RECOVERY_FAILED');
    }
  }

  // Operator-only re-evaluation, not a source repair API. Never changes source
  // payload, predecessor, identity or projection; a real contradiction stays BLOCKED.
  async recheckBlocked(eventId: string): Promise<string> {
    const receipt = await this.prisma.customerFactReceipt.findUniqueOrThrow({
      where: { eventId },
    });
    return withTransactionRetry(this.prisma, async (tx) => {
      await lockLoyaltyProfile(tx, receipt.userId, true);
      const current = await tx.customerFactReceipt.findUniqueOrThrow({
        where: { eventId },
      });
      if (current.state === 'BLOCKED') {
        await tx.customerFactReceipt.update({
          where: { eventId },
          data: {
            state: 'PENDING',
            errorCode: null,
            recheckCount: { increment: 1 },
            recheckedAt: new Date(),
          },
        });
        await this.applyContiguous(tx, receipt.userId);
      }
      return (
        await tx.customerFactReceipt.findUniqueOrThrow({ where: { eventId } })
      ).state;
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.recovery?.catch(() => {
      this.logger.error('CUSTOMER_FACT_RECOVERY_FAILED');
    });
  }
}
