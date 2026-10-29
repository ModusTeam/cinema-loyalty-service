export const PERMANENT_MESSAGE_CODES = [
  'ACCOUNTING_RANGE_EXCEEDED',
  'INVALID_PURCHASE_PAYLOAD',
  'INVALID_DOB_PAYLOAD',
  'INVALID_CUSTOMER_FACT',
  'CUSTOMER_FACT_IDENTITY_CONFLICT',
  'INVALID_SESSION_COMPLETION',
  'SESSION_COMPLETION_IDENTITY_CONFLICT',
  'INVALID_DATE_OF_BIRTH',
  'PURCHASE_IDEMPOTENCY_CONFLICT',
] as const;

export class PermanentMessageError extends Error {
  constructor(
    readonly code: (typeof PERMANENT_MESSAGE_CODES)[number],
    message: string = code,
  ) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export function classifyMessageFailure(error: unknown): {
  kind: 'permanent' | 'transient' | 'unknown';
  code: string;
} {
  if (error instanceof PermanentMessageError)
    return { kind: 'permanent', code: error.code };
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    if (error.code === 'P2020')
      return { kind: 'permanent', code: 'ACCOUNTING_RANGE_EXCEEDED' };
    if (
      [
        'P1001',
        'P1002',
        'P1008',
        'P1017',
        'P2024',
        'P2034',
        'ECONNRESET',
        'ETIMEDOUT',
      ].includes(error.code)
    )
      return { kind: 'transient', code: 'TRANSIENT_PROCESSING_FAILURE' };
  }
  return { kind: 'unknown', code: 'UNEXPECTED_PROCESSING_FAILURE' };
}

export function assertAccountingInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647)
    throw new PermanentMessageError('ACCOUNTING_RANGE_EXCEEDED');
}
