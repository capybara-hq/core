import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  MODEL_PROVIDER_CAPABILITY_V2 as V2,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { LogContentBlock } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import type { MediaBytes, MediaInfo } from "../../src/runtime/context/build.js";
import { type ModelStepDeps, RunError, runModelStep } from "../../src/runtime/model-call.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { truncateTables } from "../helpers/db.js";

/**
 * 运行一步模型调用时的附件解析（M5 T3 fix round 1）：存储暂时故障不变成占位（Ruling M4）、
 * 单次请求的媒体预算（Ruling M6）、主模型与兜底模型能力不同时各自按能力解析。
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let config: KernelConfig;
let budget = 20_971_520;

const silent = createLogger("error", { write: () => {} });

const info = (id: string, vision: boolean): ModelInfo => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  maxOutputTokens: 1000,
  capabilities: {
    tools: false,
    vision,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
    documents: vision,
  },
  parameters: [],
});

/** 测试桩：`see` 有视觉、`blind` 没有；`failing` 里的模型每次都以可重试错误失败（请求仍被记录）。 */
const calls: ModelRequest[] = [];
let failing = new Set<string>();
const provider: ModelProvider = {
  async listModels() {
    return [info("see", true), info("blind", false)];
  },
  async *stream(req): AsyncGenerator<ModelStreamEvent> {
    calls.push(structuredClone(req));
    if (failing.has(req.model)) throw new ModelError("overloaded", "busy", { retryAfterMs: 1 });
    yield {
      type: "message_complete",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

/** 假的附件来源：`rows` 是行（声明大小），`bytes` 是存储里的字节；`fetchFails` 次数内取字节抛错。 */
let rows = new Map<string, MediaInfo>();
let bytes = new Map<string, MediaBytes>();
let fetched: string[][] = [];
let fetchFails = 0;

let deps: ModelStepDeps;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  config = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = new EventLog(db, createBus(redis, sub, "kernel"));
  deps = {
    db,
    eventLog,
    registry: new ProviderRegistry(
      { list: () => [{ plugin: "stub", capability: V2, impl: provider }] },
      redis,
    ),
    tools: { forAgent: async () => ({ tools: [], unavailable: [] }) },
    config: () => ({
      ...config,
      attachments: { ...config.attachments, requestMediaBytes: budget },
    }),
    log: silent,
    media: {
      info: async (_o, _c, ids) =>
        new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) as MediaInfo]] : []))),
      fetch: async (_o, _c, ids) => {
        fetched.push([...ids]);
        if (fetchFails > 0) {
          fetchFails--;
          throw new Error("ECONNRESET");
        }
        return new Map(ids.map((id) => [id, bytes.get(id) ?? null]));
      },
    },
  };
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let conversationId: string;

beforeEach(async () => {
  calls.length = 0;
  failing = new Set();
  rows = new Map();
  bytes = new Map();
  fetched = [];
  fetchFails = 0;
  budget = 20_971_520;
  await redis.flushdb();
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  const accountId = randomUUID();
  orgId = randomUUID();
  const agentId = randomUUID();
  conversationId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
});

const agent = (model: string, fallback: string | null = null): AgentDefinition => ({
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model },
  fallback: fallback === null ? null : { provider: "stub", model: fallback },
  modelParams: {},
  fallbackParams: {},
  tools: [],
  toolPolicies: {},
});

/** 登记一张图片（行 + 字节），返回 id。 */
function image(data: Uint8Array): string {
  const id = randomUUID();
  rows.set(id, { size: data.byteLength, pages: null });
  bytes.set(id, { mediaType: "image/png", data });
  return id;
}

async function say(text: string, ids: string[]): Promise<void> {
  const content: LogContentBlock[] = [
    { type: "text", text },
    ...ids.map(
      (id, i): LogContentBlock => ({
        type: "image",
        mediaType: "image/png",
        source: { kind: "ref", attachmentId: id },
        name: `img-${text}-${i}.png`,
      }),
    ),
  ];
  await eventLog.append(conversationId, [
    { type: "user_message", payload: { content, authorAccountId: "acc" } },
  ]);
}

