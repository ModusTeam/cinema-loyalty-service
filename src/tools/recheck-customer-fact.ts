import 'reflect-metadata';
import { ConsoleLogger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { customerFactIdSchema } from '../loyalty/dto/customer-facts-changed.dto';
import { customerFactsMaintenanceConfig } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerFactsService } from '../loyalty/customer-facts.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [customerFactsMaintenanceConfig],
      skipProcessEnv: true,
    }),
  ],
  providers: [PrismaService, CustomerFactsService],
})
class CustomerFactsMaintenanceModule {}

const logger = new ConsoleLogger('CustomerFactsMaintenance');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    args[0] !== '--recheck-blocked' ||
    args[1] !== '--event-id'
  )
    throw new Error('EXPECTED_RECHECK_BLOCKED_EVENT_ID');
  const eventId = customerFactIdSchema.parse(args[2]);
  const app = await NestFactory.createApplicationContext(
    CustomerFactsMaintenanceModule,
    { logger: false, abortOnError: false },
  );

  try {
    const state = await app.get(CustomerFactsService).recheckBlocked(eventId);
    logger.log(
      JSON.stringify({
        operation: 'CustomerFactRecheck',
        eventId,
        state,
      }),
    );
    if (state === 'BLOCKED') process.exitCode = 2;
  } finally {
    await app.close();
  }
}
void main().catch(() => {
  logger.error('CUSTOMER_FACT_RECHECK_FAILED_OR_AMBIGUOUS');
  process.exitCode = 1;
});
