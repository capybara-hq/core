import { randomUUID } from "node:crypto";
import {
  CHANNEL_EXTENSION_POINT,
  type ExtensionContext,
  type Logger,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { secretValues } from "../config/fields.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { enabledExtensionsByOrg } from "../extensions/enabled.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { ReplicaStatusStore } from "../extensions/sources.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type LeaseHandle, LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { createRedactor, type KernelLogger } from "../log.js";
import {
  CHANNEL_CHANGED_TOPIC,
  ChannelConnections,
  channelBackoffKey,
  channelFailsKey,
} from "./connections.service.js";
import { ChannelInbound } from "./inbound.js";
import { GATEWAY_CHECK_JOB } from "./job-ids.js";

/** 长连接租约键（内核锁）：值为持有方的随机 token。 */
export const channelLeaseKey = (connectionId: string) => `capk:channel-lease:${connectionId}`;

/**
 * Gateway heartbeats, one ZSET per channel plugin (Ruling R3): members are process replica ids of the
 * gateways that have that plugin loaded, scores the Redis server time (ms) of the member's last
 * lease-renewal round. Live = score > server now - `leaseTtlMs`. Per plugin, so a gateway that cannot
 * load a plugin does not count toward that plugin's share.
 */
export const gatewayReplicasKey = (plugin: string) => `capk:gateway-replicas:${plugin}`;

/** Bus topic published after an over-share replica handed a connection back (claim-only nudge). */
export const CHANNEL_HANDOFF_TOPIC = "channel.handoff";

/**
 * Handoff marker written when an over-share replica gives a connection back: value = that replica's
 * id, PX = 2 x `scanIntervalMs`. The releasing replica does not claim the connection while it exists.
 */
export const channelHandoffKey = (connectionId: string) => `capk:channel-handoff:${connectionId}`;

/** Rate-limit key of the "no live gateway" warning (one line per check interval, cluster-wide). */
export const gatewayMissingWarnedKey = "capk:gateway-missing-warned";

/**
 * Upper bound of the connections one gateway replica holds: `ceil(runnable / live) + slack`, with
 * `live < 1` treated as 1. With `rank` (this replica's index among the live replicas sorted by id)
 * the remainder goes to the lowest ranks only, so the per-replica targets add up to exactly
 * `runnable + live * slack`: with slack 0, 4 connections on 3 replicas split 2 / 1 / 1 instead of
 * leaving a newcomer with nothing next to two replicas that each sit at the ceiling. Rank 0 (the
 * default) gets the full ceiling.
 */
export function shareTarget(runnable: number, live: number, slack: number, rank = 0): number {
  const n = Math.max(1, live);
  return Math.floor(runnable / n) + (rank < runnable % n ? 1 : 0) + slack;
}

/** 连续失败的退避上限。 */
const MAX_BACKOFF_MS = 300_000;
/** 连续失败计数的保留时长（秒）。 */
const FAILS_TTL_SECONDS = 3600;
/**
 * 中止后等插件 `connect` 返回的上限：等待期间照常续租；超时则停止续租、不主动释放，让租约在一个 TTL 后自然过期。
 */
const SETTLE_MS = 5_000;
/** `last_error` 的最大长度。 */
const MAX_ERROR_CHARS = 1000;

/**
 * Heartbeat with the Redis server clock (replica wall clocks may drift): for each key, ZADD the
 * member, trim members older than one TTL and refresh the key's expiry. KEYS = heartbeat keys to
 * write; ARGV = [member, ttlMs, ...stale keys to leave].
 */
const HEARTBEAT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[2])
for _, k in ipairs(KEYS) do
  redis.call('ZADD', k, now, ARGV[1])
  redis.call('ZREMRANGEBYSCORE', k, '-inf', now - ttl)
  redis.call('PEXPIRE', k, ttl * 2)
end
for i = 3, #ARGV do
  redis.call('ZREM', ARGV[i], ARGV[1])
