require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { Transport } = require('@nestjs/microservices');
const { createHash } = require('node:crypto');
const { PrismaService } = require('../../dist/prisma/prisma.service');
const {
  SessionCompletionService,
} = require('../../dist/loyalty/session-completion.service');
const {
  SessionCompletedConsumer,
} = require('../../dist/loyalty/consumers/session-completed.consumer');
const {
  RmqDeliveryService,
} = require('../../dist/loyalty/consumers/rmq-delivery.service');

const database = new URL(process.env.RMQ_TEST_DATABASE_URL);
const rabbit = new URL(process.env.RMQ_TEST_RABBIT_URL);
const queue = process.env.RMQ_TEST_QUEUE;
if (
  database.hostname !== '127.0.0.1' ||
  database.pathname !== '/loyalty_rmq' ||
  database.username !== 'loyalty_test' ||
  rabbit.hostname !== '127.0.0.1' ||
  !queue?.startsWith('rmq-test-')
)
  throw new Error('Disposable local fixture required');
const notify = (kind, fields = {}) => {
  if (process.connected) process.send({ kind, ...fields });
};
const config = new ConfigService({
  DATABASE_URL: database.toString(),
  app: { rmqQueue: queue },
  rmqDelivery: {
    maxAttempts: 3,
    prefetch: 1,
    retryBaseMs: 50,
    retryMaxMs: 50,
    leaseMs: 30000,
  },
});
const prisma = new PrismaService(config);
const deliveries = new RmqDeliveryService(prisma, config);
const realHandle = deliveries.handle.bind(deliveries);
deliveries.handle = async (operation, data, context, work) => {
  const message = context.getMessage();
  notify(message.fields.redelivered ? 'redelivered' : 'delivered', {
    bodyHash: createHash('sha256').update(message.content).digest('hex'),
    messageId: message.properties.messageId,
  });
  if (process.env.RMQ_TEST_ACK_BARRIER === 'true') {
    // Independent parent DB reader verifies commit, then kills this process.
    context.getChannelRef().ack = () => notify('ack-waiting');
  }
  await realHandle(operation, data, context, work);
  notify('handled');
};
class FixtureModule {}
Module({
  controllers: [SessionCompletedConsumer],
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: RmqDeliveryService, useValue: deliveries },
    SessionCompletionService,
  ],
})(FixtureModule);
let app;
process.on('message', (message) => {
  if (message === 'stop')
    void app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
});
process.on('unhandledRejection', () => {
  notify('worker-failed');
  process.exit(1);
});
void (async () => {
  app = await NestFactory.createMicroservice(FixtureModule, {
    transport: Transport.RMQ,
    options: {
      urls: [rabbit.toString()],
      queue,
      queueOptions: { durable: true },
      noAck: false,
      prefetchCount: 1,
    },
  });
  await app.listen();
  notify('ready');
})().catch(() => {
  notify('worker-failed');
  process.exit(1);
});
