import { z } from 'zod';
import { PermanentMessageError } from '../consumers/message-failure';

export const customerFactIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());
const instant = z.string().refine((value) => {
  const date = new Date(value);
  return (
    /^[0-9]{4}-/.test(value) &&
    date.getUTCFullYear() >= 1 &&
    Number.isFinite(date.getTime()) &&
    date.toISOString() === value
  );
});
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + 'T00:00:00.000Z');
    return (
      date.getUTCFullYear() >= 1 &&
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });

const customerFactSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: customerFactIdSchema,
    userId: customerFactIdSchema,
    revision: z.number().int().min(1).max(2147483647),
    kind: z.enum(['Registered', 'DateOfBirthSet', 'DateOfBirthCorrected']),
    occurredAtUtc: instant,
    registeredAtUtc: instant.nullable(),
    dobFirstSetAtUtc: instant.nullable(),
    dateOfBirth: calendarDate.nullable(),
    previousDateOfBirth: calendarDate.nullable(),
    correctionOperationId: customerFactIdSchema.nullable(),
  })
  .refine((fact) => {
    if (fact.kind === 'Registered') {
      return (
        fact.revision === 1 &&
        fact.registeredAtUtc === fact.occurredAtUtc &&
        fact.dateOfBirth === null &&
        fact.dobFirstSetAtUtc === null &&
        fact.previousDateOfBirth === null &&
        fact.correctionOperationId === null
      );
    }
    if (fact.kind === 'DateOfBirthSet') {
      return (
        fact.dateOfBirth !== null &&
        fact.dobFirstSetAtUtc === fact.occurredAtUtc &&
        fact.previousDateOfBirth === null &&
        fact.correctionOperationId === null
      );
    }
    return (
      fact.dateOfBirth !== null &&
      fact.previousDateOfBirth !== null &&
      fact.dateOfBirth !== fact.previousDateOfBirth &&
      fact.correctionOperationId !== null
    );
  });

export type CustomerFact = z.infer<typeof customerFactSchema>;

export function parseCustomerFact(value: unknown): CustomerFact {
  const result = customerFactSchema.safeParse(value);
  if (!result.success) throw new PermanentMessageError('INVALID_CUSTOMER_FACT');
  return result.data;
}
