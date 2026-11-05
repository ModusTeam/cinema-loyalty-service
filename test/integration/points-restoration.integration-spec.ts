import { afterAll, beforeAll, beforeEach, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  issuePointsSource,
  redeemPoints,
  restorePoints,
} from 'src/loyalty/points-allocation';

let prisma: PrismaService;
let userId: string;
const originalExpiry = new Date('2026-03-01T10:00:00Z');
const issuance = new Date('2026-01-01T10:00:00Z');
const beforeExpiry = new Date('2026-02-01T10:00:00Z');
const afterExpiry = new Date('2026-03-01T10:00:00Z');
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
  await prisma.$executeRawUnsafe(
    'CREATE TABLE points_test_clock (now timestamptz(3) NOT NULL)',
  );
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now FROM points_test_clock $$`,
  );
});
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE point_sources, point_redemptions, loyalty_profiles, points_test_clock CASCADE`;
  userId = randomUUID();
  await prisma.loyaltyProfile.create({
    data: { userId, balance: 777, lifetimePoints: 888 },
  });
  await prisma.$executeRaw`INSERT INTO points_test_clock VALUES (${beforeExpiry})`;
});
afterAll(async () => {
  if (prisma) {
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp()::timestamptz(3) $$`,
    );
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS points_test_clock');
    await prisma.$disconnect();
  }
});
async function at(date: Date) {
  await prisma.$executeRaw`UPDATE points_test_clock SET now = ${date} WHERE true`;
}
async function source(amount = 100, expiry = originalExpiry) {
  const sourceId = randomUUID();
  await prisma.$transaction((tx) =>
    issuePointsSource(tx, {
      userId,
      sourceId,
      sourceRef: sourceId,
      amount,
      issuedAt: issuance,
      originalExpiresAt: expiry,
    }),
  );
  return sourceId;
}
async function spend(amount = 60) {
  const command = {
    userId,
    redemptionId: randomUUID(),
    debitRef: randomUUID(),
    amount,
  };
  await prisma.$transaction((tx) => redeemPoints(tx, command));
  return command;
}
function restoration(redemptionId: string) {
  return { userId, restorationId: randomUUID(), redemptionId };
}
async function restore(command: ReturnType<typeof restoration>) {
  return prisma.$transaction((tx) => restorePoints(tx, command));
}
async function balances() {
  return prisma.$queryRaw<
    Array<{ remaining: number; extendedRemaining: number }>
  >`SELECT remaining, extended_remaining AS "extendedRemaining" FROM point_sources WHERE user_id = ${userId}::uuid ORDER BY source_id`;
}
it('persists restoration identity independently of legacy refund keys', async () => {
  const [row] = await prisma.$queryRaw<
    Array<{ table: string | null }>
  >`SELECT to_regclass('point_restorations')::text AS "table"`;
  expect(row.table).toBe('point_restorations');
});

it('fully restores the persisted single-source split and retains original expiry before expiry', async () => {
  const id = await source();
  const debit = await spend();
  const result = await restore(restoration(debit.redemptionId));
  expect(result).toEqual({
    amount: 60,
    restoredAt: beforeExpiry,
    funding: [{ sourceId: id, amount: 60, expiresAt: originalExpiry }],
  });
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 0 }]);
  expect(await prisma.$queryRaw`SELECT * FROM point_source_extensions`).toEqual(
    [],
  );
});
it('restores a multi-source redemption from its exact immutable funding', async () => {
  const a = await source(30);
  const b = await source(50, new Date('2026-04-01T10:00Z'));
  const debit = await spend(60);
  const result = await restore(restoration(debit.redemptionId));
  expect(result.funding).toEqual([
    { sourceId: a, amount: 30, expiresAt: originalExpiry },
    { sourceId: b, amount: 30, expiresAt: new Date('2026-04-01T10:00Z') },
  ]);
  expect(
    await prisma.pointFunding.findMany({
      where: { userId, redemptionId: debit.redemptionId },
      select: { sourceId: true, amount: true },
    }),
  ).toEqual(
    expect.arrayContaining([
      { sourceId: a, amount: 30 },
      { sourceId: b, amount: 30 },
    ]),
  );
});
it('returns the exact persisted replay snapshot after expiry without double credit', async () => {
  await source();
  const debit = await spend();
  const command = restoration(debit.redemptionId);
  const first = await restore(command);
  await at(new Date('2027-01-01T00:00Z'));
  expect(await restore(command)).toEqual(first);
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 0 }]);
});
it('rejects a second restoration identity for the same redemption', async () => {
  await source();
  const debit = await spend();
  await restore(restoration(debit.redemptionId));
  await expect(restore(restoration(debit.redemptionId))).rejects.toThrow(
    'identity conflict',
  );
});
it('rejects reusing a restoration identity for another redemption', async () => {
  await source();
  const a = await spend(20);
  const b = await spend(20);
  const command = restoration(a.redemptionId);
  await restore(command);
  await expect(
    restore({ ...command, redemptionId: b.redemptionId }),
  ).rejects.toThrow('identity conflict');
});
it('rejects missing historical funding rather than fabricating a grant from legacy balance', async () => {
  await expect(restore(restoration(randomUUID()))).rejects.toThrow(
    'Point redemption not found',
  );
  expect(await prisma.pointSource.count()).toBe(0);
});
it('opens one source extension on expiry equality and never revives untouched expired original points', async () => {
  const id = await source();
  const debit = await spend();
  await at(afterExpiry);
  expect((await restore(restoration(debit.redemptionId))).funding).toEqual([
    { sourceId: id, amount: 60, expiresAt: new Date('2026-03-31T09:00Z') },
  ]);
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
  await expect(spend(61)).rejects.toThrow('Insufficient allocated points');
  await spend(60);
  expect(await balances()).toEqual([{ remaining: 40, extendedRemaining: 0 }]);
  const [row] = await prisma.$queryRaw<
    Array<{ extended: number }>
  >`SELECT extended_amount AS extended FROM point_funding WHERE user_id=${userId}::uuid AND redemption_id<>${debit.redemptionId}::uuid`;
  expect(row.extended).toBe(60);
});
it('pre-expiry restoration does not consume the one-time extension or become spendable after original expiry', async () => {
  await source();
  const a = await spend(30);
  const b = await spend(30);
  await restore(restoration(a.redemptionId));
  await at(afterExpiry);
  await restore(restoration(b.redemptionId));
  await expect(spend(31)).rejects.toThrow('Insufficient allocated points');
  await spend(30);
  expect(await balances()).toEqual([{ remaining: 70, extendedRemaining: 0 }]);
});
it('later restorations from the same source use the first deadline', async () => {
  await source();
  const a = await spend(30);
  const b = await spend(30);
  await at(afterExpiry);
  const first = await restore(restoration(a.redemptionId));
  await at(new Date('2026-03-15T10:00Z'));
  const next = await restore(restoration(b.redemptionId));
  expect(next.funding[0].expiresAt).toEqual(first.funding[0].expiresAt);
  expect(await prisma.pointSourceExtension.count()).toBe(1);
});
it('credits evidence after extension expiry but never renews or spends that extension', async () => {
  await source();
  const a = await spend(30);
  const b = await spend(30);
  await at(afterExpiry);
  const first = await restore(restoration(a.redemptionId));
  await at(first.funding[0].expiresAt);
  const later = await restore(restoration(b.redemptionId));
  expect(later.funding[0].expiresAt).toEqual(first.funding[0].expiresAt);
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
  await expect(spend(1)).rejects.toThrow('Insufficient allocated points');
});
it('orders restored and original sources by their effective deadline', async () => {
  const old = await source();
  const debit = await spend();
  await at(afterExpiry);
  await restore(restoration(debit.redemptionId));
  const fresh = await source(10, new Date('2026-03-10T10:00Z'));
  const result = await prisma.$transaction((tx) =>
    redeemPoints(tx, {
      userId,
      redemptionId: randomUUID(),
      debitRef: randomUUID(),
      amount: 20,
    }),
  );
  expect(result.funding).toEqual([
    { sourceId: fresh, amount: 10 },
    { sourceId: old, amount: 10 },
  ]);
});
it('restores a redemption funded by extended points without creating a new extension', async () => {
  await source();
  const first = await spend();
  await at(afterExpiry);
  const initial = await restore(restoration(first.redemptionId));
  const second = await spend();
  const result = await restore(restoration(second.redemptionId));
  expect(result.funding[0].expiresAt).toEqual(initial.funding[0].expiresAt);
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
});
it('rolls back restoration, extension, counters and caller profile/ledger writes together', async () => {
  await source();
  const debit = await spend();
  await at(afterExpiry);
  await expect(
    prisma.$transaction(async (tx) => {
      await restorePoints(tx, restoration(debit.redemptionId));
      await tx.loyaltyProfile.update({
        where: { userId },
        data: { balance: 999 },
      });
      await tx.pointsTransaction.create({
        data: { userId, type: 'TEST', points: 60, balanceAfter: 999 },
      });
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(await prisma.pointRestoration.count()).toBe(0);
  expect(await prisma.pointSourceExtension.count()).toBe(0);
  expect(await balances()).toEqual([{ remaining: 40, extendedRemaining: 0 }]);
  expect(
    (await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }))
      .balance,
  ).toBe(777);
  expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(0);
});
it('does not alter active balance, lifetime, ledger, commands, outbox or source issuance facts', async () => {
  const id = await source();
  const debit = await spend();
  const profile = await prisma.loyaltyProfile.findUniqueOrThrow({
    where: { userId },
  });
  const original = await prisma.pointSource.findUniqueOrThrow({
    where: { userId_sourceId: { userId, sourceId: id } },
  });
  await at(afterExpiry);
  await restore(restoration(debit.redemptionId));
  expect(
    await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
  ).toEqual(profile);
  const current = await prisma.pointSource.findUniqueOrThrow({
    where: { userId_sourceId: { userId, sourceId: id } },
  });
  expect([
    current.sourceRef,
    current.granted,
    current.issuedAt,
    current.originalExpiresAt,
  ]).toEqual([
    original.sourceRef,
    original.granted,
    original.issuedAt,
    original.originalExpiresAt,
  ]);
  expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(0);
  const [counts] = await prisma.$queryRaw<
    Array<{ commands: bigint; outbox: bigint }>
  >`SELECT (SELECT count(*) FROM processed_events WHERE user_id=${userId}::uuid) commands, (SELECT count(*) FROM outbox_events WHERE aggregate_id=${userId}::uuid) outbox`;
  expect(counts).toEqual({ commands: 0n, outbox: 0n });
});
it('rejects root-client restoration and cross-user redemption references', async () => {
  await source();
  const debit = await spend();
  const command = restoration(debit.redemptionId);
  await expect(restorePoints(prisma, command)).rejects.toThrow(
    'Interactive transaction required',
  );
  const other = randomUUID();
  await prisma.loyaltyProfile.create({ data: { userId: other } });
  await expect(restore({ ...command, userId: other })).rejects.toThrow(
    'Point redemption not found',
  );
  await expect(
    prisma.$executeRaw`INSERT INTO point_restorations(user_id,restoration_id,redemption_id,amount,restored_at) VALUES (${other}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,60,${beforeExpiry})`,
  ).rejects.toThrow();
});
it('derives the full amount from funding and ignores caller amount and backdated timestamps', async () => {
  await source();
  const debit = await spend();
  await at(afterExpiry);
  const command = {
    ...restoration(debit.redemptionId),
    amount: 1,
    restoredAt: beforeExpiry,
  };
  const result = await restore(command);
  expect(result.amount).toBe(60);
  expect(result.restoredAt).toEqual(afterExpiry);
});
it('rejects a partial restoration header even when its exact split and source counters balance', async () => {
  const sourceId = await source(30);
  await source(50, new Date('2026-04-01T10:00Z'));
  const debit = await spend(60);
  const command = restoration(debit.redemptionId);
  const previous = await balances();
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO point_restorations(user_id,restoration_id,redemption_id,amount,restored_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,30,${beforeExpiry})`;
      await tx.$executeRaw`UPDATE point_sources SET remaining=remaining+30 WHERE user_id=${userId}::uuid AND source_id=${sourceId}::uuid`;
      await tx.$executeRaw`INSERT INTO point_restoration_splits(user_id,restoration_id,redemption_id,source_id,amount,expires_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,${sourceId}::uuid,30,${originalExpiry})`;
    }),
  ).rejects.toThrow('point restoration must fully match redemption');
  expect(await prisma.pointRestoration.count()).toBe(0);
  expect(await prisma.pointRestorationSplit.count()).toBe(0);
  expect(await balances()).toEqual(previous);
});

