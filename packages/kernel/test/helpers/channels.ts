import type { ExtensionContext, InboundEvent, Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { ChannelConnections } from "../../src/channels/connections.service.js";
import { ChannelInbound } from "../../src/channels/inbound.js";
import type { ChannelJobs } from "../../src/channels/jobs.js";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import { AnonymousGuestLock, AnonymousGuests } from "../../src/channels/threads.js";
import { ChannelWebhooks } from "../../src/channels/webhook.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { databaseHandles } from "./database.js";

const quiet = createLogger("error", { write: () => {} });

/** A webhook inbound over test doubles (the providers it injects, by name). */
export function channelWebhooksFor(d: {
  connections: Pick<ChannelConnections, "row" | "runtime">;
  inbound: Pick<ChannelInbound, "onEvent">;
  log: Pick<Logger, "warn">;
  handleTimeoutMs?: number;
  runtimeCacheMs?: number;
}): ChannelWebhooks {
  const w = new ChannelWebhooks(d.connections, d.inbound, d.log);
  if (d.handleTimeoutMs !== undefined) w.handleTimeoutMs = d.handleTimeoutMs;
  if (d.runtimeCacheMs !== undefined) w.runtimeCacheMs = d.runtimeCacheMs;
  return w;
}

/**
 * The inbound side over test doubles: real Redis for the dedupe markers, `jobs` for the channel
 * queue; every other dependency is a stub that throws when used.
 */
export function channelInboundFor(d: {
  redis: Redis;
  jobs: Pick<ChannelJobs, "enqueueInbound">;
}): ChannelInbound {
  const none = {} as never;
  return new ChannelInbound(
    none,
    d.redis,
    new LockService(d.redis, quiet),
    none,
    none,
    none,
    none,
    none,
    { enqueue: async () => {}, ...d.jobs },
    none,
    none,
    none,
    { warn: () => {}, info: () => {} },
  );
}

/**
 * A long-connection supervisor over test doubles: its own replica id, the channel plugins it
 * "loads" and the connections' runtimes; PG through the pool, real Redis (leases and heartbeats).
 */
export function channelSupervisorFor(d: {
  // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
  pool: Kysely<any>;
  redis: Redis;
  bus: ExtensionContext["bus"];
  connections: Pick<ChannelConnections, "runtime">;
  localPlugins: () => string[];
  onEvent: (connectionId: string, e: InboundEvent) => Promise<void>;
  config: () => Pick<KernelConfig, "channels">;
  log: Pick<Logger, "warn" | "error">;
  replicaId: string;
  onScan?: (claimOnly: boolean) => void;
  /** The lease source; default a `LockService` on `redis`. */
  locks?: Pick<LockService, "hold">;
}): ChannelSupervisor {
  const { db } = databaseHandles(d.pool, quiet);
  const sup = new ChannelSupervisor(
    db,
    d.redis,
    d.bus,
    d.locks ?? new LockService(d.redis, quiet),
    d.connections,
    {
      list: () => d.localPlugins().map((plugin) => ({ plugin, capability: "channel@1" })) as never,
    },
    { onEvent: d.onEvent },
    { get: () => d.config() as KernelConfig },
    d.log,
    { replicaId: d.replicaId },
  );
  sup.onScan = d.onScan;
  return sup;
}

/** The org's anonymous guest accounts over a test's own pool (the test database handles). */
// biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
export function anonymousGuestsFor(pool: Kysely<any>): AnonymousGuests {
  const { db, txHost, xactLock } = databaseHandles(pool, quiet);
  return new AnonymousGuests(db, new AnonymousGuestLock(xactLock, txHost), txHost);
}
