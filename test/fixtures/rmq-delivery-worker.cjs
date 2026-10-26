require('reflect-metadata');
const { ConfigService } = require('@nestjs/config');
const { RmqContext } = require('@nestjs/microservices');
const { EventEmitter2 } = require('eventemitter2');
const amqp = require('amqplib');
const { EventPatternType } = require('../../dist/loyalty/enums/loyalty.enums');
const { PrismaService } = require('../../dist/prisma/prisma.service');
const { LoyaltyService } = require('../../dist/loyalty/loyalty.service');
const {
  LoyaltyCalculatorService,
} = require('../../dist/loyalty/loyalty-calculator.service');
const {
  AchievementsService,
} = require('../../dist/achievements/achievements.service');
const {
  AchievementMapper,
} = require('../../dist/achievements/mappers/achievement.mapper');
const {
  RmqDeliveryService,
} = require('../../dist/loyalty/consumers/rmq-delivery.service');
const {
  TicketPurchasedConsumer,
} = require('../../dist/loyalty/consumers/ticket-purchased.consumer');
const {
  UserDateOfBirthSetConsumer,
} = require('../../dist/loyalty/consumers/user-date-of-birth-set.consumer');

const {
  CustomerFactsService,
} = require('../../dist/loyalty/customer-facts.service');
const {
  CustomerFactsChangedConsumer,
} = require('../../dist/loyalty/consumers/customer-facts-changed.consumer');
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
  throw new Error('Worker accepts only its disposable local fixture');
const notify = (kind, evidence = {}) => {
  if (process.connected) process.send({ kind, at: Date.now(), ...evidence });
};
const config = new ConfigService({
  DATABASE_URL: database.toString(),
  app: { rmqQueue: queue },
  rmqDelivery: {
    maxAttempts: 3,
    prefetch: 1,
    retryBaseMs: Number(process.env.RMQ_TEST_BACKOFF || 50),
    retryMaxMs: Number(process.env.RMQ_TEST_BACKOFF || 50),
    leaseMs: 30000,
  },
});
const prisma = new PrismaService(config);
const deliveries = new RmqDeliveryService(prisma, config);
const loyalty = new LoyaltyService(
  prisma,
  new EventEmitter2(),
  new LoyaltyCalculatorService(),
  new AchievementsService({}, prisma, new AchievementMapper()),
);
const facts = new CustomerFactsService(prisma);
let workCalls = 0;
for (const method of ['processTicketPurchase', 'processUserDateOfBirthSet']) {
  const real = loyalty[method].bind(loyalty);
  loyalty[method] = async (data) => {
    workCalls++;
    notify('work-started');
    const mode = process.env.RMQ_TEST_FAULT;
    if (mode === 'block' || mode === 'block-unknown')
      await new Promise((resolve) => {
        const release = (message) => {
          if (message !== 'release') return;
          process.removeListener('message', release);
          resolve();
        };
        process.on('message', release);
      });
    if (
      mode === 'unknown' ||
      mode === 'block-unknown' ||
      (mode === 'transient-once' && workCalls === 1) ||
      (mode === 'permanent' && workCalls === 1)
    ) {
      // Deliberately sensitive exception text: production logging must not emit it.
      const error = new Error(
        'private@example.invalid PRIVATE_NAME 1990-05-17 https://example.invalid/private-download PRIVATE_EXTRA',
      );
      if (mode === 'transient-once') error.code = 'P1001';
      if (mode === 'permanent') error.code = 'P2020';
      throw error;
    }
    return real(data);
  };
}
const purchase = new TicketPurchasedConsumer(loyalty, deliveries);
const dob = new UserDateOfBirthSetConsumer(loyalty, deliveries);
const customer = new CustomerFactsChangedConsumer(facts, deliveries);
let connection, channel;
async function stop() {
  deliveries.onModuleDestroy();
  await facts.onModuleDestroy();
  if (channel) await channel.close();
  if (connection) await connection.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('message', (message) => {
  if (message === 'stop') void stop().catch(() => process.exit(1));
});
process.on('unhandledRejection', () => {
  notify('worker-failed');
  process.exit(1);
});
void (async () => {
  await prisma.$connect();
  connection = await amqp.connect(rabbit.toString());
  connection.on('error', () => notify('connection-error'));
  channel = await connection.createChannel();
  channel.on('error', () => notify('channel-error'));
  await channel.assertQueue(queue, { durable: true });
  await channel.prefetch(1);
  if (process.env.RMQ_TEST_ACK_BARRIER === 'true') {
    // Test-only barrier: an independent DB reader verifies commit before crash.
    channel.ack = () => {
      notify('ack-waiting');
    };
  }
  if (process.env.RMQ_TEST_LOSE_ACK === 'true') {
    // Real channel/broker. Terminate immediately before writing the first basic.ack.
    channel.ack = () => {
      notify('ack-lost');
      process.exit(0);
    };
  }
  await channel.consume(
    queue,
    (message) => {
      if (!message) return;
      notify(message.fields.redelivered ? 'redelivered' : 'delivered', {
        bodyHash: require('node:crypto')
          .createHash('sha256')
          .update(message.content)
          .digest('hex'),
        messageId: message.properties.messageId,
      });
      const packet = JSON.parse(message.content.toString());
      const context = new RmqContext([message, channel, packet.pattern]);
      const handler =
        packet.pattern === EventPatternType.CUSTOMER_FACTS_CHANGED
          ? customer
          : packet.pattern === EventPatternType.USER_DATE_OF_BIRTH_SET
            ? dob
            : purchase;
      void handler
        .handle(packet.data, context)
        .then(() => notify('handled'))
        .catch(() => {
          notify('worker-failed');
          process.exit(1);
        });
    },
    { noAck: false },
  );
  await facts.recoverPending();
  notify('ready');
})().catch(() => {
  notify('worker-failed');
  process.exit(1);
});
