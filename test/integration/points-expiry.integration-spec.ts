import { afterAll, beforeAll, beforeEach, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  issuePointsSource,
  redeemPoints,
  restorePoints,
  expireSourcePoints,
  expirePointsBatch,
  getPointsAvailability,
  ExpireSourcePoints,
} from 'src/loyalty/points-allocation';

let prisma: PrismaService;
let userId: string;
const issuedAt = new Date('2026-01-01T10:00:00Z');
const deadline = new Date('2026-03-01T10:00:00Z');
const before = new Date('2026-02-01T10:00:00Z');
const late = new Date('2026-05-01T10:00:00Z');
/** Overrides the decision clock only in the runner-owned disposable database. */
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
    'CREATE TABLE points_expiry_test_clock (now timestamptz(3) NOT NULL)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now FROM points_expiry_test_clock $$',
  );
});
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE point_sources, point_redemptions, loyalty_profiles, points_expiry_test_clock CASCADE`;
  userId = randomUUID();
  await prisma.loyaltyProfile.create({
    data: { userId, balance: 777, lifetimePoints: 888 },
  });
  await prisma.$executeRaw`INSERT INTO points_expiry_test_clock VALUES (${before})`;
});
/** Restores the normal clock before subsequent integration suites run. */
afterAll(async () => {
  if (!prisma) return;
  await prisma.$executeRawUnsafe(
    'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp()::timestamptz(3) $$',
  );
  await prisma.$executeRawUnsafe(
    'DROP TABLE IF EXISTS points_expiry_test_clock',
  );
  await prisma.$disconnect();
});
/** Moves only the disposable fixture clock; production commands never accept time. */
async function at(time: Date) {
  await prisma.$executeRaw`UPDATE points_expiry_test_clock SET now=${time} WHERE true`;
}
/** Creates trusted source facts using the caller-transaction production helper. */
async function source(amount = 100, sourceId = randomUUID()) {
  await prisma.$transaction((tx) =>
    issuePointsSource(tx, {
      userId,
      sourceId,
      sourceRef: sourceId,
      amount,
      issuedAt,
      originalExpiresAt: deadline,
    }),
  );
  return sourceId;
}
/** Persists a full debit for restoration and bucket-order fixtures. */
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
/** Restores exactly one saved redemption without fabricating its amount. */
async function restore(redemptionId: string) {
  const command = { userId, restorationId: randomUUID(), redemptionId };
  return prisma.$transaction((tx) => restorePoints(tx, command));
}
/** Allocates a new operation identity unless the test explicitly supplies replay. */
function command(sourceId: string): ExpireSourcePoints {
  return { userId, sourceId, operationId: randomUUID() };
}
/** Preserves transaction ownership at the helper boundary. */
async function expire(input: ExpireSourcePoints) {
  return prisma.$transaction((tx) => expireSourcePoints(tx, input));
}
/** Checks constant-time protected conservation after every meaningful fixture transition. */
async function conserved() {
  const rows = await prisma.$queryRaw<
    Array<{ valid: boolean }>
  >`SELECT remaining::numeric+spent::numeric+expired::numeric=granted::numeric+restored::numeric AND extended_remaining::numeric+extended_spent::numeric+extended_expired::numeric=extended_restored::numeric AS valid FROM point_sources WHERE user_id=${userId}::uuid`;
  expect(rows.every((row) => row.valid)).toBe(true);
}

it.each([-1, 0, 1])(
  'retires only at the original deadline boundary %s ms',
  async (offset) => {
    const id = await source();
    await at(new Date(deadline.getTime() + offset));
    const result = await expire(command(id));
    expect(result.amount).toBe(offset < 0 ? 0 : 100);
    expect(result.entries).toHaveLength(offset < 0 ? 0 : 1);
    if (offset >= 0)
      expect(result.entries[0]).toMatchObject({
        bucket: 'ORIGINAL',
        amount: 100,
        deadline,
        creditWatermark: 0n,
      });
    await conserved();
  },
);
it('persists partial-spend expiry and stable global evidence IDs with exact replay', async () => {
  const id = await source();
  await spend(60);
  await at(deadline);
  const input = command(id);
  const first = await expire(input);
  await at(late);
  expect(first.amount).toBe(40);
  expect(await expire(input)).toEqual(first);
  expect(await prisma.pointExpiryEntry.count()).toBe(1);
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    remaining: 0,
    spent: 60n,
    expired: 40n,
  });
  await conserved();
});
it('saves zero snapshots and rejects conflicting operation source or supplied amounts', async () => {
  const a = await source();
  const b = await source();
  const input = command(a);
  const zero = await expire(input);
  await at(deadline);
  expect(await expire(input)).toEqual(zero);
  await expect(expire({ ...input, sourceId: b })).rejects.toThrow(
    'identity conflict',
  );
  const conflictingAmount = { ...input, amount: 50 };
  await expect(expire(conflictingAmount)).rejects.toThrow();
  expect((await expire(command(a))).amount).toBe(100);
});
it('retains one extension and expires original and restored buckets independently', async () => {
  const id = await source();
  const debit = await spend();
  await at(deadline);
  const returned = await restore(debit.redemptionId);
  await conserved();
  const first = await expire(command(id));
  expect(first.entries.map((e) => e.bucket)).toEqual(['ORIGINAL']);
  expect(first.amount).toBe(40);
  await at(returned.funding[0].expiresAt);
  const second = await expire(command(id));
  expect(second.entries[0]).toMatchObject({
    bucket: 'EXTENDED',
    amount: 60,
    deadline: returned.funding[0].expiresAt,
    creditWatermark: 60n,
  });
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    remaining: 0,
    expired: 100n,
    extendedExpired: 60n,
  });
  await conserved();
});
it('retires both due buckets in one operation without changing either deadline', async () => {
  const id = await source();
  const debit = await spend();
  await at(deadline);
  const returned = await restore(debit.redemptionId);
  await at(late);
  const result = await expire(command(id));
  expect(result.amount).toBe(100);
  expect(result.entries).toHaveLength(2);
  expect(result.entries.find((e) => e.bucket === 'ORIGINAL')?.deadline).toEqual(
    deadline,
  );
  expect(result.entries.find((e) => e.bucket === 'EXTENDED')?.deadline).toEqual(
    returned.funding[0].expiresAt,
  );
  await conserved();
});
it('preserves pre-expiry restoration credits and never restores original expired residue', async () => {
  const id = await source();
  const debit = await spend();
  await restore(debit.redemptionId);
  await conserved();
  await at(deadline);
  expect((await expire(command(id))).entries[0]).toMatchObject({
    amount: 100,
    creditWatermark: 60n,
  });
  expect(await prisma.pointSourceExtension.count()).toBe(0);
  await conserved();
});
it('allows expiry then restoration in the same caller transaction', async () => {
  const id = await source();
  const debit = await spend();
  await at(deadline);
  const returned = await prisma.$transaction(async (tx) => {
    await expireSourcePoints(tx, command(id));
    return restorePoints(tx, {
      userId,
      restorationId: randomUUID(),
      redemptionId: debit.redemptionId,
    });
  });
  const available = await prisma.$transaction((tx) =>
    getPointsAvailability(tx, { userId }),
  );
  expect(available).toMatchObject({
    accountingRemainder: 60n,
    spendable: 60n,
    unavailable: 0n,
    nextExpiry: returned.funding[0].expiresAt,
  });
  await conserved();
});
it('accounts spend restore extended spend expiry and later restore without reviving old credit', async () => {
  const id = await source();
  const firstDebit = await spend();
  await conserved();
  await at(deadline);
  const returned = await restore(firstDebit.redemptionId);
  await conserved();
  const secondDebit = await spend(30);
  await conserved();
  await at(late);
  const input = command(id);
  const first = await expire(input);
  expect(first.amount).toBe(70);
  await conserved();
  await restore(secondDebit.redemptionId);
  await conserved();
  const available = await prisma.$transaction((tx) =>
    getPointsAvailability(tx, { userId }),
  );
  expect(available).toMatchObject({
    accountingRemainder: 30n,
    spendable: 0n,
    unavailable: 30n,
  });
  expect(await expire(input)).toEqual(first);
  const next = await expire(command(id));
  expect(next.entries).toEqual([
    expect.objectContaining({
      bucket: 'EXTENDED',
      amount: 30,
      creditWatermark: 90n,
      deadline: returned.funding[0].expiresAt,
    }),
  ]);
  expect(await prisma.pointSourceExtension.count()).toBe(1);
  await conserved();
});
it('rolls back entries counters and header together', async () => {
  const id = await source();
  await at(deadline);
  const input = command(id);
  await expect(
    prisma.$transaction(async (tx) => {
      await expireSourcePoints(tx, input);
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  expect(await prisma.pointExpiryOperation.count()).toBe(0);
  expect(await prisma.pointExpiryEntry.count()).toBe(0);
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    remaining: 100,
    expired: 0n,
  });
  expect((await expire(input)).amount).toBe(100);
});

it('cannot retire another source when ON CONFLICT skips a colliding global evidence ID', async () => {
  const firstSource = await source();
  const secondSource = await source();
  await at(deadline);
  const first = await expire(command(firstSource));
  const operationId = randomUUID();
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO point_expiry_operations(user_id,operation_id,source_id,decision_at,amount)
      VALUES (${userId}::uuid,${operationId}::uuid,${secondSource}::uuid,${deadline},100)`;
      await tx.$executeRaw`INSERT INTO point_expiry_entries(id,user_id,operation_id,source_id,bucket,amount,deadline,credit_watermark)
      VALUES (${first.entries[0].id}::uuid,${userId}::uuid,${operationId}::uuid,${secondSource}::uuid,'ORIGINAL',100,${deadline},0)
      ON CONFLICT DO NOTHING`;
    }),
  ).rejects.toThrow('incomplete');
  expect(
    await prisma.pointSource.findUnique({
      where: { userId_sourceId: { userId, sourceId: secondSource } },
    }),
  ).toMatchObject({ remaining: 100, expired: 0n });
  expect(await prisma.pointExpiryEntry.count()).toBe(1);
  await conserved();
});
it('keeps ledger profile processed events and other active accounting unchanged', async () => {
  const id = await source();
  const profile = await prisma.loyaltyProfile.findUnique({ where: { userId } });
  const counts = await Promise.all([
    prisma.pointsTransaction.count(),
    prisma.processedEvent.count(),
    prisma.outboxEvent.count(),
    prisma.achievementDispatchIntent.count(),
    prisma.goldUpgradeReservation.count(),
  ]);
  await at(deadline);
  await expire(command(id));
  expect(await prisma.loyaltyProfile.findUnique({ where: { userId } })).toEqual(
    profile,
  );
  expect(
    await Promise.all([
      prisma.pointsTransaction.count(),
      prisma.processedEvent.count(),
      prisma.outboxEvent.count(),
      prisma.achievementDispatchIntent.count(),
      prisma.goldUpgradeReservation.count(),
    ]),
  ).toEqual(counts);
});
it('rejects missing profiles cross-user source identities and nontransaction clients', async () => {
  const id = await source();
  await at(deadline);
  const other = randomUUID();
  await prisma.loyaltyProfile.create({ data: { userId: other } });
  await expect(expire({ ...command(id), userId: other })).rejects.toThrow(
    'source not found',
  );
  await expect(
    expire({ ...command(id), userId: randomUUID() }),
  ).rejects.toThrow('profile not found');
  await expect(expireSourcePoints(prisma, command(id))).rejects.toThrow(
    'Interactive transaction required',
  );
  await expect(
    prisma.$transaction((tx) => expireSourcePoints(tx, command(id)), {
      isolationLevel: 'RepeatableRead',
    }),
  ).rejects.toThrow('Read committed');
});
it('handles the maximum int32 bucket without precision loss', async () => {
  const id = await source(2147483647);
  await at(deadline);
  expect((await expire(command(id))).amount).toBe(2147483647);
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    expired: 2147483647n,
    remaining: 0,
  });
  await conserved();
});
it('conserves cumulative bigint credit beyond int32 through actual spend restore cycles', async () => {
  const id = await source(2147483647);
  for (let i = 0; i < 2; i++) {
    const debit = await spend(2147483647);
    await restore(debit.redemptionId);
    await conserved();
  }
  await at(deadline);
  const result = await expire(command(id));
  expect(result.entries[0].creditWatermark).toBe(4294967294n);
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    spent: 4294967294n,
    restored: 4294967294n,
    expired: 2147483647n,
  });
  await conserved();
});
it('never counts future extended credits as original when the fixture clock moves backward', async () => {
  const id = await source();
  const debit = await spend();
  await at(deadline);
  await restore(debit.redemptionId);
  await at(before);
  expect(
    await prisma.$transaction((tx) => getPointsAvailability(tx, { userId })),
  ).toMatchObject({
    originalAvailable: 40n,
    extendedAvailable: 0n,
    unavailable: 60n,
  });
  await spend(40);
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    remaining: 60,
    extendedRemaining: 60,
  });
  await at(late);
  expect((await expire(command(id))).amount).toBe(60);
  await conserved();
});

