import type { Logger, PluginContext } from "@capybara-hq/plugin-sdk";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { assertNamespace } from "./namespace.js";

/** 未注入 logger 时的兜底：输出到 stderr。 */
const consoleLog: Pick<Logger, "error"> = {
  error: (msg, fields) => console.error(`[queue] ${msg}`, fields ?? ""),
};

function assertNoColon(what: string, value: string): void {
  if (value.includes(":")) {
    throw new TypeError(`${what} must not contain ":" (BullMQ restriction); use "-" instead`);
  }
}

/**
 * 创建 ctx.queue：BullMQ 队列名为 `cap.<namespace>.<name>`。namespace 经 assertNamespace 校验不含 `.`，
 * 故第一个 `.` 之后的 namespace 段边界唯一，不同插件拼出的队列名不可能相同（`-` 作分隔符时
 * `feishu` + `bot-sync` 与 `feishu-bot` + `sync` 会撞名）。BullMQ 只禁止 `:`，`.` 合法。
 * runWorkers 为 false 时 define 只登记不创建 Worker（本进程不含 worker 角色）。
 * 注意：jobId 去重只在任务仍被保留期间有效（removeOnComplete 1000 / removeOnFail 5000），
 * 任务被清理后同 jobId 可再次入队。close() 之后 add/define 抛错。
 */
export function createQueue(
  redisUrl: string,
  namespace: string,
  opts: { runWorkers: boolean; log?: Pick<Logger, "error"> },
): PluginContext["queue"] & {
  close(): Promise<void>;
  /** 停止取新任务（不等进行中的）：撤销插件实例的第一步。 */
  pauseWorkers(): Promise<void>;
  /**
   * 关闭一个队列的 worker：不再取新任务，等进行中的任务结束，最多等到 `deadline`（epoch 毫秒）；到点仍未结束的
   * 强制关闭——任务留在队列里（锁过期后按 stalled 交回等待），由新实例的 worker 接着处理（队列名不含版本）。
   * 不给 `deadline` 时一直等到进行中的任务结束（停机路径）。没有 worker（本进程不含 worker 角色）时什么都不做。
   */
  stopWorker(name: string, deadline?: number): Promise<void>;
} {
  assertNamespace(namespace);
  const log = opts.log ?? consoleLog;
  const connections: Redis[] = [];
  const queues = new Map<string, Queue>();
  const workers = new Map<string, Worker>();
  /** 每个 worker 进行中的任务数与「空了」的等待者（撤销时排空用）。 */
  const active = new Map<string, { n: number; idle: (() => void)[] }>();
  const defined = new Set<string>();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("queue is closed");
  };

  // BullMQ 要求 Worker 的阻塞连接 maxRetriesPerRequest 为 null；Queue 复用同样的配置。
  const newConn = () => {
    const c = new Redis(redisUrl, { maxRetriesPerRequest: null });
    c.on("error", (err: Error) => log.error("queue redis connection error", { err }));
    connections.push(c);
    return c;
  };
  const queueName = (name: string) => `cap.${namespace}.${name}`;
  const getQueue = (name: string): Queue => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(queueName(name), { connection: newConn() });
      q.on("error", (err) => log.error("queue error", { queue: name, err }));
      queues.set(name, q);
    }
    return q;
  };

  return {
    define(name, handler, o) {
      assertOpen();
      assertNoColon("queue name", name);
      if (defined.has(name)) throw new Error(`queue "${name}" already defined`);
      defined.add(name);
      if (!opts.runWorkers) return;
      const st = { n: 0, idle: [] as (() => void)[] };
      active.set(name, st);
      const worker = new Worker(
        queueName(name),
        async (job) => {
          st.n += 1;
          try {
            await handler(job.data);
          } finally {
            st.n -= 1;
            if (st.n === 0) for (const w of st.idle.splice(0)) w();
          }
        },
        { connection: newConn(), concurrency: o?.concurrency ?? 1 },
      );
      worker.on("error", (err) => log.error("queue worker error", { queue: name, err }));
      worker.on("failed", (job, err) =>
        log.error("queue job failed", { queue: name, jobId: job?.id, err }),
      );
      workers.set(name, worker);
    },
    async add(name, data, o) {
      assertOpen();
      assertNoColon("queue name", name);
      if (o?.jobId !== undefined) assertNoColon("jobId", o.jobId);
      await getQueue(name).add(name, data, {
        ...(o?.jobId !== undefined && { jobId: o.jobId }),
        ...(o?.delayMs !== undefined && { delay: o.delayMs }),
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
    },
    async pauseWorkers() {
      await Promise.all([...workers.values()].map((w) => w.pause(true).catch(() => {})));
    },
    async stopWorker(name, deadline) {
      const w = workers.get(name);
      if (!w) return;
      workers.delete(name);
      const st = active.get(name);
      active.delete(name);
      if (deadline === undefined) {
        await w.close();
        return;
      }
      await w.pause(true).catch(() => {});
      if (st && st.n > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          new Promise<void>((resolve) => st.idle.push(resolve)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          }),
        ]);
        clearTimeout(timer);
      }
      await w.close(st !== undefined && st.n > 0);
    },
    async close() {
      closed = true;
      await Promise.all([...workers.values()].map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      workers.clear();
      queues.clear();
      await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
      connections.length = 0;
    },
  };
}
