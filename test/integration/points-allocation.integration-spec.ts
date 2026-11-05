import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Pool } from 'pg';
import { ZodError } from 'zod';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { issuePointsSource, redeemPoints } from 'src/loyalty/points-allocation';

describe('points allocation on PostgreSQL', () => {
  let prisma: PrismaService;
  let userId: string;
  let issuedAt: Date;
  let now: Date;
  let expiresAt: Date;

  beforeAll(async () => {
    const url = process.env.INTEGRATION_DATABASE_URL;
    if (!url) throw new Error('Run through bun run test:integration');
    const parsed = new URL(url);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/loyalty_integration' ||
      parsed.username !== 'loyalty_test'
    )
      throw new Error('Disposable database required');
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: url }));
    await prisma.$connect();
    const [clock] = await prisma.$queryRaw<
      Array<{ currentTime: Date }>
    >`SELECT clock_timestamp()::timestamptz(3) AS "currentTime"`;
    now = new Date(clock.currentTime.getTime() - 60000);
    issuedAt = new Date(now.getTime() - 86400000);
    expiresAt = new Date(clock.currentTime.getTime() + 86400000);
  });
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE point_funding, point_redemptions, point_sources, loyalty_profiles CASCADE`;
    userId = randomUUID();
    await prisma.loyaltyProfile.create({ data: { userId, balance: 100 } });
  });
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('spends earliest sources first, including partial consumption', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await prisma.$transaction(async (tx) => {
      await issuePointsSource(tx, {
        userId,
        sourceId: b,
        sourceRef: 'b',
        amount: 50,
        issuedAt,
        originalExpiresAt: expiresAt,
      });
      await issuePointsSource(tx, {
        userId,
        sourceId: a,
        sourceRef: 'a',
        amount: 40,
        issuedAt,
        originalExpiresAt: new Date(expiresAt.getTime() - 3600000),
      });
    });
    const result = await prisma.$transaction((tx) =>
      redeemPoints(tx, {
        userId,
        redemptionId: randomUUID(),
        debitRef: randomUUID(),
        amount: 60,
      }),
    );
    expect(result.funding).toEqual([
      { sourceId: a, amount: 40 },
      { sourceId: b, amount: 20 },
    ]);
  });
  it('uses source UUID as the stable tie breaker and excludes expired sources', async () => {
    const ids = [randomUUID(), randomUUID()].sort();
    await prisma.$transaction(async (tx) => {
      for (const id of [...ids].reverse())
        await issuePointsSource(tx, {
          userId,
          sourceId: id,
          sourceRef: id,
          amount: 30,
          issuedAt,
          originalExpiresAt: expiresAt,
        });
      await issuePointsSource(tx, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'expired',
        amount: 100,
        issuedAt,
        originalExpiresAt: now,
      });
    });
    const result = await prisma.$transaction((tx) =>
      redeemPoints(tx, {
        userId,
        redemptionId: randomUUID(),
        debitRef: randomUUID(),
        amount: 40,
      }),
    );
    expect(result.funding).toEqual([
      { sourceId: ids[0], amount: 30 },
      { sourceId: ids[1], amount: 10 },
    ]);
    const rows = await prisma.$queryRaw<
      Array<{ sourceRef: string; remaining: number }>
    >`SELECT source_ref AS "sourceRef", remaining FROM point_sources WHERE user_id = ${userId}::uuid ORDER BY source_ref`;
    expect(rows.find((row) => row.sourceRef === 'expired')?.remaining).toBe(
      100,
    );
    expect(rows.find((row) => row.sourceRef === ids[1])?.remaining).toBe(20);
  });

  it('preserves original source facts and funding on exact replay, rejecting identity conflicts', async () => {
    const source = {
      userId,
      sourceId: randomUUID(),
      sourceRef: 'award',
      amount: 70,
      issuedAt,
      originalExpiresAt: expiresAt,
    };
    const debit = {
      userId,
      redemptionId: randomUUID(),
      debitRef: randomUUID(),
      amount: 40,
    };
    await prisma.$transaction((tx) => issuePointsSource(tx, source));
    const first = await prisma.$transaction((tx) => redeemPoints(tx, debit));
    await prisma.$transaction((tx) => issuePointsSource(tx, source));
    expect(await prisma.$transaction((tx) => redeemPoints(tx, debit))).toEqual(
      first,
    );
    await expect(
      prisma.$transaction((tx) =>
        issuePointsSource(tx, {
          ...source,
          originalExpiresAt: new Date(expiresAt.getTime() + 3600000),
        }),
      ),
    ).rejects.toThrow('identity conflict');
    await expect(
      prisma.$transaction((tx) =>
        issuePointsSource(tx, { ...source, amount: 71 }),
      ),
    ).rejects.toThrow('identity conflict');
    await expect(
      prisma.$transaction((tx) =>
        issuePointsSource(tx, { ...source, sourceId: randomUUID() }),
      ),
    ).rejects.toThrow('identity conflict');
    await expect(
      prisma.$transaction((tx) => redeemPoints(tx, { ...debit, amount: 41 })),
    ).rejects.toThrow('identity conflict');
    await expect(
      prisma.$transaction((tx) =>
        redeemPoints(tx, { ...debit, redemptionId: randomUUID() }),
      ),
    ).rejects.toThrow('identity conflict');
    const rows = await prisma.$queryRaw<
      Array<{ remaining: number; originalExpiresAt: Date }>
    >`SELECT remaining, original_expires_at AS "originalExpiresAt" FROM point_sources WHERE user_id = ${userId}::uuid`;
    expect(rows).toEqual([{ remaining: 30, originalExpiresAt: expiresAt }]);
    const refs = await prisma.$queryRaw<
      Array<{ debitRef: string; sourceRef: string }>
    >`SELECT r.debit_ref AS "debitRef", s.source_ref AS "sourceRef" FROM point_funding f JOIN point_redemptions r USING (user_id, redemption_id) JOIN point_sources s USING (user_id, source_id)`;
    expect(refs).toEqual([{ debitRef: debit.debitRef, sourceRef: 'award' }]);
  });

  it('leaves all state unchanged on insufficient funds and rolls back caller ledger/profile writes', async () => {
    const source = {
      userId,
      sourceId: randomUUID(),
      sourceRef: 'award',
      amount: 25,
      issuedAt,
      originalExpiresAt: expiresAt,
    };
    await prisma.$transaction((tx) => issuePointsSource(tx, source));
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.loyaltyProfile.update({
          where: { userId },
          data: { balance: 99 },
        });
        await tx.pointsTransaction.create({
          data: { userId, type: 'TEST', points: -1, balanceAfter: 99 },
        });
        await redeemPoints(tx, {
          userId,
          redemptionId: randomUUID(),
          debitRef: randomUUID(),
          amount: 26,
        });
      }),
    ).rejects.toThrow('Insufficient allocated points');
    expect(
      (await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }))
        .balance,
    ).toBe(100);
    expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(0);
    const rows = await prisma.$queryRaw<
      Array<{ remaining: number }>
    >`SELECT remaining FROM point_sources WHERE user_id = ${userId}::uuid`;
    expect(rows).toEqual([{ remaining: 25 }]);
    const count = await prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) FROM point_redemptions`;
    expect(count[0].count).toBe(0n);
  });

  it('serializes competing redemptions behind a real profile lock', async () => {
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'award',
        amount: 50,
        issuedAt,
        originalExpiresAt: expiresAt,
      }),
    );
    const pool = new Pool({
      connectionString: process.env.INTEGRATION_DATABASE_URL,
    });
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const run = () =>
      prisma.$transaction(
        (tx) =>
          redeemPoints(tx, {
            userId,
            redemptionId: randomUUID(),
            debitRef: randomUUID(),
            amount: 40,
          }),
        { timeout: 10000 },
      );
    const results = Promise.allSettled([run(), run()]);
    try {
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const result = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%loyalty_profiles%' AND pid <> pg_backend_pid()`,
        );
        waiting = result.rows[0].count;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pool.end();
    }
    const settled = await results;
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const rows = await prisma.$queryRaw<
      Array<{ remaining: number }>
    >`SELECT remaining FROM point_sources WHERE user_id = ${userId}::uuid`;
    expect(rows).toEqual([{ remaining: 10 }]);
  });

  it('rejects invalid numeric amounts and accepts the PostgreSQL integer maximum', async () => {
    const source = {
      userId,
      sourceId: randomUUID(),
      sourceRef: 'max',
      amount: 2147483647,
      issuedAt,
      originalExpiresAt: expiresAt,
    };
    await prisma.$transaction(async (tx) => {
      await issuePointsSource(tx, source);
      await issuePointsSource(tx, {
        ...source,
        sourceId: randomUUID(),
        sourceRef: 'extra',
        originalExpiresAt: new Date(expiresAt.getTime() + 86400000),
      });
    });
    for (const value of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
      await expect(
        prisma.$transaction((tx) =>
          issuePointsSource(tx, { ...source, amount: value }),
        ),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        prisma.$transaction((tx) =>
          redeemPoints(tx, {
            userId,
            redemptionId: randomUUID(),
            debitRef: randomUUID(),
            amount: value,
          }),
        ),
      ).rejects.toBeInstanceOf(ZodError);
    }
    await prisma.$transaction((tx) => issuePointsSource(tx, source));
    expect(
      (
        await prisma.$transaction((tx) =>
          redeemPoints(tx, {
            userId,
            redemptionId: randomUUID(),
            debitRef: randomUUID(),
            amount: 2147483647,
          }),
        )
      ).funding,
    ).toEqual([{ sourceId: source.sourceId, amount: 2147483647 }]);
  });

  it('rejects invalid direct writes, cross-user funding and incomplete autocommit operations', async () => {
    const sourceId = randomUUID();
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId,
        sourceRef: 'award',
        amount: 10,
        issuedAt,
        originalExpiresAt: expiresAt,
      }),
    );
    await expect(
      prisma.$executeRaw`UPDATE point_sources SET source_ref = 'changed' WHERE user_id = ${userId}::uuid AND source_id = ${sourceId}::uuid`,
    ).rejects.toThrow('point allocation facts are immutable');
    await expect(
      prisma.$executeRaw`UPDATE point_sources SET remaining = 11 WHERE user_id = ${userId}::uuid AND source_id = ${sourceId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE point_sources SET granted = 11 WHERE user_id = ${userId}::uuid AND source_id = ${sourceId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE point_sources SET remaining = 9 WHERE user_id = ${userId}::uuid AND source_id = ${sourceId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO point_redemptions (user_id, redemption_id, debit_ref, amount, spent_at) VALUES (${userId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, ${now})`,
    ).rejects.toThrow();
    const otherUser = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        const redemptionId = randomUUID();
        await tx.$executeRaw`INSERT INTO point_redemptions (user_id, redemption_id, debit_ref, amount, spent_at) VALUES (${otherUser}::uuid, ${redemptionId}::uuid, ${randomUUID()}::uuid, 1, ${now})`;
        await tx.$executeRaw`INSERT INTO point_funding (user_id, redemption_id, source_id, amount) VALUES (${otherUser}::uuid, ${redemptionId}::uuid, ${sourceId}::uuid, 1)`;
      }),
    ).rejects.toThrow();
    const rows = await prisma.$queryRaw<
      Array<{ remaining: number }>
    >`SELECT remaining FROM point_sources WHERE user_id = ${userId}::uuid`;
    expect(rows).toEqual([{ remaining: 10 }]);
  });
  it('does not let a backdated request spend a source already expired at decision time', async () => {
    const sourceId = randomUUID();
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId,
        sourceRef: 'expired-before-decision',
        amount: 10,
        issuedAt,
        originalExpiresAt: now,
      }),
    );
    const request = {
      userId,
      redemptionId: randomUUID(),
      debitRef: randomUUID(),
      amount: 10,
      spentAt: issuedAt,
    };
    await expect(
      prisma.$transaction((tx) => redeemPoints(tx, request)),
    ).rejects.toThrow('Insufficient allocated points');
  });
  it('replays the original funding after the source expires', async () => {
    const [clock] = await prisma.$queryRaw<
      Array<{ currentTime: Date }>
    >`SELECT clock_timestamp()::timestamptz(3) AS "currentTime"`;
    const deadline = new Date(clock.currentTime.getTime() + 5000);
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'short',
        amount: 10,
        issuedAt,
        originalExpiresAt: deadline,
      }),
    );
    const debit = {
      userId,
      redemptionId: randomUUID(),
      debitRef: randomUUID(),
      amount: 10,
    };
    expect(Date.now()).toBeLessThan(deadline.getTime());
    const first = await prisma.$transaction((tx) => redeemPoints(tx, debit));
    await prisma.$executeRaw`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${deadline}::timestamptz - clock_timestamp()))) + 0.01)`;
    expect(await prisma.$transaction((tx) => redeemPoints(tx, debit))).toEqual(
      first,
    );
  });

  it('cannot treat the legacy balance as source funding or commit a root-client partial redemption', async () => {
    const command = {
      userId,
      redemptionId: randomUUID(),
      debitRef: randomUUID(),
      amount: 10,
    };
    await expect(
      prisma.$transaction((tx) => redeemPoints(tx, command)),
    ).rejects.toThrow('Insufficient allocated points');
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'award',
        amount: 10,
        issuedAt,
        originalExpiresAt: expiresAt,
      }),
    );
    await expect(redeemPoints(prisma, command)).rejects.toThrow(
      'Interactive transaction required',
    );
    await expect(
      issuePointsSource(prisma, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'autocommit',
        amount: 10,
        issuedAt,
        originalExpiresAt: expiresAt,
      }),
    ).rejects.toThrow('Interactive transaction required');
    expect(await prisma.pointSource.count({ where: { userId } })).toBe(1);
    const rows = await prisma.$queryRaw<
      Array<{ remaining: number }>
    >`SELECT remaining FROM point_sources WHERE user_id = ${userId}::uuid`;
    expect(rows).toEqual([{ remaining: 10 }]);
  });
  it('rejects a directly written funding link outside the source validity interval', async () => {
    const sourceId = randomUUID();
    const redemptionId = randomUUID();
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId,
        sourceRef: 'expired',
        amount: 10,
        issuedAt,
        originalExpiresAt: now,
      }),
    );
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO point_redemptions (user_id, redemption_id, debit_ref, amount, spent_at) VALUES (${userId}::uuid, ${redemptionId}::uuid, ${randomUUID()}::uuid, 10, ${now})`;
        await tx.$executeRaw`UPDATE point_sources SET remaining = 0 WHERE user_id = ${userId}::uuid AND source_id = ${sourceId}::uuid`;
        await tx.$executeRaw`INSERT INTO point_funding (user_id, redemption_id, source_id, amount) VALUES (${userId}::uuid, ${redemptionId}::uuid, ${sourceId}::uuid, 10)`;
      }),
    ).rejects.toThrow();
  });
  it('checks expiry after waiting for the profile lock', async () => {
    const [clock] = await prisma.$queryRaw<
      Array<{ currentTime: Date }>
    >`SELECT clock_timestamp()::timestamptz(3) AS "currentTime"`;
    const deadline = new Date(clock.currentTime.getTime() + 5000);
    await prisma.$transaction((tx) =>
      issuePointsSource(tx, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'lock-expiry',
        amount: 10,
        issuedAt,
        originalExpiresAt: deadline,
      }),
    );
    const pool = new Pool({
      connectionString: process.env.INTEGRATION_DATABASE_URL,
    });
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    expect(Date.now()).toBeLessThan(deadline.getTime());
    const operation = prisma.$transaction(
      (tx) =>
        redeemPoints(tx, {
          userId,
          redemptionId: randomUUID(),
          debitRef: randomUUID(),
          amount: 10,
        }),
      { timeout: 10000 },
    );
    const outcome = Promise.allSettled([operation]);
    try {
      const waitUntil = Date.now() + 3000;
      let waiting = 0;
      while (Date.now() < waitUntil) {
        const result = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%loyalty_profiles%' AND pid <> pg_backend_pid()`,
        );
        waiting = result.rows[0].count;
        if (waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(Date.now()).toBeLessThan(deadline.getTime());
      await blocker.query(
        'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.01)',
        [deadline],
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pool.end();
    }
    const [result] = await outcome;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.reason).toEqual(
        expect.objectContaining({ message: 'Insufficient allocated points' }),
      );
  });

  it('ignores future-issued sources even when they expire first', async () => {
    const current = randomUUID();
    await prisma.$transaction(async (tx) => {
      await issuePointsSource(tx, {
        userId,
        sourceId: current,
        sourceRef: 'current',
        amount: 10,
        issuedAt,
        originalExpiresAt: new Date(expiresAt.getTime() + 86400000),
      });
      await issuePointsSource(tx, {
        userId,
        sourceId: randomUUID(),
        sourceRef: 'future',
        amount: 10,
        issuedAt: new Date(expiresAt.getTime() - 3600000),
        originalExpiresAt: expiresAt,
      });
    });
    const result = await prisma.$transaction((tx) =>
      redeemPoints(tx, {
        userId,
        redemptionId: randomUUID(),
        debitRef: randomUUID(),
        amount: 10,
      }),
    );
    expect(result.funding).toEqual([{ sourceId: current, amount: 10 }]);
  });

  it('handles total source availability above the int32 limit without overflow', async () => {
    await prisma.$transaction(async (tx) => {
      for (const ref of ['first', 'second'])
        await issuePointsSource(tx, {
          userId,
          sourceId: randomUUID(),
          sourceRef: ref,
          amount: 2147483647,
          issuedAt,
          originalExpiresAt: expiresAt,
        });
    });
    const result = await prisma.$transaction((tx) =>
      redeemPoints(tx, {
        userId,
        redemptionId: randomUUID(),
        debitRef: randomUUID(),
        amount: 2147483647,
      }),
    );
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0].amount).toBe(2147483647);
  });
  it('maintains funding totals across many splits and rejects direct counter changes', async () => {
    const redemptionId = randomUUID();
    await prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < 64; i++)
          await issuePointsSource(tx, {
            userId,
            sourceId: randomUUID(),
            sourceRef: `batch-${i}`,
            amount: 1,
            issuedAt,
            originalExpiresAt: expiresAt,
          });
        const result = await redeemPoints(tx, {
          userId,
          redemptionId,
          debitRef: randomUUID(),
          amount: 64,
        });
        expect(result.funding).toHaveLength(64);
      },
      { timeout: 30000 },
    );
    const rows = await prisma.$queryRaw<
      Array<{ funded: number; amount: number }>
    >`SELECT funded, amount FROM point_redemptions WHERE user_id = ${userId}::uuid`;
    expect(rows).toEqual([{ funded: 64, amount: 64 }]);
    await expect(
      prisma.$executeRaw`UPDATE point_redemptions SET funded = 0 WHERE user_id = ${userId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO point_redemptions (user_id, redemption_id, debit_ref, amount, spent_at, funded) VALUES (${userId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, ${now}, 1)`,
    ).rejects.toThrow();
    expect(
      await prisma.pointFunding.count({ where: { userId, redemptionId } }),
    ).toBe(64);
  });
});
