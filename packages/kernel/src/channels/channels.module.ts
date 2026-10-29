import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { type DynamicModule, Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Worker } from "bullmq";
import type { KernelConfig } from "../config/schema.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { EventLogModule } from "../conversations/event-log.js";
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
import { ToolsModule } from "../tools/tools.module.js";
import { ChannelConnections } from "./connections.service.js";
import { ChannelInbound } from "./inbound.js";
import { CHANNEL_QUEUE_NAME, type ChannelJobData, ChannelJobs } from "./jobs.js";
import { ChannelOutbound, deliverBackoff } from "./outbound.js";
import { ChannelSupervisor, GatewayCheckJob } from "./supervisor.js";
import { AnonymousGuestLock, AnonymousGuests } from "./threads.js";
import { ChannelWebhooks } from "./webhook.js";

/**
 * Channels on every role: the org's channel connections, inbound (dedupe and enqueue; the inbound
 * jobs), the outbound delivery, the producer of the channel queue `cap-kernel-channels`, the
 * anonymous guests and the gateway check job. The roles' parts (the queue's consumer, the
 * long-connection supervisor and the webhook inbound) are {@link ChannelRolesModule}'s.
 */
@Module({
  imports: [
    EventLogModule,
    ExtensionsModule,
    IdentityModule,
    OrgLockModule,
    OrgsModule,
    ToolsModule,
    ConversationsModule,
    RuntimeModule,
    QueueModule.registerQueue(CHANNEL_QUEUE_NAME),
  ],
  providers: [
    ChannelJobs,
    ChannelConnections,
    AnonymousGuestLock,
    AnonymousGuests,
    ChannelInbound,
    ChannelOutbound,
    GatewayCheckJob,
  ],
  exports: [ChannelJobs, ChannelConnections, AnonymousGuests, ChannelInbound, ChannelOutbound],
})
export class ChannelsModule {}

/** The consumer of `cap-kernel-channels` (deliveries and inbound jobs): {@link ChannelOutbound}. */
@Injectable()
export class ChannelsProcessor extends WorkerHost<Worker<ChannelJobData>> {
  constructor(@Inject(ChannelOutbound) private readonly outbound: ChannelOutbound) {
    super();
  }

  process(job: Job<ChannelJobData>, token?: string): Promise<void> {
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
 * The channels' role parts. Worker role: the consumer of the channel queue (concurrency
 * `channels.deliveryConcurrency`, the run queue's job lock and stalled detection, the delivery
 * backoff); it never starts by itself, `KernelLifecycle` starts it after the extension load and
 * closes it on stop. Gateway role: the long-connection supervisor (leader election and share) and
 * the webhook inbound, also driven by `KernelLifecycle` (started after the extension load).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class ChannelRolesModule {
  static forRoot(config: KernelConfig): DynamicModule {
    const worker = config.roles.includes("worker");
    const gateway = config.roles.includes("gateway");
    return {
      module: ChannelRolesModule,
      imports: [ChannelsModule, ExtensionsModule],
      providers: [
        ...(worker
          ? [
              configuredProcessor(
                ChannelsProcessor,
                CHANNEL_QUEUE_NAME,
                channelsProcessorOptions(config),
              ),
            ]
          : []),
        ...(gateway ? [ChannelSupervisor, ChannelWebhooks] : []),
      ],
      exports: [
        ChannelsModule,
        ...(worker ? [ChannelsProcessor] : []),
        ...(gateway ? [ChannelSupervisor, ChannelWebhooks] : []),
      ],
    };
  }
}
