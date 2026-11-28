import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { KERNEL_BUS, REDIS } from "../infra/tokens.js";

/** 中止广播的内核 bus 主题。 */
export const RUN_ABORT_TOPIC = "run.abort";

/** 中止标记的保留时长（秒）。 */
const ABORT_TTL_SECONDS = 3600;

const abortKey = (runId: string) => `capk:run-abort:${runId}`;

/**
 * Why the kernel stops a run, when it is not a plain stop: `wait_timeout`, a sub-agent stopped by
 * its parent's sub-agents wait timeout. Written to `run_aborted.detail`.
 */
export type RunAbortDetail = "wait_timeout";

/**
 * The kernel's reason for a stop other than a person's: `superseded`, an idle compact run preempted
 * by input (idle compaction spec §5.2). Written to `run_aborted.reason`; absent = `user`.
 */
export type RunAbortReason = "superseded";

/** Who stopped a run, and why when the kernel did. */
export interface RunAbortBy {
  byAccountId: string | null;
  detail?: RunAbortDetail;
  reason?: RunAbortReason;
}

interface AbortMessage extends RunAbortBy {
  runId: string;
}

const detailOf = (v: unknown): { detail?: RunAbortDetail } =>
  v === "wait_timeout" ? { detail: v } : {};

const reasonOf = (v: unknown): { reason?: RunAbortReason } =>
  v === "superseded" ? { reason: v } : {};

/** A stored marker or a bus message, read defensively (either may come from another version). */
const parseBy = (m: { byAccountId?: unknown; detail?: unknown; reason?: unknown }): RunAbortBy => ({
  byAccountId: typeof m.byAccountId === "string" ? m.byAccountId : null,
  ...detailOf(m.detail),
  ...reasonOf(m.reason),
});

const parseStored = (stored: string): RunAbortBy =>
  parseBy(JSON.parse(stored) as { byAccountId?: unknown; detail?: unknown; reason?: unknown });

/**
 * 跨副本中止（spec 4.3「中止信号经 Redis 广播」）：`request` 先写标记键再广播；
 * `watch` 先订阅、再检查一次标记键，订阅之前发出的中止也不会丢。
 */
@Injectable()
export class RunAbort {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
  ) {}

  async request(
    runId: string,
    byAccountId: string | null,
    opts: { detail?: RunAbortDetail | undefined; reason?: RunAbortReason | undefined } = {},
  ): Promise<void> {
    const by: RunAbortBy = {
      byAccountId,
      ...(opts.detail !== undefined && { detail: opts.detail }),
      ...(opts.reason !== undefined && { reason: opts.reason }),
    };
    await this.redis.set(abortKey(runId), JSON.stringify(by), "EX", ABORT_TTL_SECONDS);
    const msg: AbortMessage = { runId, ...by };
    await this.bus.publish(RUN_ABORT_TOPIC, msg);
  }

  /**
   * Requests the kernel's stop of a run only when no stop was requested yet: the marker is written
   * with SET NX (atomic, so a person's stop racing it is never relabelled) and broadcast only when
   * this call wrote it. True when it did. A plain {@link request} still overwrites the marker, so a
   * person's later stop replaces a kernel one.
   */
  async requestIfAbsent(
    runId: string,
    byAccountId: string | null,
    opts: { detail?: RunAbortDetail | undefined; reason?: RunAbortReason | undefined } = {},
  ): Promise<boolean> {
    const by: RunAbortBy = {
      byAccountId,
      ...(opts.detail !== undefined && { detail: opts.detail }),
      ...(opts.reason !== undefined && { reason: opts.reason }),
    };
    const set = await this.redis.set(
      abortKey(runId),
      JSON.stringify(by),
      "EX",
      ABORT_TTL_SECONDS,
      "NX",
    );
    if (set === null) return false;
    const msg: AbortMessage = { runId, ...by };
    await this.bus.publish(RUN_ABORT_TOPIC, msg);
    return true;
  }

  /**
   * Whether a stop of this run was requested (reads the marker key): who asked (and why, when the
   * kernel did: `detail`, `reason`), or null. For the moments without a subscriber (a run that just suspended and is
   * about to become `waiting`), to pick up a stop that arrived meanwhile.
   */
  async requested(runId: string): Promise<RunAbortBy | null> {
    const stored = await this.redis.get(abortKey(runId));
    if (stored === null) return null;
    return parseStored(stored);
  }

  /** Subscribes to stops of one run; `onAbort` is called at most once. Returns the unsubscribe. */
  async watch(
    runId: string,
    onAbort: (byAccountId: string | null, detail?: RunAbortDetail, reason?: RunAbortReason) => void,
  ): Promise<() => Promise<void>> {
    let fired = false;
    const fire = (by: RunAbortBy) => {
      if (fired) return;
      fired = true;
      onAbort(by.byAccountId, by.detail, by.reason);
    };
    const unsubscribe = await this.bus.subscribe(RUN_ABORT_TOPIC, (payload) => {
      const m = payload as Partial<AbortMessage> | null;
      if (m?.runId === runId) fire(parseBy(m));
    });
    try {
      const stored = await this.redis.get(abortKey(runId));
      if (stored !== null) fire(parseStored(stored));
    } catch (err) {
      await unsubscribe();
      throw err;
    }
    return unsubscribe;
  }
}
