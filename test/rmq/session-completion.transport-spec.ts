import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { PrismaService } from 'src/prisma/prisma.service';
import { inboundDeliveryId } from 'src/loyalty/consumers/rmq-delivery.service';
import { sessionCompletion } from '../fixtures/session-completion';

const evidence = z.object({
  kind: z.string(),
  bodyHash: z.string().optional(),
  messageId: z.string().optional(),
});
interface Worker {
  child: ChildProcess;
  messages: z.infer<typeof evidence>[];
  output: string;
}

describe('SESSION_COMPLETED through Nest RMQ and PostgreSQL', () => {
  let prisma: PrismaService;
  let connection: ChannelModel;
  let channel: ConfirmChannel;
  let queue: string;
  const workers: Worker[] = [];

  async function until<T>(
    read: () => T | Promise<T>,
    accept: (value: T) => boolean,
  ): Promise<T> {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const value = await read();
      if (accept(value)) return value;
      const failed = workers.find((worker) =>
        worker.messages.some((message) => message.kind === 'worker-failed'),
      );
      if (failed) throw new Error('Worker failed: ' + failed.output);
      await delay(10);
    }
    throw new Error(
      'Timed out: ' + workers.map((worker) => worker.output).join('\n'),
    );
  }
  async function start(barrier = false) {
    const child = fork(
      resolve('test/fixtures/session-completion-worker.cjs'),
      [],
      {
        env: {
          ...process.env,
          RMQ_TEST_QUEUE: queue,
          RMQ_TEST_ACK_BARRIER: String(barrier),
        },
        execArgv: ['--max-old-space-size=128'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const worker: Worker = { child, messages: [], output: '' };
    workers.push(worker);
    child.on('message', (input: unknown) => {
      const message = evidence.safeParse(input);
      if (message.success) worker.messages.push(message.data);
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: unknown) => {
        if (Buffer.isBuffer(chunk))
          worker.output = (worker.output + chunk.toString()).slice(-65536);
      });
    await until(
      () => worker.messages,
      (messages) => messages.some((message) => message.kind === 'ready'),
    );
    return worker;
  }
  async function stop(worker: Worker, crash = false) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null)
      return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => worker.child.kill('SIGKILL'), 5000);
      worker.child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      if (crash) worker.child.kill('SIGKILL');
      else worker.child.send('stop');
    });
  }
  async function publish(data: unknown, messageId = randomUUID()) {
    const body = Buffer.from(
      JSON.stringify({ pattern: 'SESSION_COMPLETED', data }),
    );
    channel.sendToQueue(queue, body, { persistent: true, messageId });
    await channel.waitForConfirms();
    return body;
  }
  async function effects() {
    return Promise.all([
      prisma.loyaltyProfile.count(),
      prisma.pointsTransaction.count(),
      prisma.processedEvent.count(),
      prisma.userBonusGrant.count(),
      prisma.userAchievement.count(),
      prisma.achievementDispatchIntent.count(),
      prisma.outboxEvent.count(),
      prisma.goldUpgradeReservation.count(),
    ]);
  }
  const completed = () =>
    prisma.inboundDelivery.count({
      where: { sourceQueue: queue, completedAt: { not: null } },
    });

  beforeAll(async () => {
    const database = new URL(process.env.RMQ_TEST_DATABASE_URL ?? '');
    const rabbit = new URL(process.env.RMQ_TEST_RABBIT_URL ?? '');
    if (
      database.hostname !== '127.0.0.1' ||
      database.pathname !== '/loyalty_rmq' ||
      database.username !== 'loyalty_test' ||
      rabbit.hostname !== '127.0.0.1'
    )
      throw new Error('Use disposable RMQ runner');
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: database.toString() }),
    );
    await prisma.$connect();
    connection = await connect(rabbit.toString());
    connection.on('error', () => {});
    channel = await connection.createConfirmChannel();
  });
  beforeEach(async () => {
    queue = 'rmq-test-session-' + randomUUID();
    await channel.assertQueue(queue, { durable: true });
    await prisma.sessionCompletionFact.deleteMany();
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await stop(worker);
    await channel.deleteQueue(queue);
  });
  afterAll(async () => {
    await channel?.close();
    await connection?.close();
    await prisma?.$disconnect();
  });

  it('routes and ACKs all fixed .NET fixtures before purchases with no loyalty effects', async () => {
    const before = await effects();
    const worker = await start();
    const fixtures: unknown = JSON.parse(
      readFileSync(resolve('test/fixtures/session-completed-v1.json'), 'utf8'),
    );
    if (!Array.isArray(fixtures))
      throw new Error('Expected fixed fixture array');
    for (const input of fixtures) {
      const packet: unknown = input;
      if (typeof packet !== 'object' || packet === null || !('data' in packet))
        throw new Error('Invalid fixture');
      await publish(packet.data);
    }
    await until(completed, (count) => count === 4);
    expect(await prisma.sessionCompletionFact.count()).toBe(4);
    const facts = await prisma.sessionCompletionFact.findMany();
    expect(
      facts
        .map((fact) => fact.completedAtUtc)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      '0001-01-01T00:00:00.000001Z',
      '2024-02-29T23:59:59.123456Z',
      '2024-02-29T23:59:59.123457Z',
      '9999-12-31T23:59:59.999999Z',
    ]);
    await until(
      () => worker.messages,
      (messages) =>
        messages.filter((message) => message.kind === 'handled').length === 4,
    );
    await stop(worker);
    expect((await channel.checkQueue(queue)).messageCount).toBe(0);
    expect(await effects()).toEqual(before);
  });

  it('deduplicates semantic republishes across two real Nest consumer instances', async () => {
    const first = await start();
    const second = await start();
    const fact = sessionCompletion();
    await publish(fact);
    await publish(
      Object.fromEntries(
        Object.entries({
          ...fact,
          eventId: fact.eventId.toUpperCase(),
        }).reverse(),
      ),
    );
    await until(completed, (count) => count === 2);
    await until(
      () => [first, second],
      (active) =>
        active.every((worker) =>
          worker.messages.some((message) => message.kind === 'handled'),
        ),
    );
    expect(await prisma.sessionCompletionFact.count()).toBe(1);
    expect(
      await prisma.sessionCompletionFact.findUnique({
        where: { eventId: fact.eventId },
      }),
    ).toMatchObject(fact);
  });

  it('quarantines malformed revisions and identity/payload conflicts while allowing another session', async () => {
    const worker = await start();
    const fact = sessionCompletion();
    await publish(fact);
    await until(completed, (count) => count === 1);
    const original = await prisma.sessionCompletionFact.findUnique({
      where: { eventId: fact.eventId },
    });
    for (const invalid of [
      { ...fact, revision: 2 },
      { ...fact, completedAtUtc: '2024-02-29T23:59:59.123Z' },
      { ...fact, eventId: randomUUID() },
      { ...fact, sessionId: randomUUID() },
      { ...fact, completedAtUtc: '2024-02-29T23:59:59.123457Z' },
    ])
      await publish({
        ...invalid,
        email: 'PRIVATE_EMAIL',
        dob: 'PRIVATE_DOB',
        privateExtra: 'PRIVATE_EXTRA',
      });
    const other = sessionCompletion();
    await publish(other);
    await until(completed, (count) => count === 2);
    const quarantined = await prisma.inboundDelivery.findMany({
      where: { sourceQueue: queue, quarantinedAt: { not: null } },
    });
    expect(quarantined).toHaveLength(5);
    expect(
      quarantined.filter(
        (delivery) => delivery.errorCode === 'INVALID_SESSION_COMPLETION',
      ),
    ).toHaveLength(2);
    expect(
      quarantined.filter(
        (delivery) =>
          delivery.errorCode === 'SESSION_COMPLETION_IDENTITY_CONFLICT',
      ),
    ).toHaveLength(3);
    expect(
      quarantined.every(
        (delivery) => delivery.originalBody !== null && delivery.attempts === 1,
      ),
    ).toBe(true);
    expect(
      await prisma.sessionCompletionFact.findUnique({
        where: { eventId: fact.eventId },
      }),
    ).toEqual(original);
    expect(await prisma.sessionCompletionFact.count()).toBe(2);
    expect(worker.output).not.toMatch(
      /PRIVATE_EMAIL|PRIVATE_DOB|PRIVATE_EXTRA/,
    );
  });

  it('recovers actual broker redelivery after committed business state and lost ACK', async () => {
    const first = await start(true);
    const fact = sessionCompletion();
    const body = await publish(fact, fact.eventId);
    await until(
      () => first.messages,
      (messages) => messages.some((message) => message.kind === 'ack-waiting'),
    );
    const original = await prisma.sessionCompletionFact.findUniqueOrThrow({
      where: { eventId: fact.eventId },
    });
    await stop(first, true);
    const restarted = await start();
    await until(
      () => restarted.messages,
      (messages) => messages.some((message) => message.kind === 'redelivered'),
    );
    await until(
      () => restarted.messages,
      (messages) => messages.some((message) => message.kind === 'handled'),
    );
    expect(
      restarted.messages.find((message) => message.kind === 'redelivered'),
    ).toMatchObject({
      bodyHash: createHash('sha256').update(body).digest('hex'),
      messageId: fact.eventId,
    });
    expect(await prisma.sessionCompletionFact.findMany()).toEqual([original]);
    expect(
      await prisma.inboundDelivery.findUnique({
        where: { id: inboundDeliveryId(queue, body) },
      }),
    ).toMatchObject({ attempts: 1, operation: 'SessionCompleted' });
  });

  it('recovers a database processing failure via the durable budget without leaking raw errors', async () => {
    await prisma.$executeRawUnsafe(
      'CREATE SEQUENCE session_completion_transport_failure',
    );
    await prisma.$executeRawUnsafe(`CREATE FUNCTION session_completion_transport_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('session_completion_transport_failure') = 1 THEN
        RAISE EXCEPTION 'PRIVATE_EMAIL PRIVATE_DOB PRIVATE_EXTRA'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER session_completion_transport_failure BEFORE INSERT ON session_completion_facts
      FOR EACH ROW EXECUTE FUNCTION session_completion_transport_failure()`);
    try {
      const worker = await start();
      const fact = sessionCompletion();
      const body = await publish(fact);
      await until(completed, (count) => count === 1);
      expect(
        await prisma.inboundDelivery.findUnique({
          where: { id: inboundDeliveryId(queue, body) },
        }),
      ).toMatchObject({ attempts: 2 });
      expect(await prisma.sessionCompletionFact.count()).toBe(1);
      expect(worker.output).not.toMatch(
        /PRIVATE_EMAIL|PRIVATE_DOB|PRIVATE_EXTRA/,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER session_completion_transport_failure ON session_completion_facts',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION session_completion_transport_failure()',
      );
      await prisma.$executeRawUnsafe(
        'DROP SEQUENCE session_completion_transport_failure',
      );
    }
  });
});
