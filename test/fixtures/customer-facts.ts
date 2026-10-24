import { randomUUID } from 'node:crypto';

export function customerFacts(userId = randomUUID()) {
  const registered = {
    schemaVersion: 1,
    eventId: randomUUID(),
    userId,
    revision: 1,
    kind: 'Registered',
    occurredAtUtc: '2024-02-29T22:30:00.000Z',
    registeredAtUtc: '2024-02-29T22:30:00.000Z',
    dobFirstSetAtUtc: null,
    dateOfBirth: null,
    previousDateOfBirth: null,
    correctionOperationId: null,
  };
  const set = {
    ...registered,
    eventId: randomUUID(),
    revision: 2,
    kind: 'DateOfBirthSet',
    occurredAtUtc: '2024-03-01T10:00:00.000Z',
    dobFirstSetAtUtc: '2024-03-01T10:00:00.000Z',
    dateOfBirth: '1992-02-29',
  };
  const corrected = {
    ...set,
    eventId: randomUUID(),
    revision: 3,
    kind: 'DateOfBirthCorrected',
    occurredAtUtc: '2024-04-01T10:00:00.000Z',
    previousDateOfBirth: set.dateOfBirth,
    dateOfBirth: '1990-10-21',
    correctionOperationId: randomUUID(),
  };
  return { registered, set, corrected };
}