end
return now
`;

/**
 * Live members per heartbeat key, by the Redis server clock: returns one array per key (in KEYS
 * order) of members with score > now - ARGV[1].
 */
const LIVE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local out = {}
for i, k in ipairs(KEYS) do
  out[i] = redis.call('ZRANGEBYSCORE', k, '(' .. (now - tonumber(ARGV[1])), '+inf')
end
return out
`;

/** Live heartbeat members of each plugin (Redis server clock). */
export async function liveGateways(
  redis: Redis,
  plugins: string[],
  ttlMs: number,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (plugins.length === 0) return out;
  const res = (await redis.eval(
    LIVE,
    plugins.length,
    ...plugins.map(gatewayReplicasKey),
    ttlMs,
  )) as string[][];
  plugins.forEach((p, i) => {
    out.set(p, res[i] ?? []);
  });
  return out;
}

/** 本进程持有的一条长连接。 */
interface Held {
  /** 提供这条连接的插件（实例撤销 / 替换时据此交还）。 */
  plugin: string;
  /** The lease `capk:channel-lease:<id>` (LockService renews it; `lost` drops the connection). */
  lease: LeaseHandle;
  abort: AbortController;
  done: Promise<void>;
  startedAt: number;
  /** 最近一次续租成功的时刻。 */
  renewedAt: number;
  /** 已连续稳定运行超过一个租约周期并清掉了失败计数。 */
  stable: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 渠道长连接选主（runs only on the gateway role: a provider of the gateway role, started and stopped by
 * `KernelLifecycle` after the extension load）。每个副本两个各自独立的循环，周期都是 `channels.scanIntervalMs`（默认 10s）：
 * - 心跳循环：写本副本的 gateway 心跳，再为本进程持有的连接续一次租。它不做任何可能慢的事（不等交还、不查库），
 *   一个插件迟迟不退出不会拖慢其他连接的续租。
 * - 扫描循环：复核持有的连接仍为 active、未删除且插件在该组织启用（不满足就交还，交还不阻塞本轮），
 *   再扫描无人持有的这类连接，取到租约（`LockService.hold`）的副本调用插件 `connect`（传 `signal`）。
 * 租约 `capk:channel-lease:<id>`（值为本副本的随机 token，TTL `channels.leaseTtlMs` 默认 30s）由 `LockService` 续租
 * （每 TTL/3，另加心跳循环里的一次）。租约丢失（被改写 / 已过期，或 Redis 出错直到下一次续租会落在过期之后，R17）→
 * 立即中止，不释放（已不是自己的）。连接被停用 / 删除 / 改配置（内核 bus `channel.changed`，
 * 或扫描时复核发现）→ 中止、等 `connect` 返回后释放租约，下一轮任一副本按新配置重连；取得租约到 `connect` 开始之间
 * 收到的重连广播会被记下，开始后立即交还。
 * `connect` 抛错或提前返回 → 记 `last_error`，在 Redis 写退避标记（指数退避，上限 5 分钟），释放租约后由任一副本重试。
 * Fair share (E11-B): the heartbeat loop writes this replica's heartbeat into `capk:gateway-replicas`;
 * each scan computes this replica's target from the runnable count and the live replicas
 * (`shareTarget`), stops claiming at the target and, when above it, gives back one connection per
 * round (the most recently connected) with a handoff marker. Exactly one holder per connection is
 * still guaranteed by the lease alone; the share only decides who claims.
 * 停机时中止全部长连接并释放租约，并等进行中的 `onEvent`（入队）结束。持有的长连接、租约与定时器都是「本进程持有的资源」，
 * 跨副本的状态（租约、退避、失败计数）都在 Redis。
 */
@Injectable()
export class ChannelSupervisor {
  private readonly held = new Map<string, Held>();
  /** 已取得租约、正在读配置准备 `connect` 的连接；值为期间是否收到了重连广播。 */
  private readonly connecting = new Map<string, { reconnect: boolean }>();
  /** 进行中的交还（`stop()` 要等它们全部结束）。 */
  private readonly releasing = new Set<Promise<void>>();
  /** 进行中的 `onEvent`（去重 + 入队，很快）：`stop()` 等它们结束，插件才不会在内核关闭队列之后才拿到结果。 */
  private readonly inflight = new Set<Promise<void>>();
  private readonly loops: {
    timer?: NodeJS.Timeout | undefined;
    running?: Promise<void> | undefined;
  }[] = [];
  private stopped = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private unsubscribeHandoff: (() => Promise<void>) | undefined;
  /** Scans run one at a time (periodic and nudged), so share counts are never raced. */
  private scanChain: Promise<void> = Promise.resolve();
  /** Plugins this replica heartbeats for (to ZREM when a plugin goes away and on stop). */
  private heartbeated = new Set<string>();
  /** A claim-only scan is queued and has not started yet: further nudges until then are dropped. */
  private claimQueued = false;
  /**
   * This process's replica id (`ReplicaStatusStore.replicaId`), the member of the gateway heartbeat
   * ZSET. Not `http.replicaId`, which is optional and may repeat across replicas.
   */
  readonly replicaId: string;
  /** Called at the start of every scan round (`claimOnly` for handoff nudges); for tests / metrics. */
  onScan: ((claimOnly: boolean) => void) | undefined;

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(LockService) private readonly locks: Pick<LockService, "hold">,
    @Inject(ChannelConnections) private readonly connections: Pick<ChannelConnections, "runtime">,
    /** The channel extensions loaded in this process (`channel@1` providers). */
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    /** Events from a plugin's `connect` (dedupe and enqueue; ack after it resolves). */
    @Inject(ChannelInbound) private readonly inbound: Pick<ChannelInbound, "onEvent">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn" | "error">,
    @Inject(ReplicaStatusStore) replicaStatus: Pick<ReplicaStatusStore, "replicaId">,
  ) {
    this.replicaId = replicaStatus.replicaId;
  }

