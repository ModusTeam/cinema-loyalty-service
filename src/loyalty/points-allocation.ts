import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Prisma } from 'src/generated/prisma/client';
import { lockLoyaltyProfile } from 'src/prisma/profile-transaction';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const amount = z.number().int().positive().max(2147483647);
const sourceSchema = z
  .object({
    userId: uuid,
    sourceId: uuid,
    sourceRef: z.string().min(1).max(128),
    amount,
    issuedAt: z.date(),
    originalExpiresAt: z.date(),
  })
  .refine((value) => value.originalExpiresAt > value.issuedAt);
const redemptionSchema = z.object({
  userId: uuid,
  redemptionId: uuid,
  debitRef: uuid,
  amount,
});
const restorationSchema = z.object({
  userId: uuid,
  restorationId: uuid,
  redemptionId: uuid,
});
const AVAILABILITY_BATCH_SIZE = 100;
const availabilitySchema = z.object({ userId: uuid });
const availabilityPageSchema = availabilitySchema.extend({
  afterSourceId: uuid.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(AVAILABILITY_BATCH_SIZE)
    .default(AVAILABILITY_BATCH_SIZE),
});
export type GetPointsAvailability = z.input<typeof availabilitySchema>;
export type GetPointsAvailabilityPage = z.input<typeof availabilityPageSchema>;
export interface PointsAvailability {
  decisionAt: Date;
  accountingRemainder: bigint;
  spendable: bigint;
  unavailable: bigint;
  originalAvailable: bigint;
  extendedAvailable: bigint;
  nextExpiry: Date | null;
}
export interface PointsSourceAvailability {
  sourceId: string;
  sourceRef: string;
  issuedAt: Date;
  originalExpiresAt: Date;
  extensionDeadline: Date | null;
  remaining: number;
  originalAvailable: number;
  extendedAvailable: number;
  unavailable: number;
  available: number;
  effectiveExpiry: Date | null;
}
export interface PointsAvailabilityPage {
  decisionAt: Date;
  sources: PointsSourceAvailability[];
  nextSourceId: string | null;
}
export type IssuePointsSource = z.input<typeof sourceSchema>;
export type RedeemPoints = z.input<typeof redemptionSchema>;
export type RestorePoints = z.input<typeof restorationSchema>;
export interface RedemptionResult {
  funding: Array<{ sourceId: string; amount: number }>;
}
export interface RestorationResult {
  amount: number;
  restoredAt: Date;
  funding: Array<{ sourceId: string; amount: number; expiresAt: Date }>;
}

type SourceRow = {
  sourceId: string;
  sourceRef: string;
  granted: number;
  remaining: number;
  issuedAt: Date;
  originalExpiresAt: Date;
};
type RedemptionRow = { debitRef: string; amount: number };

// These operations require the caller's transaction. They deliberately do not
// modify the legacy balance, ledger, command keys, or any external service.
/** Requires a live caller transaction so the profile lock survives subsequent writes. */
async function lockProfile(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  if (!(await lockLoyaltyProfile(tx, userId)))
    throw new Error('Loyalty profile not found');
  const [context] = await tx.$queryRaw<
    Array<{ active: boolean }>
  >`SELECT txid_current_if_assigned() IS NOT NULL AS active`;
  if (!context.active) throw new Error('Interactive transaction required');
}