const step = (a: AgentDefinition) =>
  runModelStep(deps, {
    orgId,
    conversationId,
    runId: randomUUID(),
    step: 1,
    agent: a,
    agentVersion: 1,
    absorbedUpToSeq: 1_000_000_000,
    signal: new AbortController().signal,
    sink: () => {},
  });

const userBlocks = (r: ModelRequest) =>
  r.messages.flatMap((m) => (m.role === "user" ? m.content : []));
const PLACEHOLDER = /no longer available|cannot view|omitted/;

describe("存储暂时故障（Ruling M4）", () => {
  it("每次取字节都失败：本步以可重试的 run.storage_unavailable 失败，模型一次也没被调用", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    await say("look", [image(data)]);
    fetchFails = 100;
    const err = await step(agent("see")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).code).toBe("run.storage_unavailable");
    expect(calls).toHaveLength(0);
    // 重试过（主模型两次），失败不缓存：每次都重新取
    expect(fetched.length).toBeGreaterThanOrEqual(2);
  });

  it("第一次取失败、重试成功：发出的请求带字节，没有占位", async () => {
    const data = new Uint8Array([9, 8, 7, 6]);
    await say("look", [image(data)]);
    fetchFails = 1;
    await step(agent("see"));
    expect(calls).toHaveLength(1);
    const blocks = userBlocks(calls[0] as ModelRequest);
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { kind: "base64", data: Buffer.from(data).toString("base64") },
    });
    expect(JSON.stringify(calls)).not.toMatch(PLACEHOLDER);
  });
});

describe("单次请求的媒体预算（Ruling M6）", () => {
  it("十张超出预算：只保留最新的、在预算内的几张；被丢弃的不取字节", async () => {
    budget = 250;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = image(new Uint8Array(100).fill(i));
      ids.push(id);
      await say(`m${i}`, [id]);
    }
    await step(agent("see"));
    const kept = ids.slice(8);
    expect(fetched.flat().sort()).toEqual([...kept].sort());
    const blocks = userBlocks(calls[0] as ModelRequest);
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    const texts = blocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
    expect(texts.filter((t) => t.includes("omitted to fit the request size limit"))).toHaveLength(
      8,
    );
    expect(texts).toContain('[Attachment "img-m0-0.png" omitted to fit the request size limit.]');
  });
});

describe("主模型与兜底的能力不同", () => {
  it("主模型有视觉但失败，兜底没有视觉：兜底请求只有占位、没有字节", async () => {
    const data = new Uint8Array([5, 5, 5, 5]);
    await say("look", [image(data)]);
    failing = new Set(["see"]);
    await step(agent("see", "blind"));
    const b64 = Buffer.from(data).toString("base64");
    const seeCalls = calls.filter((c) => c.model === "see");
    const blindCalls = calls.filter((c) => c.model === "blind");
    expect(seeCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(seeCalls)).toContain(b64);
    expect(blindCalls).toHaveLength(1);
    expect(JSON.stringify(blindCalls)).not.toContain(b64);
    expect(userBlocks(blindCalls[0] as ModelRequest)).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: '[Attached image "img-look-0.png" — this model cannot view images.]' },
    ]);
  });

  it("反过来：主模型没有视觉且失败，兜底有视觉：兜底请求带字节，主模型请求没有", async () => {
    const data = new Uint8Array([6, 6, 6, 6]);
    await say("look", [image(data)]);
    failing = new Set(["blind"]);
    await step(agent("blind", "see"));
    const b64 = Buffer.from(data).toString("base64");
    const blindCalls = calls.filter((c) => c.model === "blind");
    const seeCalls = calls.filter((c) => c.model === "see");
    expect(blindCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(blindCalls)).not.toContain(b64);
    expect(seeCalls).toHaveLength(1);
    expect(JSON.stringify(seeCalls)).toContain(b64);
  });
});