  /** 本进程已加载、提供 `channel@1` 的插件名。 */
  private localPlugins(): string[] {
    return this.registry
      .list("channel")
      .filter((e) => e.capability === CHANNEL_EXTENSION_POINT)
      .map((e) => e.plugin);
  }

  async start(): Promise<void> {
    this.unsubscribe = await this.bus.subscribe(CHANNEL_CHANGED_TOPIC, (payload) => {
      const m = payload as { connectionId?: unknown; reconnect?: unknown } | null;
      const id = m?.connectionId;
      if (m?.reconnect !== true || typeof id !== "string") return;
      if (this.held.has(id)) this.releaseInBackground(id);
      else {
        const c = this.connecting.get(id);
        if (c) c.reconnect = true;
      }
    });
    // Another replica handed a connection back: claim right away instead of waiting for the next
    // round. Claim only (no hand-back), so hand-backs stay at one per plugin per scan round.
    // Nudges coalesce: at most one claim-only scan waits behind the one running; nudges for a
    // plugin not loaded here are ignored.
    this.unsubscribeHandoff = await this.bus.subscribe(CHANNEL_HANDOFF_TOPIC, (payload) => {
      const m = payload as { replicaId?: unknown; plugin?: unknown } | null;
      if (this.stopped || m?.replicaId === this.replicaId || this.claimQueued) return;
      if (typeof m?.plugin !== "string" || !this.localPlugins().includes(m.plugin)) return;
      this.claimQueued = true;
      const run = this.exclusive(() => {
        this.claimQueued = false;
        return this.scan(true);
      });
      this.track(run).catch((err: unknown) =>
        this.log.error("channel supervisor scan failed", { err }),
      );
    });
    this.loop("heartbeat", () => this.heartbeatRound());
    this.loop("scan", () =>
      this.exclusive(async () => {
        await this.recheckHeld();
        if (!this.stopped) await this.scan(false);
      }),
    );
  }

  /** Runs `fn` after any scan in progress. */
  private exclusive(fn: () => Promise<void>): Promise<void> {
    const p = this.scanChain.then(fn);
    this.scanChain = p.catch(() => {});
    return p;
  }

