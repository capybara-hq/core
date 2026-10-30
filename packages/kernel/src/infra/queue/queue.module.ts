import { BullModule } from "@nestjs/bullmq";
import { type DynamicModule, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import type { DefaultJobOptions } from "bullmq";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { QueueShutdown } from "./queue-shutdown.js";
import { bullConnectionOptions } from "./redis-connection.js";

/** Defaults of every job a kernel queue adds (the values `ctx.queue` uses today). */
export const QUEUE_JOB_DEFAULTS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * Global: the BullMQ root configuration (the kernel's Redis URL, BullMQ's default key prefix, which
 * the hand-made queues also use, and {@link QUEUE_JOB_DEFAULTS}). A feature module that owns a
 * queue imports `QueueModule.registerQueue(...names)` and declares a `@Processor(name)` provider;
 * without the registration the processor has no queue and never consumes. Queue names and job
 * ids must not contain `:`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class QueueModule {
  static forRoot(): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      imports: [
        DiscoveryModule,
        BullModule.forRootAsync({
          inject: [KernelConfigService],
          useFactory: (config: KernelConfigService) => ({
            connection: bullConnectionOptions(config.get().redis.url),
            defaultJobOptions: QUEUE_JOB_DEFAULTS,
          }),
        }),
      ],
      // every queue and worker closes within the stop budget (before @nestjs/bullmq's own close)
      providers: [QueueShutdown],
    };
  }

  /** Registers queues in the importing feature module (names without `:`). */
  static registerQueue(...names: string[]): DynamicModule {
    for (const name of names) {
      if (name.includes(":")) throw new Error(`queue name "${name}" must not contain ":"`);
    }
    // forceDisconnectOnShutdown: a queue's connection is dropped after its close at shutdown
    return BullModule.registerQueue(
      ...names.map((name) => ({ name, forceDisconnectOnShutdown: true })),
    );
  }
}
