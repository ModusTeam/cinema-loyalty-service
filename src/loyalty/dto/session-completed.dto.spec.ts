import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSessionCompleted } from './session-completed.dto';

const fact = {
  schemaVersion: 1,
  eventId: 'abcdef12-3456-4789-abcd-123456789abc',
  sessionId: '12345678-abcd-4123-abcd-123456789abc',
  revision: 1,
  completedAtUtc: '2024-02-29T23:59:59.123456Z',
};

describe('SESSION_COMPLETED v1 boundary', () => {
  it('accepts every fixed .NET envelope without changing the timestamp text', () => {
    const fixtures: unknown = JSON.parse(
      readFileSync(resolve('test/fixtures/session-completed-v1.json'), 'utf8'),
    );
    if (!Array.isArray(fixtures))
      throw new Error('Expected fixed fixture array');
    expect(fixtures).toHaveLength(4);
    for (const envelope of fixtures) {
      const packet: unknown = envelope;
      if (typeof packet !== 'object' || packet === null || !('data' in packet))
        throw new Error('Invalid fixed envelope');
      expect(packet).toHaveProperty('pattern', 'SESSION_COMPLETED');
      expect(parseSessionCompleted(packet.data)).toEqual(packet.data);
    }
  });

  it('canonicalizes UUID case/key order and strips unrelated metadata', () => {
    const input = Object.fromEntries(Object.entries(fact).reverse());
    expect(
      parseSessionCompleted({
        ...input,
        eventId: fact.eventId.toUpperCase(),
        sessionId: fact.sessionId.toUpperCase(),
        privateMetadata: 'PRIVATE_EXTRA',
      }),
    ).toEqual(fact);
  });

  it('keeps distinct microsecond timestamps distinct', () => {
    const other = parseSessionCompleted({
      ...fact,
      completedAtUtc: '2024-02-29T23:59:59.123457Z',
    });
    expect(other.completedAtUtc).not.toBe(fact.completedAtUtc);
  });

  it.each([
    '1991-02-29T00:00:00.000000Z',
    '0000-01-01T00:00:00.000000Z',
    '2024-02-29T00:00:00.123Z',
    '2024-02-29T00:00:00.1234567Z',
    '2024-02-29T00:00:00.123456+00:00',
    '2024-02-29T00:00:00.123456',
    '2024-02-29T24:00:00.000000Z',
  ])('rejects a noncanonical or invalid timestamp: %s', (completedAtUtc) => {
    expect(() => parseSessionCompleted({ ...fact, completedAtUtc })).toThrow(
      'INVALID_SESSION_COMPLETION',
    );
  });

  it.each([
    { schemaVersion: 2 },
    { schemaVersion: '1' },
    { revision: 0 },
    { revision: 2 },
    { revision: 1.5 },
    { eventId: 'invalid' },
    { sessionId: null },
    { completedAtUtc: undefined },
  ])('rejects malformed identity/version/revision: %j', (invalid) => {
    expect(() => parseSessionCompleted({ ...fact, ...invalid })).toThrow(
      'INVALID_SESSION_COMPLETION',
    );
  });

  it.each([null, [], 'PRIVATE_PAYLOAD', 1])(
    'rejects non-object payloads',
    (input) => {
      expect(() => parseSessionCompleted(input)).toThrow(
        'INVALID_SESSION_COMPLETION',
      );
    },
  );
});
