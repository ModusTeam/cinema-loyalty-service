import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { EventPatternType } from '../enums/loyalty.enums';
import { SessionCompletionService } from '../session-completion.service';
import { RmqDeliveryService } from './rmq-delivery.service';

@Controller()
export class SessionCompletedConsumer {
  constructor(
    private readonly facts: SessionCompletionService,
    private readonly deliveries: RmqDeliveryService,
  ) {}

  @EventPattern(EventPatternType.SESSION_COMPLETED)
  async handle(
    @Payload() data: unknown,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.deliveries.handle(
      'SessionCompleted',
      data,
      context,
      async () => {
        await this.facts.ingest(data);
      },
    );
  }
}