/** Supplies complete valid headers so negative entry fixtures exercise the intended guard. */
async function rawEntry(
  sourceId: string,
  patch: {
    amount?: number;
    deadline?: Date;
    watermark?: bigint;
    userId?: string;
  } = {},
) {
  return prisma.$transaction(async (tx) => {
    const operationId = randomUUID();
    await tx.$executeRaw`INSERT INTO point_expiry_operations(user_id,operation_id,source_id,decision_at,amount) VALUES (${userId}::uuid,${operationId}::uuid,${sourceId}::uuid,${deadline},100)`;
    await tx.$executeRaw`INSERT INTO point_expiry_entries(id,user_id,operation_id,source_id,bucket,amount,deadline,credit_watermark) VALUES (${randomUUID()}::uuid,${patch.userId ?? userId}::uuid,${operationId}::uuid,${sourceId}::uuid,'ORIGINAL',${patch.amount ?? 100},${patch.deadline ?? deadline},${patch.watermark ?? 0n})`;
  });
}
it.each([
  ['partial amount', { amount: 99 }],
  ['incorrect deadline', { deadline: before }],
  ['unbacked credit frontier', { watermark: 1n }],
])(
  'rejects raw SQL %s even with a valid operation and all referenced facts',
  async (_name, patch) => {
    const id = await source();
    await at(deadline);
    await expect(rawEntry(id, patch)).rejects.toThrow('full due bucket');
    expect(await prisma.pointSource.findFirst()).toMatchObject({
      remaining: 100,
      expired: 0n,
    });
  },
);
it('rejects raw SQL cross-user entries without retiring another user source', async () => {
  const id = await source();
  await at(deadline);
  const other = randomUUID();
  await prisma.loyaltyProfile.create({ data: { userId: other } });
  await expect(rawEntry(id, { userId: other })).rejects.toThrow(
    'point_expiry_entries_user_id_operation_id_source_id_fkey',
  );
  await conserved();
});
it('rejects direct counter updates balanced unbacked retirement and fake initial counters', async () => {
  const id = await source();
  await at(deadline);
  await expect(
    prisma.$executeRaw`UPDATE point_sources SET remaining=0,expired=100 WHERE user_id=${userId}::uuid AND source_id=${id}::uuid`,
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$executeRaw`INSERT INTO point_sources(user_id,source_id,source_ref,granted,remaining,issued_at,original_expires_at,expired) VALUES (${userId}::uuid,${randomUUID()}::uuid,'fake',100,0,${issuedAt},${deadline},100)`,
  ).rejects.toThrow('initial expiry');
  await expect(
    prisma.$executeRaw`UPDATE point_sources SET remaining=0 WHERE user_id=${userId}::uuid AND source_id=${id}::uuid`,
  ).rejects.toThrow('conservation');
  await expect(
    prisma.$executeRaw`INSERT INTO point_expiry_operations(user_id,operation_id,source_id,decision_at,amount,applied) VALUES (${userId}::uuid,${randomUUID()}::uuid,${id}::uuid,${deadline},100,100)`,
  ).rejects.toThrow('snapshot mismatch');
});
it('rejects mutually compensating nonzero initial spent and restored totals', async () => {
  const sourceId = randomUUID();
  await expect(
    prisma.$executeRaw`INSERT INTO point_sources(user_id,source_id,source_ref,granted,remaining,issued_at,original_expires_at,spent,restored)
      VALUES (${userId}::uuid,${sourceId}::uuid,${sourceId},100,100,${issuedAt},${deadline},10,10)`,
  ).rejects.toThrow('initial source totals must be zero');
  expect(await prisma.pointSource.count()).toBe(0);
});
it('rejects mutually compensating nonzero initial extended spent and restored totals', async () => {
  const sourceId = randomUUID();
  await expect(
    prisma.$executeRaw`INSERT INTO point_sources(user_id,source_id,source_ref,granted,remaining,issued_at,original_expires_at,extended_spent,extended_restored)
      VALUES (${userId}::uuid,${sourceId}::uuid,${sourceId},100,100,${issuedAt},${deadline},10,10)`,
  ).rejects.toThrow('initial source totals must be zero');
  expect(await prisma.pointSource.count()).toBe(0);
});
it('rejects incomplete forged zero and oversized operation totals', async () => {
  const id = await source();
  await at(deadline);
  for (const amount of [0, 99, 101])
    await expect(
      prisma.$executeRaw`INSERT INTO point_expiry_operations(user_id,operation_id,source_id,decision_at,amount) VALUES (${userId}::uuid,${randomUUID()}::uuid,${id}::uuid,${deadline},${amount})`,
    ).rejects.toThrow('snapshot mismatch');
  await expect(
    prisma.$executeRaw`INSERT INTO point_expiry_operations(user_id,operation_id,source_id,decision_at,amount) VALUES (${userId}::uuid,${randomUUID()}::uuid,${id}::uuid,${deadline},100)`,
  ).rejects.toThrow('incomplete');
});
it('keeps operation entry source funding and restoration facts immutable', async () => {
  const id = await source();
  const debit = await spend();
  await at(deadline);
  await restore(debit.redemptionId);
  const result = await expire(command(id));
  const entry = result.entries[0];
  await expect(
    prisma.$executeRaw`UPDATE point_expiry_operations SET source_id=${randomUUID()}::uuid WHERE user_id=${userId}::uuid`,
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$executeRaw`UPDATE point_expiry_entries SET deadline=${late} WHERE id=${entry.id}::uuid`,
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$executeRaw`DELETE FROM point_expiry_entries WHERE id=${entry.id}::uuid`,
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$executeRaw`UPDATE point_funding SET amount=1 WHERE user_id=${userId}::uuid`,
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$executeRaw`UPDATE point_restoration_splits SET expires_at=${late} WHERE user_id=${userId}::uuid`,
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$executeRaw`UPDATE point_sources SET original_expires_at=${late} WHERE user_id=${userId}::uuid`,
  ).rejects.toThrow('immutable');
  await conserved();
});