it('rejects raw SQL partial/fabricated splits, unbacked counters and forged extensions', async () => {
  const id = await source();
  const debit = await spend();
  const command = restoration(debit.redemptionId);
  for (const value of [59, 61, 0, -1, 2147483648]) {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO point_restorations(user_id,restoration_id,redemption_id,amount,restored_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,60,${beforeExpiry})`;
        await tx.$executeRaw`INSERT INTO point_restoration_splits(user_id,restoration_id,redemption_id,source_id,amount,expires_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,${id}::uuid,${value},${originalExpiry})`;
      }),
    ).rejects.toThrow();
  }
  await expect(
    prisma.$executeRaw`UPDATE point_sources SET remaining=100 WHERE user_id=${userId}::uuid`,
  ).rejects.toThrow();
  await expect(
    prisma.$executeRaw`UPDATE point_sources SET restored=60 WHERE user_id=${userId}::uuid`,
  ).rejects.toThrow();
  await expect(
    prisma.$executeRaw`INSERT INTO point_source_extensions(user_id,source_id,restoration_id,opened_at,expires_at) VALUES (${userId}::uuid,${id}::uuid,${command.restorationId}::uuid,${afterExpiry},${new Date('2027-01-01Z')})`,
  ).rejects.toThrow();
});
it('keeps original funding and new restoration evidence immutable', async () => {
  await source();
  const debit = await spend();
  await at(afterExpiry);
  await restore(restoration(debit.redemptionId));
  for (const sql of [
    'UPDATE point_funding SET amount=amount+1 WHERE true',
    'UPDATE point_funding SET extended_amount=1 WHERE true',
    'DELETE FROM point_funding WHERE true',
    'UPDATE point_restorations SET restored_at=clock_timestamp() WHERE true',
    'UPDATE point_restorations SET credited=0 WHERE true',
    'DELETE FROM point_restoration_splits WHERE true',
    "UPDATE point_source_extensions SET expires_at=expires_at+interval '1 day' WHERE true",
    'DELETE FROM point_source_extensions WHERE true',
  ])
    await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow();
});
it('supports an int32 maximum full restoration without total overflow', async () => {
  await source(2147483647);
  const debit = await spend(2147483647);
  await at(afterExpiry);
  expect((await restore(restoration(debit.redemptionId))).amount).toBe(
    2147483647,
  );
  expect(await balances()).toEqual([
    { remaining: 2147483647, extendedRemaining: 2147483647 },
  ]);
  await spend(2147483647);
  const [totals] = await prisma.$queryRaw<
    Array<{ spent: bigint; restored: bigint }>
  >`
    SELECT spent, restored FROM point_sources WHERE user_id=${userId}::uuid`;
  expect(totals).toEqual({ spent: 4294967294n, restored: 2147483647n });
});

it('rejects balanced fabricated source splits even when the full restored total matches', async () => {
  const a = await source(30);
  const b = await source(50, new Date('2026-04-01T10:00Z'));
  const debit = await spend(60);
  await spend(20);
  const command = restoration(debit.redemptionId);
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO point_restorations(user_id,restoration_id,redemption_id,amount,restored_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,60,${beforeExpiry})`;
      for (const split of [
        { id: a, amount: 20, expiry: originalExpiry },
        { id: b, amount: 40, expiry: new Date('2026-04-01T10:00Z') },
      ]) {
        await tx.$executeRaw`UPDATE point_sources SET remaining=remaining+${split.amount} WHERE user_id=${userId}::uuid AND source_id=${split.id}::uuid`;
        await tx.$executeRaw`INSERT INTO point_restoration_splits(user_id,restoration_id,redemption_id,source_id,amount,expires_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,${split.id}::uuid,${split.amount},${split.expiry})`;
      }
    }),
  ).rejects.toThrow('point restoration split mismatch');
  expect(await prisma.pointRestoration.count()).toBe(0);
});

