import { randomUUID } from "node:crypto";
import type { InboundEvent, Logger, PluginContext } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { secretValues } from "../config/fields.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { createRedactor } from "../log.js";
import {
  CHANNEL_CHANGED_TOPIC,
  type ChannelConnections,
  channelBackoffKey,
  channelFailsKey,
} from "./connections.service.js";

/** 长连接租约键（内核锁）：值为持有方的随机 token。 */
export const channelLeaseKey = (connectionId: string) => `capk:channel-lease:${connectionId}`;

/**
 * Gateway heartbeats: a ZSET whose members are process replica ids and whose scores are the
 * millisecond time of the member's last lease-renewal round. Live = score > now - `leaseTtlMs`.
 */
export const gatewayReplicasKey = "capk:gateway-replicas";

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

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** 本进程持有的一条长连接。 */
interface Held {
  /** 提供这条连接的插件（实例撤销 / 替换时据此交还）。 */
  plugin: string;
  token: string;
  abort: AbortController;
  done: Promise<void>;
  startedAt: number;
  /** 最近一次续租成功的时刻。 */
  renewedAt: number;
  /** 已连续稳定运行超过一个租约周期并清掉了失败计数。 */
  stable: boolean;
}

export interface ChannelSupervisorDeps {
  db: KernelDb;
  redis: Redis;
  bus: PluginContext["bus"];
  connections: Pick<ChannelConnections, "runtime">;
  /** 本进程已加载、提供 `channel@1` 的插件名（内核传 `host.list("channel")`）。 */
  localPlugins: () => string[];
  onEvent(connectionId: string, e: InboundEvent): Promise<void>;
  config: () => Pick<KernelConfig, "channels">;
  log: Pick<Logger, "warn" | "error">;
  /**
   * This process's replica id (`newReplicaId()` in kernel.ts), the member of the gateway heartbeat
   * ZSET. Not `http.replicaId`, which is optional and may repeat across replicas.
   */
  replicaId: string;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 渠道长连接选主（runs only on the gateway role）。每个副本两个各自独立的循环，周期都是 `channels.scanIntervalMs`（默认 10s）：
 * - 续租循环：为本进程持有的连接续租（`capk:channel-lease:<id>`，TTL `channels.leaseTtlMs` 默认 30s）。
 *   它不做任何可能慢的事（不等交还、不查库），一个插件迟迟不退出不会拖慢其他连接的续租。
 * - 扫描循环：复核持有的连接仍为 active、未删除且插件在该组织启用（不满足就交还，交还不阻塞本轮），
 *   再扫描无人持有的这类连接，`SET NX PX` 取到租约的副本调用插件 `connect`（传 `signal`）。
 * 续租失败（租约已丢）→ 立即中止，不释放（已不是自己的）；Redis 出错时，自上次续租成功起满 `TTL - 扫描周期`
 * 仍续不上就按丢失处理（赶在租约可能被别的副本拿走之前断开）。连接被停用 / 删除 / 改配置（内核 bus `channel.changed`，
 * 或扫描时复核发现）→ 中止、等 `connect` 返回后释放租约，下一轮任一副本按新配置重连；取得租约到 `connect` 开始之间
 * 收到的重连广播会被记下，开始后立即交还。
 * `connect` 抛错或提前返回 → 记 `last_error`，在 Redis 写退避标记（指数退避，上限 5 分钟），释放租约后由任一副本重试。
 * Fair share (E11-B): the renewal loop also writes this replica's heartbeat into `capk:gateway-replicas`;
 * each scan computes this replica's target from the runnable count and the live replicas
 * (`shareTarget`), stops claiming at the target and, when above it, gives back one connection per
 * round (the most recently connected) with a handoff marker. Exactly one holder per connection is
 * still guaranteed by the lease alone; the share only decides who claims.
 * 停机时中止全部长连接并释放租约，并等进行中的 `onEvent`（入队）结束。持有的长连接、租约 token 与定时器都是「本进程持有的资源」，
 * 跨副本的状态（租约、退避、失败计数）都在 Redis。
 */
export class ChannelSupervisor {
  private readonly held = new Map<string, Held>();
  /** 已取得租约、正在读配置准备 `connect` 的连接；值为期间是否收到了重连广播。 */
  private readonly connecting = new Map<string, { reconnect: boolean }>();
  /** 正在交还（已中止、等 `connect` 返回）的连接 → 租约 token：等待期间照常续租，交还完成才释放。 */
  private readonly settling = new Map<string, string>();
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

  constructor(private readonly deps: ChannelSupervisorDeps) {}

