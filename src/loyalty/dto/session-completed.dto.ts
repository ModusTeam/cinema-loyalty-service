import { z } from 'zod';
import { PermanentMessageError } from '../consumers/message-failure';
import { customerFactIdSchema } from './customer-facts-changed.dto';

const sessionCompletedSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: customerFactIdSchema,
  sessionId: customerFactIdSchema,
  revision: z.literal(1),
  // PostgreSQL microseconds are authoritative; never round-trip through JS Date.
  completedAtUtc: z.iso
    .datetime({ precision: 6 })
    .refine((value) => !value.startsWith('0000-')),
});

export type SessionCompletedFact = z.infer<typeof sessionCompletedSchema>;

export function parseSessionCompleted(input: unknown): SessionCompletedFact {
  const result = sessionCompletedSchema.safeParse(input);
  if (!result.success)
    throw new PermanentMessageError('INVALID_SESSION_COMPLETION');
  return result.data;
}
