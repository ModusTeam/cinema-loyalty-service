import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomerFactsService } from '../../src/loyalty/customer-facts.service';
import { customerFacts } from '../fixtures/customer-facts';

describe('passive customer facts on PostgreSQL', () => {
  let prisma: PrismaService;
  let observer: Pool;
  let service: CustomerFactsService;
  beforeAll(async () => {
    const value = process.env.INTEGRATION_DATABASE_URL;
    if (!value) throw new Error('Disposable integration DB required');
    const url = new URL(value);
    if (
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/loyalty_integration' ||
      url.username !== 'loyalty_test'
    )
      throw new Error('Unsafe test database');
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: value }));
    observer = new Pool({ connectionString: value });
    await prisma.$connect();
    service = new CustomerFactsService(prisma);
  });
  afterAll(async () => {
    await service?.onModuleDestroy();
    await prisma?.$disconnect();
    await observer?.end();
  });
  beforeEach(async () => {
    await prisma.customerFactReceipt.deleteMany();
    await prisma.customerFactsProjection.deleteMany();
  });
  const projection = (userId: string) =>
    prisma.customerFactsProjection.findUniqueOrThrow({ where: { userId } });

  it('persists exact replay once, independent of object key order and UUID case', async () => {
    const { registered } = customerFacts();
    await service.ingest(registered);
    await service.ingest(
      Object.fromEntries(Object.entries(registered).reverse()),
    );
    await service.ingest({
      ...registered,
      userId: registered.userId.toUpperCase(),
    });
    expect(await projection(registered.userId)).toMatchObject({
      appliedRevision: 1,
      registeredAtUtc: new Date(registered.registeredAtUtc),
    });
    expect(await prisma.customerFactReceipt.count()).toBe(1);
  });
  it('rejects eventId and user/revision content conflicts without overwriting evidence', async () => {
    const { registered } = customerFacts();
    await service.ingest(registered);
    for (const bad of [
      { ...registered, eventId: randomUUID() },
      { ...registered, userId: randomUUID() },
      {
        ...registered,
        registeredAtUtc: '2024-01-01T00:00:00.000Z',
        occurredAtUtc: '2024-01-01T00:00:00.000Z',
      },
    ])
      await expect(service.ingest(bad)).rejects.toThrow(
        'CUSTOMER_FACT_IDENTITY_CONFLICT',
      );
    expect(await prisma.customerFactReceipt.count()).toBe(1);
    expect((await projection(registered.userId)).registeredAtUtc).toEqual(
      new Date(registered.registeredAtUtc),
    );
  });
  it('durably accepts 3 before 1/2 and resumes when missing revision arrives', async () => {
    const { registered, set, corrected } = customerFacts();
    await service.ingest(corrected);
    expect((await projection(registered.userId)).appliedRevision).toBe(0);
    expect(await service.recoverPending()).toBe(0);
    await service.ingest(registered);
    expect((await projection(registered.userId)).appliedRevision).toBe(1);
    await service.ingest(set);
    expect(await projection(registered.userId)).toMatchObject({
      appliedRevision: 3,
      dateOfBirth: new Date('1990-10-21T00:00:00.000Z'),
    });
    expect(
      await prisma.customerFactReceipt.count({ where: { state: 'APPLIED' } }),
    ).toBe(3);
  });
  it('blocks a contradictory already-ACKed successor durably, retaining last valid state', async () => {
    const { registered, set, corrected } = customerFacts();
    const bad = { ...corrected, previousDateOfBirth: '1980-01-01' };
    await service.ingest(bad);
    await service.ingest(registered);
    await service.ingest(set);
    expect((await projection(registered.userId)).appliedRevision).toBe(2);
    expect(
      await prisma.customerFactReceipt.findUnique({
        where: { eventId: bad.eventId },
      }),
    ).toMatchObject({
      state: 'BLOCKED',
      errorCode: 'CUSTOMER_FACT_PREDECESSOR_MISMATCH',
      payload: bad,
    });
    expect(await service.recoverPending()).toBe(0);
    expect(await service.recheckBlocked(bad.eventId)).toBe('BLOCKED');
    expect(
      await prisma.customerFactReceipt.findUnique({
        where: { eventId: bad.eventId },
      }),
    ).toMatchObject({ recheckCount: 1, state: 'BLOCKED', payload: bad });
  });
  it('accepts explicit unknown historical root without invented registration or first-set times', async () => {
    const { corrected } = customerFacts();
    await service.ingest({
      ...corrected,
      revision: 1,
      registeredAtUtc: null,
      dobFirstSetAtUtc: null,
    });
    expect(await projection(corrected.userId)).toMatchObject({
      appliedRevision: 1,
      registeredAtUtc: null,
      dobFirstSetAtUtc: null,
    });
  });
  it('does not overwrite immutable known timestamps or reinitialize DOB', async () => {
    const { registered, set, corrected } = customerFacts();
    await service.ingest(registered);
    await service.ingest(set);
    await service.ingest({
      ...corrected,
      dobFirstSetAtUtc: corrected.occurredAtUtc,
    });
    expect((await projection(registered.userId)).appliedRevision).toBe(2);
    expect(
      await prisma.customerFactReceipt.findUnique({
        where: { eventId: corrected.eventId },
      }),
    ).toMatchObject({ state: 'BLOCKED' });
  });
  it('uses real profile locks for concurrent same-user duplicates and revisions', async () => {
    const { registered, set, corrected } = customerFacts();
    await service.ingest(registered);
    const client = await observer.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
      [registered.userId],
    );
    const work = Promise.allSettled([
      service.ingest(corrected),
      service.ingest(set),
    ]);
    try {
      const deadline = Date.now() + 4000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const result = await observer.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%'",
        );
        waiting = Number(result.rows[0].count);
        if (waiting >= 2) break;
        await delay(10);
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
    } finally {
      await client.query('COMMIT');
      client.release();
    }
    expect((await work).map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    await Promise.all([service.ingest(set), service.ingest(set)]);
    expect((await projection(registered.userId)).appliedRevision).toBe(3);
    expect(await prisma.customerFactReceipt.count()).toBe(3);
  });
  it('classifies concurrent cross-user global event identity collision after rollback', async () => {
    const { registered } = customerFacts();
    const results = await Promise.allSettled([
      service.ingest(registered),
      service.ingest({ ...registered, userId: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({
      code: 'CUSTOMER_FACT_IDENTITY_CONFLICT',
    });
    expect(await prisma.customerFactReceipt.count()).toBe(1);
    expect(await prisma.customerFactsProjection.count()).toBe(1);
  });
  it('rolls receipt, new profile and projection back on a projection write failure', async () => {
    const { registered } = customerFacts();
    await observer.query(`CREATE FUNCTION customer_facts_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture projection failure'; END $$;
      CREATE TRIGGER customer_facts_test_fail BEFORE UPDATE ON customer_facts_projections
      FOR EACH ROW EXECUTE FUNCTION customer_facts_test_fail();`);
    try {
      await expect(service.ingest(registered)).rejects.toThrow();
      expect(await prisma.customerFactReceipt.count()).toBe(0);
      expect(await prisma.customerFactsProjection.count()).toBe(0);
      expect(
        await prisma.loyaltyProfile.count({
          where: { userId: registered.userId },
        }),
      ).toBe(0);
    } finally {
      await observer.query(
        'DROP TRIGGER customer_facts_test_fail ON customer_facts_projections; DROP FUNCTION customer_facts_test_fail()',
      );
    }
  });
  it('continues the same recovery pass after one user transaction fails', async () => {
    const first = customerFacts('10000000-0000-4000-8000-000000000001');
    const second = customerFacts('10000000-0000-4000-8000-000000000002');
    await service.ingest(first.registered);
    await service.ingest(second.registered);
    await prisma.customerFactReceipt.createMany({
      data: [first.set, second.set].map((fact) => ({
        eventId: fact.eventId,
        userId: fact.userId,
        revision: fact.revision,
        payload: fact,
        fingerprint: 'fixture',
      })),
    });
    const firstProjection = await projection(first.set.userId);
    const firstReceipt = await prisma.customerFactReceipt.findUniqueOrThrow({
      where: { eventId: first.set.eventId },
    });
    await observer.query(`CREATE FUNCTION customer_facts_recovery_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '10000000-0000-4000-8000-000000000001'::uuid AND NEW.state = 'APPLIED' THEN
          RAISE EXCEPTION 'PRIVATE_RECOVERY_FAILURE private@example.invalid';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER customer_facts_recovery_test_fail BEFORE UPDATE ON customer_fact_receipts
      FOR EACH ROW EXECUTE FUNCTION customer_facts_recovery_test_fail();`);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      await expect(service.recoverPending()).resolves.toBe(2);
      expect(await projection(first.set.userId)).toEqual(firstProjection);
      expect(
        await prisma.customerFactReceipt.findUniqueOrThrow({
          where: { eventId: first.set.eventId },
        }),
      ).toEqual(firstReceipt);
      expect(await projection(second.set.userId)).toMatchObject({
        appliedRevision: 2,
        sourceEventId: second.set.eventId,
        dateOfBirth: new Date(second.set.dateOfBirth + 'T00:00:00.000Z'),
      });
      expect(
        await prisma.customerFactReceipt.findUniqueOrThrow({
          where: { eventId: second.set.eventId },
        }),
      ).toMatchObject({ state: 'APPLIED' });
      expect(errors.mock.calls).toEqual([
        [
          JSON.stringify({
            userId: first.set.userId,
            code: 'CUSTOMER_FACT_RECOVERY_FAILED',
          }),
        ],
      ]);
    } finally {
      errors.mockRestore();
      await observer.query(
        'DROP TRIGGER customer_facts_recovery_test_fail ON customer_fact_receipts; DROP FUNCTION customer_facts_recovery_test_fail()',
      );
    }
    const secondProjection = await projection(second.set.userId);
    await expect(service.recoverPending()).resolves.toBe(1);
    expect((await projection(first.set.userId)).appliedRevision).toBe(2);
    expect(await projection(second.set.userId)).toEqual(secondProjection);
    expect(
      await prisma.customerFactReceipt.count({ where: { state: 'APPLIED' } }),
    ).toBe(4);
  });

  it('advances past a full failing recovery batch and returns to retry it', async () => {
    const facts = Array.from({ length: 51 }, (_, index) =>
      customerFacts(
        '20000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
      ),
    );
    const last = facts[facts.length - 1];
    for (const fact of facts) await service.ingest(fact.registered);
    await prisma.customerFactReceipt.createMany({
      data: facts.map(({ set }) => ({
        eventId: set.eventId,
        userId: set.userId,
        revision: set.revision,
        payload: set,
        fingerprint: 'fixture',
      })),
    });
    await observer.query(`CREATE FUNCTION customer_facts_starvation_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id < '20000000-0000-4000-8000-000000000051'::uuid AND NEW.state = 'APPLIED' THEN
          RAISE EXCEPTION 'fixture recovery batch failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER customer_facts_starvation_test_fail BEFORE UPDATE ON customer_fact_receipts
      FOR EACH ROW EXECUTE FUNCTION customer_facts_starvation_test_fail();`);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      await expect(service.recoverPending()).resolves.toBe(50);
      expect((await projection(last.set.userId)).appliedRevision).toBe(1);
      expect(
        await prisma.customerFactReceipt.count({ where: { state: 'PENDING' } }),
      ).toBe(51);
      await expect(service.recoverPending()).resolves.toBe(1);
      expect((await projection(last.set.userId)).appliedRevision).toBe(2);
      expect(
        await prisma.customerFactReceipt.count({ where: { state: 'PENDING' } }),
      ).toBe(50);
      expect(errors).toHaveBeenCalledTimes(50);
    } finally {
      errors.mockRestore();
      await observer.query(
        'DROP TRIGGER customer_facts_starvation_test_fail ON customer_fact_receipts; DROP FUNCTION customer_facts_starvation_test_fail()',
      );
    }
    const completed = await projection(last.set.userId);
    await expect(service.recoverPending()).resolves.toBe(50);
    expect(
      await prisma.customerFactReceipt.count({ where: { state: 'PENDING' } }),
    ).toBe(0);
    expect(
      await prisma.customerFactReceipt.count({ where: { state: 'APPLIED' } }),
    ).toBe(102);
    expect(await projection(last.set.userId)).toEqual(completed);
    // Work committed before the keyset boundary must be found on wrap-around.
    const earlier = customerFacts('10000000-0000-4000-8000-000000000003');
    await service.ingest(earlier.registered);
    await prisma.customerFactReceipt.create({
      data: {
        eventId: earlier.set.eventId,
        userId: earlier.set.userId,
        revision: earlier.set.revision,
        payload: earlier.set,
        fingerprint: 'fixture',
      },
    });
    await expect(service.recoverPending()).resolves.toBe(1);
    expect((await projection(earlier.set.userId)).appliedRevision).toBe(2);
    expect(await projection(last.set.userId)).toEqual(completed);
  });

  it('recovers committed pending receipts after provider restart, bounded to 50 revisions per transaction', async () => {
    const { registered, set } = customerFacts();
    await service.ingest(registered);
    const receipts = [];
    for (let revision = 2; revision <= 103; revision++) {
      const even = revision % 2 === 0;
      const fact =
        revision === 2
          ? set
          : {
              ...set,
              eventId: randomUUID(),
              revision,
              kind: 'DateOfBirthCorrected',
              correctionOperationId: randomUUID(),
              previousDateOfBirth: even ? '1990-10-21' : set.dateOfBirth,
              dateOfBirth: even ? set.dateOfBirth : '1990-10-21',
            };
      receipts.push({
        eventId: fact.eventId,
        userId: fact.userId,
        revision,
        payload: fact,
        fingerprint: 'fixture',
      });
    }
    // Simulate committed receipts surviving a crash before recovery has run.
    await prisma.customerFactReceipt.createMany({ data: receipts });
    const restarted = new CustomerFactsService(prisma);
    await restarted.recoverPending();
    expect((await projection(set.userId)).appliedRevision).toBe(51);
    await restarted.recoverPending();
    expect((await projection(set.userId)).appliedRevision).toBe(101);
    await restarted.recoverPending();
    expect((await projection(set.userId)).appliedRevision).toBe(103);
    await restarted.onModuleDestroy();
  });
  it('does not alter legacy DOB, balance, tier, counters, grants, ledger, intents or outbox', async () => {
    const { registered, set, corrected } = customerFacts();
    await prisma.loyaltyProfile.create({
      data: {
        userId: registered.userId,
        balance: 80,
        lifetimePoints: 300,
        yearPoints: 100,
        yearVisits: 4,
        tier: 'SILVER',
        birthdayDate: new Date('1988-12-31T00:00:00.000Z'),
      },
    });
    const snapshot = async () => ({
      profile: await prisma.loyaltyProfile.findUnique({
        where: { userId: registered.userId },
      }),
      ledger: await prisma.pointsTransaction.count(),
      processed: await prisma.processedEvent.count(),
      grants: await prisma.userBonusGrant.count(),
      intents: await prisma.achievementDispatchIntent.count(),
      outbox: await prisma.outboxEvent.count(),
      achievements: await prisma.userAchievement.count(),
      gold: await prisma.goldUpgradeReservation.count(),
      debits: await prisma.checkoutDebit.count(),
    });
    const before = await snapshot();
    for (const fact of [corrected, registered, set, corrected])
      await service.ingest(fact);
    expect(await snapshot()).toEqual(before);
  });
  it('enforces positive revisions and tuple uniqueness in PostgreSQL', async () => {
    const { registered } = customerFacts();
    await service.ingest(registered);
    await expect(
      prisma.customerFactReceipt.create({
        data: {
          eventId: randomUUID(),
          userId: registered.userId,
          revision: 0,
          payload: registered,
          fingerprint: 'fixture',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.customerFactReceipt.create({
        data: {
          eventId: randomUUID(),
          userId: registered.userId,
          revision: 1,
          payload: registered,
          fingerprint: 'fixture',
        },
      }),
    ).rejects.toThrow();
  });
  it('serializes two recovery replicas and a duplicate event behind the same real profile lock', async () => {
    const { registered, set } = customerFacts();
    await service.ingest(registered);
    await prisma.customerFactReceipt.create({
      data: {
        eventId: set.eventId,
        userId: set.userId,
        revision: 2,
        payload: set,
        fingerprint: 'fixture',
      },
    });
    const replica = new CustomerFactsService(prisma);
    const client = await observer.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
      [set.userId],
    );
    const work = Promise.allSettled([
      service.recoverPending(),
      replica.recoverPending(),
      service.ingest(set),
    ]);
    try {
      const deadline = Date.now() + 4000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const result = await observer.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%'",
        );
        waiting = Number(result.rows[0].count);
        if (waiting >= 3) break;
        await delay(10);
      }
      expect(waiting).toBeGreaterThanOrEqual(3);
    } finally {
      await client.query('COMMIT');
      client.release();
    }
    expect((await work).every((result) => result.status === 'fulfilled')).toBe(
      true,
    );
    expect((await projection(set.userId)).appliedRevision).toBe(2);
    expect(await prisma.customerFactReceipt.count()).toBe(2);
    await replica.onModuleDestroy();
  });

  it('applies the additive migration over prior data and measures the actual recovery query', async () => {
    const client = await observer.connect();
    const schema = 'customer_facts_fixture_' + randomUUID().replaceAll('-', '');
    const query = `SELECT p.user_id FROM customer_facts_projections p
      JOIN customer_fact_receipts r ON r.user_id = p.user_id
        AND r.revision = p.applied_revision::bigint + 1
      WHERE r.state = 'PENDING' ORDER BY p.user_id LIMIT 50`;
    await client.query('BEGIN');
    try {
      await client.query('CREATE SCHEMA ' + schema);
      await client.query('SET LOCAL search_path TO ' + schema);
      await client.query(
        'CREATE TABLE prior_profile_fixture (balance integer); INSERT INTO prior_profile_fixture VALUES (123)',
      );
      await client.query(
        readFileSync(
          resolve(
            'prisma/migrations/20261024010000_passive_customer_facts/migration.sql',
          ),
          'utf8',
        ),
      );
      expect(
        (await client.query('SELECT balance FROM prior_profile_fixture')).rows,
      ).toEqual([{ balance: 123 }]);
      await client.query(`INSERT INTO customer_facts_projections(user_id)
        SELECT md5(n::text)::uuid FROM generate_series(1,10010) n`);
      await client.query(`INSERT INTO customer_fact_receipts(event_id,user_id,revision,payload,fingerprint,state,applied_at)
        SELECT md5(('event-'||n)::text)::uuid, md5(n::text)::uuid, 1, '{}', 'fixture',
          CASE WHEN n <= 10000 THEN 'APPLIED'::"CustomerFactState" ELSE 'PENDING'::"CustomerFactState" END,
          CASE WHEN n <= 10000 THEN now() ELSE NULL END
        FROM generate_series(1,10010) n`);
      await client.query(
        'ANALYZE customer_facts_projections; ANALYZE customer_fact_receipts',
      );
      await client.query(
        'DROP INDEX IF EXISTS customer_fact_receipts_pending_next_idx',
      );
      const before = await client.query(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query,
      );
      await client.query(
        "CREATE INDEX customer_facts_fixture_pending ON customer_fact_receipts(user_id, revision) WHERE state='PENDING'",
      );
      const after = await client.query(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query,
      );
      mkdirSync('.tmp/customer-facts-plans', { recursive: true });
      writeFileSync(
        '.tmp/customer-facts-plans/recovery-plans.json',
        JSON.stringify({ before: before.rows, after: after.rows }, null, 2),
      );
      expect((await client.query(query)).rows).toHaveLength(10);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('rechecks a valid BLOCKED receipt through the real operator process without rewriting history', async () => {
    const { registered, set, corrected } = customerFacts();
    await service.ingest(corrected);
    await service.ingest(registered);
    // Represents a valid source receipt incorrectly blocked by a prior consumer validator.
    await prisma.customerFactReceipt.create({
      data: {
        eventId: set.eventId,
        userId: set.userId,
        revision: 2,
        payload: set,
        fingerprint: 'fixture',
        state: 'BLOCKED',
        errorCode: 'OLD_VALIDATOR_FIXTURE',
      },
    });
    const result = await promisify(execFile)(
      process.execPath,
      [
        resolve('dist/tools/recheck-customer-fact.js'),
        '--recheck-blocked',
        '--event-id',
        set.eventId,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.INTEGRATION_DATABASE_URL,
        },
        timeout: 10000,
      },
    );
    expect(result.stdout).toContain('"state":"APPLIED"');
    expect(result.stdout).not.toContain(set.dateOfBirth);
    expect((await projection(set.userId)).appliedRevision).toBe(3);
    expect(
      await prisma.customerFactReceipt.findUnique({
        where: { eventId: set.eventId },
      }),
    ).toMatchObject({ payload: set, recheckCount: 1, state: 'APPLIED' });
  });
});