  async start(): Promise<void> {
    this.unsubscribe = await this.deps.bus.subscribe(CHANNEL_CHANGED_TOPIC, (payload) => {
      const m = payload as { connectionId?: unknown; reconnect?: unknown } | null;
      const id = m?.connectionId;
      if (m?.reconnect !== true || typeof id !== "string") return;
      if (this.held.has(id)) this.releaseInBackground(id);
      else {
        const c = this.connecting.get(id);
        if (c) c.reconnect = true;
      }
    });
    this.loop("renew", () => this.renewAll());
    this.loop("scan", async () => {
      await this.recheckHeld();
      if (!this.stopped) await this.scan();
    });
  }

  /** 周期循环：上一轮结束后隔 `scanIntervalMs` 再跑下一轮；首轮立即执行。 */
  private loop(name: string, fn: () => Promise<void>): void {
    const st: { timer?: NodeJS.Timeout | undefined; running?: Promise<void> | undefined } = {};
    this.loops.push(st);
    const run = (ms: number) => {
      if (this.stopped) return;
      st.timer = setTimeout(() => {
        st.running = fn()
          .catch((err) => this.deps.log.error(`channel supervisor ${name} failed`, { err }))
          .finally(() => {
            st.running = undefined;
            run(this.deps.config().channels.scanIntervalMs);
          });
      }, ms);
      st.timer.unref?.();
    };
    run(0);
  }

  private async renewAll(): Promise<void> {
    const { leaseTtlMs: ttl, scanIntervalMs } = this.deps.config().channels;
    // Heartbeat before renewing: a crashed replica's heartbeat then goes stale no later than its
    // leases expire, so the survivors' share already excludes it when those connections free up
    await this.heartbeat(ttl);
    await Promise.all(
      [...this.held].map(async ([id, h]) => {
        let ok: boolean;
        try {
          ok =
            Number(await this.deps.redis.eval(RENEW, 1, channelLeaseKey(id), h.token, ttl)) === 1;
        } catch (err) {
          // Redis 暂时不可用：再等一轮就可能超过 TTL（租约在别的副本眼里已过期），提前按丢失处理
          this.deps.log.warn("channel lease renew failed", { connectionId: id, err });
          ok = Date.now() - h.renewedAt < ttl - scanIntervalMs;
          if (ok) return;
        }
        await this.afterRenew(id, h, ok, ttl);
      }),
    );
    // 交还中的连接：插件还没退出，租约不能在别的副本眼里过期（否则两边同时在线）；续不上就算了（已不是自己的）
    await Promise.all(
      [...this.settling].map(([id, token]) =>
        this.deps.redis.eval(RENEW, 1, channelLeaseKey(id), token, ttl).catch((err: unknown) => {
          this.deps.log.warn("channel lease renew failed", { connectionId: id, err });
        }),
      ),
    );
  }

  /** Writes this replica's heartbeat and drops members older than one TTL; the key itself expires too. */
  private async heartbeat(ttl: number): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    try {
      await this.deps.redis
        .multi()
        .zadd(gatewayReplicasKey, now, this.deps.replicaId)
        .zremrangebyscore(gatewayReplicasKey, "-inf", now - ttl)
        .pexpire(gatewayReplicasKey, ttl * 2)
        .exec();
    } catch (err) {
      this.deps.log.warn("gateway heartbeat failed", { err });
    }
  }

  /**
   * This replica's share target for the round. Live replicas are the heartbeat members newer than
   * one TTL plus this replica itself (its own heartbeat may not be written yet on the first round).
   */
  private async target(runnable: number): Promise<number> {
    const { leaseTtlMs: ttl, shareSlack } = this.deps.config().channels;
    const members = await this.deps.redis.zrangebyscore(
      gatewayReplicasKey,
      `(${Date.now() - ttl}`,
      "+inf",
    );
    const live = [...new Set([...members, this.deps.replicaId])].sort();
    return shareTarget(runnable, live.length, shareSlack, live.indexOf(this.deps.replicaId));
  }

  /** Gives back the most recently connected connection, leaving a handoff marker first. */
  private async handOff(): Promise<void> {
    let latest: [string, Held] | undefined;
    for (const e of this.held) if (!latest || e[1].startedAt > latest[1].startedAt) latest = e;
    if (!latest) return;
    const [id] = latest;
    const px = this.deps.config().channels.scanIntervalMs * 2;
    await this.deps.redis.set(channelHandoffKey(id), this.deps.replicaId, "PX", px);
    this.releaseInBackground(id);
  }

  private async afterRenew(id: string, h: Held, ok: boolean, ttl: number): Promise<void> {
    if (!ok) {
      this.deps.log.warn("channel lease lost; disconnecting", { connectionId: id });
      this.drop(id, h);
      return;
    }
    h.renewedAt = Date.now();
    if (!h.stable && Date.now() - h.startedAt >= ttl) {
      h.stable = true;
      await this.deps.redis.del(channelFailsKey(id)).catch(() => {});
    }
  }