  /** 周期循环：上一轮结束后隔 `scanIntervalMs` 再跑下一轮；首轮立即执行。 */
  private loop(name: string, fn: () => Promise<void>): void {
    const st: { timer?: NodeJS.Timeout | undefined; running?: Promise<void> | undefined } = {};
    this.loops.push(st);
    const run = (ms: number) => {
      if (this.stopped) return;
      st.timer = setTimeout(() => {
        st.running = fn()
          .catch((err) => this.log.error(`channel supervisor ${name} failed`, { err }))
          .finally(() => {
            st.running = undefined;
            run(this.config.get().channels.scanIntervalMs);
          });
      }, ms);
      st.timer.unref?.();
    };
    run(0);
  }

  /**
   * One heartbeat round: the heartbeat first, then one renewal of every lease held (on top of
   * `LockService`'s own), so a crashed replica's heartbeat goes stale no later than its leases
   * expire and the survivors' share already excludes it when those connections free up.
   */
  private async heartbeatRound(): Promise<void> {
    const ttl = this.config.get().channels.leaseTtlMs;
    await this.heartbeat(ttl);
    await Promise.all(
      [...this.held].map(async ([id, h]) => {
        // false marks the lease lost (`lost` aborts, the connection drops); a Redis error is the
        // watchdog's to judge (lost once renewals failed until the next would land past expiry)
        // a Redis error is the watchdog's to log and judge (R19: lost at the deadline)
        const ok = await h.lease.renew().catch(() => undefined);
        if (ok === true) await this.afterRenew(id, h, ttl);
        // false: the key is gone or taken, or the lease was already lost (`drop` is idempotent)
        else if (ok === false) this.drop(id, h);
      }),
    );
  }

  /**
   * Writes this replica's heartbeat into the ZSET of every channel plugin loaded here (trimming
   * members older than one TTL; the keys expire too) and leaves the ZSETs of plugins no longer
   * loaded. Uses the Redis server clock.
   */
  private async heartbeat(ttl: number): Promise<void> {
    if (this.stopped) return;
    const plugins = [...new Set(this.localPlugins())];
    const gone = [...this.heartbeated].filter((p) => !plugins.includes(p));
    if (plugins.length === 0 && gone.length === 0) return;
    try {
      await this.redis.eval(
        HEARTBEAT,
        plugins.length,
        ...plugins.map(gatewayReplicasKey),
        this.replicaId,
        ttl,
        ...gone.map(gatewayReplicasKey),
      );
      this.heartbeated = new Set(plugins);
    } catch (err) {
      this.log.warn("gateway heartbeat failed", { err });
    }
  }

  /**
   * This replica's share target per plugin for the round. Live replicas of a plugin are its
   * heartbeat members newer than one TTL plus this replica itself (its own heartbeat may not be
   * written yet on the first round).
   */
  private async targets(runnable: Map<string, number>): Promise<Map<string, number>> {
    const { leaseTtlMs: ttl, shareSlack } = this.config.get().channels;
    const plugins = [...runnable.keys()];
    const live = await liveGateways(this.redis, plugins, ttl);
    const out = new Map<string, number>();
    for (const p of plugins) {
      const members = [...new Set([...(live.get(p) ?? []), this.replicaId])].sort();
      const rank = members.indexOf(this.replicaId);
      out.set(p, shareTarget(runnable.get(p) ?? 0, members.length, shareSlack, rank));
    }
    return out;
  }

  private heldOf(plugin: string): number {
    let n = 0;
    for (const h of this.held.values()) if (h.plugin === plugin) n++;
    return n;
  }