it('cannot precreate a valid-looking extension from a pre-expiry restoration', async () => {
  const id = await source();
  const debit = await spend();
  const command = restoration(debit.redemptionId);
  await expect(
    prisma.$transaction(async (tx) => {
      await restorePoints(tx, command);
      await tx.$executeRaw`INSERT INTO point_source_extensions(user_id,source_id,restoration_id,opened_at,expires_at)
      VALUES (${userId}::uuid,${id}::uuid,${command.restorationId}::uuid,${beforeExpiry},point_extension_deadline(${beforeExpiry}::timestamptz))`;
    }),
  ).rejects.toThrow('point extension must originate');
  expect(await prisma.pointRestoration.count()).toBe(0);
});

it('rejects a forged extension deadline despite complete matching restoration evidence', async () => {
  const id = await source();
  const debit = await spend();
  const command = restoration(debit.redemptionId);
  const forgedDeadline = new Date('2026-04-01T09:00Z');
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO point_restorations(user_id,restoration_id,redemption_id,amount,restored_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,60,${afterExpiry})`;
      await tx.$executeRaw`INSERT INTO point_source_extensions(user_id,source_id,restoration_id,opened_at,expires_at) VALUES (${userId}::uuid,${id}::uuid,${command.restorationId}::uuid,${afterExpiry},${forgedDeadline})`;
      await tx.$executeRaw`UPDATE point_sources SET remaining=remaining+60,extended_remaining=extended_remaining+60 WHERE user_id=${userId}::uuid AND source_id=${id}::uuid`;
      await tx.$executeRaw`INSERT INTO point_restoration_splits(user_id,restoration_id,redemption_id,source_id,amount,expires_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${debit.redemptionId}::uuid,${id}::uuid,60,${forgedDeadline})`;
    }),
  ).rejects.toThrow('point extension must originate');
  expect(await balances()).toEqual([{ remaining: 40, extendedRemaining: 0 }]);
});

it('rejects a post-expiry restoration timestamp earlier than its source extension opening', async () => {
  const id = await source();
  const a = await spend(30);
  const b = await spend(30);
  const opening = new Date('2026-03-10T10:00Z');
  await at(opening);
  const first = await restore(restoration(a.redemptionId));
  const command = restoration(b.redemptionId);
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO point_restorations(user_id,restoration_id,redemption_id,amount,restored_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${b.redemptionId}::uuid,30,${afterExpiry})`;
      await tx.$executeRaw`UPDATE point_sources SET remaining=remaining+30, extended_remaining=extended_remaining+30 WHERE user_id=${userId}::uuid AND source_id=${id}::uuid`;
      await tx.$executeRaw`INSERT INTO point_restoration_splits(user_id,restoration_id,redemption_id,source_id,amount,expires_at) VALUES (${userId}::uuid,${command.restorationId}::uuid,${b.redemptionId}::uuid,${id}::uuid,30,${first.funding[0].expiresAt})`;
    }),
  ).rejects.toThrow('point restoration split mismatch');
  expect(await balances()).toEqual([{ remaining: 70, extendedRemaining: 30 }]);
});

