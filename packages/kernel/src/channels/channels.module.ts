import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { type DynamicModule, Inject, Injectable, Module } from "@nestjs/common";
import { type Job, UnrecoverableError, type Worker } from "bullmq";
import type { KernelConfig } from "../config/schema.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { DevicesModule } from "../devices/devices.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import {
  configuredProcessor,
  type ProcessorWorkerOptions,
} from "../infra/queue/configured-processor.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { runJob } from "../infra/queue/run-job.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { SchedulesModule } from "../schedules/schedules.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ChannelConnections } from "./connections.service.js";
import { ChannelInbound } from "./inbound.js";
import {
  CHANNEL_QUEUE_NAME,
  type ChannelJobData,
  ChannelJobs,
  DELIVER_JOB,
  INBOUND_JOB,
} from "./jobs.js";
import { ChannelOutbound, deliverBackoff } from "./outbound.js";
import { AnonymousGuestLock, AnonymousGuests } from "./threads.js";

/** The channel queue's registration (its producer here; the admin health reads its counts). */
const CHANNEL_QUEUE_MODULE = QueueModule.registerQueue(CHANNEL_QUEUE_NAME);

/**
 * Channels on every role: the org's channel connections, inbound (dedupe and enqueue; the inbound
 * jobs), the outbound delivery, the producer of the channel queue `cap-kernel-channels`, the
 * anonymous guests. The roles' parts are the role modules': the queue's consumer
 * ({@link ChannelWorkersModule}) and the gateway check job are the worker role's, the long-connection
 * supervisor and the webhook inbound the gateway role's (`GatewayModule`).
 */
@Module({
  imports: [
    DevicesModule,
    EventLogModule,
    ExtensionsModule,
    IdentityModule,
    OrgLockModule,
    OrgsModule,
    ToolsModule,
    ConversationsModule,
    RuntimeModule,
    // outbound pauses the scheduled task of a run whose chat is gone (scheduled tasks spec §8)
    SchedulesModule,
    CHANNEL_QUEUE_MODULE,
  ],
  providers: [
    ChannelJobs,
    ChannelConnections,
    AnonymousGuestLock,
    AnonymousGuests,
    ChannelInbound,
    ChannelOutbound,
  ],
  exports: [
    ChannelJobs,
    ChannelConnections,
    AnonymousGuests,
    ChannelInbound,
    ChannelOutbound,
    CHANNEL_QUEUE_MODULE,
  ],
})
export class ChannelsModule {}

/**
 * The consumer of `cap-kernel-channels`: deliveries (`DELIVER_JOB`, owed through the outbox or
 * hinted) and inbound jobs (`INBOUND_JOB`), both handled by {@link ChannelOutbound}.
 */
@Injectable()
export class ChannelsProcessor extends WorkerHost<Worker<ChannelJobData>> {
  constructor(@Inject(ChannelOutbound) private readonly outbound: ChannelOutbound) {
    super();
  }

  process(job: Job<ChannelJobData>, token?: string): Promise<void> {
    if (job.name !== DELIVER_JOB && job.name !== INBOUND_JOB) {
      return Promise.reject(new UnrecoverableError(`unknown channel job "${job.name}"`));
    }
    return runJob(CHANNEL_QUEUE_NAME, job, () => this.outbound.process(job, token));
  }

  @OnWorkerEvent("failed")
  failed(job: Job<ChannelJobData> | undefined, err: Error): void {
    this.outbound.onFailed(job, err);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.outbound.onError(err);
  }
}

/**
 * The worker options of the channel queue's consumer, from the startup config: concurrency
 * `channels.deliveryConcurrency`, the run queue's job lock and stalled detection, and the delivery
 * backoff (a platform's retry-after, else exponential).
 */
export function channelsProcessorOptions(
  config: Pick<KernelConfig, "runtime" | "channels">,
): ProcessorWorkerOptions {
  return {
    concurrency: config.channels.deliveryConcurrency,
    lockDuration: config.runtime.jobLockMs,
    stalledInterval: config.runtime.stalledIntervalMs,
    maxStalledCount: 3,
    settings: { backoffStrategy: (n, _type, err) => deliverBackoff(n, err) },
  };
}

/**
 * The consumer of the channel queue (concurrency `channels.deliveryConcurrency`, the run queue's job
 * lock and stalled detection, the delivery backoff). Imported only by the worker role
 * (`WorkerModule`), so other roles get no processor and no BullMQ worker. It never starts by itself:
 * the worker role (`WorkerRole`) starts it after the extension load; `ChannelOutbound.close` closes it
 * on stop.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class ChannelWorkersModule {
  static forRoot(config: KernelConfig): DynamicModule {
    return {
      module: ChannelWorkersModule,
      imports: [ChannelsModule],
      providers: [
        configuredProcessor(
          ChannelsProcessor,
          CHANNEL_QUEUE_NAME,
          channelsProcessorOptions(config),
        ),
      ],
      exports: [ChannelsProcessor],
    };
  }
}
