import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { PLUGIN_SCOPE_QUEUE } from "../catalog/scope-sync.js";
import { CHANNEL_QUEUE_NAME } from "../channels/jobs.js";
import { TITLE_QUEUE } from "../conversations/titles.js";
import { EVAL_QUEUE_NAME } from "../evals/jobs.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type LiveReplica, ReplicaPresence } from "../infra/presence/replica-presence.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../runtime/run-jobs.js";
import { USAGE_REPORT_QUEUE } from "../runtime/usage-report-jobs.js";
import { KERNEL_VERSION } from "../version.js";

/** The kernel's own queues, in the order the overview lists them (extension queues are not read). */
export const KERNEL_QUEUE_NAMES = [
  RUN_QUEUE_NAME,
  SUBAGENT_RUN_QUEUE_NAME,
  CHANNEL_QUEUE_NAME,
  MAINTENANCE_QUEUE_NAME,
  PLUGIN_SCOPE_QUEUE,
  TITLE_QUEUE,
  USAGE_REPORT_QUEUE,
  EVAL_QUEUE_NAME,
] as const;

/** How long each source's reads may take before the answer marks it unavailable. */
export const HEALTH_READ_TIMEOUT_MS = 3_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A live replica as the overview shows it. */
export interface AdminHealthReplica {
  /** The process id (the one extension status rows and the gateway heartbeat use). */
  id: string;
  roles: LiveReplica["roles"];
  version: string;
  startedAt: string;
  httpReplicaId: string | null;
}

/** One kernel queue: counts only, never job data or a failure text (spec §9). */
export interface AdminHealthQueue {
  name: (typeof KERNEL_QUEUE_NAMES)[number];
  /** Waiting to be picked up (a paused queue keeps them here too), prioritized ones included. */
  waiting: number;
  active: number;
  /** Delayed: scheduled for later, or waiting out a retry backoff. */
  delayed: number;
  /** Failed jobs still kept (each queue keeps the last 5000). */
  failed: number;
  /** Of those, the ones that failed in the last 24 hours (by `finishedOn`). */
  failedLastDay: number;
}

/** A source the answer could not read right now (its numbers are null). */
export type AdminHealthSource = "redis" | "database";

/**
 * The admin overview's 运行状况 (`GET /api/v1/admin/overview/health`, admin overview spec §5.2,
 * §6.2). Each source degrades on its own: when Redis does not answer, `replicas`, `roles`,
 * `queues`, `channels.online` / `.offline` and `devices.online` are null; when PostgreSQL does
 * not, the channel, device and sandbox numbers read from it are null; `unavailable` names them.
 */
export interface AdminHealth {
  kernel: { version: string };
  /** Live replicas (presence beat within its window), oldest start first. */
  replicas: AdminHealthReplica[] | null;
  /** Live replicas per role (a replica with several roles counts in each). */
  roles: { api: number; worker: number; gateway: number } | null;
  queues: AdminHealthQueue[] | null;
  /**
   * Channel connections of orgs not deleted (deleted connections are not counted):
   * - `online`: long connections held by a live gateway replica now (the replicas' own counts);
   * - `offline`: active long-connection connections no replica holds (`max(0, active − online)`):
   *   waiting for a gateway, backing off after a failure, or their plugin is off in the org;
   * - `webhook`: active connections in webhook mode (callbacks, nothing to hold);
   * - `disabled` / `error`: connections in that status, whatever their mode.
   */
  channels: {
    online: number | null;
    offline: number | null;
    webhook: number | null;
    disabled: number | null;
    error: number | null;
  };
  /**
   * `local`: local devices (not deleted, org not deleted); `online`: the devices whose connection a
   * live replica holds (lease held), at most `local`.
   */
  devices: { online: number | null; local: number | null };
  /** Sandbox instances by status, and running ones per provider (most first). */
  sandboxes: {
    running: number;
    suspended: number;
    byProvider: { provider: string; running: number }[];
  } | null;
  unavailable: AdminHealthSource[];
}

interface RedisFacts {
  replicas: LiveReplica[];
  queues: AdminHealthQueue[];
}

interface DbFacts {
  channels: { status: string; mode: string; n: number }[];
  localDevices: number;
  instances: { provider: string | null; status: string; n: number }[];
}

