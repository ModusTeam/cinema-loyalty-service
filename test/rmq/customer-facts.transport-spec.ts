import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { PrismaService } from 'src/prisma/prisma.service';
import { inboundDeliveryId } from 'src/loyalty/consumers/rmq-delivery.service';
import { customerFacts } from '../fixtures/customer-facts';

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

describe('Passive facts over real RabbitMQ/PostgreSQL', () => {
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
      const failed = workers.find((w) =>
        w.messages.some((m) => m.kind === 'worker-failed'),
      );
      if (failed) throw new Error('Worker failed: ' + failed.output);
      await delay(10);
    }
    throw new Error('Timed out: ' + workers.map((w) => w.output).join('\n'));
  }
  async function start(barrier = false) {
    const child = fork(resolve('test/fixtures/rmq-delivery-worker.cjs'), [], {
      env: {
        ...process.env,
        RMQ_TEST_QUEUE: queue,
        RMQ_TEST_ACK_BARRIER: String(barrier),
        RMQ_TEST_LOSE_ACK: 'false',
        RMQ_TEST_FAULT: '',
        RMQ_TEST_BACKOFF: '50',
      },
      execArgv: ['--max-old-space-size=128'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
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
      (messages) => messages.some((m) => m.kind === 'ready'),
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
  async function publish(data: unknown, originalBody?: Buffer) {
    const body =
      originalBody ??
      Buffer.from(JSON.stringify({ pattern: 'CUSTOMER_FACTS_CHANGED', data }));
    channel.sendToQueue(queue, body, {
      persistent: true,
      messageId: 'customer-fact-message',
    });
    await channel.waitForConfirms();
    return body;
  }
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
    queue = 'rmq-test-facts-' + randomUUID();
    await channel.assertQueue(queue, { durable: true });
    await prisma.customerFactReceipt.deleteMany();
    await prisma.customerFactsProjection.deleteMany();
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
  const current = (userId: string) =>
    prisma.customerFactsProjection.findUnique({ where: { userId } });

  it('ACKs valid facts and deduplicates manual republishes with equivalent JSON', async () => {
    await start();
    const { registered } = customerFacts();
    await publish(registered);
    await until(
      () => current(registered.userId),
      (p) => p?.appliedRevision === 1,
    );
    await publish(Object.fromEntries(Object.entries(registered).reverse()));
    await until(
      () =>
        prisma.inboundDelivery.count({
          where: { sourceQueue: queue, completedAt: { not: null } },
        }),
      (n) => n === 2,
    );
    expect(await prisma.customerFactReceipt.count()).toBe(1);
  });
  it('preserves a durable gap across an actual consumer process restart, then drains 3→1→2', async () => {
    const first = await start();
    const { registered, set, corrected } = customerFacts();
    await publish(corrected);
    await until(
      () => prisma.customerFactReceipt.count({ where: { state: 'PENDING' } }),
      (n) => n === 1,
    );
    await until(
      () => first.messages,
      (m) => m.some((value) => value.kind === 'handled'),
    );
    await stop(first, true);
    await start();
    expect((await current(registered.userId))?.appliedRevision).toBe(0);
    await publish(registered);
    await publish(set);
    await until(
      () => current(registered.userId),
      (p) => p?.appliedRevision === 3,
    );
    expect(
      await prisma.customerFactReceipt.count({ where: { state: 'APPLIED' } }),
    ).toBe(3);
  });
  it('quarantines malformed and conflicting facts without blocking another user or leaking private fields', async () => {
    await start();
    const { registered } = customerFacts();
    await publish(registered);
    await until(
      () => current(registered.userId),
      (p) => p?.appliedRevision === 1,
    );
    await publish({
      ...registered,
      eventId: randomUUID(),
      email: 'PRIVATE_EMAIL',
      dateExtra: 'PRIVATE_DOB',
    });
    await publish({
      ...registered,
      revision: 0,
      dateOfBirth: '1990-10-21',
      private: 'PRIVATE_EXTRA',
    });
    const other = customerFacts().registered;
    await publish(other);
    await until(
      () => current(other.userId),
      (p) => p?.appliedRevision === 1,
    );
    expect(
      await prisma.inboundDelivery.count({
        where: { sourceQueue: queue, quarantinedAt: { not: null } },
      }),
    ).toBe(2);
    expect(await prisma.customerFactReceipt.count()).toBe(2);
    for (const worker of workers) {
      expect(worker.output).not.toMatch(
        /PRIVATE_EMAIL|PRIVATE_DOB|PRIVATE_EXTRA|1990-10-21/,
      );
    }
  });
  it('proves broker redelivery after independent confirmation of business commit before lost ACK', async () => {
    const first = await start(true);
    const { registered } = customerFacts();
    const body = await publish(registered);
    await until(
      () => first.messages,
      (m) => m.some((value) => value.kind === 'ack-waiting'),
    );
    // Separate DB client in this process observes the worker's committed transaction.
    expect(
      await prisma.customerFactReceipt.findUnique({
        where: { eventId: registered.eventId },
      }),
    ).toMatchObject({ state: 'APPLIED' });
    const before = await current(registered.userId);
    await stop(first, true);
    const second = await start();
    await until(
      () => second.messages,
      (messages) => messages.some((m) => m.kind === 'redelivered'),
    );
    await until(
      () => second.messages,
      (messages) => messages.some((m) => m.kind === 'handled'),
    );
    expect(second.messages.find((m) => m.kind === 'redelivered')).toMatchObject(
      {
        bodyHash: createHash('sha256').update(body).digest('hex'),
        messageId: 'customer-fact-message',
      },
    );
    expect(await current(registered.userId)).toEqual(before);
    expect(await prisma.customerFactReceipt.count()).toBe(1);
    expect(
      await prisma.inboundDelivery.findUnique({
        where: { id: inboundDeliveryId(queue, body) },
      }),
    ).toMatchObject({ attempts: 1 });
  });
  it('retries a real transient DB failure without duplicate effects or private exception logging', async () => {
    const { registered } = customerFacts();
    await prisma.$executeRawUnsafe(
      'CREATE SEQUENCE customer_facts_transport_failure',
    );
    await prisma.$executeRawUnsafe(`CREATE FUNCTION customer_facts_transport_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('customer_facts_transport_failure') = 1 THEN
        RAISE EXCEPTION 'PRIVATE_EXTRA PRIVATE_EMAIL 1990-10-21'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER customer_facts_transport_failure BEFORE UPDATE ON customer_facts_projections
      FOR EACH ROW EXECUTE FUNCTION customer_facts_transport_failure()`);
    try {
      await start();
      const body = await publish(registered);
      await until(
        () => current(registered.userId),
        (p) => p?.appliedRevision === 1,
      );
      await until(
        () =>
          prisma.inboundDelivery.findUnique({
            where: { id: inboundDeliveryId(queue, body) },
          }),
        (d) => d?.completedAt !== null && d?.attempts === 2,
      );
      expect(await prisma.customerFactReceipt.count()).toBe(1);
      for (const worker of workers)
        expect(worker.output).not.toMatch(
          /PRIVATE_EXTRA|PRIVATE_EMAIL|1990-10-21/,
        );
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER customer_facts_transport_failure ON customer_facts_projections',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION customer_facts_transport_failure()',
      );
      await prisma.$executeRawUnsafe(
        'DROP SEQUENCE customer_facts_transport_failure',
      );
    }
  });
});
