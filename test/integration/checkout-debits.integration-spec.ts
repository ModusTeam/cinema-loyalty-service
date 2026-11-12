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
    'CREATE TABLE checkout_test_clock (now timestamptz(3) NOT NULL)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now FROM checkout_test_clock $$',
  );
});
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE point_sources, point_redemptions, points_transactions, processed_events, loyalty_profiles, checkout_test_clock CASCADE`;
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
  await prisma.$executeRaw`INSERT INTO checkout_test_clock VALUES (${before})`;
});
afterAll(async () => {
  if (!prisma) return;
  await prisma.$executeRawUnsafe(
    'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp()::timestamptz(3) $$',
  );
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS checkout_test_clock');
  await prisma.$disconnect();
  await observer.end();
});

function debit(
  tx: Prisma.TransactionClient,
  command = input,
): Promise<PointCommandResult> {
  return accounting.debitCheckoutPoints(tx, command);
}
function run(command = input) {
  return prisma.$transaction((tx) => debit(tx, command));
}
async function at(time: Date) {
  await prisma.$executeRaw`UPDATE checkout_test_clock SET now = ${time}`;
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

it('commits one source, ledger, checkout binding, historical command result and balance together', async () => {
  const id = await source();
  expect(await run()).toEqual({
    success: true,
    balanceAfter: 20,
    errorMessage: '',
  });
  const state = await snapshot();
  expect(state.counts).toEqual({
    ledger: 1n,
    redemptions: 1n,
    funding: 1n,
    commands: 1n,
    checkouts: 1n,
  });
  expect(state.profile).toMatchObject({
    balance: 20,
    lifetimePoints: 200,
    yearPoints: 150,
    yearVisits: 4,
  });
  expect(state.sources).toEqual([{ source_id: id, remaining: 20, spent: 80n }]);
  const row = await binding();
  expect(row).toMatchObject({
    debitRef: row.checkoutDebitId,
    amount: 80,
    points: -80,
    commandEventId: input.idempotencyKey,
    userId,
  });
});
it('funds multiple sources by expiry then UUID with a partial final split', async () => {
  const ids = [randomUUID(), randomUUID()].sort();
  const later = await source(
    40,
    randomUUID(),
    new Date('2026-04-01T00:00:00Z'),
  );
  await source(30, ids[1]);
  await source(30, ids[0]);
  await run({ ...input, amount: 80 });
  const rows = await prisma.$queryRaw<
    Array<{ sourceId: string; amount: number }>
  >`SELECT source_id AS "sourceId", amount FROM point_funding ORDER BY source_id`;
  expect(rows).toEqual(
    [
      { sourceId: ids[0], amount: 30 },
      { sourceId: ids[1], amount: 30 },
      { sourceId: later, amount: 20 },
    ].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  );
});
it('rejects insufficient spendable funds with no writes', async () => {
  await source();
  const original = await snapshot();
  expect(await run({ ...input, amount: 101 })).toMatchObject({
    success: false,
    balanceAfter: 100,
  });
  expect(await snapshot()).toEqual(original);
});
it.each([99, 101])(
  'fails closed on projection mismatch %s rather than reconciling',
  async (balance) => {
    await source();
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { balance },
    });
    const original = await snapshot();
    await expect(run()).rejects.toThrow('Source balance projection mismatch');
    expect(await snapshot()).toEqual(original);
  },
);
it.each([-1, 0, 1])(
  'excludes expired sources at deadline %s ms and compares spendable rather than remainder',
  async (offset) => {
    await source(100, randomUUID(), deadline);
    await at(new Date(deadline.getTime() + offset));
    if (offset < 0)
      expect(await run()).toMatchObject({ success: true, balanceAfter: 20 });
    else {
      await expect(run()).rejects.toThrow('Source balance projection mismatch');
      expect((await snapshot()).counts.ledger).toBe(0n);
    }
  },
);
it('permits unavailable accounting remainder when profile equals spendable', async () => {
  await source();
  await source(77, randomUUID(), new Date('2026-01-15T00:00:00Z'));
  expect(await run()).toMatchObject({ success: true, balanceAfter: 20 });
  const availability = await prisma.$transaction((tx) =>
    accounting.getPointsAvailability(tx, { userId }),
  );
  expect(availability).toMatchObject({
    spendable: 20n,
    accountingRemainder: 97n,
    unavailable: 77n,
  });
});
it.each([-1, 0, 1])(
  'spends extended sources only before their shared deadline %s ms',
  async (offset) => {
    await source();
    const redemptionId = randomUUID();
    await prisma.$transaction((tx) =>
      accounting.redeemPoints(tx, {
        userId,
        redemptionId,
        debitRef: randomUUID(),
        amount: 100,
      }),
    );
    await at(deadline);
    const restoration = await prisma.$transaction((tx) =>
      accounting.restorePoints(tx, {
        userId,
        redemptionId,
        restorationId: randomUUID(),
      }),
    );
    await at(new Date(restoration.funding[0].expiresAt.getTime() + offset));
    if (offset < 0) {
      expect(await run()).toMatchObject({ success: true, balanceAfter: 20 });
      const [row] = await prisma.$queryRaw<
        Array<{ amount: number }>
      >`SELECT extended_amount AS amount FROM point_funding WHERE redemption_id <> ${redemptionId}::uuid`;
      expect(row.amount).toBe(80);
    } else
      await expect(run()).rejects.toThrow('Source balance projection mismatch');
  },
);
it('rolls back every effect when caller aborts after helper success', async () => {
  await source();
  const original = await snapshot();
  await expect(
    prisma.$transaction(async (tx) => {
      await debit(tx);
      throw new Error('caller abort');
    }),
  ).rejects.toThrow('caller abort');
  expect(await snapshot()).toEqual(original);
});
it.each(['points_transactions', 'point_funding', 'processed_events'])(
  'rolls back a real database fault after inserting %s',
  async (table) => {
    await source();
    const original = await snapshot();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION checkout_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'checkout injected fault'; END $$",
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER checkout_test_fail AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION checkout_test_fail()`,
    );
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER checkout_test_fail ON ${table}`,
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION checkout_test_fail()');
    }
    expect(await snapshot()).toEqual(original);
  },
);
it('replays historical success before current balance or expiry and never adds writes', async () => {
  await source();
  const first = await run();
  await at(deadline);
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 3 },
  });
  const saved = await snapshot();
  expect(await run()).toEqual(first);
  expect(await snapshot()).toEqual(saved);
});
it.each(['amount', 'orderId', 'userId'] as const)(
  'rejects conflicting %s under one arbitrary command key',
  async (field) => {
    await source();
    await run();
    const saved = await snapshot();
    const other = randomUUID();
    if (field === 'userId')
      await prisma.loyaltyProfile.create({
        data: { userId: other, balance: 0 },
      });
    const changed =
      field === 'amount'
        ? { ...input, amount: 81 }
        : { ...input, [field]: other };
    expect(await run(changed)).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.IDEMPOTENCY_CONFLICT,
    });
    const state = await snapshot();
    expect(state.counts).toEqual(saved.counts);
    expect(state.sources).toEqual(saved.sources);
  },
);
it('keeps legacy unbound processed-event replay semantics', async () => {
  await prisma.processedEvent.create({
    data: { eventId: input.idempotencyKey },
  });
  expect(await run()).toMatchObject({
    success: false,
    errorMessage: ERROR_MESSAGES.LEGACY_IDEMPOTENCY,
  });
  expect((await snapshot()).counts.ledger).toBe(0n);
});
it.each([0, -1, 1.5, 2147483648, Number.NaN])(
  'rejects invalid int32 amount %s without writes',
  async (amount) => {
    await source();
    const saved = await snapshot();
    expect(await run({ ...input, amount })).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.INVALID_POINT_COMMAND,
    });
    expect(await snapshot()).toEqual(saved);
  },
);
it('retains the existing minimum deduction rule', async () => {
  await source();
  const saved = await snapshot();
  const savedSources = await prisma.pointSource.findMany();
  expect(saved.counts.ledger).toBe(0n);
  for (const amount of [1, 25, 74]) {
    expect(await run({ ...input, amount })).toEqual({
      success: false,
      balanceAfter: 0,
      errorMessage: 'Minimum deduction is 75 points',
    });
    expect(await snapshot()).toEqual(saved);
    expect(await prisma.pointSource.findMany()).toEqual(savedSources);
  }
  expect(await run({ ...input, amount: 75 })).toEqual({
    success: true,
    balanceAfter: 25,
    errorMessage: '',
  });
});
it('accepts the largest positive int32 debit without overflow', async () => {
  await prisma.loyaltyProfile.update({
    where: { userId },
    data: { balance: 2147483647 },
  });
  await source(2147483647);
  expect(await run({ ...input, amount: 2147483647 })).toMatchObject({
    success: true,
    balanceAfter: 0,
  });
  expect((await binding()).points).toBe(-2147483647);
});
it('requires caller-owned READ COMMITTED and an existing locked profile', async () => {
  await source();
  await expect(debit(prisma)).rejects.toThrow(
    'Interactive transaction required',
  );
  await expect(
    prisma.$transaction((tx) => debit(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    }),
  ).rejects.toThrow('Read committed transaction required');
  await expect(run({ ...input, userId: randomUUID() })).rejects.toThrow(
    'Loyalty profile not found',
  );
  expect((await snapshot()).counts.ledger).toBe(0n);
});
it('preserves legacy debit-linked full refund and duplicate protection', async () => {
  await source();
  await run();
  const module = await Test.createTestingModule({
    providers: [
      LoyaltyExpirationService,
      { provide: PrismaService, useValue: prisma },
      { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: {} },
    ],
  }).compile();
  try {
    const service = module.get(LoyaltyExpirationService);
    expect(
      await service.refundPoints(userId, 80, input.orderId, 'refund'),
    ).toMatchObject({ success: true, balanceAfter: 100 });
    expect(
      await service.refundPoints(userId, 80, input.orderId, 'another-refund'),
    ).toMatchObject({
      success: false,
      errorMessage: ERROR_MESSAGES.REFUND_ALREADY_COMPENSATED,
    });
  } finally {
    await module.close();
  }
  // This dormant debit does not activate source-linked refund orchestration.
  expect((await snapshot()).sources).toEqual([
    expect.objectContaining({ remaining: 20 }),
  ]);
});
it('creates no outbox, achievement, grant or admin effects', async () => {
  await source();
  const beforeCounts =
    await prisma.$queryRaw`SELECT (SELECT count(*) FROM outbox_events) AS outbox,(SELECT count(*) FROM achievement_dispatch_intents) AS intents,(SELECT count(*) FROM user_bonus_grants) AS grants,(SELECT count(*) FROM user_achievements) AS achievements`;
  await run();
  expect(
    await prisma.$queryRaw`SELECT (SELECT count(*) FROM outbox_events) AS outbox,(SELECT count(*) FROM achievement_dispatch_intents) AS intents,(SELECT count(*) FROM user_bonus_grants) AS grants,(SELECT count(*) FROM user_achievements) AS achievements`,
  ).toEqual(beforeCounts);
});

async function waitBlocked(count: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await observer.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%' AND pid<>pg_backend_pid()",
    );
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Profile lock barrier not reached');
}
it('serializes competing debits on a PostgreSQL lock barrier', async () => {
  await source();
  const blocker = await observer.connect();
  await blocker.query('BEGIN');
  await blocker.query(
    'SELECT 1 FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
    [userId],
  );
  const one = run();
  const two = run({
    ...input,
    idempotencyKey: 'second',
    orderId: randomUUID(),
  });
  try {
    await waitBlocked(2);
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const results = await Promise.all([one, two]);
  expect(results.filter((r) => r.success)).toHaveLength(1);
  expect((await snapshot()).profile.balance).toBe(20);
  expect((await snapshot()).counts.redemptions).toBe(1n);
});
it('does not block independent profiles behind another profile lock', async () => {
  await source();
  const other = randomUUID();
  await prisma.loyaltyProfile.create({ data: { userId: other, balance: 100 } });
  await source(100, randomUUID(), deadline, other);
  const blocker = await observer.connect();
  await blocker.query('BEGIN');
  await blocker.query(
    'SELECT 1 FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
    [userId],
  );
  const pending = run();
  try {
    await waitBlocked(1);
    expect(
      await run({ ...input, userId: other, idempotencyKey: 'independent' }),
    ).toMatchObject({ success: true, balanceAfter: 20 });
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  expect(await pending).toMatchObject({ success: true });
});
it('serializes source expiry with a waiting debit and rejects stale projection', async () => {
  const sourceId = await source();
  await at(deadline);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const expiry = prisma.$transaction(
    async (tx) => {
      await accounting.expireSourcePoints(tx, {
        userId,
        sourceId,
        operationId: randomUUID(),
      });
      locked();
      await gate;
    },
    { timeout: 15000 },
  );
  await ready;
  const pending = run();
  const rejection = expect(pending).rejects.toThrow(
    'Source balance projection mismatch',
  );
  try {
    await waitBlocked(1);
  } finally {
    release();
  }
  await expiry;
  await rejection;
  expect((await snapshot()).counts.ledger).toBe(0n);
  expect((await snapshot()).sources).toEqual([
    expect.objectContaining({ remaining: 0 }),
  ]);
});

it.each([
  'user',
  'amount',
  'positive',
  'type',
  'debitRef',
  'command',
  'commandUser',
  'order',
  'balance',
] as const)(
  'database rejects a forged checkout binding: %s',
  async (mismatch) => {
    await source();
    const other = randomUUID();
    const ledger = await prisma.pointsTransaction.create({
      data: {
        userId: mismatch === 'user' ? other : userId,
        type: mismatch === 'type' ? 'REFUND' : 'BURN_DISCOUNT',
        points:
          mismatch === 'amount' ? -81 : mismatch === 'positive' ? 80 : -80,
        balanceAfter: 20,
        orderId: input.orderId,
      },
    });
    await prisma.checkoutDebit.create({ data: { debitId: ledger.id } });
    await prisma.processedEvent.create({
      data: {
        eventId: input.idempotencyKey,
        operation: mismatch === 'command' ? 'REFUND' : 'DEDUCT',
        userId: mismatch === 'commandUser' ? other : userId,
        amount: 80,
        orderId: mismatch === 'order' ? randomUUID() : input.orderId,
        balanceAfter: mismatch === 'balance' ? 39 : 20,
      },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO point_redemptions (user_id,redemption_id,debit_ref,amount,spent_at,checkout_debit_id,command_event_id) VALUES (${userId}::uuid,${randomUUID()}::uuid,${mismatch === 'debitRef' ? randomUUID() : ledger.id}::uuid,80,${before},${ledger.id}::uuid,${input.idempotencyKey})`;
      }),
    ).rejects.toThrow('Checkout debit binding mismatch');
    expect((await snapshot()).counts.redemptions).toBe(0n);
  },
);
it.each(['checkout_debit_id', 'command_event_id', 'debit_ref'] as const)(
  'prevents changing immutable %s after binding',
  async (field) => {
    await source();
    await run();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE point_redemptions SET ${field} = NULL`),
    ).rejects.toThrow('immutable');
  },
);
it.each([
  'id',
  'points',
  'user_id',
  'type',
  'balance_after',
  'order_id',
] as const)(
  'protects linked ledger %s against later mutation',
  async (field) => {
    await source();
    await run();
    const value =
      field === 'points'
        ? '-59'
        : field === 'balance_after'
          ? '41'
          : field === 'type'
            ? "'REFUND'"
            : `'${randomUUID()}'::uuid`;
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE points_transactions SET ${field} = ${value}`,
      ),
    ).rejects.toThrow('Linked checkout ledger facts are immutable');
  },
);
it('protects the saved command payload used by a bound redemption', async () => {
  await source();
  await run();
  await expect(
    prisma.processedEvent.update({
      where: { eventId: input.idempotencyKey },
      data: { amount: 81 },
    }),
  ).rejects.toThrow('Linked checkout command facts are immutable');
  await expect(
    prisma.processedEvent.delete({ where: { eventId: input.idempotencyKey } }),
  ).rejects.toThrow('Linked checkout command facts are immutable');
});
it('cannot reuse a checkout debit or command key for another redemption', async () => {
  await source();
  await run();
  const row = await binding();
  await expect(
    prisma.$transaction((tx) =>
      accounting.redeemPoints(tx, {
        userId,
        redemptionId: randomUUID(),
        debitRef: row.debitRef,
        amount: 10,
      }),
    ),
  ).rejects.toThrow('identity conflict');
  await expect(
    prisma.$executeRaw`INSERT INTO point_redemptions (user_id,redemption_id,debit_ref,amount,spent_at,checkout_debit_id,command_event_id) VALUES (${userId}::uuid,${randomUUID()}::uuid,${row.debitRef}::uuid,80,${before},${row.checkoutDebitId}::uuid,${input.idempotencyKey})`,
  ).rejects.toThrow();
});
it('keeps standalone redemption and historical checkout rows unbound', async () => {
  await source();
  const redemptionId = randomUUID();
  await prisma.$transaction((tx) =>
    accounting.redeemPoints(tx, {
      userId,
      redemptionId,
      debitRef: randomUUID(),
      amount: 10,
    }),
  );
  const [row] = await prisma.$queryRaw<
    Array<{ checkout: string | null; command: string | null }>
  >`SELECT checkout_debit_id AS checkout,command_event_id AS command FROM point_redemptions`;
  expect(row).toEqual({ checkout: null, command: null });
  const ledger = await prisma.pointsTransaction.create({
    data: { userId, type: 'BURN_DISCOUNT', points: -10, balanceAfter: 90 },
  });
  await prisma.checkoutDebit.create({ data: { debitId: ledger.id } });
  expect(await prisma.checkoutDebit.count()).toBe(1);
});