  /**
   * Gives back the most recently connected connection of `plugin`, leaving a handoff marker first;
   * once its lease is released, nudges the other replicas to claim it.
   */
  private async handOff(plugin: string): Promise<void> {
    let latest: [string, Held] | undefined;
    for (const e of this.held) {
      if (e[1].plugin !== plugin) continue;
      if (!latest || e[1].startedAt > latest[1].startedAt) latest = e;
    }
    if (!latest) return;
    const [id] = latest;
    const px = this.config.get().channels.scanIntervalMs * 2;
    await this.redis.set(channelHandoffKey(id), this.replicaId, "PX", px);
    this.releaseInBackground(id, this.nudge(plugin));
  }

  /** After-release callback: tells the other replicas a connection of `plugin` is free to claim. */
  private nudge(plugin: string): () => Promise<void> {
    return () =>
      this.bus
        .publish(CHANNEL_HANDOFF_TOPIC, { plugin, replicaId: this.replicaId })
        .catch((err: unknown) => this.log.warn("cannot publish channel handoff", { err }));
  }

  /** A renewal succeeded: one lease period connected in a row clears the failure count. */
  private async afterRenew(id: string, h: Held, ttl: number): Promise<void> {
    h.renewedAt = Date.now();
    if (!h.stable && Date.now() - h.startedAt >= ttl) {
      h.stable = true;
      await this.redis.del(channelFailsKey(id)).catch(() => {});
    }
  }

  /**
   * 可以持有的连接：active、未删除、所属组织未删除、插件在该组织启用（组织停用插件 / 删除组织时持有方据此断开），
   * 且插件在本进程已加载——滚动升级期间还没有该插件的副本根本不考虑它（不取租约、不记失败），留给有插件的副本。
   */
  private runnable(plugins: string[]) {
    const db = this.db.db;
    return (
      db
        .selectFrom("channel_connections")
        .innerJoin("orgs", "orgs.id", "channel_connections.org_id")
        .innerJoin(enabledExtensionsByOrg(db).as("en"), (j) =>
          j
            .onRef("en.plugin", "=", "channel_connections.plugin")
            .onRef("en.org_id", "=", "channel_connections.org_id"),
        )
        .select(["channel_connections.id", "channel_connections.plugin"])
        .where("channel_connections.status", "=", "active")
        // Webhook-mode connections get callbacks on the gateway route instead (F9)
        .where("channel_connections.inbound_mode", "=", "long_connection")
        .where("channel_connections.deleted_at", "is", null)
        .where("orgs.deleted_at", "is", null)
        .where("channel_connections.plugin", "in", plugins)
    );
  }

  /**
   * 持有的连接仍须可持有（bus 广播是尽力而为，这里兜底）。交还不等待：交还要等插件 `connect` 返回（至多 SETTLE_MS），
   * 不能让一个迟迟不退出的插件拖住扫描。
   */
  private async recheckHeld(): Promise<void> {
    const ids = [...this.held.keys()];
    if (ids.length === 0) return;
    const plugins = this.localPlugins();
    const live = new Set(
      plugins.length === 0
        ? []
        : (await this.runnable(plugins).where("channel_connections.id", "in", ids).execute()).map(
            (r) => r.id,
          ),
    );
    for (const id of ids) {
      const h = this.held.get(id);
      if (h && !live.has(id)) this.releaseInBackground(id, this.nudge(h.plugin));
    }
  }

  /**
   * One scan round, per channel plugin (Ruling R3): above that plugin's share, give back one of its
   * connections (never more, so this replica does not drop below its target) and claim none of it;
   * otherwise claim unheld ones up to the target. `claimOnly` (a handoff nudge) never gives back.
   */
  private async scan(claimOnly: boolean): Promise<void> {
    if (this.stopped) return;
    this.onScan?.(claimOnly);
    const plugins = this.localPlugins();
    if (plugins.length === 0) return;
    const rows = await this.runnable(plugins).execute();
    const runnable = new Map<string, number>();
    for (const r of rows) runnable.set(r.plugin, (runnable.get(r.plugin) ?? 0) + 1);
    const targets = await this.targets(runnable);
    const full = new Set<string>();
    for (const [p, target] of targets) {
      const held = this.heldOf(p);
      if (held > target && !claimOnly) await this.handOff(p);
      if (held >= target) full.add(p);
    }
    for (const { id, plugin } of rows) {
      if (this.stopped) return;
      if (full.has(plugin)) continue;
      if (this.heldOf(plugin) >= (targets.get(plugin) ?? 0)) {
        full.add(plugin);
        continue;
      }
      if (this.held.has(id)) continue;
      if ((await this.redis.exists(channelBackoffKey(id))) === 1) continue;
      if ((await this.redis.get(channelHandoffKey(id))) === this.replicaId) continue;
      const ttl = this.config.get().channels.leaseTtlMs;
      const lease = await this.locks.hold(channelLeaseKey(id), randomUUID(), ttl);
      if (!lease) continue;
      if (this.stopped) {
        await lease.release();
        return;
      }
      await this.connect(id, lease);
    }
  }

