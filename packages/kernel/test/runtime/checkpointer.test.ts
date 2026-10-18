import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import { validate } from "@langchain/langgraph-checkpoint-validation";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";

let box: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;

const clearTables = async () => {
  await sql`TRUNCATE capybara.lg_checkpoints, capybara.lg_checkpoint_writes`.execute(raw);
};

/**
 * 校验套件按 Jest 风格使用全局 describe / it / expect；本仓库的 Vitest 未开 globals，这里手动挂上。
 * `it` 包一层：套件里「只存 newVersions 中变化的 channel_values」一例只适用于按 channel 增量存 blob
 * 的实现，套件自己也对存整份 checkpoint 的 MemorySaver / SQLiteSaver 跳过；本实现同样存整份
 * checkpoint（剪枝到最新一份后仍能独立还原），所以同样跳过该例。
 */
const SKIPPED: Record<string, string> = {
  "should only store channel_values that have changed (based on newVersions)":
    "KyselyCheckpointSaver stores full checkpoints, like MemorySaver and SQLiteSaver",
};
const wrappedIt = new Proxy(it, {
  apply(target, thisArg, args: Parameters<typeof it>) {
    const [name, ...rest] = args;
    const reason = typeof name === "string" ? SKIPPED[name] : undefined;
    if (reason) return target.skip(`[because ${reason}] ${name}`, ...(rest as []));
    return Reflect.apply(target, thisArg, args);
  },
});
Object.assign(globalThis, {
  describe,
  it: wrappedIt,
  test: wrappedIt,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
});

validate({
  checkpointerName: "KyselyCheckpointSaver",
  beforeAllTimeout: 120_000,
  async beforeAll() {
    box = await startTestPostgres();
    await migrate(box.url, {
      schema: "capybara",
      dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
    });
    raw = createDb(box.url, 10);
    db = kernelDb(raw);
  },
  async afterAll() {
    await raw?.destroy();
    await box?.stop();
  },
  async createCheckpointer() {
    // 测试库独占：每个新建的 checkpointer 都从空表开始，满足套件的状态隔离要求。
    await clearTables();
    return new KyselyCheckpointSaver(db);
  },
});

describe("KyselyCheckpointSaver#pruneToLatest", () => {
  it("keeps only the latest root checkpoint and its writes", async () => {
    await clearTables();
    const saver = new KyselyCheckpointSaver(db);
    const threadId = "run-prune";
    let config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cp = { ...emptyCheckpoint(), id: uuid6(i), channel_values: { n: i } };
      cp.channel_versions = { n: i + 1 };
      ids.push(cp.id);
      config = (await saver.put(
        config,
        cp,
        { source: "loop", step: i, parents: {} },
        { n: i + 1 },
      )) as typeof config;
      await saver.putWrites(config, [["n", i * 10]], `task-${i}`);
    }
    // 另一个 thread 不受影响。
    await saver.put(
      { configurable: { thread_id: "other", checkpoint_ns: "" } },
      emptyCheckpoint(),
      { source: "input", step: -1, parents: {} },
      {},
    );

    expect(await saver.pruneToLatest(threadId)).toBe(4);

    const remaining = await db
      .selectFrom("lg_checkpoints")
      .select(["thread_id", "checkpoint_id"])
      .where("thread_id", "=", threadId)
      .execute();
    expect(remaining).toEqual([{ thread_id: threadId, checkpoint_id: ids[4] }]);
    const writes = await db
      .selectFrom("lg_checkpoint_writes")
      .select("checkpoint_id")
      .where("thread_id", "=", threadId)
      .execute();
    expect(writes).toEqual([{ checkpoint_id: ids[4] }]);

    const latest = await saver.getTuple({ configurable: { thread_id: threadId } });
    expect(latest?.checkpoint.id).toBe(ids[4]);
    expect(latest?.checkpoint.channel_values).toEqual({ n: 4 });
    expect(latest?.pendingWrites).toEqual([["task-4", "n", 40]]);
    expect(await saver.getTuple({ configurable: { thread_id: "other" } })).toBeDefined();

    // 再剪一次没有可删的。
    expect(await saver.pruneToLatest(threadId)).toBe(0);
  });
});

describe("KyselyCheckpointSaver with StateGraph", () => {
  it("resumes from the failed node after an error", async () => {
    await clearTables();
    const saver = new KyselyCheckpointSaver(db);
    const State = Annotation.Root({
      log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
    });
    let aCalls = 0;
    let bCalls = 0;
    const graph = new StateGraph(State)
      .addNode("a", () => {
        aCalls++;
        return { log: ["a"] };
      })
      .addNode("b", () => {
        bCalls++;
        if (bCalls === 1) throw new Error("boom");
        return { log: ["b"] };
      })
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer: saver });

    const config = { configurable: { thread_id: "run-resume" } };
    await expect(graph.invoke({ log: ["start"] }, config)).rejects.toThrow("boom");
    expect(aCalls).toBe(1);

    // 换一个 saver 实例续跑：状态只在 PG 里。
    const resumed = new StateGraph(State)
      .addNode("a", () => {
        aCalls++;
        return { log: ["a"] };
      })
      .addNode("b", () => {
        bCalls++;
        return { log: ["b"] };
      })
      .addEdge(START, "a")
      .addEdge("a", "b")
      .addEdge("b", END)
      .compile({ checkpointer: new KyselyCheckpointSaver(db) });
    const out = await resumed.invoke(null, config);
    expect(out.log).toEqual(["start", "a", "b"]);
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(2);
  });
});
