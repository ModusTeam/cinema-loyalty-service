import {
  parseEnvironment,
  replayEnvSchema,
  runtimeEnvSchema,
} from './env.schema';
import type { RuntimeEnv } from './env.schema';
import rmqDeliveryConfig from './rmq-delivery.config';

export function createAppConfig(env: RuntimeEnv) {
  return {
    port: env.PORT,
    grpcUrl: env.GRPC_URL,
    rmqUrl: env.RMQ_URL,
    rmqQueue: env.RMQ_QUEUE,
    outboxPublishTimeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS,
    outboxLeaseMs: env.OUTBOX_LEASE_MS,
    outboxPublishConcurrency: env.OUTBOX_PUBLISH_CONCURRENCY,
  };
}

export function createRuntimeConfiguration(input: unknown) {
  const env = parseEnvironment(runtimeEnvSchema, input);
  return {
    ...env,
    app: createAppConfig(env),
    rmqDelivery: rmqDeliveryConfig(env),
  };
}

// ConfigModule executes this factory during dependency creation, before lifecycle
// hooks or transports start. Consumers receive parsed values, never raw env.
export default function appConfig() {
  return createRuntimeConfiguration(process.env);
}
export type RuntimeConfiguration = ReturnType<
  typeof createRuntimeConfiguration
>;

export function replayConfig() {
  const env = parseEnvironment(replayEnvSchema, process.env);
  return { ...env, app: { rmqUrl: env.RMQ_URL, rmqQueue: env.RMQ_QUEUE } };
}
export type ReplayConfiguration = ReturnType<typeof replayConfig>;

export function customerFactsMaintenanceConfig() {
  return parseEnvironment(
    replayEnvSchema.pick({ DATABASE_URL: true }),
    process.env,
  );
}