/** Rejects when `p` does not settle within `ms` (a down Redis makes commands wait, not fail). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    timer.unref?.();
  });
  p.catch(() => {}); // a late rejection after the timeout is not unhandled
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads the platform's health for the admin overview: the live replicas (replica presence), the
 * kernel queues (BullMQ counts plus a ZCOUNT of each failed set over the last 24 hours, the set's
 * score being `finishedOn`), and channel, device and sandbox counts (grouped PostgreSQL counts,
 * plus the connections the live replicas report holding). Not cached: it is cheap, and stale health
 * misleads. Reads the shared queue instances (no connection per request).
 */
@Injectable()
export class AdminHealthService {
  private readonly queues: Queue[];

  constructor(
    @Inject(ReplicaPresence) private readonly presence: Pick<ReplicaPresence, "live">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Pick<Redis, "zcount" | "status">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(getQueueToken(RUN_QUEUE_NAME)) runs: Queue,
    @Inject(getQueueToken(SUBAGENT_RUN_QUEUE_NAME)) subagentRuns: Queue,
    @Inject(getQueueToken(CHANNEL_QUEUE_NAME)) channels: Queue,
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) maintenance: Queue,
    @Inject(getQueueToken(PLUGIN_SCOPE_QUEUE)) pluginScope: Queue,
    @Inject(getQueueToken(TITLE_QUEUE)) titles: Queue,
    @Inject(getQueueToken(USAGE_REPORT_QUEUE)) usageReport: Queue,
    @Inject(getQueueToken(EVAL_QUEUE_NAME)) evals: Queue,
  ) {
    // the order of KERNEL_QUEUE_NAMES
    this.queues = [
      runs,
      subagentRuns,
      channels,
      maintenance,
      pluginScope,
      titles,
      usageReport,
      evals,
    ];
  }

  async read(): Promise<AdminHealth> {
    const [r, d] = await Promise.allSettled([
      within(this.readRedis(), HEALTH_READ_TIMEOUT_MS),
      // a query left running past the limit finishes on its pooled connection
      within(this.readDb(), HEALTH_READ_TIMEOUT_MS),
    ]);
    const unavailable: AdminHealthSource[] = [];
    const redis = r.status === "fulfilled" ? r.value : null;
    if (r.status === "rejected") {
      unavailable.push("redis");
      this.log.warn("admin health: cannot read Redis", { err: r.reason });
    }
    const db = d.status === "fulfilled" ? d.value : null;
    if (d.status === "rejected") {
      unavailable.push("database");
      this.log.warn("admin health: cannot read the database", { err: d.reason });
    }

    const replicas = redis?.replicas ?? null;
    const sum = (k: "channelsHeld" | "devicesConnected") =>
      replicas === null ? null : replicas.reduce((n, x) => n + x[k], 0);
    const online = sum("channelsHeld");
    const channelCount = (f: (c: DbFacts["channels"][number]) => boolean) =>
      db === null ? null : db.channels.filter(f).reduce((n, c) => n + c.n, 0);
    const longActive = channelCount((c) => c.status === "active" && c.mode === "long_connection");

    // Each replica counts only the devices whose lease it holds, so a device is online on at most
    // one; the clamp covers a lease handover in flight and devices deleted while still connected
    const connected = sum("devicesConnected");
    const devicesOnline =
      connected === null || db === null ? connected : Math.min(connected, db.localDevices);

    let sandboxes: AdminHealth["sandboxes"] = null;
    if (db !== null) {
      const byProvider = new Map<string, number>();
      let running = 0;
      let suspended = 0;
      for (const i of db.instances) {
        if (i.status === "suspended") suspended += i.n;
        if (i.status !== "running") continue;
        running += i.n;
        if (i.provider !== null) {
          byProvider.set(i.provider, (byProvider.get(i.provider) ?? 0) + i.n);
        }
      }
      sandboxes = {
        running,
        suspended,
        byProvider: [...byProvider]
          .map(([provider, n]) => ({ provider, running: n }))
          .sort((a, b) => b.running - a.running || a.provider.localeCompare(b.provider)),
      };
    }

    return {
      kernel: { version: KERNEL_VERSION },
      replicas:
        replicas?.map((x) => ({
          id: x.id,
          roles: x.roles,
          version: x.version,
          startedAt: x.startedAt,
          httpReplicaId: x.httpReplicaId,
        })) ?? null,
      roles:
        replicas === null
          ? null
          : {
              api: replicas.filter((x) => x.roles.includes("api")).length,
              worker: replicas.filter((x) => x.roles.includes("worker")).length,
              gateway: replicas.filter((x) => x.roles.includes("gateway")).length,
            },
      queues: redis?.queues ?? null,
      channels: {
        online,
        offline: online === null || longActive === null ? null : Math.max(0, longActive - online),
        webhook: channelCount((c) => c.status === "active" && c.mode === "webhook"),
        disabled: channelCount((c) => c.status === "disabled"),
        error: channelCount((c) => c.status === "error"),
      },
      devices: { online: devicesOnline, local: db?.localDevices ?? null },
      sandboxes,
      unavailable,
    };
  }

  private async readRedis(): Promise<RedisFacts> {
    // Fail fast while a connection is down: ioredis queues commands until it reconnects (the
    // BullMQ connections retry forever, maxRetriesPerRequest null), so with the page polling every
    // 30 s the reads would pile up in the offline queues instead of reporting Redis unavailable
    if (this.redis.status !== "ready") throw new Error(`redis is ${this.redis.status}`);
    for (const q of this.queues) {
      const status = (await q.getBackend().client).status;
      if (status !== "ready") throw new Error(`queue ${q.name} connection is ${status}`);
    }
    const since = Date.now() - DAY_MS;
    const [replicas, queues] = await Promise.all([
      this.presence.live(),
      Promise.all(
        this.queues.map(async (q, i): Promise<AdminHealthQueue> => {
          const [c, failedLastDay] = await Promise.all([
            q.getJobCounts("wait", "prioritized", "active", "delayed", "failed"),
            // the failed set is scored by finishedOn (pinned by the health test)
            this.redis.zcount(q.toKey("failed"), since, "+inf"),
          ]);
          return {
            name: KERNEL_QUEUE_NAMES[i] as AdminHealthQueue["name"],
            waiting: (c.wait ?? 0) + (c.prioritized ?? 0),
            active: c.active ?? 0,
            delayed: c.delayed ?? 0,
            failed: c.failed ?? 0,
            failedLastDay,
          };
        }),
      ),
    ]);
    return { replicas, queues };
  }

  private async readDb(): Promise<DbFacts> {
    const db = this.db.db;
    const [channels, devices, instances] = await Promise.all([
      db
        .selectFrom("channel_connections as c")
        .innerJoin("orgs as o", "o.id", "c.org_id")
        .select(["c.status as status", "c.inbound_mode as mode"])
        .select(sql<string>`count(*)`.as("n"))
        .where("c.deleted_at", "is", null)
        .where("o.deleted_at", "is", null)
        .groupBy(["c.status", "c.inbound_mode"])
        .execute(),
      db
        .selectFrom("devices as d")
        .innerJoin("orgs as o", "o.id", "d.org_id")
        .select(sql<string>`count(*)`.as("n"))
        .where("d.source", "=", "local")
        .where("d.deleted_at", "is", null)
        .where("o.deleted_at", "is", null)
        .executeTakeFirst(),
      // the partial indexes on device_instances (running / live) serve these statuses; an
      // instance of a deleted org is left out like its channels and devices
      db
        .selectFrom("device_instances as i")
        .innerJoin("orgs as o", "o.id", "i.org_id")
        .select(["i.provider as provider", "i.status as status"])
        .select(sql<string>`count(*)`.as("n"))
        .where("i.status", "in", ["running", "suspended"])
        .where("o.deleted_at", "is", null)
        .groupBy(["i.provider", "i.status"])
        .execute(),
    ]);
    return {
      channels: channels.map((c) => ({ status: c.status, mode: c.mode, n: Number(c.n) })),
      localDevices: Number(devices?.n ?? 0),
      instances: instances.map((i) => ({
        provider: i.provider,
        status: i.status,
        n: Number(i.n),
      })),
    };
  }
}
