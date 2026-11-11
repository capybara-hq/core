import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { KernelLogger } from "../../log.js";
import { KERNEL_VERSION } from "../../version.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { KERNEL_LOGGER, REDIS } from "../tokens.js";

/** How often each process writes its presence (admin overview spec §5.1). */
export const PRESENCE_DEFAULT_INTERVAL_MS = 15_000;

/** Optional provider: the presence interval (ms) instead of {@link PRESENCE_DEFAULT_INTERVAL_MS} (tests). */
export const PRESENCE_INTERVAL_MS = Symbol("PRESENCE_INTERVAL_MS");

/** The ZSET of live replicas: member = replica id, score = last beat (Redis server clock, ms). */
export const REPLICAS_KEY = "capk:replicas";

/** One replica's facts: `capk:replica:<replicaId>`. */
export const replicaKey = (replicaId: string): string => `capk:replica:${replicaId}`;

/** A kernel role (`roles` in the config). */
export type ReplicaRole = "api" | "worker" | "gateway";

/** What a live replica last reported about itself. */
export interface LiveReplica {
  /** The process id (`ReplicaStatusStore.replicaId`, the gateway heartbeat's member). */
  id: string;
  roles: ReplicaRole[];
  /** `KERNEL_VERSION` of the process. */
  version: string;
  /** When the process's start sequence was done, before it listens (ISO 8601). */
  startedAt: string;
  /** The configured `http.replicaId` (the `x-capybara-replica` header), null when unset. */
  httpReplicaId: string | null;
  /** Channel long connections this process holds (0 without the gateway role). */
  channelsHeld: number;
  /** Device sockets open on this process (0 without the gateway role). */
  devicesConnected: number;
}

/** The per-process facts the presence reports, read at every beat. */
export interface PresenceSources {
  /** This process's replica id (`ReplicaStatusStore.replicaId`). */
  replicaId: string;
  channelsHeld(): number;
  devicesConnected(): number;
}

/**
 * One beat: ZADD the member at the server clock, write the facts, give both keys a TTL of the
 * window and trim members older than it. KEYS: the ZSET, the replica's hash. ARGV: the replica id,
 * the window (ms), then the hash's field / value pairs.
 */
const BEAT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('HSET', KEYS[2], unpack(ARGV, 3))
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
return now
`;

/** The members newer than the window (ARGV[1], ms) by the Redis server clock. */
const LIVE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
return redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. (now - tonumber(ARGV[1])), '+inf')
`;

const ROLES: readonly ReplicaRole[] = ["api", "worker", "gateway"];

const count = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/**
 * The replicas with a beat newer than `windowMs` (Redis server clock): one script for the members,
 * then one pipelined HGETALL each. A member whose facts already expired is left out. Sorted by
 * start time, then id.
 */
export async function readLiveReplicas(
  redis: Pick<Redis, "eval" | "pipeline">,
  windowMs: number,
): Promise<LiveReplica[]> {
  const ids = (await redis.eval(LIVE, 1, REPLICAS_KEY, windowMs)) as string[];
  if (ids.length === 0) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(replicaKey(id));
  const res = (await pipe.exec()) ?? [];
  const out: LiveReplica[] = [];
  ids.forEach((id, i) => {
    const [err, h] = res[i] ?? [null, null];
    if (err) throw err;
    const f = h as Record<string, string> | null;
    if (f === null || f.version === undefined) return;
    out.push({
      id,
      roles: (f.roles ?? "")
        .split(",")
        .filter((r): r is ReplicaRole => ROLES.includes(r as ReplicaRole)),
      version: f.version,
      startedAt: f.startedAt ?? "",
      httpReplicaId: f.httpReplicaId ? f.httpReplicaId : null,
      channelsHeld: count(f.channelsHeld),
      devicesConnected: count(f.devicesConnected),
    });
  });
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

/**
 * Replica presence (admin overview spec §5.1): every process, whatever its roles, says every
 * {@link PRESENCE_DEFAULT_INTERVAL_MS} that it is alive, with its roles, version, start time and
 * the connections it holds, so the admin console can tell which replicas run in which role.
 *
 * Multi-replica: the state lives only in Redis, with a TTL of three intervals on both keys; the
 * score is the Redis server clock (replica clocks may drift), as in the gateway heartbeat. Each
 * process writes only its own entry and holds nothing other processes need: no lock, no
 * transaction, no shared job. So it is not a `@LockedInterval` (that runs once across replicas)
 * but a `setTimeout` chain of this process (`unref`), started by `KernelLifecycle` at the end of
 * the start (after the start gate opened) and stopped first thing in the stop, which removes the
 * entry at once; a crashed process ages out of {@link live} within the window. A failing beat is
 * logged at warn and never thrown.
 */
@Injectable()
export class ReplicaPresence {
  /** The beat interval; the window (and the TTL) is three of them. */
  readonly intervalMs: number;
  private sources: PresenceSources | undefined;
  private startedAt = "";
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private halted = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional() @Inject(PRESENCE_INTERVAL_MS) intervalMs?: number,
  ) {
    this.intervalMs = intervalMs ?? PRESENCE_DEFAULT_INTERVAL_MS;
  }

  /** How long an entry stays live without a beat (ms). */
  get windowMs(): number {
    return this.intervalMs * 3;
  }

  /** Starts beating (the first beat at once). Called once, at the end of the start. */
  start(sources: PresenceSources): void {
    if (this.sources !== undefined || this.halted) return;
    this.sources = sources;
    this.startedAt = new Date().toISOString();
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.halted) return;
    this.timer = setTimeout(() => {
      this.running = this.beat().finally(() => {
        this.running = undefined;
        this.schedule(this.intervalMs);
      });
    }, ms);
    this.timer.unref?.();
  }

  private async beat(): Promise<void> {
    const s = this.sources;
    if (s === undefined || this.halted) return;
    try {
      const http = this.config.get().http.replicaId;
      await this.redis.eval(
        BEAT,
        2,
        REPLICAS_KEY,
        replicaKey(s.replicaId),
        s.replicaId,
        this.windowMs,
        "roles",
        this.config.get().roles.join(","),
        "version",
        KERNEL_VERSION,
        "startedAt",
        this.startedAt,
        "httpReplicaId",
        http === undefined ? "" : String(http),
        "channelsHeld",
        s.channelsHeld(),
        "devicesConnected",
        s.devicesConnected(),
      );
    } catch (err) {
      this.log.warn("replica presence beat failed", { err });
    }
  }

  /**
   * Stops beating and waits for a beat in flight, leaving the entry to age out (a crash looks like
   * this; the tests use it as one). Idempotent.
   */
  async halt(): Promise<void> {
    this.halted = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** The stop: {@link halt}, then removes this process's entry at once (best effort). Idempotent. */
  async stop(): Promise<void> {
    await this.halt();
    const s = this.sources;
    if (s === undefined) return;
    this.sources = undefined;
    try {
      await this.redis.multi().zrem(REPLICAS_KEY, s.replicaId).del(replicaKey(s.replicaId)).exec();
    } catch (err) {
      this.log.warn("cannot remove replica presence", { err });
    }
  }

  /**
   * The live replicas (a beat within the window, by the Redis server clock), sorted by start time.
   * Throws when Redis does not answer.
   */
  live(): Promise<LiveReplica[]> {
    return readLiveReplicas(this.redis, this.windowMs);
  }
}
