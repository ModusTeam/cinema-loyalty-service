import { describe, expect, it, jest } from '@jest/globals';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { RmqContext } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { LoyaltyModule } from '../loyalty.module';
import { SessionCompletionService } from '../session-completion.service';
import { PermanentMessageError } from './message-failure';
import { RmqDeliveryService } from './rmq-delivery.service';
import { SessionCompletedConsumer } from './session-completed.consumer';

describe('session completion transport wiring', () => {
  it('registers the consumer and its service in the production module', () => {
    const controllers: unknown = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      LoyaltyModule,
    );
    const providers: unknown = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      LoyaltyModule,
    );
    expect(controllers).toContain(SessionCompletedConsumer);
    expect(providers).toContain(SessionCompletionService);
  });

  it.each([false, true])(
    'keeps work and failure propagation inside durable delivery: permanent=%s',
    async (fails) => {
      const error = new PermanentMessageError(
        'SESSION_COMPLETION_IDENTITY_CONFLICT',
      );
      const ingest = jest.fn<SessionCompletionService['ingest']>();
      if (fails) ingest.mockRejectedValue(error);
      else ingest.mockResolvedValue(undefined);
      const handle = jest
        .fn<RmqDeliveryService['handle']>()
        .mockImplementation(async (_operation, _data, _context, work) => {
          await work();
        });
      const module = await Test.createTestingModule({
        controllers: [SessionCompletedConsumer],
        providers: [
          { provide: SessionCompletionService, useValue: { ingest } },
          { provide: RmqDeliveryService, useValue: { handle } },
        ],
      }).compile();
      try {
        const consumer = module.get(SessionCompletedConsumer);
        const payload = { eventId: 'unchanged transport input' };
        const context = new RmqContext([{}, {}, 'SESSION_COMPLETED']);
        const result = consumer.handle(payload, context);
        if (fails) await expect(result).rejects.toBe(error);
        else await expect(result).resolves.toBeUndefined();
        expect(handle).toHaveBeenCalledWith(
          'SessionCompleted',
          payload,
          context,
          expect.any(Function),
        );
        expect(ingest).toHaveBeenCalledWith(payload);
      } finally {
        await module.close();
      }
    },
  );
});
