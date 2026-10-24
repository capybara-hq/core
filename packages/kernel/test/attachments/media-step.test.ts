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
import {
  type MediaBytes,
  type MediaInfo,
  TEXT_FETCH_MAX_BYTES,
  TEXT_INLINE_MAX_CHARS,
} from "../../src/runtime/context/build.js";
import { MediaCache } from "../../src/runtime/media-cache.js";
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

/**
 * 测试桩：`see` 有视觉、`blind` 没有；`failing` 里的模型每次都以可重试错误失败（请求仍被记录）；
 * `rejectMedia` 为真时带图片 / 文档字节的请求以 `invalid_request` 失败（模拟供应商拒收坏图片）。
 */
const calls: ModelRequest[] = [];
let failing = new Set<string>();
let rejectMedia = false;
/** 为真时每个请求都以 `invalid_request` 失败。 */
let rejectAll = false;
const provider: ModelProvider = {
  async listModels() {
    return [info("see", true), info("blind", false)];
  },
  async *stream(req): AsyncGenerator<ModelStreamEvent> {
    calls.push(structuredClone(req));
    if (failing.has(req.model)) throw new ModelError("overloaded", "busy", { retryAfterMs: 1 });
    if (rejectAll) throw new ModelError("invalid_request", "bad");
    if (rejectMedia && userBlocks(req).some((b) => b.type === "image" || b.type === "document")) {
      throw new ModelError("invalid_request", "Could not process image");
    }
    yield {
      type: "message_complete",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

/**
 * 假的附件来源：`rows` 是行（声明大小），`bytes` 是存储里的字节；`fetchFails` 次数内取字节抛错。
 * `caps` 里的附件只给开头若干字节（按范围读）。
 */
let rows = new Map<string, MediaInfo>();
let bytes = new Map<string, MediaBytes>();
let fetched: string[][] = [];
let fetchCaps: (ReadonlyMap<string, number> | undefined)[] = [];
let fetchFails = 0;

let deps: ModelStepDeps;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis({ shared: true })]);
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
      fetch: async (_o, _c, ids, caps) => {
        fetched.push([...ids]);
        fetchCaps.push(caps);
        if (fetchFails > 0) {
          fetchFails--;
          throw new Error("ECONNRESET");
        }
        return new Map(
          ids.map((id) => {
            const b = bytes.get(id);
            const cap = caps?.get(id);
            if (!b) return [id, null];
            return [id, cap === undefined ? b : { ...b, data: b.data.subarray(0, cap) }];
          }),
        );
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
  rejectMedia = false;
  rejectAll = false;
  rows = new Map();
  bytes = new Map();
  fetched = [];
  fetchCaps = [];
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

const step = (
  a: AgentDefinition,
  opts: { runId?: string; step?: number; mediaCache?: MediaCache } = {},
) =>
  runModelStep(deps, {
    orgId,
    conversationId,
    runId: opts.runId ?? randomUUID(),
    step: opts.step ?? 1,
    agent: a,
    agentVersion: 1,
    absorbedUpToSeq: 1_000_000_000,
    signal: new AbortController().signal,
    sink: () => {},
    ...(opts.mediaCache && { mediaCache: opts.mediaCache }),
  });

/** 读会话日志里某类事件。 */
async function eventsOfType(type: string) {
  const all = await eventLog.readAfter(conversationId, 0, 1000);
  return all.filter((e) => e.type === type);
}

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

describe("大文本附件（Ruling M8 / C1）", () => {
  it("5 MB 的 CSV 发给 documents:true 模型：只按范围取开头，发出的文档被截断并注明", async () => {
    const id = randomUUID();
    const big = new TextEncoder().encode("a,b\n".repeat(5 * 1024 * 256));
    rows.set(id, { size: big.byteLength, pages: null });
    bytes.set(id, { mediaType: "text/csv", data: big });
    await eventLog.append(conversationId, [
      {
        type: "user_message",
        payload: {
          content: [
            { type: "text", text: "read" },
            {
              type: "document",
              mediaType: "text/csv",
              source: { kind: "ref", attachmentId: id },
              name: "big.csv",
            },
          ],
          authorAccountId: "acc",
        },
      },
    ]);
    await step(agent("see"));
    expect(fetchCaps.at(-1)?.get(id)).toBe(TEXT_FETCH_MAX_BYTES);
    const doc = userBlocks(calls[0] as ModelRequest).find((b) => b.type === "document");
    const sent =
      doc?.type === "document" && doc.source.kind === "base64"
        ? Buffer.from(doc.source.data, "base64").toString("utf8")
        : "";
    expect(sent.length).toBeLessThan(TEXT_INLINE_MAX_CHARS + 200);
    expect(sent).toContain("[Truncated:");
    expect(JSON.stringify(calls[0]).length).toBeLessThan(200_000);
  });
});

describe("供应商拒收媒体（Ruling M8 / I1）", () => {
  it("invalid_request 且请求带字节：追加 media_excluded、运行照常失败；下一条消息换成占位并成功", async () => {
    const id = image(new Uint8Array([1, 1, 2, 3]));
    await say("look", [id]);
    rejectMedia = true;
    const err = await step(agent("see")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).code).toBe("model.invalid_request");
    const excluded = await eventsOfType("media_excluded");
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.payload).toEqual({ attachmentIds: [id], reason: "provider_rejected" });

    await say("again", []);
    calls.length = 0;
    fetched = [];
    const r = await step(agent("see"));
    expect(r.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(1);
    expect(fetched.flat()).not.toContain(id);
    expect(userBlocks(calls[0] as ModelRequest)).toContainEqual({
      type: "text",
      text: '[Attachment "img-look-0.png" was rejected by the model provider.]',
    });
  });

  it("写 media_excluded 失败：只记 warn，仍以原来的 RunError 失败", async () => {
    const id = image(new Uint8Array([9, 9]));
    await say("look", [id]);
    rejectMedia = true;
    const warned: string[] = [];
    const brokenLog = Object.create(eventLog) as EventLog;
    brokenLog.append = async (c, evs) => {
      if (evs.some((e) => e.type === "media_excluded")) throw new Error("db down");
      return eventLog.append(c, evs);
    };
    const err = await runModelStep(
      {
        ...deps,
        eventLog: brokenLog,
        log: { ...silent, warn: (msg: string) => void warned.push(msg) },
      },
      {
        orgId,
        conversationId,
        runId: randomUUID(),
        step: 1,
        agent: agent("see"),
        agentVersion: 1,
        absorbedUpToSeq: 1_000_000_000,
        signal: new AbortController().signal,
        sink: () => {},
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).code).toBe("model.invalid_request");
    expect(warned).toContain("cannot record media_excluded");
    expect(await eventsOfType("media_excluded")).toHaveLength(0);
  });

  it("请求里没有媒体字节：invalid_request 不写 media_excluded", async () => {
    const id = image(new Uint8Array([1, 2]));
    await say("look", [id]);
    // 不支持视觉：只发占位；模型以 invalid_request 失败
    rejectAll = true;
    const err = await step(agent("blind")).catch((e: unknown) => e);
    expect((err as RunError).code).toBe("model.invalid_request");
    expect(await eventsOfType("media_excluded")).toHaveLength(0);
  });
});

describe("model_call 记录媒体结果（I2）", () => {
  it("request.media 记下每个附件的结果与 etag", async () => {
    const id = image(new Uint8Array([4, 4]));
    rows.set(id, { size: 2, pages: null, etag: "etag-1" });
    await say("look", [id]);
    await step(agent("see"));
    const [mc] = await eventsOfType("model_call");
    expect(mc?.type === "model_call" && mc.payload.request.media).toEqual([
      { attachmentId: id, outcome: "bytes", etag: "etag-1" },
    ]);
  });
});

describe("每次运行的媒体缓存（9）", () => {
  it("同一次运行的第二步不再取同一附件的字节", async () => {
    const id = image(new Uint8Array([7, 7, 7]));
    rows.set(id, { size: 3, pages: null, etag: "e" });
    await say("look", [id]);
    const cache = new MediaCache(budget);
    const runId = randomUUID();
    await step(agent("see"), { runId, step: 1, mediaCache: cache });
    await step(agent("see"), { runId, step: 2, mediaCache: cache });
    expect(calls).toHaveLength(2);
    expect(fetched.flat()).toEqual([id]);
    // 两次请求都带字节
    for (const c of calls) expect(userBlocks(c).some((b) => b.type === "image")).toBe(true);
  });

  it("按总字节数 LRU 淘汰", () => {
    const cache = new MediaCache(10);
    const m = (n: number): MediaBytes => ({ mediaType: "image/png", data: new Uint8Array(n) });
    cache.set("a", m(4));
    cache.set("b", m(4));
    expect(cache.get("a")).toBeDefined(); // a 变成最近使用
    cache.set("c", m(4)); // 超出 10：淘汰最久未用的 b
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    cache.set("huge", m(11)); // 比上限还大：不缓存
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.size).toBe(8);
  });
});