it('keeps active DeductPoints on its existing projection-only path', async () => {
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
    const service = module.get(LoyaltyService);
    expect(
      await service.deductPoints(
        userId,
        80,
        input.orderId,
        input.idempotencyKey,
      ),
    ).toEqual({ success: true, balanceAfter: 20, errorMessage: '' });
    expect((await snapshot()).counts.redemptions).toBe(0n);
    expect((await snapshot()).counts.checkouts).toBe(1n);
  } finally {
    await module.close();
  }
});
it('uses one cutoff for projection validation and FEFO at an expiry boundary', async () => {
  await source();
  // Advance the test-only clock after each observation: a second decision would
  // see the source expired. The caller must use the first observation throughout.
  await prisma.$executeRawUnsafe(
    "CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$ DECLARE moment timestamptz; BEGIN SELECT now INTO moment FROM checkout_test_clock; UPDATE checkout_test_clock SET now='2026-03-01T00:00:00Z'; RETURN moment; END $$",
  );
  try {
    expect(await run()).toMatchObject({ success: true, balanceAfter: 20 });
  } finally {
    await prisma.$executeRawUnsafe(
      'CREATE OR REPLACE FUNCTION points_decision_time() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now FROM checkout_test_clock $$',
    );
  }
});

it('replays an old successful DEDUCT result without fabricating allocations', async () => {
  await prisma.processedEvent.create({
    data: {
      eventId: input.idempotencyKey,
      operation: 'DEDUCT',
      userId,
      orderId: input.orderId,
      amount: 80,
      balanceAfter: 17,
    },
  });
  const original = await snapshot();
  expect(await run()).toEqual({
    success: true,
    balanceAfter: 17,
    errorMessage: '',
  });
  expect(await snapshot()).toEqual(original);
});
it('fails closed when spendable totals exceed int32 rather than truncating', async () => {
  await source(2147483647);
  await source(1);
  const original = await snapshot();
  await expect(run()).rejects.toThrow('Source balance projection mismatch');
  expect(await snapshot()).toEqual(original);
});
it('serializes expiry after a committed debit without spending the expired remainder twice', async () => {
  const sourceId = await source();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const spending = prisma.$transaction(
    async (tx) => {
      const result = await debit(tx);
      locked();
      await gate;
      return result;
    },
    { timeout: 15000 },
  );
  await ready;
  await at(deadline);
  const expiry = prisma.$transaction((tx) =>
    accounting.expireSourcePoints(tx, {
      userId,
      sourceId,
      operationId: randomUUID(),
    }),
  );
  try {
    await waitBlocked(1);
  } finally {
    release();
  }
  expect(await spending).toMatchObject({ success: true, balanceAfter: 20 });
  expect(await expiry).toMatchObject({ amount: 20 });
  const [row] = await prisma.$queryRaw<
    Array<{ remaining: number; spent: bigint; expired: bigint }>
  >`SELECT remaining,spent,expired FROM point_sources`;
  expect(row).toEqual({ remaining: 0, spent: 80n, expired: 20n });
  expect((await snapshot()).counts.redemptions).toBe(1n);
});
