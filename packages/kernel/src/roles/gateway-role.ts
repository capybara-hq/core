import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { CHANNEL_CHANGED_TOPIC } from "../channels/connections.service.js";
import { ChannelSupervisor } from "../channels/supervisor.js";
import { ChannelWebhooks } from "../channels/webhook.js";
import { ExtensionHost } from "../extensions/host.js";
import type { GatewayRoutes } from "../http/gateway-routes.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_BUS } from "../infra/tokens.js";

/**
 * The gateway role's parts, driven by `KernelLifecycle` at fixed points of its start order and
 * stop phases: the channel long-connection supervisor (leader election and share) and the webhook
 * inbound (its raw Fastify route, {@link routes}, and its runtime cache's invalidation). Provided
 * only by `GatewayModule`, so a process without the gateway role has none of them.
 */
@Injectable()
export class GatewayRole {
  /** The supervisor's subscription to extension instance changes. */
  private unwatchPlugins: (() => void) | undefined;
  private unwatchWebhooks: (() => void) | undefined;
  /** The webhook cache's `channel.changed` subscription (a field: a test replaces it). */
  private unsubscribeWebhooks: (() => Promise<void>) | undefined;
  /** The supervisor was started: the runs phase stops it. */
  private supervisorStarted = false;

  constructor(
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    @Inject(KERNEL_BUS) private readonly bus: Pick<ExtensionContext["bus"], "subscribe">,
    @Inject(ChannelSupervisor) private readonly supervisor: ChannelSupervisor,
    @Inject(ChannelWebhooks) private readonly webhooks: ChannelWebhooks,
  ) {}

  /** The gateway role's HTTP routes (the channel webhook), registered when the app is built. */
  routes(): GatewayRoutes {
    return {
      webhooks: this.webhooks,
      webhookMaxBodyBytes: this.config.get().channels.webhookMaxBodyBytes,
    };
  }

  /**
   * Starts the supervisor and the webhook cache invalidation (after the extension load).
   * `checkpoint` throws when a stop began meanwhile.
   */
  async start(checkpoint: () => void): Promise<void> {
    const supervisor = this.supervisor;
    this.supervisorStarted = true;
    await supervisor.start();
    // An extension instance revoked or replaced: hand back the long connections it holds and
    // elect again on the new instance (C17)
    this.unwatchPlugins = this.host.onChange((plugin) => supervisor.pluginChanged(plugin));
    checkpoint();
    // The webhook runtime cache is read-through only: drop entries on every connection change and
    // whenever a plugin instance changes
    const webhooks = this.webhooks;
    this.unsubscribeWebhooks = await this.bus.subscribe(CHANNEL_CHANGED_TOPIC, (payload) => {
      const id = (payload as { connectionId?: unknown } | null)?.connectionId;
      if (typeof id === "string") webhooks.invalidate(id);
    });
    this.unwatchWebhooks = this.host.onChange(() => webhooks.invalidateAll());
    checkpoint();
  }

  /** Stops watching extension instance changes (the stop's first step). */
  unwatch(): void {
    this.unwatchPlugins?.();
    this.unwatchWebhooks?.();
  }

  /** Ends the webhook cache's `channel.changed` subscription. */
  unsubscribe(): Promise<void> {
    return this.unsubscribeWebhooks?.() ?? Promise.resolve();
  }

  /**
   * The runs phase: the supervisor aborts its connects and hands back its leases (undefined: never
   * started).
   */
  stopSupervisor(): Promise<void> | undefined {
    return this.supervisorStarted ? this.supervisor.stop() : undefined;
  }
}
