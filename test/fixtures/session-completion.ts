import { randomUUID } from 'node:crypto';

export function sessionCompletion() {
  return {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    sessionId: randomUUID(),
    revision: 1 as const,
    completedAtUtc: '2024-02-29T23:59:59.123456Z',
  };
}