  /** 已取得租约：读配置并在后台跑插件的 `connect`。 */
  private async connect(id: string, lease: LeaseHandle): Promise<void> {
    const pending = { reconnect: false };
    this.connecting.set(id, pending);
    let rt: Awaited<ReturnType<ChannelConnections["runtime"]>>;
    try {
      rt = await this.connections.runtime(id);
    } catch (err) {
      this.connecting.delete(id);
      await this.failed(id, err);
      await lease.release();
      return;
    }
    // The lease was lost while the config was read (an aborted signal never fires a listener
    // added later): not ours any more, so no connect and no release
    if (lease.lost.aborted) {
      this.connecting.delete(id);
      lease.abandon();
      return;
    }
    // 插件异常信息可能带上凭据：写进 last_error / 日志前按该连接的密钥打码
    const redact = createRedactor(secretValues(rt.channel.connectionSchema, rt.config), 4);
    const abort = new AbortController();
    const now = Date.now();
    const h: Held = {
      plugin: rt.row.plugin,
      lease,
      abort,
      done: Promise.resolve(),
      startedAt: now,
      renewedAt: now,
      stable: false,
    };
    this.held.set(id, h);
    this.connecting.delete(id);
    // 租约丢失（LockService 记一行 `lock lost`）：中止，不释放（已不是自己的）
    lease.lost.addEventListener("abort", () => this.drop(id, h), { once: true });
    h.done = (async () => {
      try {
        await rt.channel.connect({
          connectionId: id,
          config: rt.config,
          onEvent: (e) => this.track(this.inbound.onEvent(id, e)),
          signal: abort.signal,
        });
        if (!abort.signal.aborted) throw new Error("connect returned before it was aborted");
      } catch (err) {
        if (abort.signal.aborted) return;
        await this.failed(id, err, redact);
      } finally {
        // 自己结束（出错 / 提前返回）：交还租约，退避后由任一副本重试
        if (!abort.signal.aborted && this.held.get(id) === h) {
          this.held.delete(id);
          await lease.release();
        }
      }
    })();
    // 读配置期间收到了重连广播（配置可能已在读取之后改过）：立即交还，下一轮按新配置重连
    if (pending.reconnect) this.releaseInBackground(id);
  }

  /** 记下进行中的 `onEvent`，原样返回（结果与异常都交给插件）。 */
  private track(p: Promise<void>): Promise<void> {
    const t: Promise<void> = p.then(
      () => {},
      () => {},
    );
    this.inflight.add(t);
    void t.then(() => this.inflight.delete(t));
    return p;
  }

  /** 记录失败：`last_error`、连续失败计数与退避标记（都跨副本可见）。 */
  private async failed(id: string, err: unknown, redact?: (s: string) => string): Promise<void> {
    const raw = errMsg(err);
    const message = (redact ? redact(raw) : raw).slice(0, MAX_ERROR_CHARS);
    this.log.warn("channel connection failed", { connectionId: id, error: message });
    try {
      const fails = await this.redis.incr(channelFailsKey(id));
      await this.redis.expire(channelFailsKey(id), FAILS_TTL_SECONDS);
      const delay = Math.min(
        MAX_BACKOFF_MS,
        this.config.get().channels.retryBaseMs * 2 ** Math.min(fails - 1, 20),
      );
      await this.redis.set(channelBackoffKey(id), "1", "PX", delay);
      await this.db
        .updateTable("channel_connections")
        .set({ last_error: message })
        .where("id", "=", id)
        .execute();
    } catch (e) {
      this.log.warn("cannot record channel failure", { connectionId: id, err: e });
    }
  }

