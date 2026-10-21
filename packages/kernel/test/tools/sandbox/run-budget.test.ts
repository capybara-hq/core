import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { AccountsService } from "../../../src/identity/accounts.js";
import type { Kernel } from "../../../src/kernel.js";
import { sandboxConfigWarnings } from "../../../src/sandbox/sandbox.service.js";
import {
  RUN_DEADLINE_MARGIN_MS,
  runTimeLeftMs,
  searchTimeoutMs,
} from "../../../src/tools/builtins/sandbox/index.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  runConfig,
  session,
  startKernel,
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * Ruling M20：运行截止（`runtime.maxRunSeconds`）早于命令超时时，`sandbox_bash` 把超时收紧到运行剩下的时间，
 * 命令自己超时并告诉模型原因，而不是被运行截止打断成「结果未知」。
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
/** 运行时限：截止前留 {@link RUN_DEADLINE_MARGIN_MS}，命令最多约 4 秒。 */
const MAX_RUN_SECONDS = RUN_DEADLINE_MARGIN_MS / 1000 + 4;

const cfg = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});

describe("运行时限与命令超时（纯函数）", () => {
  it("runTimeLeftMs：截止时间减余量；没有截止时间为 Infinity", () => {
    expect(runTimeLeftMs(undefined)).toBe(Infinity);
    expect(runTimeLeftMs(100_000, 10_000)).toBe(90_000 - RUN_DEADLINE_MARGIN_MS);
  });

  it("searchTimeoutMs 也受运行截止约束（至少 1 秒）", () => {
    const t0 = 1_000_000;
    expect(searchTimeoutMs(cfg, t0, t0)).toBe(cfg.tools.timeoutMs);
    expect(searchTimeoutMs(cfg, t0, t0, t0 + RUN_DEADLINE_MARGIN_MS + 5000)).toBe(5000);
    expect(searchTimeoutMs(cfg, t0, t0, t0 + 1000)).toBe(1000);
  });

  it("maxRunSeconds < maxCommandSeconds 时启动告警，指向两个配置键", () => {
    const [w] = sandboxConfigWarnings(cfg);
    expect(w).toContain("runtime.maxRunSeconds (900)");
    expect(w).toContain("sandbox.limits.maxCommandSeconds (7200)");
    expect(
      sandboxConfigWarnings({ ...cfg, runtime: { ...cfg.runtime, maxRunSeconds: 7200 } }),
    ).toEqual([]);
  });
});

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-sbx-budget-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        plugins: [MODEL_FAKE, SANDBOX_FAKE],
        pluginConfig: { "sandbox-fake": { root } },
        runtime: { maxRunSeconds: MAX_RUN_SECONDS },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

describe("sandbox_bash 按运行剩下的时间收紧超时", { timeout: 90_000 }, () => {
  it("请求的 timeoutSeconds 超过运行剩余：命令在截止前超时，结果说明运行时限（不是结果未知）", async () => {
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    const owner = await session(k, "owner");
    const orgId = await createOrg(owner);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Coder",
          instructions: "Use the sandbox.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "builtin", name: "sandbox_bash" }],
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const conv = await createConv(owner, orgId, (res.json() as { agent: { id: string } }).agent.id);

    const t0 = Date.now();
    const input = { command: "sleep 120", timeoutSeconds: 600 };
    await postMessage(owner, orgId, conv, `tool:sandbox_bash:${JSON.stringify(input)}`);
    const [run] = await waitForTerminal(db, conv, 1, 60_000);
    // 命令收紧到约 4 秒后超时，运行照常结束（没有撞上截止时间）
    expect(Date.now() - t0).toBeLessThan(MAX_RUN_SECONDS * 1000);
    expect(run?.type).toBe("run_finished");
    const r = (await eventsOf(db, conv)).find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    )?.payload;
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain("timedOut");
    expect(r?.content).toMatch(/time budget limits commands to \d+ seconds/);
    expect(r?.content).toContain("runtime.maxRunSeconds");
    expect(r?.content).not.toContain("stopped before it finished");
  });
});