  /**
   * 可以持有的连接：active、未删除、所属组织未删除、插件在该组织启用（组织停用插件 / 删除组织时持有方据此断开），
   * 且插件在本进程已加载——滚动升级期间还没有该插件的副本根本不考虑它（不取租约、不记失败），留给有插件的副本。
   */
  private runnable(plugins: string[]) {
    return this.deps.db
      .selectFrom("channel_connections")
      .innerJoin("orgs", "orgs.id", "channel_connections.org_id")
      .innerJoin("plugin_org_configs", (j) =>
        j
          .onRef("plugin_org_configs.plugin", "=", "channel_connections.plugin")
          .onRef("plugin_org_configs.org_id", "=", "channel_connections.org_id"),
      )
      .select("channel_connections.id")
      .where("plugin_org_configs.enabled", "=", true)
      .where("channel_connections.status", "=", "active")
      .where("channel_connections.deleted_at", "is", null)
      .where("orgs.deleted_at", "is", null)
      .where("channel_connections.plugin", "in", plugins);
  }

  /**
   * 持有的连接仍须可持有（bus 广播是尽力而为，这里兜底）。交还不等待：交还要等插件 `connect` 返回（至多 SETTLE_MS），
   * 不能让一个迟迟不退出的插件拖住扫描。
   */
  private async recheckHeld(): Promise<void> {
    const ids = [...this.held.keys()];
    if (ids.length === 0) return;
    const plugins = this.deps.localPlugins();
    const live = new Set(
      plugins.length === 0
        ? []
        : (await this.runnable(plugins).where("channel_connections.id", "in", ids).execute()).map(
            (r) => r.id,
          ),
    );
    for (const id of ids) if (!live.has(id)) this.releaseInBackground(id);
  }

  private async scan(): Promise<void> {
    const plugins = this.deps.localPlugins();
    if (plugins.length === 0) return;
    const rows = await this.runnable(plugins).execute();
    const target = await this.target(rows.length);
    // Above the share: give back one per round (never more, so this replica does not drop below
    // its target) and claim nothing
    if (this.held.size > target) {
      await this.handOff();
      return;
    }
    for (const { id } of rows) {
      if (this.stopped) return;
      if (this.held.size >= target) return;
      if (this.held.has(id)) continue;
      if ((await this.deps.redis.exists(channelBackoffKey(id))) === 1) continue;
      if ((await this.deps.redis.get(channelHandoffKey(id))) === this.deps.replicaId) continue;
      const token = randomUUID();
      const ttl = this.deps.config().channels.leaseTtlMs;
      const ok = await this.deps.redis.set(channelLeaseKey(id), token, "PX", ttl, "NX");
      if (ok !== "OK") continue;
      if (this.stopped) {
        await this.releaseLease(id, token);
        return;
      }
      await this.connect(id, token);
    }
  }

