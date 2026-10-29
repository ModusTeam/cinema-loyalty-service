import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionCompletionService } from 'src/loyalty/session-completion.service';
import { sessionCompletion } from '../fixtures/session-completion';

describe('passive session completion on PostgreSQL', () => {
  let prisma: PrismaService;
  let observer: Pool;
  let service: SessionCompletionService;
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = process.env.INTEGRATION_DATABASE_URL ?? '';
    const url = new URL(databaseUrl);
    if (
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/loyalty_integration' ||
      url.username !== 'loyalty_test'
    )
      throw new Error('Use the disposable integration runner');
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    );
    observer = new Pool({ connectionString: databaseUrl });
    await prisma.$connect();
    service = new SessionCompletionService(prisma);
  });
  beforeEach(async () => {
    await prisma.sessionCompletionFact.deleteMany();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await observer?.end();
  });

  async function effectCounts() {
    return Promise.all([
      prisma.loyaltyProfile.count(),
      prisma.pointsTransaction.count(),
      prisma.processedEvent.count(),
      prisma.userBonusGrant.count(),
      prisma.userAchievement.count(),
      prisma.achievementDispatchIntent.count(),
      prisma.outboxEvent.count(),
      prisma.goldUpgradeReservation.count(),
      prisma.customerFactReceipt.count(),
    ]);
  }

  it('stores canonical microseconds exactly, accepts replay and never touches loyalty state', async () => {
    const profile = await prisma.loyaltyProfile.create({
      data: {
        userId: randomUUID(),
        balance: 100,
        lifetimePoints: 200,
        yearPoints: 150,
        yearVisits: 3,
        tier: 'SILVER',
        birthdayDate: new Date('1990-01-01T00:00:00.000Z'),
      },
    });
    const before = await effectCounts();
    const fact = sessionCompletion();
    await service.ingest(fact);
    const original = await prisma.sessionCompletionFact.findUniqueOrThrow({
      where: { eventId: fact.eventId },
    });
    expect(original).toMatchObject(fact);
    await service.ingest(Object.fromEntries(Object.entries(fact).reverse()));
    await service.ingest({
      ...fact,
      eventId: fact.eventId.toUpperCase(),
      sessionId: fact.sessionId.toUpperCase(),
      privateExtra: 'PRIVATE_EXTRA',
    });
    expect(await prisma.sessionCompletionFact.findMany()).toEqual([original]);
    expect(
      await prisma.loyaltyProfile.findUnique({
        where: { userId: profile.userId },
      }),
    ).toEqual(profile);
    expect(await effectCounts()).toEqual(before);
  });

  it('rejects conflicting event, session/revision and microsecond payload without overwriting the fact', async () => {
    const fact = sessionCompletion();
    await service.ingest(fact);
    const original = await prisma.sessionCompletionFact.findMany();
    for (const conflict of [
      { ...fact, sessionId: randomUUID() },
      { ...fact, eventId: randomUUID() },
      { ...fact, completedAtUtc: '2024-02-29T23:59:59.123457Z' },
    ])
      await expect(service.ingest(conflict)).rejects.toThrow(
        'SESSION_COMPLETION_IDENTITY_CONFLICT',
      );
    expect(await prisma.sessionCompletionFact.findMany()).toEqual(original);
  });

  it('rejects an identity that bridges two existing facts', async () => {
    const first = sessionCompletion();
    const second = sessionCompletion();
    await service.ingest(first);
    await service.ingest(second);
    await expect(
      service.ingest({ ...first, sessionId: second.sessionId }),
    ).rejects.toThrow('SESSION_COMPLETION_IDENTITY_CONFLICT');
    expect(await prisma.sessionCompletionFact.count()).toBe(2);
  });

  it('retains completion before any purchase across a fresh database client/restart', async () => {
    const fact = sessionCompletion();
    const before = await effectCounts();
    await service.ingest(fact);
    const original = await prisma.sessionCompletionFact.findUnique({
      where: { eventId: fact.eventId },
    });
    const restarted = new PrismaService(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    );
    try {
      await restarted.$connect();
      await new SessionCompletionService(restarted).ingest(fact);
      expect(await restarted.sessionCompletionFact.findMany()).toEqual([
        original,
      ]);
    } finally {
      await restarted.$disconnect();
    }
    expect(await effectCounts()).toEqual(before);
  });

  it('rolls back a database failure, then permits retry without partial business effects', async () => {
    const fact = sessionCompletion();
    const before = await effectCounts();
    await observer.query(`CREATE FUNCTION session_completion_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'PRIVATE_FAILURE'; END $$;
      CREATE TRIGGER session_completion_fail AFTER INSERT ON session_completion_facts
      FOR EACH ROW EXECUTE FUNCTION session_completion_fail()`);
    try {
      await expect(service.ingest(fact)).rejects.toThrow();
      expect(await prisma.sessionCompletionFact.count()).toBe(0);
      expect(await effectCounts()).toEqual(before);
    } finally {
      await observer.query(
        'DROP TRIGGER session_completion_fail ON session_completion_facts; DROP FUNCTION session_completion_fail()',
      );
    }
    await service.ingest(fact);
    expect(await prisma.sessionCompletionFact.count()).toBe(1);
  });

  it('enforces both identities and v1 version constraints in PostgreSQL', async () => {
    const fact = sessionCompletion();
    await service.ingest(fact);
    await expect(
      observer.query(
        'INSERT INTO session_completion_facts(event_id,session_id,schema_version,revision,completed_at_utc) VALUES ($1,$2,1,1,$3)',
        [randomUUID(), fact.sessionId, fact.completedAtUtc],
      ),
    ).rejects.toHaveProperty('code', '23505');
    await expect(
      observer.query(
        'INSERT INTO session_completion_facts(event_id,session_id,schema_version,revision,completed_at_utc) VALUES ($1,$2,1,1,$3)',
        [fact.eventId, randomUUID(), fact.completedAtUtc],
      ),
    ).rejects.toHaveProperty('code', '23505');
    await expect(
      observer.query(
        'INSERT INTO session_completion_facts(event_id,session_id,schema_version,revision,completed_at_utc) VALUES ($1,$2,1,2,$3)',
        [randomUUID(), randomUUID(), fact.completedAtUtc],
      ),
    ).rejects.toHaveProperty('code', '23514');
    expect(await prisma.sessionCompletionFact.count()).toBe(1);
  });

  it.each(['exact', 'event-conflict', 'session-conflict'] as const)(
    'arbitrates overlapping inserts through PostgreSQL unique indexes: %s',
    async (mode) => {
      const first = sessionCompletion();
      const second =
        mode === 'exact'
          ? first
          : mode === 'event-conflict'
            ? { ...first, sessionId: randomUUID() }
            : { ...first, eventId: randomUUID() };
      const blocker = await observer.connect();
      await observer.query(`CREATE FUNCTION session_completion_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock_shared(20481029); RETURN NEW; END $$;
        CREATE TRIGGER session_completion_barrier BEFORE INSERT ON session_completion_facts
        FOR EACH ROW EXECUTE FUNCTION session_completion_barrier()`);
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(20481029)');
      const results = Promise.allSettled([
        service.ingest(first),
        new SessionCompletionService(prisma).ingest(second),
      ]);
      try {
        const end = Date.now() + 5000;
        let waiting = 0;
        while (Date.now() < end && waiting < 2) {
          const observed = await observer.query<{
            count: number;
          }>(`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%INSERT%session_completion_facts%'`);
          waiting = observed.rows[0].count;
          if (waiting < 2) await delay(10);
        }
        expect(waiting).toBe(2);
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
        await results;
        await observer.query(
          'DROP TRIGGER session_completion_barrier ON session_completion_facts; DROP FUNCTION session_completion_barrier()',
        );
      }
      const outcomes = await results;
      expect(
        outcomes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(mode === 'exact' ? 2 : 1);
      for (const result of outcomes)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({
            code: 'SESSION_COMPLETION_IDENTITY_CONFLICT',
          });
      expect(await prisma.sessionCompletionFact.count()).toBe(1);
    },
  );
});
