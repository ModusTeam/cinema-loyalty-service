import { afterAll, beforeAll, beforeEach, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import * as accounting from 'src/loyalty/points-allocation';
import { PointCommandResult } from 'src/loyalty/point-command-idempotency';
import { LoyaltyExpirationService } from 'src/loyalty/loyalty-expiration.service';
import { Test } from '@nestjs/testing';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { LoyaltyCalculatorService } from 'src/loyalty/loyalty-calculator.service';
import { AchievementsService } from 'src/achievements/achievements.service';
import { EventEmitter2 } from 'eventemitter2';
import {
  ERROR_MESSAGES,
  INJECTION_TOKENS,
} from 'src/loyalty/constants/loyalty.constants';

let prisma: PrismaService;
let observer: Pool;
let userId: string;
let input: {
  userId: string;
  amount: number;
  orderId: string;
  idempotencyKey: string;
};
const issuedAt = new Date('2026-01-01T00:00:00Z');
const before = new Date('2026-02-01T00:00:00Z');
const deadline = new Date('2026-03-01T00:00:00Z');

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
  observer = new Pool({ connectionString: url });
  await prisma.$connect();
  await prisma.$executeRawUnsafe(
    'CREATE TABLE refund_test_clock (now timestamptz(3) NOT NULL)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now FROM refund_test_clock $$',
  );
});
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE point_sources, point_redemptions, points_transactions, processed_events, loyalty_profiles, refund_test_clock CASCADE`;
  userId = randomUUID();
  input = {
    userId,
    amount: 80,
    orderId: randomUUID(),
    idempotencyKey: 'checkout:arbitrary/non-UUID:key',
  };
  await prisma.loyaltyProfile.create({
    data: {
      userId,
      balance: 100,
      lifetimePoints: 200,
      yearPoints: 150,
      yearVisits: 4,
    },
  });
  await prisma.$executeRaw`INSERT INTO refund_test_clock VALUES (${before})`;
});
afterAll(async () => {
  if (!prisma) return;
  await prisma.$executeRawUnsafe(
    'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp()::timestamptz(3) $$',
  );
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS refund_test_clock');
  await prisma.$disconnect();
  await observer.end();
});

function refund(
  tx: Prisma.TransactionClient,
  command = input,
): Promise<PointCommandResult> {
  return accounting.refundCheckoutPoints(tx, command);
}
function run(command = input) {
  return prisma.$transaction((tx) => refund(tx, command));
}
async function at(time: Date) {
  await prisma.$executeRaw`UPDATE refund_test_clock SET now = ${time}`;
}
async function source(
  amount = 100,
  sourceId = randomUUID(),
  expiry = deadline,
  owner = userId,
) {
  await prisma.$transaction((tx) =>
    accounting.issuePointsSource(tx, {
      userId: owner,
      sourceId,
      sourceRef: sourceId,
      amount,
      issuedAt,
      originalExpiresAt: expiry,
    }),
  );
  return sourceId;
}
async function snapshot() {
  const [counts] = await prisma.$queryRaw<
    Array<{
      ledger: bigint;
      redemptions: bigint;
      funding: bigint;
      commands: bigint;
      checkouts: bigint;
    }>
  >`SELECT (SELECT count(*) FROM points_transactions) AS ledger, (SELECT count(*) FROM point_redemptions) AS redemptions, (SELECT count(*) FROM point_funding) AS funding, (SELECT count(*) FROM processed_events) AS commands, (SELECT count(*) FROM checkout_debits) AS checkouts`;
  const profile = await prisma.loyaltyProfile.findUniqueOrThrow({
    where: { userId },
  });
  const sources =
    await prisma.$queryRaw`SELECT source_id, remaining, spent FROM point_sources ORDER BY source_id`;
  return { counts, profile, sources };
}
async function binding() {
  const [row] = await prisma.$queryRaw<
    Array<{
      redemptionId: string;
      debitRef: string;
      checkoutDebitId: string;
      commandEventId: string;
      amount: number;
      points: number;
      userId: string;
    }>
  >`SELECT r.redemption_id AS "redemptionId", r.debit_ref AS "debitRef", r.checkout_debit_id AS "checkoutDebitId", r.command_event_id AS "commandEventId", r.amount, p.points, p.user_id AS "userId" FROM point_redemptions r JOIN points_transactions p ON p.id=r.checkout_debit_id`;
  return row;
}

async function checkout() {
  await source();
  await prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, {
      ...input,
      idempotencyKey: 'original-debit',
    }),
  );
}
it('restores full source funding and commits ledger, binding, projection and command together', async () => {
  await checkout();
  expect(await run()).toEqual({
    success: true,
    balanceAfter: 100,
    errorMessage: '',
  });
  expect((await snapshot()).sources).toEqual([
    expect.objectContaining({ remaining: 100 }),
  ]);
  expect(
    await prisma.pointsTransaction.findMany({ where: { type: 'REFUND' } }),
  ).toEqual([expect.objectContaining({ points: 80, balanceAfter: 100 })]);
});

async function state() {
  return {
    profiles: await prisma.loyaltyProfile.findMany({
      orderBy: { userId: 'asc' },
    }),
    ledger: await prisma.pointsTransaction.findMany({ orderBy: { id: 'asc' } }),
    commands: await prisma.processedEvent.findMany({
      orderBy: { eventId: 'asc' },
    }),
    checkout: await prisma.checkoutDebit.findMany({
      orderBy: { debitId: 'asc' },
    }),
    sources: await prisma.pointSource.findMany({
      orderBy: { sourceId: 'asc' },
    }),
    redemptions: await prisma.pointRedemption.findMany({
      orderBy: { redemptionId: 'asc' },
    }),
    restorations: await prisma.pointRestoration.findMany({
      orderBy: { restorationId: 'asc' },
    }),
    splits: await prisma.pointRestorationSplit.findMany({
      orderBy: { sourceId: 'asc' },
    }),
    extensions: await prisma.pointSourceExtension.findMany({
      orderBy: { sourceId: 'asc' },
    }),
  };
}
async function conserved() {
  const invalid = await prisma.$queryRaw<
    Array<{ source_id: string }>
  >`SELECT source_id FROM point_sources WHERE remaining::bigint+spent+expired<>granted::bigint+restored OR extended_remaining::bigint+extended_spent+extended_expired<>extended_restored`;
  expect(invalid).toEqual([]);
}
it('restores immutable multisource funding instead of allocating again', async () => {
  await source(30);
  await source(70, randomUUID(), new Date('2026-04-01T00:00:00Z'));
  await prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, { ...input, idempotencyKey: 'debit' }),
  );
  const funding = await prisma.pointFunding.findMany({
    orderBy: { sourceId: 'asc' },
  });
  expect(await run()).toMatchObject({ success: true, balanceAfter: 100 });
  const splits = await prisma.pointRestorationSplit.findMany({
    orderBy: { sourceId: 'asc' },
  });
  expect(splits.map(({ sourceId, amount }) => ({ sourceId, amount }))).toEqual(
    funding.map(({ sourceId, amount }) => ({ sourceId, amount })),
  );
  await conserved();
});
it.each([-1, 0, 1])(
  'uses original expiry boundary %s without reviving expired remainder',
  async (offset) => {
    await checkout();
    await at(new Date(deadline.getTime() + offset));
    if (offset >= 0)
      await prisma.loyaltyProfile.update({
        where: { userId },
        data: { balance: 0 },
      });
    expect(await run()).toMatchObject({
      success: true,
      balanceAfter: offset < 0 ? 100 : 80,
    });
    const restoration = await prisma.pointRestoration.findFirstOrThrow();
    const extension = await prisma.pointSourceExtension.findFirst();
    expect(restoration.amount).toBe(80);
    expect(extension === null).toBe(offset < 0);
    expect((await prisma.pointSource.findFirstOrThrow()).remaining).toBe(100);
    await conserved();
  },
);
async function extension() {
  await checkout();
  const redemptionId = randomUUID();
  await prisma.$transaction((tx) =>
    accounting.redeemPoints(tx, {
      userId,
      redemptionId,
      debitRef: randomUUID(),
      amount: 10,
    }),
  );
  await at(deadline);
  const restored = await prisma.$transaction((tx) =>
    accounting.restorePoints(tx, {
      userId,
      redemptionId,
      restorationId: randomUUID(),
    }),
  );
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 10 },
  });
  return restored.funding[0].expiresAt;
}
it.each([-1, 0, 1])(
  'preserves saved source extension at boundary %s, including zero spendable credit',
  async (offset) => {
    const until = await extension();
    const saved = await prisma.pointSourceExtension.findMany();
    await at(new Date(until.getTime() + offset));
    if (offset >= 0)
      await prisma.loyaltyProfile.update({
        where: { userId },
        data: { balance: 0 },
      });
    expect(await run()).toMatchObject({
      success: true,
      balanceAfter: offset < 0 ? 90 : 0,
    });
    expect(await prisma.pointSourceExtension.findMany()).toEqual(saved);
    expect(
      await prisma.pointsTransaction.findFirst({ where: { type: 'REFUND' } }),
    ).toMatchObject({ points: 80, balanceAfter: offset < 0 ? 90 : 0 });
    expect(
      (await prisma.pointRestoration.findMany()).map((r) => r.amount).sort(),
    ).toEqual([10, 80]);
    await conserved();
  },
);
it('replays saved REFUND before changed profile, expiry or restoration availability', async () => {
  await checkout();
  const result = await run();
  await at(new Date('2030-01-01T00:00:00Z'));
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 3 },
  });
  const saved = await state();
  expect(await run()).toEqual(result);
  expect(await state()).toEqual(saved);
});
it('replays historical REFUND without inventing accounting identities', async () => {
  await prisma.processedEvent.create({
    data: {
      eventId: input.idempotencyKey,
      operation: 'REFUND',
      userId,
      orderId: input.orderId,
      amount: input.amount,
      balanceAfter: 7,
    },
  });
  const saved = await state();
  expect(await run()).toEqual({
    success: true,
    balanceAfter: 7,
    errorMessage: '',
  });
  expect(await state()).toEqual(saved);
});
it.each(['userId', 'orderId', 'amount'] as const)(
  'rejects shared-key conflicting %s without writes',
  async (field) => {
    await checkout();
    await run();
    const other = randomUUID();
    if (field === 'userId')
      await prisma.loyaltyProfile.create({ data: { userId: other } });
    const saved = await state();
    const changed =
      field === 'amount'
        ? { ...input, amount: 81 }
        : { ...input, [field]: other };
    expect(await run(changed)).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.IDEMPOTENCY_CONFLICT,
    });
    expect(await state()).toEqual(saved);
  },
);
it('rejects a second key for a compensated debit without writes', async () => {
  await checkout();
  await run();
  const saved = await state();
  expect(
    await run({ ...input, idempotencyKey: 'second-refund' }),
  ).toMatchObject({
    success: false,
    errorMessage: ERROR_MESSAGES.REFUND_ALREADY_COMPENSATED,
  });
  expect(await state()).toEqual(saved);
});
it('rejects generic legacy keys without writes', async () => {
  await checkout();
  await prisma.processedEvent.create({
    data: { eventId: input.idempotencyKey },
  });
  const saved = await state();
  expect(await run()).toMatchObject({
    success: false,
    errorMessage: ERROR_MESSAGES.LEGACY_IDEMPOTENCY,
  });
  expect(await state()).toEqual(saved);
});
it.each([
  'missing',
  'cross-user',
  'amount',
  'ambiguous',
  'unbound',
  'no-checkout',
  'prior-refund',
  'prior-restoration',
] as const)(
  'fails closed for %s ownership without writes',
  async (scenario) => {
    if (scenario !== 'missing') await checkout();
    let command = input;
    if (scenario === 'cross-user') {
      const other = randomUUID();
      await prisma.loyaltyProfile.create({ data: { userId: other } });
      command = { ...input, userId: other };
    }
    if (scenario === 'amount') command = { ...input, amount: 79 };
    if (scenario === 'ambiguous')
      await prisma.pointsTransaction.create({
        data: {
          userId,
          orderId: input.orderId,
          type: 'BURN_DISCOUNT',
          points: -80,
          balanceAfter: 20,
        },
      });
    if (scenario === 'unbound' || scenario === 'no-checkout') {
      await prisma.$executeRaw`TRUNCATE point_sources, point_redemptions, points_transactions, processed_events CASCADE`;
      const ledger = await prisma.pointsTransaction.create({
        data: {
          userId,
          orderId: input.orderId,
          type: 'BURN_DISCOUNT',
          points: -80,
          balanceAfter: 20,
        },
      });
      if (scenario === 'unbound')
        await prisma.checkoutDebit.create({ data: { debitId: ledger.id } });
    }
    if (scenario === 'prior-refund')
      await prisma.pointsTransaction.create({
        data: {
          userId,
          orderId: input.orderId,
          type: 'REFUND',
          points: 80,
          balanceAfter: 100,
        },
      });
    if (scenario === 'prior-restoration') {
      const row = await binding();
      await prisma.$transaction((tx) =>
        accounting.restorePoints(tx, {
          userId,
          redemptionId: row.redemptionId,
          restorationId: randomUUID(),
        }),
      );
    }
    const saved = await state();
    expect(await run(command)).toMatchObject({ success: false });
    expect(await state()).toEqual(saved);
  },
);
it.each([0, -1, 1.5, 2147483648, Number.NaN])(
  'rejects invalid int32 %s without writes',
  async (amount) => {
    await checkout();
    const saved = await state();
    expect(await run({ ...input, amount })).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.INVALID_POINT_COMMAND,
    });
    expect(await state()).toEqual(saved);
  },
);
it('requires matching spendable projection rather than accounting remainder', async () => {
  await checkout();
  await at(deadline);
  const saved = await state();
  await expect(run()).rejects.toThrow('Source balance projection mismatch');
  expect(await state()).toEqual(saved);
});
it('uses exactly one PostgreSQL cutoff across validation, restoration and projection', async () => {
  await checkout();
  await prisma.$executeRawUnsafe(
    "CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$ DECLARE moment timestamptz; BEGIN SELECT now INTO moment FROM refund_test_clock; UPDATE refund_test_clock SET now='2026-03-01T00:00:00Z'; RETURN moment; END $$",
  );
  try {
    expect(await run()).toMatchObject({ success: true, balanceAfter: 100 });
    expect(await prisma.pointSourceExtension.count()).toBe(0);
  } finally {
    await prisma.$executeRawUnsafe(
      'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now FROM refund_test_clock $$',
    );
  }
});
it('requires caller READ COMMITTED transaction and existing profile', async () => {
  await checkout();
  const saved = await state();
  await expect(refund(prisma)).rejects.toThrow(
    'Interactive transaction required',
  );
  await expect(
    prisma.$transaction((tx) => refund(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    }),
  ).rejects.toThrow('Read committed transaction required');
  await expect(run({ ...input, userId: randomUUID() })).rejects.toThrow(
    'Loyalty profile not found',
  );
  expect(await state()).toEqual(saved);
});
it.each([
  'processed_events',
  'points_transactions',
  'point_restorations',
  'point_restoration_splits',
  'loyalty_profiles',
] as const)(
  'rolls back all effects on a real fault after %s',
  async (table) => {
    await checkout();
    const saved = await state();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION refund_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refund injected fault'; END $$",
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER refund_test_fail AFTER ${table === 'loyalty_profiles' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION refund_test_fail()`,
    );
    try {
      await expect(run()).rejects.toThrow('refund injected fault');
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER refund_test_fail ON ${table}`,
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION refund_test_fail()');
    }
    expect(await state()).toEqual(saved);
  },
);
it('rolls back after helper success when the caller aborts', async () => {
  await checkout();
  const saved = await state();
  await expect(
    prisma.$transaction(async (tx) => {
      await refund(tx);
      throw new Error('caller abort');
    }),
  ).rejects.toThrow('caller abort');
  expect(await state()).toEqual(saved);
});
it('restores largest int32 debit without truncation', async () => {
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 2147483647 },
  });
  await source(2147483647);
  await prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, {
      ...input,
      amount: 2147483647,
      idempotencyKey: 'max-debit',
    }),
  );
  expect(await run({ ...input, amount: 2147483647 })).toMatchObject({
    success: true,
    balanceAfter: 2147483647,
  });
  await conserved();
});
it('fails closed when restored spendability would overflow int32', async () => {
  await checkout();
  await source(2147483627);
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 2147483647 },
  });
  const saved = await state();
  await expect(run()).rejects.toThrow('Source balance exceeds int32');
  expect(await state()).toEqual(saved);
});
it('does not create achievement, grant, outbox or qualification effects', async () => {
  await checkout();
  const profile = await prisma.loyaltyProfile.findUniqueOrThrow({
    where: { userId },
  });
  const counts = () =>
    prisma.$queryRaw`SELECT (SELECT count(*) FROM outbox_events) outbox,(SELECT count(*) FROM achievement_dispatch_intents) intents,(SELECT count(*) FROM user_bonus_grants) grants,(SELECT count(*) FROM user_achievements) achievements`;
  const saved = await counts();
  await run();
  expect(await counts()).toEqual(saved);
  expect(
    await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
  ).toEqual({ ...profile, balance: 100, updatedAt: expect.any(Date) });
});
async function waitBlocked(count: number, query = 'loyalty_profiles') {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await observer.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1 AND pid<>pg_backend_pid()",
      [`%${query}%`],
    );
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('PostgreSQL lock barrier not reached');
}
it.each([true, false])(
  'serializes concurrent refunds with same key=%s at a real profile barrier',
  async (sameKey) => {
    await checkout();
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT 1 FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    const one = run();
    const two = run({
      ...input,
      idempotencyKey: sameKey ? input.idempotencyKey : 'different-key',
    });
    try {
      await waitBlocked(2);
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    const results = await Promise.all([one, two]);
    expect(results.filter((r) => r.success)).toHaveLength(sameKey ? 2 : 1);
    expect(await prisma.pointRestoration.count()).toBe(1);
    expect((await snapshot()).profile.balance).toBe(100);
    await conserved();
  },
);
it('loses a cross-profile shared-key claim without committing partial restoration', async () => {
  await checkout();
  const other = randomUUID();
  await prisma.loyaltyProfile.create({ data: { userId: other, balance: 100 } });
  await source(100, randomUUID(), deadline, other);
  const otherCommand = { ...input, userId: other, orderId: randomUUID() };
  await prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, {
      ...otherCommand,
      idempotencyKey: 'other-debit',
    }),
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready = () => {};
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = prisma.$transaction(
    async (tx) => {
      const result = await refund(tx);
      ready();
      await gate;
      return result;
    },
    { timeout: 15000 },
  );
  await locked;
  const second = run(otherCommand);
  try {
    await waitBlocked(1, 'processed_events');
  } finally {
    release();
  }
  expect(await first).toMatchObject({ success: true });
  expect(await second).toMatchObject({
    success: false,
    errorMessage: ERROR_MESSAGES.IDEMPOTENCY_CONFLICT,
  });
  expect(await prisma.pointRestoration.count()).toBe(1);
  expect(
    await prisma.pointSource.findFirst({ where: { userId: other } }),
  ).toMatchObject({ remaining: 20, restored: 0n });
  expect(
    await prisma.loyaltyProfile.findUnique({ where: { userId: other } }),
  ).toMatchObject({ balance: 20 });
  expect(
    await prisma.pointsTransaction.count({ where: { userId: other } }),
  ).toBe(1);
  await conserved();
});
it.each(['refund-first', 'expiry-first'] as const)(
  'serializes refund/expiry: %s',
  async (order) => {
    await checkout();
    await at(deadline);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { balance: 0 },
    });
    const s = await prisma.pointSource.findFirstOrThrow();
    const expire = (tx: Prisma.TransactionClient) =>
      accounting.expireSourcePoints(tx, {
        userId,
        sourceId: s.sourceId,
        operationId: randomUUID(),
      });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = () => {};
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const first = prisma.$transaction(
      async (tx) => {
        if (order === 'refund-first') await refund(tx);
        else await expire(tx);
        ready();
        await gate;
      },
      { timeout: 15000 },
    );
    await locked;
    const second = prisma.$transaction((tx) =>
      order === 'refund-first' ? expire(tx) : refund(tx),
    );
    try {
      await waitBlocked(1);
    } finally {
      release();
    }
    await first;
    await second;
    expect((await snapshot()).profile.balance).toBe(80);
    expect(await prisma.pointSource.findFirst()).toMatchObject({
      remaining: 80,
      extendedRemaining: 80,
      expired: 20n,
      restored: 80n,
    });
    await conserved();
  },
);
it('serializes a debit after refund and conserves source quantities', async () => {
  await checkout();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready = () => {};
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = prisma.$transaction(
    async (tx) => {
      await refund(tx);
      ready();
      await gate;
    },
    { timeout: 15000 },
  );
  await locked;
  const second = prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, {
      ...input,
      orderId: randomUUID(),
      idempotencyKey: 'next-debit',
    }),
  );
  try {
    await waitBlocked(1);
  } finally {
    release();
  }
  await first;
  expect(await second).toMatchObject({ success: true, balanceAfter: 20 });
  await conserved();
});
it.each([
  'refund_ledger_id',
  'command_event_id',
  'amount',
  'restored_at',
] as const)('preserves restoration header immutability: %s', async (field) => {
  await checkout();
  await run();
  const saved = await state();
  const value =
    field === 'amount'
      ? '79'
      : field === 'restored_at'
        ? "'2030-01-01'::timestamptz"
        : 'NULL';
  await expect(
    prisma.$executeRawUnsafe(`UPDATE point_restorations SET ${field}=${value}`),
  ).rejects.toThrow('immutable');
  expect(await state()).toEqual(saved);
});
it.each(['ledger', 'command', 'owner'] as const)(
  'protects bound refund %s facts',
  async (kind) => {
    await checkout();
    await run();
    const saved = await state();
    const operation =
      kind === 'ledger'
        ? prisma.$executeRaw`UPDATE points_transactions SET points=79 WHERE type='REFUND'`
        : kind === 'command'
          ? prisma.processedEvent.update({
              where: { eventId: input.idempotencyKey },
              data: { balanceAfter: 99 },
            })
          : prisma.$executeRaw`UPDATE checkout_debits SET refund_id=NULL`;
    await expect(operation).rejects.toThrow('immutable');
    expect(await state()).toEqual(saved);
  },
);

it('projects a mixed refund with full evidence but only partially spendable credit', async () => {
  await source(40);
  await source(60, randomUUID(), new Date('2026-05-01T00:00:00Z'));
  const earlyRedemption = randomUUID();
  await prisma.$transaction((tx) =>
    accounting.redeemPoints(tx, {
      userId,
      redemptionId: earlyRedemption,
      debitRef: randomUUID(),
      amount: 10,
    }),
  );
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 90 },
  });
  await prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, {
      ...input,
      idempotencyKey: 'mixed-debit',
    }),
  );
  await at(deadline);
  const restored = await prisma.$transaction((tx) =>
    accounting.restorePoints(tx, {
      userId,
      redemptionId: earlyRedemption,
      restorationId: randomUUID(),
    }),
  );
  await at(restored.funding[0].expiresAt);
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 10 },
  });
  expect(await run()).toMatchObject({ success: true, balanceAfter: 60 });
  expect(
    await prisma.pointsTransaction.findFirst({ where: { type: 'REFUND' } }),
  ).toMatchObject({ points: 80, balanceAfter: 60 });
  const h = await prisma.pointRestoration.findFirstOrThrow({
    where: { refundLedgerId: { not: null } },
  });
  expect(h).toMatchObject({ amount: 80, credited: 80 });
  await conserved();
});
it('rejects an ambiguous order with two legitimate source-linked debits', async () => {
  await checkout();
  await source();
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 120 },
  });
  await prisma.$transaction((tx) =>
    accounting.debitCheckoutPoints(tx, {
      ...input,
      idempotencyKey: 'second-debit',
    }),
  );
  const saved = await state();
  expect(await run()).toMatchObject({
    success: false,
    errorMessage: ERROR_MESSAGES.REFUND_RECONCILIATION,
  });
  expect(await state()).toEqual(saved);
});
it.each([
  'user',
  'order',
  'amount',
  'positive',
  'type',
  'balance',
  'command',
  'commandUser',
  'commandOrder',
  'commandAmount',
  'redemption',
] as const)('database rejects forged refund binding: %s', async (mismatch) => {
  await checkout();
  const original = await binding();
  const other = randomUUID();
  const ledger = await prisma.pointsTransaction.create({
    data: {
      userId: mismatch === 'user' ? other : userId,
      orderId: mismatch === 'order' ? other : input.orderId,
      points: mismatch === 'amount' ? 79 : mismatch === 'positive' ? -80 : 80,
      type: mismatch === 'type' ? 'BURN_DISCOUNT' : 'REFUND',
      balanceAfter: 100,
    },
  });
  await prisma.checkoutDebit.update({
    where: { debitId: original.checkoutDebitId },
    data: { refundId: ledger.id },
  });
  await prisma.processedEvent.create({
    data: {
      eventId: input.idempotencyKey,
      operation: mismatch === 'command' ? 'DEDUCT' : 'REFUND',
      userId: mismatch === 'commandUser' ? other : userId,
      orderId: mismatch === 'commandOrder' ? other : input.orderId,
      amount: mismatch === 'commandAmount' ? 79 : 80,
      balanceAfter: mismatch === 'balance' ? 99 : 100,
    },
  });
  const saved = await state();
  await expect(
    prisma.$transaction(
      (
        tx,
      ) => tx.$executeRaw`INSERT INTO point_restorations (user_id,restoration_id,redemption_id,amount,restored_at,refund_ledger_id,command_event_id)
    VALUES (${userId}::uuid,${randomUUID()}::uuid,${mismatch === 'redemption' ? other : original.redemptionId}::uuid,80,${before},${ledger.id}::uuid,${input.idempotencyKey})`,
    ),
  ).rejects.toThrow('Checkout refund binding mismatch');
  expect(await state()).toEqual(saved);
});
it('preserves the nullable binding pair without backfilling standalone restorations', async () => {
  await checkout();
  const original = await binding();
  await prisma.$transaction((tx) =>
    accounting.restorePoints(tx, {
      userId,
      redemptionId: original.redemptionId,
      restorationId: randomUUID(),
    }),
  );
  expect(await prisma.pointRestoration.findFirst()).toMatchObject({
    refundLedgerId: null,
    commandEventId: null,
  });
});
it('keeps active RefundPoints on its legacy projection-only compensation path', async () => {
  await checkout();
  const module = await Test.createTestingModule({
    providers: [
      LoyaltyExpirationService,
      { provide: PrismaService, useValue: prisma },
      { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: {} },
    ],
  }).compile();
  try {
    expect(
      await module
        .get(LoyaltyExpirationService)
        .refundPoints(userId, 80, input.orderId, 'public-refund'),
    ).toEqual({ success: true, balanceAfter: 100, errorMessage: '' });
    expect(await prisma.pointRestoration.count()).toBe(0);
    expect(await prisma.pointSource.findFirst()).toMatchObject({
      remaining: 20,
    });
    const saved = await state();
    expect(await run()).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.REFUND_ALREADY_COMPENSATED,
    });
    expect(await state()).toEqual(saved);
  } finally {
    await module.close();
  }
});
it('keeps active DeductPoints unbound and fails closed for its refund accounting', async () => {
  const module = await Test.createTestingModule({
    providers: [
      LoyaltyService,
      { provide: PrismaService, useValue: prisma },
      LoyaltyCalculatorService,
      { provide: AchievementsService, useValue: {} },
      { provide: EventEmitter2, useValue: new EventEmitter2() },
    ],
  }).compile();
  try {
    expect(
      await module
        .get(LoyaltyService)
        .deductPoints(userId, 80, input.orderId, 'public-debit'),
    ).toMatchObject({ success: true, balanceAfter: 20 });
    expect(await prisma.pointRedemption.count()).toBe(0);
    const saved = await state();
    expect(await run()).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.REFUND_RECONCILIATION,
    });
    expect(await state()).toEqual(saved);
  } finally {
    await module.close();
  }
});

it('rolls back the claim and full restoration if actual availability differs from prediction', async () => {
  await checkout();
  const saved = await state();
  await prisma.$executeRawUnsafe(
    "CREATE FUNCTION refund_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO point_sources(user_id,source_id,source_ref,granted,remaining,issued_at,original_expires_at) VALUES (NEW.user_id,gen_random_uuid(),'injected-extra-source',1,1,'2026-01-01','2026-06-01'); RETURN NEW; END $$",
  );
  await prisma.$executeRawUnsafe(
    'CREATE TRIGGER refund_projection_fault AFTER INSERT ON point_restoration_splits FOR EACH ROW EXECUTE FUNCTION refund_projection_fault()',
  );
  try {
    await expect(run()).rejects.toThrow('Restoration projection mismatch');
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER refund_projection_fault ON point_restoration_splits',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION refund_projection_fault()');
  }
  expect(await state()).toEqual(saved);
});