/** Locks against cooperating writers and rejects snapshots established before that lock. */
async function availabilityDecisionTime(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<Date> {
  await lockProfile(tx, userId);
  await requireReadCommitted(tx);
  const [clock] = await tx.$queryRaw<
    Array<{ decisionAt: Date }>
  >`SELECT points_decision_time() AS "decisionAt"`;
  return clock.decisionAt;
}

/** Avoids decisions from snapshots established before the profile lock. */
async function requireReadCommitted(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const [context] = await tx.$queryRaw<
    Array<{ isolation: string }>
  >`SELECT current_setting('transaction_isolation') AS isolation`;
  if (context.isolation !== 'read committed')
    throw new Error('Read committed transaction required');
}

/** Shared SQL policy for redemption and reads; windowing bounds every projection read. */
function sourceAvailabilitySql(
  userId: string,
  decisionAt: Date,
  window?: { afterSourceId?: string; limit: number },
): Prisma.Sql {
  return Prisma.sql`WITH buckets AS (
    SELECT s.source_id AS "sourceId", s.source_ref AS "sourceRef", s.issued_at AS "issuedAt",
      s.original_expires_at AS "originalExpiresAt", e.expires_at AS "extensionDeadline", s.remaining,
      CASE WHEN s.issued_at <= ${decisionAt} AND s.original_expires_at > ${decisionAt}
        THEN s.remaining - s.extended_remaining ELSE 0 END AS "originalAvailable",
      CASE WHEN s.issued_at <= ${decisionAt} AND s.original_expires_at <= ${decisionAt}
        AND e.opened_at <= ${decisionAt} AND e.expires_at > ${decisionAt}
        THEN s.extended_remaining ELSE 0 END AS "extendedAvailable"
    FROM point_sources s
    LEFT JOIN point_source_extensions e ON e.user_id = s.user_id AND e.source_id = s.source_id
    WHERE s.user_id = ${userId}::uuid
      ${window?.afterSourceId ? Prisma.sql`AND s.source_id > ${window.afterSourceId}::uuid` : Prisma.empty}
    ${window ? Prisma.sql`ORDER BY s.source_id LIMIT ${window.limit}` : Prisma.empty}
  ) SELECT *, "originalAvailable" + "extendedAvailable" AS available,
    remaining - "originalAvailable" - "extendedAvailable" AS unavailable,
    CASE WHEN "originalAvailable" > 0 THEN "originalExpiresAt"
      WHEN "extendedAvailable" > 0 THEN "extensionDeadline" ELSE NULL END AS "effectiveExpiry"
    FROM buckets
    ${window ? Prisma.sql`ORDER BY "sourceId"` : Prisma.empty}`;
}

/**
 * Returns exact internal bigint totals as of one database decision time after
 * locking the existing profile. Requires a caller-owned READ COMMITTED
 * interactive transaction; scans UUID keyset batches without retaining sources.
 * This observation does not reserve funds for a later redemption.
 */
export async function getPointsAvailability(
  tx: Prisma.TransactionClient,
  input: GetPointsAvailability,
): Promise<PointsAvailability> {
  const command = availabilitySchema.parse(input);
  const decisionAt = await availabilityDecisionTime(tx, command.userId);
  const result: PointsAvailability = {
    decisionAt,
    accountingRemainder: 0n,
    spendable: 0n,
    unavailable: 0n,
    originalAvailable: 0n,
    extendedAvailable: 0n,
    nextExpiry: null,
  };
  let afterSourceId: string | undefined;
  for (;;) {
    const sources = await tx.$queryRaw<PointsSourceAvailability[]>(
      sourceAvailabilitySql(command.userId, decisionAt, {
        afterSourceId,
        limit: AVAILABILITY_BATCH_SIZE,
      }),
    );
    for (const source of sources) {
      result.accountingRemainder += BigInt(source.remaining);
      result.spendable += BigInt(source.available);
      result.unavailable += BigInt(source.unavailable);
      result.originalAvailable += BigInt(source.originalAvailable);
      result.extendedAvailable += BigInt(source.extendedAvailable);
      if (
        source.effectiveExpiry &&
        (!result.nextExpiry || source.effectiveExpiry < result.nextExpiry)
      )
        result.nextExpiry = source.effectiveExpiry;
    }
    if (sources.length < AVAILABILITY_BATCH_SIZE) return result;
    afterSourceId = sources[sources.length - 1].sourceId;
  }
}

/**
 * Returns at most 100 source observations in UUID order. The optional cursor is
 * a lexical UUID bound and need not identify an existing source. Each call has
 * its own post-lock database decision time; pages across requests do not promise
 * a shared snapshot. Requires an existing profile and READ COMMITTED caller tx.
 */
export async function getPointsAvailabilityPage(
  tx: Prisma.TransactionClient,
  input: GetPointsAvailabilityPage,
): Promise<PointsAvailabilityPage> {
  const command = availabilityPageSchema.parse(input);
  const decisionAt = await availabilityDecisionTime(tx, command.userId);
  const rows = await tx.$queryRaw<PointsSourceAvailability[]>(
    sourceAvailabilitySql(command.userId, decisionAt, {
      afterSourceId: command.afterSourceId,
      limit: command.limit + 1,
    }),
  );
  const sources = rows.slice(0, command.limit);
  return {
    decisionAt,
    sources,
    nextSourceId:
      rows.length > command.limit ? sources[sources.length - 1].sourceId : null,
  };
}

/**
 * Registers trusted issuance facts in the caller transaction without deriving
 * historical provenance or recalculating expiry. Reusing an identity requires
 * the same original source facts, even after that source has been spent.
 */
export async function issuePointsSource(
  tx: Prisma.TransactionClient,
  input: IssuePointsSource,
): Promise<void> {
  const command = sourceSchema.parse(input);
  await lockProfile(tx, command.userId);
  const existing = await tx.$queryRaw<
    SourceRow[]
  >`SELECT source_id AS "sourceId", source_ref AS "sourceRef", granted, remaining,
      issued_at AS "issuedAt", original_expires_at AS "originalExpiresAt"
    FROM point_sources
    WHERE user_id = ${command.userId}::uuid
      AND (source_id = ${command.sourceId}::uuid OR source_ref = ${command.sourceRef})`;
  if (existing.length) {
    const row = existing[0];
    if (
      existing.length !== 1 ||
      row.sourceId !== command.sourceId ||
      row.sourceRef !== command.sourceRef ||
      row.granted !== command.amount ||
      row.issuedAt.getTime() !== command.issuedAt.getTime() ||
      row.originalExpiresAt.getTime() !== command.originalExpiresAt.getTime()
    )
      throw new Error('Point source identity conflict');
    return;
  }
  await tx.$executeRaw`INSERT INTO point_sources
    (user_id, source_id, source_ref, granted, remaining, issued_at, original_expires_at)
    VALUES (${command.userId}::uuid, ${command.sourceId}::uuid, ${command.sourceRef},
      ${command.amount}, ${command.amount}, ${command.issuedAt}, ${command.originalExpiresAt})`;
}

/**
 * Spends currently eligible source buckets in effective-expiry/UUID order.
 * Requires the caller interactive transaction; decision time is read after the
 * profile lock. Exact replay returns saved funding even after its expiry.
 */
export async function redeemPoints(
  tx: Prisma.TransactionClient,
  input: RedeemPoints,
): Promise<RedemptionResult> {
  const command = redemptionSchema.parse(input);
  await lockProfile(tx, command.userId);
  const existing = await tx.$queryRaw<
    RedemptionRow[]
  >`SELECT debit_ref AS "debitRef", amount FROM point_redemptions
    WHERE user_id = ${command.userId}::uuid AND redemption_id = ${command.redemptionId}::uuid`;
  if (existing.length) {
    const row = existing[0];
    if (row.debitRef !== command.debitRef || row.amount !== command.amount)
      throw new Error('Point redemption identity conflict');
    return {
      funding: await tx.$queryRaw<
        Array<{ sourceId: string; amount: number }>
      >`SELECT f.source_id AS "sourceId", f.amount FROM point_funding f
        JOIN point_sources s ON s.user_id = f.user_id AND s.source_id = f.source_id
        JOIN point_redemptions r ON r.user_id = f.user_id AND r.redemption_id = f.redemption_id
        LEFT JOIN point_source_extensions e ON e.user_id = s.user_id AND e.source_id = s.source_id
        WHERE f.user_id = ${command.userId}::uuid AND f.redemption_id = ${command.redemptionId}::uuid
        ORDER BY CASE WHEN r.spent_at < s.original_expires_at THEN s.original_expires_at ELSE e.expires_at END, s.source_id`,
    };
  }
  const duplicateDebit = await tx.$queryRaw<
    Array<{ redemptionId: string }>
  >`SELECT redemption_id AS "redemptionId" FROM point_redemptions
    WHERE user_id = ${command.userId}::uuid AND debit_ref = ${command.debitRef}::uuid`;
  if (duplicateDebit.length)
    throw new Error('Point redemption identity conflict');
  const [clock] = await tx.$queryRaw<
    Array<{ spentAt: Date }>
  >`SELECT points_decision_time() AS "spentAt"`;
  const sources = await tx.$queryRaw<
    Array<{ sourceId: string; available: number; extended: boolean }>
  >(Prisma.sql`SELECT "sourceId", available, "extendedAvailable" > 0 AS extended
    FROM (${sourceAvailabilitySql(command.userId, clock.spentAt)}) availability
    WHERE available > 0 ORDER BY "effectiveExpiry", "sourceId"`);
  let needed = command.amount;
  const funding: Array<{
    sourceId: string;
    amount: number;
    extendedAmount: number;
  }> = [];
  for (const source of sources) {
    const consumed = Math.min(source.available, needed);
    funding.push({
      sourceId: source.sourceId,
      amount: consumed,
      extendedAmount: source.extended ? consumed : 0,
    });
    needed -= consumed;
    if (needed === 0) break;
  }
  if (needed > 0) throw new Error('Insufficient allocated points');
  await tx.$executeRaw`INSERT INTO point_redemptions (user_id, redemption_id, debit_ref, amount, spent_at)
    VALUES (${command.userId}::uuid, ${command.redemptionId}::uuid,
      ${command.debitRef}::uuid, ${command.amount}, ${clock.spentAt})`;
  for (const split of funding) {
    await tx.$executeRaw`UPDATE point_sources SET remaining = remaining - ${split.amount},
      extended_remaining = extended_remaining - ${split.extendedAmount}
      WHERE user_id = ${command.userId}::uuid AND source_id = ${split.sourceId}::uuid`;
    await tx.$executeRaw`INSERT INTO point_funding (user_id, redemption_id, source_id, amount, extended_amount)
      VALUES (${command.userId}::uuid, ${command.redemptionId}::uuid, ${split.sourceId}::uuid, ${split.amount}, ${split.extendedAmount})`;
  }
  return {
    funding: funding.map(({ sourceId, amount }) => ({ sourceId, amount })),
  };
}

/**
 * Restores the full persisted debit in the caller interactive transaction.
 * Original funding stays immutable; one saved source extension governs all
 * post-expiry returns. Replay returns the original snapshot without recrediting
 * points or recomputing deadlines, including deadlines that have now expired.
 */
export async function restorePoints(
  tx: Prisma.TransactionClient,
  input: RestorePoints,
): Promise<RestorationResult> {
  const command = restorationSchema.parse(input);
  await lockProfile(tx, command.userId);
  const existing = await tx.$queryRaw<
    Array<{
      restorationId: string;
      redemptionId: string;
      amount: number;
      restoredAt: Date;
    }>
  >`
    SELECT restoration_id AS "restorationId", redemption_id AS "redemptionId", amount, restored_at AS "restoredAt"
    FROM point_restorations WHERE user_id = ${command.userId}::uuid
      AND (restoration_id = ${command.restorationId}::uuid OR redemption_id = ${command.redemptionId}::uuid)`;
  if (existing.length) {
    const saved = existing[0];
    if (
      existing.length !== 1 ||
      saved.restorationId !== command.restorationId ||
      saved.redemptionId !== command.redemptionId
    )
      throw new Error('Point restoration identity conflict');
    return restorationSnapshot(tx, command, saved.amount, saved.restoredAt);
  }
  const [redemption] = await tx.$queryRaw<Array<{ amount: number }>>`
    SELECT amount FROM point_redemptions WHERE user_id = ${command.userId}::uuid AND redemption_id = ${command.redemptionId}::uuid`;
  if (!redemption) throw new Error('Point redemption not found');
  const [clock] = await tx.$queryRaw<
    Array<{ restoredAt: Date }>
  >`SELECT points_decision_time() AS "restoredAt"`;
  await tx.$executeRaw`INSERT INTO point_restorations (user_id, restoration_id, redemption_id, amount, restored_at)
    VALUES (${command.userId}::uuid, ${command.restorationId}::uuid, ${command.redemptionId}::uuid, ${redemption.amount}, ${clock.restoredAt})`;
  const funding = await tx.$queryRaw<
    Array<{ sourceId: string; amount: number; originalExpiresAt: Date }>
  >`
    SELECT f.source_id AS "sourceId", f.amount, s.original_expires_at AS "originalExpiresAt"
    FROM point_funding f JOIN point_sources s USING (user_id, source_id)
    WHERE f.user_id = ${command.userId}::uuid AND f.redemption_id = ${command.redemptionId}::uuid
    ORDER BY s.source_id`;
  for (const split of funding) {
    const afterExpiry = clock.restoredAt >= split.originalExpiresAt;
    let expiresAt = split.originalExpiresAt;
    if (afterExpiry) {
      await tx.$executeRaw`INSERT INTO point_source_extensions (user_id, source_id, restoration_id, opened_at, expires_at)
        VALUES (${command.userId}::uuid, ${split.sourceId}::uuid, ${command.restorationId}::uuid,
          ${clock.restoredAt}, point_extension_deadline(${clock.restoredAt}::timestamptz))
        ON CONFLICT (user_id, source_id) DO NOTHING`;
      const [extension] = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
        SELECT expires_at AS "expiresAt" FROM point_source_extensions
        WHERE user_id = ${command.userId}::uuid AND source_id = ${split.sourceId}::uuid`;
      expiresAt = extension.expiresAt;
    }
    await tx.$executeRaw`UPDATE point_sources SET remaining = remaining + ${split.amount},
      extended_remaining = extended_remaining + ${afterExpiry ? split.amount : 0}
      WHERE user_id = ${command.userId}::uuid AND source_id = ${split.sourceId}::uuid`;
    await tx.$executeRaw`INSERT INTO point_restoration_splits (user_id, restoration_id, redemption_id, source_id, amount, expires_at)
      VALUES (${command.userId}::uuid, ${command.restorationId}::uuid, ${command.redemptionId}::uuid,
        ${split.sourceId}::uuid, ${split.amount}, ${expiresAt})`;
  }
  return restorationSnapshot(tx, command, redemption.amount, clock.restoredAt);
}

/** Returns immutable replay facts; an expired deadline is not renewed here. */
async function restorationSnapshot(
  tx: Prisma.TransactionClient,
  command: RestorePoints,
  amount: number,
  restoredAt: Date,
): Promise<RestorationResult> {
  const funding = await tx.$queryRaw<RestorationResult['funding']>`
    SELECT source_id AS "sourceId", amount, expires_at AS "expiresAt" FROM point_restoration_splits
    WHERE user_id = ${command.userId}::uuid AND restoration_id = ${command.restorationId}::uuid
    ORDER BY expires_at, source_id`;
  return { amount, restoredAt, funding };
}

const expirySchema = z
  .object({ userId: uuid, operationId: uuid, sourceId: uuid })
  .strict();
const expiryBatchSchema = z
  .object({
    userId: uuid,
    afterSourceId: uuid.optional(),
    limit: z.number().int().min(1).max(500).default(500),
  })
  .strict();
export type ExpireSourcePoints = z.input<typeof expirySchema>;
export type ExpirePointsBatch = z.input<typeof expiryBatchSchema>;
export interface PointExpiryEntry {
  id: string;
  bucket: 'ORIGINAL' | 'EXTENDED';
  amount: number;
  deadline: Date;
  creditWatermark: bigint;
}
export interface PointExpiryResult {
  operationId: string;
  sourceId: string;
  decisionAt: Date;
  amount: number;
  entries: PointExpiryEntry[];
}
export interface PointExpiryBatchResult {
  decisionAt: Date;
  operations: PointExpiryResult[];
  nextSourceId: string | null;
}

/** Reads only saved evidence, including a saved zero decision, for exact replay. */
async function expirySnapshot(
  tx: Prisma.TransactionClient,
  userId: string,
  operationId: string,
): Promise<PointExpiryResult | null> {
  const [header] = await tx.$queryRaw<
    Array<Omit<PointExpiryResult, 'entries'>>
  >`
    SELECT operation_id AS "operationId", source_id AS "sourceId", decision_at AS "decisionAt", amount
    FROM point_expiry_operations WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid`;
  if (!header) return null;
  const entries = await tx.$queryRaw<PointExpiryEntry[]>`
    SELECT id, bucket, amount, deadline, credit_watermark AS "creditWatermark"
    FROM point_expiry_entries WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid ORDER BY bucket`;
  return { ...header, entries };
}

/** Locks fresh bucket quantities; entry triggers atomically retire and protect their totals. */
async function expireAt(
  tx: Prisma.TransactionClient,
  command: ExpireSourcePoints,
  decisionAt: Date,
): Promise<PointExpiryResult> {
  const [source] = await tx.$queryRaw<
    Array<{
      remaining: number;
      extendedRemaining: number;
      originalExpiresAt: Date;
      originalWatermark: bigint;
      extendedWatermark: bigint;
    }>
  >`SELECT remaining, extended_remaining AS "extendedRemaining", original_expires_at AS "originalExpiresAt",
      restored - extended_restored AS "originalWatermark", extended_restored AS "extendedWatermark"
    FROM point_sources WHERE user_id = ${command.userId}::uuid AND source_id = ${command.sourceId}::uuid FOR UPDATE`;
  if (!source) throw new Error('Point expiry source not found');
  const [extension] = await tx.$queryRaw<Array<{ deadline: Date }>>`
    SELECT expires_at AS deadline FROM point_source_extensions WHERE user_id = ${command.userId}::uuid AND source_id = ${command.sourceId}::uuid`;
  const entries: PointExpiryEntry[] = [];
  if (
    source.originalExpiresAt <= decisionAt &&
    source.remaining > source.extendedRemaining
  )
    entries.push({
      id: randomUUID(),
      bucket: 'ORIGINAL',
      amount: source.remaining - source.extendedRemaining,
      deadline: source.originalExpiresAt,
      creditWatermark: source.originalWatermark,
    });
  if (
    extension &&
    extension.deadline <= decisionAt &&
    source.extendedRemaining > 0
  )
    entries.push({
      id: randomUUID(),
      bucket: 'EXTENDED',
      amount: source.extendedRemaining,
      deadline: extension.deadline,
      creditWatermark: source.extendedWatermark,
    });
  const amount = entries.reduce((sum, entry) => sum + entry.amount, 0);
  await tx.$executeRaw`INSERT INTO point_expiry_operations(user_id,operation_id,source_id,decision_at,amount)
    VALUES (${command.userId}::uuid,${command.operationId}::uuid,${command.sourceId}::uuid,${decisionAt},${amount})`;
  for (const entry of entries) {
    await tx.$executeRaw`INSERT INTO point_expiry_entries(id,user_id,operation_id,source_id,bucket,amount,deadline,credit_watermark)
      VALUES (${entry.id}::uuid,${command.userId}::uuid,${command.operationId}::uuid,${command.sourceId}::uuid,
        ${entry.bucket},${entry.amount},${entry.deadline},${entry.creditWatermark})`;
  }
  return {
    operationId: command.operationId,
    sourceId: command.sourceId,
    decisionAt,
    amount,
    entries: entries.sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

/**
 * Retires full currently due buckets without accepting an amount or changing
 * deadlines. Requires a caller-owned READ COMMITTED transaction and profile.
 * Exact replay returns the original evidence before reading a new clock, even
 * when a later restoration has credited additional already expired points.
 */
export async function expireSourcePoints(
  tx: Prisma.TransactionClient,
  input: ExpireSourcePoints,
): Promise<PointExpiryResult> {
  const command = expirySchema.parse(input);
  await lockProfile(tx, command.userId);
  await requireReadCommitted(tx);
  const saved = await expirySnapshot(tx, command.userId, command.operationId);
  if (saved) {
    if (saved.sourceId !== command.sourceId)
      throw new Error('Point expiry identity conflict');
    return saved;
  }
  const [clock] = await tx.$queryRaw<Array<{ decisionAt: Date }>>`
    SELECT points_decision_time() AS "decisionAt"`;
  return expireAt(tx, command, clock.decisionAt);
}

/** Builds one bounded portion of the circular due-source UUID scan. */
function expiryCandidates(
  userId: string,
  decisionAt: Date,
  bound: Prisma.Sql,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`SELECT s.source_id AS "sourceId" FROM point_sources s
    LEFT JOIN point_source_extensions e USING (user_id, source_id)
    WHERE s.user_id = ${userId}::uuid AND ${bound}
      AND ((s.original_expires_at <= ${decisionAt} AND s.remaining > s.extended_remaining)
        OR (e.expires_at <= ${decisionAt} AND s.extended_remaining > 0))
    ORDER BY s.source_id LIMIT ${limit}`;
}

/**
 * Retires at most 500 sources for one profile in the caller's transaction.
 * A circular UUID scan uses at most two bounded candidate queries and one
 * post-lock decision time. Lookahead includes due credits behind the cursor;
 * no source is processed twice within a call. The cursor is progress, not a
 * batch idempotency key: restart may advance other sources, while persisted
 * bucket watermarks prevent retiring a credited quantity twice.
 */
export async function expirePointsBatch(
  tx: Prisma.TransactionClient,
  input: ExpirePointsBatch,
): Promise<PointExpiryBatchResult> {
  const command = expiryBatchSchema.parse(input);
  const decisionAt = await availabilityDecisionTime(tx, command.userId);
  const rows = await tx.$queryRaw<Array<{ sourceId: string }>>(
    expiryCandidates(
      command.userId,
      decisionAt,
      command.afterSourceId
        ? Prisma.sql`s.source_id > ${command.afterSourceId}::uuid`
        : Prisma.sql`true`,
      command.limit + 1,
    ),
  );
  if (command.afterSourceId && rows.length < command.limit + 1) {
    rows.push(
      ...(await tx.$queryRaw<Array<{ sourceId: string }>>(
        expiryCandidates(
          command.userId,
          decisionAt,
          Prisma.sql`s.source_id <= ${command.afterSourceId}::uuid`,
          command.limit + 1 - rows.length,
        ),
      )),
    );
  }
  const operations: PointExpiryResult[] = [];
  for (const row of rows.slice(0, command.limit))
    operations.push(
      await expireAt(
        tx,
        {
          userId: command.userId,
          sourceId: row.sourceId,
          operationId: randomUUID(),
        },
        decisionAt,
      ),
    );
  return {
    decisionAt,
    operations,
    nextSourceId:
      rows.length > command.limit
        ? operations[operations.length - 1].sourceId
        : null,
  };
}
