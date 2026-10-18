import type { PluginContext } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";

/** 中止广播的内核 bus 主题。 */
export const RUN_ABORT_TOPIC = "run.abort";

/** 中止标记的保留时长（秒）。 */
const ABORT_TTL_SECONDS = 3600;

const abortKey = (runId: string) => `capk:run-abort:${runId}`;

interface AbortMessage {
  runId: string;
  byAccountId: string | null;
}

/**
 * 跨副本中止（spec 4.3「中止信号经 Redis 广播」）：`request` 先写标记键再广播；
 * `watch` 先订阅、再检查一次标记键，订阅之前发出的中止也不会丢。
 */
export class RunAbort {
  constructor(
    private readonly redis: Redis,
    private readonly bus: PluginContext["bus"],
  ) {}

  async request(runId: string, byAccountId: string | null): Promise<void> {
    await this.redis.set(abortKey(runId), JSON.stringify({ byAccountId }), "EX", ABORT_TTL_SECONDS);
    const msg: AbortMessage = { runId, byAccountId };
    await this.bus.publish(RUN_ABORT_TOPIC, msg);
  }

  /**
   * 是否已请求中止该运行（读标记键）：返回请求人，未请求 → null。
   * 用于没有订阅者的时刻（运行刚暂停、即将进入 waiting）补查期间到达的中止。
   */
  async requested(runId: string): Promise<{ byAccountId: string | null } | null> {
    const stored = await this.redis.get(abortKey(runId));
    if (stored === null) return null;
    const by = (JSON.parse(stored) as { byAccountId?: unknown }).byAccountId;
    return { byAccountId: typeof by === "string" ? by : null };
  }

  /** 订阅某个运行的中止；`onAbort` 至多调用一次。返回取消订阅函数。 */
  async watch(
    runId: string,
    onAbort: (byAccountId: string | null) => void,
  ): Promise<() => Promise<void>> {
    let fired = false;
    const fire = (by: string | null) => {
      if (fired) return;
      fired = true;
      onAbort(by);
    };
    const unsubscribe = await this.bus.subscribe(RUN_ABORT_TOPIC, (payload) => {
      const m = payload as Partial<AbortMessage> | null;
      if (m?.runId === runId) fire(typeof m.byAccountId === "string" ? m.byAccountId : null);
    });
    try {
      const stored = await this.redis.get(abortKey(runId));
      if (stored !== null) {
        const by = (JSON.parse(stored) as { byAccountId?: unknown }).byAccountId;
        fire(typeof by === "string" ? by : null);
      }
    } catch (err) {
      await unsubscribe();
      throw err;
    }
    return unsubscribe;
  }
}
