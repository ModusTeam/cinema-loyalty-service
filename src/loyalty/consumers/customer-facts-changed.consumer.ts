import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { CustomerFactsService } from '../customer-facts.service';
import { EventPatternType } from '../enums/loyalty.enums';
import { RmqDeliveryService } from './rmq-delivery.service';

@Controller()
export class CustomerFactsChangedConsumer {
  constructor(
    private readonly facts: CustomerFactsService,
    private readonly deliveries: RmqDeliveryService,
  ) {}

  @EventPattern(EventPatternType.CUSTOMER_FACTS_CHANGED)
  async handle(
    @Payload() data: unknown,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.deliveries.handle(
      'CustomerFactsChanged',
      data,
      context,
      async () => {
        await this.facts.ingest(data);
      },
    );
  }
}
