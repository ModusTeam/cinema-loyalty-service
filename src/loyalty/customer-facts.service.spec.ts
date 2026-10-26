import { describe, it, expect } from '@jest/globals';
import { customerFacts } from '../../test/fixtures/customer-facts';
import { parseCustomerFact } from './dto/customer-facts-changed.dto';

describe('Customer fact boundary', () => {
  const facts = customerFacts();
  it('preserves source facts and valid leap-day DOB', () => {
    expect(parseCustomerFact(facts.set)).toEqual(facts.set);
  });
  it.each([
    { revision: 0 },
    { revision: 1.5 },
    { revision: 2147483648 },
    { schemaVersion: 2 },
    { dateOfBirth: '1991-02-29' },
    { dateOfBirth: '1992-02-30' },
    { dateOfBirth: '1992-02-29T00:00:00Z' },
    { occurredAtUtc: '2024-03-01T10:00:00+00:00' },
    { occurredAtUtc: '2024-02-30T10:00:00.000Z' },
    { dobFirstSetAtUtc: null },
    { previousDateOfBirth: '1990-01-01' },
    { correctionOperationId: facts.corrected.correctionOperationId },
  ])('rejects malformed or inconsistent fact %j', (change) => {
    expect(() => parseCustomerFact({ ...facts.set, ...change })).toThrow(
      'INVALID_CUSTOMER_FACT',
    );
  });
  it('requires explicit nullable fields and omits private extras', () => {
    expect(() =>
      parseCustomerFact({ ...facts.set, registeredAtUtc: undefined }),
    ).toThrow('INVALID_CUSTOMER_FACT');
    expect(
      parseCustomerFact({
        ...facts.set,
        email: 'PRIVATE@example.invalid',
        private: 'SECRET',
      }),
    ).toEqual(facts.set);
  });
  it('accepts unknown historical root and future source clock', () => {
    const root = {
      ...facts.corrected,
      revision: 1,
      registeredAtUtc: null,
      dobFirstSetAtUtc: null,
      occurredAtUtc: '2099-01-01T00:00:00.000Z',
    };
    expect(parseCustomerFact(root)).toEqual(root);
  });
  it('normalizes UUID case without changing the facts', () => {
    expect(
      parseCustomerFact({
        ...facts.set,
        userId: facts.set.userId.toUpperCase(),
      }),
    ).toEqual(facts.set);
  });
  it('rejects inconsistent Registered/correction shapes and nonobjects', () => {
    for (const value of [
      null,
      [],
      { ...facts.registered, revision: 2 },
      { ...facts.corrected, correctionOperationId: null },
      { ...facts.corrected, previousDateOfBirth: facts.corrected.dateOfBirth },
    ]) {
      expect(() => parseCustomerFact(value)).toThrow('INVALID_CUSTOMER_FACT');
    }
  });
  it('accepts canonical PostgreSQL/.NET Guid shapes without a UUID-version constraint', () => {
    const value = {
      ...facts.registered,
      userId: '00000000-0000-0000-0000-000000000001',
    };
    expect(parseCustomerFact(value)).toEqual(value);
  });
  it('rejects year zero, which is not a .NET/PostgreSQL calendar year', () => {
    expect(() =>
      parseCustomerFact({ ...facts.set, dateOfBirth: '0000-01-01' }),
    ).toThrow('INVALID_CUSTOMER_FACT');
    expect(() =>
      parseCustomerFact({
        ...facts.registered,
        occurredAtUtc: '0000-01-01T00:00:00.000Z',
        registeredAtUtc: '0000-01-01T00:00:00.000Z',
      }),
    ).toThrow('INVALID_CUSTOMER_FACT');
  });
});
