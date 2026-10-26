import { describe, it, expect, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';
import { CustomerFactsChangedConsumer } from './consumers/customer-facts-changed.consumer';
import { CustomerFactsService } from './customer-facts.service';
import { RmqDeliveryService } from './consumers/rmq-delivery.service';
import { customerFacts } from '../../test/fixtures/customer-facts';

describe('Passive consumer transport boundary', () => {
  it('delegates through durable delivery and propagates failure without raw payload logging', async () => {
    const sensitive = {
      ...customerFacts().set,
      email: 'PRIVATE@example.invalid',
      downloadUrl: 'https://private.invalid/SECRET',
      private: 'PRIVATE_EXTRA',
    };
    const ingest = jest
      .fn<(input: unknown) => Promise<void>>()
      .mockRejectedValue(new Error('fixture processing failure'));

    const handle = jest.fn(
      async (
        _operation: string,
        _data: unknown,
        _context: RmqContext,
        work: () => Promise<void>,
      ) => {
        await work();
      },
    );

    const logs = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(),
    ];
    try {
      const module = await Test.createTestingModule({
        controllers: [CustomerFactsChangedConsumer],
        providers: [
          { provide: CustomerFactsService, useValue: { ingest } },
          { provide: RmqDeliveryService, useValue: { handle } },
        ],
      }).compile();
      logs.forEach((spy) => spy.mockClear());
      const consumer = module.get(CustomerFactsChangedConsumer);
      const context = new RmqContext([]);
      await expect(consumer.handle(sensitive, context)).rejects.toThrow(
        'fixture processing failure',
      );
      expect(handle).toHaveBeenCalledWith(
        'CustomerFactsChanged',
        sensitive,
        context,
        expect.any(Function),
      );
      expect(ingest).toHaveBeenCalledWith(sensitive);
      expect(logs.flatMap((spy) => spy.mock.calls)).toEqual([]);
      await module.close();
    } finally {
      logs.forEach((spy) => spy.mockRestore());
    }
  });
});