it('does not select a future extension when another original source can fund the debit', async () => {
  await source();
  const debit = await spend();
  await at(new Date('2026-03-10T10:00Z'));
  await restore(restoration(debit.redemptionId));
  await at(afterExpiry);
  const valid = await source(10, new Date('2026-05-01T10:00Z'));
  const command = await spend(10);
  const saved = await prisma.$transaction((tx) => redeemPoints(tx, command));
  expect(saved.funding).toEqual([{ sourceId: valid, amount: 10 }]);
});

async function blockedOperations(
  operations: Array<() => Promise<unknown>>,
  whileBlocked?: () => Promise<void>,
) {
  const pool = new Pool({
    connectionString: process.env.INTEGRATION_DATABASE_URL,
  });
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query(
    'SELECT id FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
    [userId],
  );
  const results = Promise.allSettled(operations.map((run) => run()));
  try {
    const deadline = Date.now() + 5000;
    let waiting = 0;
    while (Date.now() < deadline) {
      const rows = await pool.query<{ count: number }>(
        `SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%' AND pid<>pg_backend_pid()`,
      );
      waiting = rows.rows[0].count;
      if (waiting >= operations.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBeGreaterThanOrEqual(operations.length);
    if (whileBlocked) await whileBlocked();
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await pool.end();
  }
  return results;
}
it('serializes concurrent exact restoration replay behind the real profile lock', async () => {
  await source();
  const debit = await spend();
  await at(afterExpiry);
  const command = restoration(debit.redemptionId);
  const results = await blockedOperations([
    () => restore(command),
    () => restore(command),
  ]);
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
  expect(await prisma.pointRestoration.count()).toBe(1);
});
it('serializes competing restoration identities without double credit', async () => {
  await source();
  const debit = await spend();
  await at(afterExpiry);
  const results = await blockedOperations([
    () => restore(restoration(debit.redemptionId)),
    () => restore(restoration(debit.redemptionId)),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
});
it('serializes different redemptions restoring one source and opens only one extension', async () => {
  await source();
  const a = await spend(30);
  const b = await spend(30);
  await at(afterExpiry);
  const results = await blockedOperations([
    () => restore(restoration(a.redemptionId)),
    () => restore(restoration(b.redemptionId)),
  ]);
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  expect(await prisma.pointSourceExtension.count()).toBe(1);
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
  const deadlines = await prisma.$queryRaw<
    Array<{ expiresAt: Date }>
  >`SELECT expires_at AS "expiresAt" FROM point_restoration_splits WHERE user_id=${userId}::uuid`;
  expect(deadlines).toEqual([
    { expiresAt: new Date('2026-03-31T09:00Z') },
    { expiresAt: new Date('2026-03-31T09:00Z') },
  ]);
});
it('serializes restoration/redeem and conserves the observed lock order', async () => {
  await source();
  const debit = await spend();
  await at(afterExpiry);
  const results = await blockedOperations([
    () => restore(restoration(debit.redemptionId)),
    () => spend(60),
  ]);
  expect(results[0].status).toBe('fulfilled');
  if (results[1].status === 'rejected') {
    expect(results[1].reason).toEqual(
      expect.objectContaining({ message: 'Insufficient allocated points' }),
    );
  }
  expect(await balances()).toEqual([
    {
      remaining: results[1].status === 'fulfilled' ? 40 : 100,
      extendedRemaining: results[1].status === 'fulfilled' ? 0 : 60,
    },
  ]);
});
it('reads restoration decision time only after its profile lock is acquired', async () => {
  await source();
  const debit = await spend();
  const results = await blockedOperations(
    [() => restore(restoration(debit.redemptionId))],
    () => at(afterExpiry),
  );
  expect(results[0]).toEqual(
    expect.objectContaining({
      status: 'fulfilled',
      value: expect.objectContaining({ restoredAt: afterExpiry }),
    }),
  );
  expect(await balances()).toEqual([{ remaining: 100, extendedRemaining: 60 }]);
});

it.each([
  ['2026-03-01T10:00:00Z', '2026-03-31T09:00:00Z'],
  ['2026-10-01T09:00:00Z', '2026-10-31T10:00:00Z'],
  ['2026-02-27T01:30:00Z', '2026-03-29T01:30:00Z'],
  ['2026-09-25T00:30:00Z', '2026-10-25T01:30:00Z'],
  ['2024-02-01T10:00:00Z', '2024-03-02T10:00:00Z'],
  ['2026-01-31T10:00:00Z', '2026-03-02T10:00:00Z'],
  ['2026-12-15T10:00:00Z', '2027-01-14T10:00:00Z'],
])(
  'adds 30 Kyiv calendar days with pinned timezone policy: %s',
  async (start, end) => {
    const [row] = await prisma.$queryRaw<
      Array<{ deadline: Date }>
    >`SELECT point_extension_deadline(${new Date(start)}::timestamptz) deadline`;
    expect(row.deadline).toEqual(new Date(end));
  },
);