  /** 已取得租约：读配置并在后台跑插件的 `connect`。 */
  private async connect(id: string, token: string): Promise<void> {
    const pending = { reconnect: false };
    this.connecting.set(id, pending);
    let rt: Awaited<ReturnType<ChannelConnections["runtime"]>>;
    try {
      rt = await this.deps.connections.runtime(id);
    } catch (err) {
      this.connecting.delete(id);
      await this.failed(id, err);
      await this.releaseLease(id, token);
      return;
    }
    // 插件异常信息可能带上凭据：写进 last_error / 日志前按该连接的密钥打码
    const redact = createRedactor(secretValues(rt.channel.connectionSchema, rt.config), 4);
    const abort = new AbortController();
    const now = Date.now();
    const h: Held = {
      plugin: rt.row.plugin,
      token,
      abort,
      done: Promise.resolve(),
      startedAt: now,
      renewedAt: now,
      stable: false,
    };
    this.held.set(id, h);
    this.connecting.delete(id);
    h.done = (async () => {
      try {
        await rt.channel.connect({
          connectionId: id,
          config: rt.config,
          onEvent: (e) => this.track(this.deps.onEvent(id, e)),
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
          await this.releaseLease(id, token);
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
    this.deps.log.warn("channel connection failed", { connectionId: id, error: message });
    try {
      const fails = await this.deps.redis.incr(channelFailsKey(id));
      await this.deps.redis.expire(channelFailsKey(id), FAILS_TTL_SECONDS);
      const delay = Math.min(
        MAX_BACKOFF_MS,
        this.deps.config().channels.retryBaseMs * 2 ** Math.min(fails - 1, 20),
      );
      await this.deps.redis.set(channelBackoffKey(id), "1", "PX", delay);
      await this.deps.db
        .updateTable("channel_connections")
        .set({ last_error: message })
        .where("id", "=", id)
        .execute();
    } catch (e) {
      this.deps.log.warn("cannot record channel failure", { connectionId: id, err: e });
    }
  }

  /** 租约已丢：中止，不释放（已不是自己的）。 */
  private drop(id: string, h: Held): void {
    if (this.held.get(id) === h) this.held.delete(id);
    h.abort.abort();
  }

  /** 后台交还，记入 `releasing` 供 `stop()` 等待。 */
  private releaseInBackground(id: string): void {
    const p = this.release(id).finally(() => this.releasing.delete(p));
    this.releasing.add(p);
  }

  /** 主动交还：中止，等 `connect` 返回（至多 SETTLE_MS）后释放租约；超时则让租约自然过期，避免两边同时在线。 */
  private async release(id: string): Promise<void> {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    this.settling.set(id, h.token);
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
    if (this.settling.get(id) === h.token) this.settling.delete(id);
    if (settled) await this.releaseLease(id, h.token);
    else
      this.deps.log.warn("channel connect did not stop in time; lease left to expire", {
        connectionId: id,
      });
  }

  private async releaseLease(id: string, token: string): Promise<void> {
    try {
      await this.deps.redis.eval(RELEASE, 1, channelLeaseKey(id), token);
    } catch (err) {
      this.deps.log.warn("cannot release channel lease", { connectionId: id, err });
    }
  }

  /**
   * 本进程的插件实例变了（撤销、替换为新实例；内核接 `host.onChange`，C17）：交还该插件持有的全部长连接
   * （中止旧实例的 `connect`、等它返回后释放租约）。插件仍在本进程（新实例）时，下一轮扫描由任一副本按新实例重新选主；
   * 已撤销则本副本不再考虑它（`localPlugins` 里没有了）。
   */
  pluginChanged(plugin: string): void {
    if (this.stopped) return;
    for (const [id, h] of this.held) if (h.plugin === plugin) this.releaseInBackground(id);
  }

  /** 停机：停止扫描，中止全部长连接并释放租约。幂等。 */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const st of this.loops) clearTimeout(st.timer);
    await Promise.all(this.loops.map((st) => st.running?.catch(() => {})));
    await this.unsubscribe?.().catch(() => {});
    this.unsubscribe = undefined;
    // Leave the share first so the other gateways count one replica fewer right away
    await this.deps.redis.zrem(gatewayReplicasKey, this.deps.replicaId).catch((err: unknown) => {
      this.deps.log.warn("cannot remove gateway heartbeat", { err });
    });
    await Promise.all([...this.held.keys()].map((id) => this.release(id)));
    // 别处发起、仍在进行的交还（bus 广播、复核）也要等完，租约才都释放了
    await Promise.all([...this.releasing]);
    // 插件交来的事件已在入队途中：等它们结束（之后内核才关闭队列）
    await Promise.all([...this.inflight]);
  }
}

/** Maintenance job that warns when channel connections need a gateway and none is live (Ruling R1). */
export const GATEWAY_CHECK_JOB = "channel-gateway-check";
export const GATEWAY_CHECK_SCHEDULER_ID = "channel-gateway-check-every";
export const GATEWAY_CHECK_EVERY_MS = 60_000;

/**
 * Runs on the worker role (maintenance queue): when active channel connections exist but no
 * gateway replica has a heartbeat newer than one lease TTL, nobody holds their long connections.
 * Logs one `warn` per `everyMs` at most across the cluster (a Redis `SET NX PX` rate limit), so a
 * duplicated job or several worker replicas do not repeat it. Returns whether it warned.
 */
export async function checkGatewayPresence(deps: {
  db: KernelDb;
  redis: Redis;
  config: () => Pick<KernelConfig, "channels">;
  log: Pick<Logger, "warn">;
  everyMs?: number;
}): Promise<boolean> {
  const ttl = deps.config().channels.leaseTtlMs;
  const live = await deps.redis.zcount(gatewayReplicasKey, `(${Date.now() - ttl}`, "+inf");
  if (live > 0) return false;
  const row = await deps.db
    .selectFrom("channel_connections")
    .innerJoin("orgs", "orgs.id", "channel_connections.org_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("channel_connections.status", "=", "active")
    .where("channel_connections.deleted_at", "is", null)
    .where("orgs.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  const count = Number(row.n);
  if (count === 0) return false;
  const first = await deps.redis.set(
    gatewayMissingWarnedKey,
    "1",
    "PX",
    deps.everyMs ?? GATEWAY_CHECK_EVERY_MS,
    "NX",
  );
  if (first !== "OK") return false;
  deps.log.warn(
    "active channel connections have no live gateway replica; add the gateway role to a process (CAPYBARA_ROLES) or they receive no messages",
    { connections: count },
  );
  return true;
}