  /** 租约已丢：中止，不释放（已不是自己的；续租已停）。 */
  private drop(id: string, h: Held): void {
    if (this.held.get(id) !== h) return;
    this.held.delete(id);
    h.lease.abandon();
    h.abort.abort();
  }

  /** 后台交还，记入 `releasing` 供 `stop()` 等待；`after` runs once the lease is released. */
  private releaseInBackground(id: string, after?: () => Promise<void>): void {
    const p = this.release(id)
      .then(async (released) => {
        if (released && after) await after();
      })
      .finally(() => this.releasing.delete(p));
    this.releasing.add(p);
  }

  /**
   * 主动交还：中止，等 `connect` 返回（至多 SETTLE_MS，期间租约照常续着，不会在别的副本眼里提前过期）后释放租约；
   * 超时则停止续租、让租约自然过期，避免两边同时在线。
   */
  private async release(id: string): Promise<boolean> {
    const h = this.held.get(id);
    if (!h) return false;
    this.held.delete(id);
    h.abort.abort();
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      h.done.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), SETTLE_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (settled) await h.lease.release();
    else {
      h.lease.abandon();
      this.log.warn("channel connect did not stop in time; lease left to expire", {
        connectionId: id,
      });
    }
    return settled;
  }

  /**
   * 本进程的插件实例变了（撤销、替换为新实例；内核接 `host.onChange`，C17）：交还该插件持有的全部长连接
   * （中止旧实例的 `connect`、等它返回后释放租约）。插件仍在本进程（新实例）时，下一轮扫描由任一副本按新实例重新选主；
   * 已撤销则本副本不再考虑它（`localPlugins` 里没有了）。
   */
  pluginChanged(plugin: string): void {
    if (this.stopped) return;
    for (const [id, h] of this.held) {
      if (h.plugin === plugin) this.releaseInBackground(id, this.nudge(plugin));
    }
  }

  /** 停机：停止扫描，中止全部长连接并释放租约。幂等。 */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const st of this.loops) clearTimeout(st.timer);
    await Promise.all(this.loops.map((st) => st.running?.catch(() => {})));
    await this.unsubscribe?.().catch(() => {});
    this.unsubscribe = undefined;
    await this.unsubscribeHandoff?.().catch(() => {});
    this.unsubscribeHandoff = undefined;
    // A nudged scan may still be claiming: let it finish so its leases are released below
    await this.scanChain;
    // Leave the share first so the other gateways count one replica fewer right away
    await Promise.all(
      [...this.heartbeated].map((p) =>
        this.redis.zrem(gatewayReplicasKey(p), this.replicaId).catch((err: unknown) => {
          this.log.warn("cannot remove gateway heartbeat", { plugin: p, err });
        }),
      ),
    );
    this.heartbeated.clear();
    await Promise.all([...this.held.keys()].map((id) => this.release(id)));
    // 别处发起、仍在进行的交还（bus 广播、复核）也要等完，租约才都释放了
    await Promise.all([...this.releasing]);
    // 插件交来的事件已在入队途中：等它们结束（之后内核才关闭队列）
    await Promise.all([...this.inflight]);
  }
}

export { GATEWAY_CHECK_JOB, GATEWAY_CHECK_SCHEDULER_ID } from "./job-ids.js";
/** The period of the gateway check (`@LockedCron` every minute). */
export const GATEWAY_CHECK_EVERY_MS = 60_000;

