import { z } from 'zod';
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
  >`SELECT s.source_id AS "sourceId",
      CASE WHEN s.original_expires_at > ${clock.spentAt} THEN s.remaining ELSE s.extended_remaining END AS available,
      s.original_expires_at <= ${clock.spentAt} AS extended
    FROM point_sources s
    LEFT JOIN point_source_extensions e ON e.user_id = s.user_id AND e.source_id = s.source_id
    WHERE s.user_id = ${command.userId}::uuid AND s.issued_at <= ${clock.spentAt}
      AND ((s.original_expires_at > ${clock.spentAt} AND s.remaining > 0)
        OR (s.original_expires_at <= ${clock.spentAt} AND s.extended_remaining > 0
          AND e.opened_at <= ${clock.spentAt} AND e.expires_at > ${clock.spentAt}))
    ORDER BY CASE WHEN s.original_expires_at > ${clock.spentAt} THEN s.original_expires_at ELSE e.expires_at END, s.source_id`;
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