/**
 * Holds a real profile lock until pg_stat_activity confirms all callers wait.
 * The optional clock change proves decisions use time after lock acquisition.
 */
async function blocked(
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
    const until = Date.now() + 5000;
    let waiting = 0;
    while (Date.now() < until) {
      const rows = await pool.query<{ count: number }>(
        "SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%' AND pid<>pg_backend_pid()",
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
it('serializes competing expiry identities and exact replays at a PostgreSQL barrier', async () => {
  const id = await source();
  await at(deadline);
  const input = command(id);
  const results = await blocked([
    () => expire(input),
    () => expire(input),
    () => expire(command(id)),
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  expect(results[0]).toEqual(results[1]);
  expect(await prisma.pointExpiryEntry.count()).toBe(1);
  await conserved();
});
it('serializes expiry against redemption at the exact deadline', async () => {
  const id = await source();
  await at(deadline);
  const results = await blocked([() => expire(command(id)), () => spend(100)]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1].status).toBe('rejected');
  expect(results[1]).toMatchObject({
    status: 'rejected',
    reason: expect.objectContaining({
      message: 'Insufficient allocated points',
    }),
  });
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    remaining: 0,
    expired: 100n,
    spent: 0n,
  });
  await conserved();
});
it('serializes expiry against restoration without losing either bucket', async () => {
  const id = await source();
  const debit = await spend();
  await at(deadline);
  const results = await blocked([
    () => expire(command(id)),
    () => restore(debit.redemptionId),
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  expect(await prisma.pointSource.findFirst()).toMatchObject({
    remaining: 60,
    extendedRemaining: 60,
    expired: 40n,
    restored: 60n,
  });
  await conserved();
});
it('reads the expiry clock only after the blocked profile lock is acquired', async () => {
  const id = await source();
  const results = await blocked([() => expire(command(id))], () =>
    at(deadline),
  );
  expect(results[0]).toMatchObject({
    status: 'fulfilled',
    value: { decisionAt: deadline, amount: 100 },
  });
  await conserved();
});

/** Bounded fixtures use actual issuance and preserve the source zero-counter guard. */
async function sources(count: number) {
  await prisma.$transaction(
    async (tx) => {
      for (let i = 1; i <= count; i++) {
        const sourceId = `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
        await issuePointsSource(tx, {
          userId,
          sourceId,
          sourceRef: sourceId,
          amount: 1,
          issuedAt,
          originalExpiresAt: deadline,
        });
      }
    },
    { timeout: 60000 },
  );
}
it.each([500, 501, 1001])(
  'restarts bounded source batches across %s sources',
  async (count) => {
    await sources(count);
    await at(deadline);
    let afterSourceId: string | undefined;
    let total = 0;
    const seen = new Set<string>();
    do {
      const page = await prisma.$transaction(
        (tx) => expirePointsBatch(tx, { userId, afterSourceId }),
        { timeout: 60000 },
      );
      expect(page.operations.length).toBeLessThanOrEqual(500);
      for (const operation of page.operations) {
        expect(seen.has(operation.sourceId)).toBe(false);
        seen.add(operation.sourceId);
        total += operation.amount;
        expect(operation.decisionAt).toEqual(page.decisionAt);
      }
      afterSourceId = page.nextSourceId ?? undefined;
    } while (afterSourceId);
    expect(total).toBe(count);
    expect(seen.size).toBe(count);
    expect(await prisma.pointExpiryEntry.count()).toBe(count);
    await conserved();
  },
);
it('rolls back interrupted pages and resumes committed partial pages', async () => {
  await sources(5);
  await at(deadline);
  const first = await prisma.$transaction((tx) =>
    expirePointsBatch(tx, { userId, limit: 2 }),
  );
  await expect(
    prisma.$transaction(async (tx) => {
      await expirePointsBatch(tx, {
        userId,
        afterSourceId: first.nextSourceId ?? undefined,
        limit: 2,
      });
      throw new Error('interrupt');
    }),
  ).rejects.toThrow('interrupt');
  expect(await prisma.pointExpiryEntry.count()).toBe(2);
  const resumed = await prisma.$transaction((tx) =>
    expirePointsBatch(tx, {
      userId,
      afterSourceId: first.nextSourceId ?? undefined,
      limit: 2,
    }),
  );
  expect(resumed.operations).toHaveLength(2);
  const last = await prisma.$transaction((tx) =>
    expirePointsBatch(tx, {
      userId,
      afterSourceId: resumed.nextSourceId ?? undefined,
      limit: 2,
    }),
  );
  expect(last.operations).toHaveLength(1);
  expect(last.nextSourceId).toBeNull();
  await conserved();
});

it('safely advances after a lost acknowledgement replays an already committed page cursor', async () => {
  await sources(5);
  await at(deadline);
  const input = {
    userId,
    afterSourceId: '00000000-0000-4000-8000-000000000000',
    limit: 2,
  };
  const first = await prisma.$transaction((tx) => expirePointsBatch(tx, input));
  const retried = await prisma.$transaction((tx) =>
    expirePointsBatch(tx, input),
  );
  expect(first.operations).toHaveLength(2);
  expect(retried.operations).toHaveLength(2);
  const firstIds = new Set(
    first.operations.map((operation) => operation.sourceId),
  );
  expect(
    retried.operations.every((operation) => !firstIds.has(operation.sourceId)),
  ).toBe(true);
  const tail = await prisma.$transaction((tx) =>
    expirePointsBatch(tx, {
      userId,
      afterSourceId: retried.nextSourceId ?? undefined,
      limit: 2,
    }),
  );
  expect(tail.operations).toHaveLength(1);
  expect(tail.nextSourceId).toBeNull();
  expect(await prisma.pointExpiryEntry.count()).toBe(5);
  expect(
    (await prisma.$transaction((tx) => expirePointsBatch(tx, input)))
      .operations,
  ).toEqual([]);
  await conserved();
});
it('looks behind the cursor when exactly 500 forward candidates hide late restored credit', async () => {
  const id = await source(100, '00000000-0000-4000-8000-000000000000');
  const debit = await spend(30);
  const secondDebit = await spend(30);
  await at(deadline);
  await restore(debit.redemptionId);
  await at(late);
  const first = await expire(command(id));
  expect(first.amount).toBe(70);
  await restore(secondDebit.redemptionId);
  const cursor = '00000000-0000-4000-8000-000000000000';
  await sources(500);
  const page = await prisma.$transaction(
    (tx) => expirePointsBatch(tx, { userId, afterSourceId: cursor }),
    { timeout: 60000 },
  );
  expect(page.operations).toHaveLength(500);
  expect(page.nextSourceId).not.toBeNull();
  const tail = await prisma.$transaction((tx) =>
    expirePointsBatch(tx, {
      userId,
      afterSourceId: page.nextSourceId ?? undefined,
    }),
  );
  expect(tail.operations.reduce((sum, op) => sum + op.amount, 0)).toBe(30);
  await conserved();
});