/**
 * Warns when channel connections need a gateway and none is live (Ruling R1 / R3 / R4):
 * {@link checkGatewayPresence}, every minute, once across replicas. Silent for one lease TTL after
 * this process starts (the gateways' first heartbeats). Replaces the maintenance scheduler
 * `channel-gateway-check-every` (retired at worker start).
 */
@Injectable()
export class GatewayCheckJob {
  /** The start of the grace period: when this process built its providers. */
  private readonly graceFrom = Date.now();

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("* * * * *", { name: GATEWAY_CHECK_JOB })
  async run(): Promise<void> {
    await checkGatewayPresence({
      db: this.db.db,
      redis: this.redis,
      locks: this.lockService,
      config: this.config,
      log: this.log,
      graceUntil: this.graceFrom + this.config.get().channels.leaseTtlMs,
    });
  }
}

/**
 * Runs once a minute across replicas ({@link GatewayCheckJob}), per channel plugin (Ruling R3): when a plugin has
 * active connections (not deleted, org not deleted, plugin enabled for the org; long connection or
 * webhook mode, Ruling R4) but no gateway replica with that plugin loaded has a heartbeat newer than
 * one lease TTL (Redis server clock), nobody holds those long connections or answers their webhooks.
 * - Logs one `warn` (naming the plugins) per interval at most across the cluster: a Redis
 *   marker (`LockService.lease`, a `SET NX PX`) a little shorter than the job period, so a
 *   duplicated job or several replicas do not repeat it while each period still gets its line.
 * - Silent before `graceUntil` (this process's start + one lease TTL), so a fresh cluster does not
 *   warn before the gateways' first heartbeat.
 * Returns whether it warned.
 */
export async function checkGatewayPresence(deps: {
  db: KernelSchemaDb;
  redis: Redis;
  locks: Pick<LockService, "lease">;
  config: { get(): Pick<KernelConfig, "channels"> };
  log: Pick<Logger, "warn">;
  everyMs?: number;
  graceUntil?: number;
}): Promise<boolean> {
  if (deps.graceUntil !== undefined && Date.now() < deps.graceUntil) return false;
  // Webhook-mode connections count too (Ruling R4): the webhook route is served only by gateway
  // replicas, so without one their callbacks get no answer either
  const rows = await deps.db
    .selectFrom("channel_connections")
    .innerJoin("orgs", "orgs.id", "channel_connections.org_id")
    .innerJoin(enabledExtensionsByOrg(deps.db).as("en"), (j) =>
      j
        .onRef("en.plugin", "=", "channel_connections.plugin")
        .onRef("en.org_id", "=", "channel_connections.org_id"),
    )
    .select(["channel_connections.plugin", (eb) => eb.fn.countAll<string>().as("n")])
    .where("channel_connections.status", "=", "active")
    .where("channel_connections.deleted_at", "is", null)
    .where("orgs.deleted_at", "is", null)
    .groupBy("channel_connections.plugin")
    .execute();
  const counts = new Map(rows.map((r) => [r.plugin, Number(r.n)] as const));
  const plugins = [...counts.keys()].filter((p) => (counts.get(p) ?? 0) > 0).sort();
  if (plugins.length === 0) return false;
  const live = await liveGateways(deps.redis, plugins, deps.config.get().channels.leaseTtlMs);
  const missing = plugins.filter((p) => (live.get(p) ?? []).length === 0);
  if (missing.length === 0) return false;
  const everyMs = deps.everyMs ?? GATEWAY_CHECK_EVERY_MS;
  const first = await deps.locks.lease(
    gatewayMissingWarnedKey,
    "1",
    Math.max(Math.ceil(everyMs / 2), everyMs - 5_000),
  );
  if (!first) return false;
  deps.log.warn(
    "active channel connections have no live gateway replica with their plugin loaded; add the gateway role to a process (CAPYBARA_ROLES) that can load the plugin, or they receive no messages",
    {
      plugins: missing,
      connections: missing.reduce((n, p) => n + (counts.get(p) ?? 0), 0),
    },
  );
  return true;
}
