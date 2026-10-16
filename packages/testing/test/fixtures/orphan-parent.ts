// 测试用父进程：起 harness、打印两个副本 pid，然后自己被 SIGKILL（不给任何清理机会）。
import { fileURLToPath } from "node:url";
import { createDualReplicaHarness } from "../../src/dual-replica.js";

const h = await createDualReplicaHarness({
  plugins: [fileURLToPath(new URL("./good-counter/index.ts", import.meta.url))],
  pgUrl: process.env.TEST_PG_URL as string,
  redisUrl: process.env.TEST_REDIS_URL as string,
});
process.stdout.write(`${JSON.stringify(h.replicas.map((r) => r.pid))}\n`, () => {
  process.kill(process.pid, "SIGKILL");
});
