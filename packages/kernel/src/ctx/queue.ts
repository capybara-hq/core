import type { Logger, PluginContext } from "@capybara-hq/plugin-sdk";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

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
 * 创建 ctx.queue：BullMQ 队列名为 `cap-<namespace>-<name>`。
 * runWorkers 为 false 时 define 只登记不创建 Worker（本进程不含 worker 角色）。
 * 注意：jobId 去重只在任务仍被保留期间有效（removeOnComplete 1000 / removeOnFail 5000），
 * 任务被清理后同 jobId 可再次入队。close() 之后 add/define 抛错。
 */
export function createQueue(
  redisUrl: string,
  namespace: string,
  opts: { runWorkers: boolean; log?: Pick<Logger, "error"> },
): PluginContext["queue"] & { close(): Promise<void> } {
  const log = opts.log ?? consoleLog;
  const connections: Redis[] = [];
  const queues = new Map<string, Queue>();
  const workers = new Map<string, Worker>();
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
  const queueName = (name: string) => `cap-${namespace}-${name}`;
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
      const worker = new Worker(
        queueName(name),
        async (job) => {
          await handler(job.data);
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
