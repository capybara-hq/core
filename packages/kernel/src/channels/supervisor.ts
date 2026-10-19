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

/** 连续失败的退避上限。 */
const MAX_BACKOFF_MS = 300_000;
/** 连续失败计数的保留时长（秒）。 */
const FAILS_TTL_SECONDS = 3600;
/** 中止后等插件 `connect` 返回的上限；超时则不主动释放租约，让它自然过期。 */
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
  onEvent(connectionId: string, e: InboundEvent): Promise<void>;
  config: () => Pick<KernelConfig, "channels">;
  log: Pick<Logger, "warn" | "error">;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 渠道长连接选主（只在 worker 角色运行）：每个副本每 `channels.scanIntervalMs`（默认 10s）一轮——
 * 先为本进程持有的连接续租（`capk:channel-lease:<id>`，TTL `channels.leaseTtlMs` 默认 30s）并复核连接仍为 active，
 * 再扫描无人持有的 active 连接，`SET NX PX` 取到租约的副本调用插件 `connect`（传 `signal`）。
 * 续租失败（租约已丢）→ 立即中止，不释放（已不是自己的）；连接被停用 / 删除 / 改配置（内核 bus `channel.changed`，
 * 或续租时复核发现）→ 中止、等 `connect` 返回后释放租约，下一轮任一副本按新配置重连。
 * `connect` 抛错或提前返回 → 记 `last_error`，在 Redis 写退避标记（指数退避，上限 5 分钟），释放租约后由任一副本重试。
 * 停机时中止全部长连接并释放租约。持有的长连接、租约 token 与定时器都是「本进程持有的资源」，
 * 跨副本的状态（租约、退避、失败计数）都在 Redis。
 */
export class ChannelSupervisor {
  private readonly held = new Map<string, Held>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private unsubscribe: (() => Promise<void>) | undefined;

  constructor(private readonly deps: ChannelSupervisorDeps) {}

  async start(): Promise<void> {
    this.unsubscribe = await this.deps.bus.subscribe(CHANNEL_CHANGED_TOPIC, (payload) => {
      const m = payload as { connectionId?: unknown; reconnect?: unknown } | null;
      const id = m?.connectionId;
      if (m?.reconnect === true && typeof id === "string" && this.held.has(id)) {
        void this.release(id);
      }
    });
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.ticking = this.tick()
        .catch((err) => this.deps.log.error("channel supervisor tick failed", { err }))
        .finally(() => {
          this.ticking = undefined;
          this.schedule(this.deps.config().channels.scanIntervalMs);
        });
    }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    await this.renewAll();
    await this.recheckHeld();
    if (!this.stopped) await this.scan();
  }

  private async renewAll(): Promise<void> {
    const ttl = this.deps.config().channels.leaseTtlMs;
    for (const [id, h] of [...this.held]) {
      let ok: boolean;
      try {
        ok = Number(await this.deps.redis.eval(RENEW, 1, channelLeaseKey(id), h.token, ttl)) === 1;
      } catch (err) {
        // Redis 暂时不可用：超过一个 TTL 都没续上，租约可能已被别的副本拿走，按丢失处理
        this.deps.log.warn("channel lease renew failed", { connectionId: id, err });
        ok = Date.now() - h.renewedAt < ttl;
        if (ok) continue;
      }
      if (!ok) {
        this.deps.log.warn("channel lease lost; disconnecting", { connectionId: id });
        this.drop(id, h);
        continue;
      }
      h.renewedAt = Date.now();
      if (!h.stable && Date.now() - h.startedAt >= ttl) {
        h.stable = true;
        await this.deps.redis.del(channelFailsKey(id)).catch(() => {});
      }
    }
  }

  /** 持有的连接仍须是 active 且未删除（bus 广播是尽力而为，这里兜底）。 */
  private async recheckHeld(): Promise<void> {
    const ids = [...this.held.keys()];
    if (ids.length === 0) return;
    const live = new Set(
      (
        await this.deps.db
          .selectFrom("channel_connections")
          .select("id")
          .where("id", "in", ids)
          .where("status", "=", "active")
          .where("deleted_at", "is", null)
          .execute()
      ).map((r) => r.id),
    );
    for (const id of ids) if (!live.has(id)) await this.release(id);
  }

  private async scan(): Promise<void> {
    const rows = await this.deps.db
      .selectFrom("channel_connections")
      .select("id")
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .execute();
    for (const { id } of rows) {
      if (this.stopped) return;
      if (this.held.has(id)) continue;
      if ((await this.deps.redis.exists(channelBackoffKey(id))) === 1) continue;
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
    let rt: Awaited<ReturnType<ChannelConnections["runtime"]>>;
    try {
      rt = await this.deps.connections.runtime(id);
    } catch (err) {
      await this.failed(id, err);
      await this.releaseLease(id, token);
      return;
    }
    // 插件异常信息可能带上凭据：写进 last_error / 日志前按该连接的密钥打码
    const redact = createRedactor(secretValues(rt.channel.connectionSchema, rt.config), 4);
    const abort = new AbortController();
    const now = Date.now();
    const h: Held = {
      token,
      abort,
      done: Promise.resolve(),
      startedAt: now,
      renewedAt: now,
      stable: false,
    };
    this.held.set(id, h);
    h.done = (async () => {
      try {
        await rt.channel.connect({
          connectionId: id,
          config: rt.config,
          onEvent: (e) => this.deps.onEvent(id, e),
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

  /** 主动交还：中止，等 `connect` 返回（至多 SETTLE_MS）后释放租约；超时则让租约自然过期，避免两边同时在线。 */
  private async release(id: string): Promise<void> {
    const h = this.held.get(id);
    if (!h) return;
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

  /** 停机：停止扫描，中止全部长连接并释放租约。幂等。 */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.ticking?.catch(() => {});
    await this.unsubscribe?.().catch(() => {});
    this.unsubscribe = undefined;
    await Promise.all([...this.held.keys()].map((id) => this.release(id)));
  }
}
