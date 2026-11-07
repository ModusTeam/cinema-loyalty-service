import { afterAll, beforeAll, beforeEach, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ZodError } from 'zod';
import { ConfigService } from '@nestjs/config';
import { Prisma } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  getPointsAvailability,
  getPointsAvailabilityPage,
  issuePointsSource,
  redeemPoints,
  restorePoints,
} from 'src/loyalty/points-allocation';

let prisma: PrismaService;
let pool: Pool;
let userId: string;
const issuance = new Date('2026-01-01T10:00:00Z');
const beforeExpiry = new Date('2026-02-01T10:00:00Z');
const expiry = new Date('2026-03-01T10:00:00Z');
/** Installs a controlled clock only in the runner's isolated PostgreSQL fixture. */
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
  pool = new Pool({ connectionString: url });
  await prisma.$connect();
  await prisma.$executeRawUnsafe(
    'CREATE TABLE availability_test_clock (now timestamptz(3) NOT NULL, calls integer NOT NULL DEFAULT 0)',
  );
  await installClock();
});
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE point_sources, point_redemptions, loyalty_profiles, availability_test_clock CASCADE`;
  userId = randomUUID();
  await prisma.loyaltyProfile.create({
    data: { userId, balance: 777, lifetimePoints: 888 },
  });
  await prisma.$executeRaw`INSERT INTO availability_test_clock (now) VALUES (${beforeExpiry})`;
});
/** Restores the production clock before other suites execute. */
afterAll(async () => {
  if (prisma) {
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp()::timestamptz(3) $$`,
    );
    await prisma.$executeRawUnsafe(
      'DROP TABLE IF EXISTS availability_test_clock',
    );
    await prisma.$disconnect();
  }
  if (pool) await pool.end();
});
async function installClock() {
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$ DECLARE decision timestamptz; BEGIN UPDATE availability_test_clock SET calls = calls + 1 RETURNING now INTO decision; RETURN decision; END $$`,
  );
}
async function at(now: Date) {
  await prisma.$executeRaw`UPDATE availability_test_clock SET now = ${now} WHERE true`;
}
/** Supplies explicit source dates in a real transaction to exercise eligibility boundaries. */
async function source(
  amount = 100,
  originalExpiresAt = expiry,
  issuedAt = issuance,
) {
  const sourceId = randomUUID();
  await prisma.$transaction((tx) =>
    issuePointsSource(tx, {
      userId,
      sourceId,
      sourceRef: sourceId,
      amount,
      issuedAt,
      originalExpiresAt,
    }),
  );
  return sourceId;
}
/** Creates an independent debit and restoration identity, rather than replaying a prior debit. */
async function spend(amount = 60) {
  const redemptionId = randomUUID();
  await prisma.$transaction((tx) =>
    redeemPoints(tx, { userId, redemptionId, debitRef: randomUUID(), amount }),
  );
  return { userId, restorationId: randomUUID(), redemptionId };
}
async function summary() {
  return prisma.$transaction((tx) => getPointsAvailability(tx, { userId }));
}
async function page(afterSourceId?: string, limit?: number) {
  return prisma.$transaction((tx) =>
    getPointsAvailabilityPage(tx, { userId, afterSourceId, limit }),
  );
}
/** Requires an observed PostgreSQL lock wait, rather than a timing assumption. */
async function waitForReader() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%loyalty_profiles%' AND pid <> pg_backend_pid()`,
    );
    if (result.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Availability reader did not wait for the profile lock');
}
it('returns zero totals without deriving source funding from legacy balance', async () => {
  expect(await summary()).toEqual({
    decisionAt: beforeExpiry,
    accountingRemainder: 0n,
    spendable: 0n,
    unavailable: 0n,
    originalAvailable: 0n,
    extendedAvailable: 0n,
    nextExpiry: null,
  });
  expect(await page()).toEqual({
    decisionAt: beforeExpiry,
    sources: [],
    nextSourceId: null,
  });
});
it('separates current, expired untouched and future-issued source remainders', async () => {
  const later = new Date('2026-04-01T10:00Z');
  const current = await source(40, later);
  const expired = await source(30, beforeExpiry);
  const future = await source(20, expiry, new Date('2026-02-10T10:00Z'));
  expect(await summary()).toEqual({
    decisionAt: beforeExpiry,
    accountingRemainder: 90n,
    spendable: 40n,
    unavailable: 50n,
    originalAvailable: 40n,
    extendedAvailable: 0n,
    nextExpiry: later,
  });
  const rows = (await page()).sources;
  expect(rows.find((row) => row.sourceId === current)).toMatchObject({
    remaining: 40,
    originalAvailable: 40,
    extendedAvailable: 0,
    unavailable: 0,
    effectiveExpiry: later,
    extensionDeadline: null,
  });
  for (const id of [expired, future])
    expect(rows.find((row) => row.sourceId === id)).toMatchObject({
      originalAvailable: 0,
      extendedAvailable: 0,
      effectiveExpiry: null,
    });
});
it('includes issuance equality but excludes original-expiry equality', async () => {
  await source(25, expiry, beforeExpiry);
  expect((await summary()).spendable).toBe(25n);
  await at(expiry);
  expect(await summary()).toMatchObject({
    accountingRemainder: 25n,
    spendable: 0n,
    unavailable: 25n,
    nextExpiry: null,
  });
});
it('ignores zero buckets for next expiry and reports partial remainders', async () => {
  await source(20);
  const later = new Date('2026-04-01T10:00Z');
  await source(50, later);
  await spend(35);
  expect(await summary()).toMatchObject({
    accountingRemainder: 35n,
    spendable: 35n,
    originalAvailable: 35n,
    nextExpiry: later,
  });
});
it('does not revive a pre-expiry restore or open an extension', async () => {
  await source();
  const command = await spend();
  await prisma.$transaction((tx) => restorePoints(tx, command));
  await at(expiry);
  expect(await summary()).toMatchObject({
    accountingRemainder: 100n,
    spendable: 0n,
    unavailable: 100n,
    nextExpiry: null,
  });
  expect((await page()).sources[0].extensionDeadline).toBeNull();
});
it('exposes only post-expiry restored credit and expires it exactly at its saved deadline', async () => {
  await source();
  const command = await spend();
  await at(expiry);
  const restored = await prisma.$transaction((tx) =>
    restorePoints(tx, command),
  );
  const deadline = restored.funding[0].expiresAt;
  expect(await summary()).toMatchObject({
    accountingRemainder: 100n,
    spendable: 60n,
    unavailable: 40n,
    originalAvailable: 0n,
    extendedAvailable: 60n,
    nextExpiry: deadline,
  });
  expect((await page()).sources[0]).toMatchObject({
    remaining: 100,
    originalExpiresAt: expiry,
    extensionDeadline: deadline,
    effectiveExpiry: deadline,
    extendedAvailable: 60,
    unavailable: 40,
  });
  await at(new Date(deadline.getTime() - 1));
  expect((await summary()).spendable).toBe(60n);
  await at(deadline);
  expect(await summary()).toMatchObject({
    accountingRemainder: 100n,
    spendable: 0n,
    unavailable: 100n,
    nextExpiry: null,
  });
  expect((await page()).sources[0]).toMatchObject({
    extensionDeadline: deadline,
    effectiveExpiry: null,
  });
});
it('excludes an extension before opening and preserves expired extension restore evidence', async () => {
  await source();
  const first = await spend(30);
  const second = await spend(20);
  const opened = new Date('2026-03-02T10:00Z');
  await at(opened);
  const restored = await prisma.$transaction((tx) => restorePoints(tx, first));
  const deadline = restored.funding[0].expiresAt;
  await at(expiry);
  expect(await summary()).toMatchObject({ spendable: 0n, nextExpiry: null });
  await at(opened);
  expect((await summary()).extendedAvailable).toBe(30n);
  await at(deadline);
  await prisma.$transaction((tx) => restorePoints(tx, second));
  expect(await summary()).toMatchObject({
    accountingRemainder: 100n,
    spendable: 0n,
    unavailable: 100n,
    nextExpiry: null,
  });
  expect((await page()).sources[0].extensionDeadline).toEqual(deadline);
});
it('agrees with FEFO redemption across original and multiple extended deadlines', async () => {
  const a = await source(30);
  const b = await source(40, new Date('2026-03-02T10:00Z'));
  const first = await spend(30);
  const second = await spend(40);
  await at(expiry);
  await prisma.$transaction((tx) => restorePoints(tx, first));
  await at(new Date('2026-03-02T10:00Z'));
  await prisma.$transaction((tx) => restorePoints(tx, second));
  const c = await source(50, new Date('2026-03-15T10:00Z'));
  expect((await summary()).nextExpiry).toEqual(new Date('2026-03-15T10:00Z'));
  const result = await prisma.$transaction((tx) =>
    redeemPoints(tx, {
      userId,
      redemptionId: randomUUID(),
      debitRef: randomUUID(),
      amount: 90,
    }),
  );
  expect(result.funding).toEqual([
    { sourceId: c, amount: 50 },
    { sourceId: a, amount: 30 },
    { sourceId: b, amount: 10 },
  ]);
  expect(await summary()).toMatchObject({
    spendable: 30n,
    originalAvailable: 0n,
    extendedAvailable: 30n,
  });
});
it.each([
  ['2026-03-01T10:00Z', '2026-03-31T09:00Z'],
  ['2026-10-01T09:00Z', '2026-10-31T10:00Z'],
])(
  'uses the persisted Kyiv DST deadline from restoration at %s',
  async (opened, expected) => {
    await source();
    const command = await spend();
    await at(new Date(opened));
    await prisma.$transaction((tx) => restorePoints(tx, command));
    expect((await summary()).nextExpiry).toEqual(new Date(expected));
    expect((await page()).sources[0].extensionDeadline).toEqual(
      new Date(expected),
    );
  },
);
it('traverses 205 max-int sources in bounded UUID pages and sums exact bigint totals', async () => {
  await prisma.$executeRaw`INSERT INTO point_sources (user_id, source_id, source_ref, granted, remaining, issued_at, original_expires_at) SELECT ${userId}::uuid, gen_random_uuid(), 'batch-' || n, 2147483647, 2147483647, ${issuance}, ${expiry} FROM generate_series(1, 205) n`;
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    expect(result.sources.length).toBeLessThanOrEqual(100);
    ids.push(...result.sources.map((row) => row.sourceId));
    cursor = result.nextSourceId ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(205);
  expect(ids).toEqual([...new Set(ids)].sort());
  const result = await summary();
  expect(result.accountingRemainder).toBe(205n * 2147483647n);
  expect(result.spendable).toBe(result.accountingRemainder);
  expect(typeof result.spendable).toBe('bigint');
});
it('uses one decision time for the entire summary when the DB clock advances between batches', async () => {
  await prisma.$executeRaw`INSERT INTO point_sources (user_id, source_id, source_ref, granted, remaining, issued_at, original_expires_at) SELECT ${userId}::uuid, gen_random_uuid(), 'clock-' || n, 1, 1, ${issuance}, ${expiry} FROM generate_series(1, 101) n`;
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$ DECLARE decision timestamptz; BEGIN UPDATE availability_test_clock SET calls = calls + 1, now = now + interval '1 year' RETURNING now - interval '1 year' INTO decision; RETURN decision; END $$`,
  );
  try {
    expect(await summary()).toMatchObject({
      decisionAt: beforeExpiry,
      spendable: 101n,
      nextExpiry: expiry,
    });
    expect(
      await prisma.$queryRaw`SELECT calls FROM availability_test_clock`,
    ).toEqual([{ calls: 1 }]);
  } finally {
    await installClock();
  }
});
it.each([0, -1, 1.5, 101])('rejects invalid page limit %s', async (limit) => {
  await expect(page(undefined, limit)).rejects.toThrow(ZodError);
});
it('validates cursors and treats another users UUID as a lexical bound without leaking data', async () => {
  await source();
  await expect(page('not-a-uuid')).rejects.toThrow(ZodError);
  const stranger = randomUUID();
  const strangerSource = randomUUID();
  await prisma.loyaltyProfile.create({ data: { userId: stranger } });
  await prisma.$transaction((tx) =>
    issuePointsSource(tx, {
      userId: stranger,
      sourceId: strangerSource,
      sourceRef: 'private',
      amount: 999,
      issuedAt: issuance,
      originalExpiresAt: expiry,
    }),
  );
  const all = (await page()).sources;
  expect((await page(strangerSource)).sources).toEqual(
    all.filter((row) => row.sourceId > strangerSource),
  );
  expect((await page('ffffffff-ffff-4fff-bfff-ffffffffffff')).sources).toEqual(
    [],
  );
});
it('honors limit one and advances the cursor without skipping or repeating sources', async () => {
  const ids = [await source(), await source(), await source()].sort();
  let cursor: string | undefined;
  for (const [index, sourceId] of ids.entries()) {
    const result = await page(cursor, 1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].sourceId).toBe(sourceId);
    expect(result.nextSourceId).toBe(index < ids.length - 1 ? sourceId : null);
    cursor = result.nextSourceId ?? undefined;
  }
  expect((await page(ids[ids.length - 1], 1)).sources).toEqual([]);
});

it('requires an existing profile, an interactive tx and read committed isolation', async () => {
  await expect(getPointsAvailability(prisma, { userId })).rejects.toThrow(
    'Interactive transaction required',
  );
  await expect(getPointsAvailabilityPage(prisma, { userId })).rejects.toThrow(
    'Interactive transaction required',
  );
  const missing = randomUUID();
  await expect(
    prisma.$transaction((tx) => getPointsAvailability(tx, { userId: missing })),
  ).rejects.toThrow('Loyalty profile not found');
  expect(
    await prisma.loyaltyProfile.findUnique({ where: { userId: missing } }),
  ).toBeNull();
  await expect(
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT count(*) FROM point_sources`;
        return getPointsAvailability(tx, { userId });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    ),
  ).rejects.toThrow('Read committed transaction required');
});
it('gives each public page its own decision time and does not reserve subsequent spending', async () => {
  await source(20);
  expect((await page()).decisionAt).toEqual(beforeExpiry);
  await at(expiry);
  expect(await page()).toMatchObject({
    decisionAt: expiry,
    sources: [expect.objectContaining({ originalAvailable: 0 })],
  });
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE availability_test_clock SET now = ${beforeExpiry} WHERE true`;
      expect((await getPointsAvailability(tx, { userId })).spendable).toBe(20n);
      await tx.$executeRaw`UPDATE availability_test_clock SET now = ${expiry} WHERE true`;
      return redeemPoints(tx, {
        userId,
        redemptionId: randomUUID(),
        debitRef: randomUUID(),
        amount: 20,
      });
    }),
  ).rejects.toThrow('Insufficient allocated points');
});
it('samples the DB clock after a real profile-lock wait crossing expiry', async () => {
  await source(20);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query(
    'SELECT id FROM loyalty_profiles WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  const outcome = Promise.allSettled([summary()]);
  try {
    await waitForReader();
    await blocker.query('UPDATE availability_test_clock SET now = $1', [
      expiry,
    ]);
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const [result] = await outcome;
  expect(result.status).toBe('fulfilled');
  if (result.status === 'fulfilled')
    expect(result.value).toMatchObject({
      decisionAt: expiry,
      spendable: 0n,
      unavailable: 20n,
      nextExpiry: null,
    });
});
it('waits for a restoration and sees its whole committed credit and deadline', async () => {
  await source();
  const command = await spend();
  await at(expiry);
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restored = new Promise<void>((resolve) => {
    ready = resolve;
  });
  // The writer retains the profile lock after restoring until the reader is observed waiting.
  const writer = prisma.$transaction(
    async (tx) => {
      const result = await restorePoints(tx, command);
      ready();
      await released;
      return result;
    },
    { timeout: 10000 },
  );
  const writerOutcome = Promise.allSettled([writer]);
  await Promise.race([
    restored,
    writer.then(() => {
      throw new Error('Restoration completed before its barrier');
    }),
  ]);
  const readerOutcome = Promise.allSettled([summary()]);
  try {
    await waitForReader();
  } finally {
    release();
  }
  const [writeResult] = await writerOutcome;
  const [readResult] = await readerOutcome;
  expect(writeResult.status).toBe('fulfilled');
  expect(readResult.status).toBe('fulfilled');
  if (writeResult.status === 'fulfilled' && readResult.status === 'fulfilled')
    expect(readResult.value).toMatchObject({
      accountingRemainder: 100n,
      spendable: 60n,
      extendedAvailable: 60n,
      unavailable: 40n,
      nextExpiry: writeResult.value.funding[0].expiresAt,
    });
});
it('does not mutate legacy profile, ledger, dedupe, outbox or allocation evidence', async () => {
  await source();
  const tables = [
    'loyalty_profiles',
    'points_transactions',
    'processed_events',
    'outbox_events',
    'point_sources',
    'point_redemptions',
    'point_funding',
    'point_restorations',
    'point_restoration_splits',
    'point_source_extensions',
  ];
  const before: unknown[] = [];
  for (const table of tables)
    before.push(
      await prisma.$queryRawUnsafe(
        `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
      ),
    );
  await at(expiry);
  await summary();
  await page();
  for (const [index, table] of tables.entries())
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
      ),
    ).toEqual(before[index]);
});
