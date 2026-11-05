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
export type IssuePointsSource = z.input<typeof sourceSchema>;
export type RedeemPoints = z.input<typeof redemptionSchema>;
export interface RedemptionResult {
  funding: Array<{ sourceId: string; amount: number }>;
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
async function lockProfile(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  if (!(await lockLoyaltyProfile(tx, userId)))
    throw new Error('Loyalty profile not found');
}

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
        WHERE f.user_id = ${command.userId}::uuid AND f.redemption_id = ${command.redemptionId}::uuid
        ORDER BY s.original_expires_at, s.source_id`,
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
  >`SELECT clock_timestamp()::timestamptz(3) AS "spentAt"`;
  const sources = await tx.$queryRaw<
    SourceRow[]
  >`SELECT source_id AS "sourceId", source_ref AS "sourceRef", granted, remaining,
      issued_at AS "issuedAt", original_expires_at AS "originalExpiresAt"
    FROM point_sources
    WHERE user_id = ${command.userId}::uuid AND remaining > 0
      AND issued_at <= ${clock.spentAt} AND original_expires_at > ${clock.spentAt}
    ORDER BY original_expires_at, source_id`;
  let needed = command.amount;
  const funding: RedemptionResult['funding'] = [];
  for (const source of sources) {
    const consumed = Math.min(source.remaining, needed);
    funding.push({ sourceId: source.sourceId, amount: consumed });
    needed -= consumed;
    if (needed === 0) break;
  }
  if (needed > 0) throw new Error('Insufficient allocated points');
  await tx.$executeRaw`INSERT INTO point_redemptions (user_id, redemption_id, debit_ref, amount, spent_at)
    VALUES (${command.userId}::uuid, ${command.redemptionId}::uuid,
      ${command.debitRef}::uuid, ${command.amount}, ${clock.spentAt})`;
  for (const split of funding) {
    await tx.$executeRaw`UPDATE point_sources SET remaining = remaining - ${split.amount}
      WHERE user_id = ${command.userId}::uuid AND source_id = ${split.sourceId}::uuid`;
    await tx.$executeRaw`INSERT INTO point_funding (user_id, redemption_id, source_id, amount)
      VALUES (${command.userId}::uuid, ${command.redemptionId}::uuid, ${split.sourceId}::uuid, ${split.amount})`;
  }
  return { funding };
}
