import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { reconstructRequest, snapshotMediaRefs } from "../../src/evals/reconstruct.js";
import {
  type CaseSnapshot,
  replayableCalls,
  takeSnapshot,
  toEvents,
} from "../../src/evals/snapshot.js";
import { buildTrajectory } from "../../src/evals/trajectory.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import type { MediaInfo } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { WRAP_UP_REMINDER } from "../../src/runtime/model-call.js";
import { hookDeniedText } from "../../src/tools/pipeline.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  MODEL_LOOPER,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * M6 T2：由日志快照还原模型请求（零漂移基线）。真实内核 + model-fake / model-looper + SeaweedFS，
 * 在 `ProviderRegistry.resolve` 处截下供应商实际收到的每个请求，与 `reconstructRequest` 的结果逐项 `toEqual`。
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const TOOLS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/tools-probe/index.ts", import.meta.url),
);
const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);

/** 1×1 透明 PNG。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** What the provider actually received (in order; compaction requests apart). */
const capture = captureProviderRequests();
const { sent, compactions } = capture;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
let owner: Req;
let ownerId: string;
let orgId: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_LOOPER, OBJECT_STORE, TOOLS_PROBE, HOOKS_PROBE],
        runtime: { maxSteps: 4, keepRecentTurns: 1 },
        tools: { searchThresholdTools: 1 },
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1" },
              { id: "fake-v", vision: true, documents: true },
              { id: "fake-small", contextWindow: 1500 },
            ],
          },
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
  ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await enableProbe(true);
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

async function enableProbe(enabled: boolean): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/tools-probe`,
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const PROBE_TOOLS = [
  { kind: "plugin", plugin: "tools-probe", name: "echo" },
  { kind: "plugin", plugin: "tools-probe", name: "second" },
];

async function createAgent(
  model: { provider: string; model: string },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: { name: "Helper", instructions: "Be helpful.", model, tools: [], ...extra },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** 写一个技能版本（文件进存储、行直接写库）；`skillId` 给出时为新版本。 */
async function seedSkill(
  name: string,
  body: string,
  skillId?: string,
  opts: { format?: "claude-code"; plugin?: string } = {},
): Promise<string> {
  const prefix = `skills/${randomUUID()}/`;
  const text = `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;
  const data = new TextEncoder().encode(text);
  await k.storage.kernel(orgId).put(`${prefix}SKILL.md`, data, {
    contentType: "application/octet-stream",
    size: data.byteLength,
  });
  const manifest = {
    name,
    description: `Use for ${name} work.`,
    files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data) }],
  };
  let id = skillId;
  let version = 1;
  if (id === undefined) {
    id = randomUUID();
    await db
      .insertInto("skills")
      .values({
        id,
        org_id: orgId,
        scope: "org",
        agent_id: null,
        name,
        description: manifest.description,
        current_version: 1,
        created_by: ownerId,
        ...(opts.plugin !== undefined && { catalog_item_id: await catalogItem(opts.plugin) }),
      })
      .execute();
  } else {
    const row = await db
      .updateTable("skills")
      .set((eb) => ({ current_version: eb("current_version", "+", 1) }))
      .where("id", "=", id)
      .returning("current_version")
      .executeTakeFirstOrThrow();
    version = row.current_version;
  }
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version,
      manifest: JSON.stringify(manifest),
      object_prefix: prefix,
      created_by: ownerId,
      ...(opts.format !== undefined && { source_format: opts.format }),
    })
    .execute();
  return id;
}

/** The id of catalog item `name` (created when missing). */
async function catalogItem(name: string): Promise<string> {
  const got = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();
  if (got) return got.id;
  const id = randomUUID();
  await db
    .insertInto("catalog_items")
    .values({
      id,
      name,
      package_name: `@acme/plugin-${name}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

/** 建、传、finalize 一个附件，返回 id。 */
async function attach(name: string, bytes: Buffer): Promise<string> {
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments`,
    payload: { name, contentType: "image/png", size: bytes.length },
  });
  expect(created.statusCode, created.body).toBe(201);
  const c = created.json() as {
    id: string;
    upload: { method: string; url: string; headers: Record<string, string> };
  } & { upload: { fields?: Record<string, string> } };
  let up: Response;
  if (c.upload.method === "PUT") {
    up = await fetch(c.upload.url, {
      method: "PUT",
      headers: c.upload.headers,
      body: Buffer.from(bytes),
    });
  } else {
    const form = new FormData();
    for (const [key, v] of Object.entries(c.upload.fields ?? {})) form.append(key, v);
    form.append("file", new Blob([Buffer.from(bytes)], { type: "image/png" }));
    up = await fetch(c.upload.url, { method: "POST", headers: c.upload.headers, body: form });
  }
  expect(up.status).toBeLessThan(300);
  const f = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments/${c.id}/finalize`,
  });
  expect(f.statusCode, f.body).toBe(200);
  return c.id;
}

async function postWithFiles(convId: string, text: string, files: string[]): Promise<void> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
    payload: { text, files },
  });
  expect(res.statusCode, res.body).toBe(202);
}

type ModelCallEvent = Extract<ConversationEvent, { type: "model_call" }>;

const modelCalls = (events: readonly ConversationEvent[]) =>
  events.filter((e): e is ModelCallEvent => e.type === "model_call");

/** 最新一次运行（按创建时间）的 id。 */
async function lastRunId(convId: string): Promise<string> {
  const runs = await runsOf(db, convId);
  return (runs.at(-1) as { id: string }).id;
}

async function modelInfo(provider: string, model: string): Promise<ModelInfo> {
  return (await k.runs.registry.resolve({ provider, model })).info;
}

/** 还原用的媒体：按快照里的引用取当前的附件行与字节（与运行时一样，只取该模型用得到的）。 */
async function mediaFor(convId: string, snap: CaseSnapshot, seq: number, info: ModelInfo) {
  const ids = snapshotMediaRefs(snap, seq, info);
  if (ids.length === 0) return {};
  const mediaInfo = await k.attachments.mediaInfo(orgId, convId, ids);
  const media = await k.attachments.fetchMedia(orgId, convId, [...mediaInfo.keys()]);
  return { mediaInfo, media };
}

/**
 * 核对：快照里每次 model_call（包括较早运行的、失败的尝试）还原出的请求与供应商实际收到的逐项相等、
 * 基线没有漂移；返回还原结果的漂移（供调用方另行断言）。
 */
async function expectZeroDrift(convId: string, snap: CaseSnapshot, upTo = sent.length) {
  const calls = modelCalls(toEvents(snap));
  expect(calls).toHaveLength(upTo);
  for (const [i, c] of calls.entries()) {
    const info = await modelInfo(c.payload.provider, c.payload.model);
    const out = reconstructRequest(snap, c.seq, {
      model: info,
      mediaBudgetBytes: k.config.attachments.requestMediaBytes,
      ...(await mediaFor(convId, snap, c.seq, info)),
    });
    expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
    expect(out.request, `model_call seq ${c.seq}`).toEqual(sent[i]);
    const {
      maxOutputTokens: _m,
      droppedParams: _d,
      estimatedInputTokens: _e,
      ...meta
    } = c.payload.request;
    expect(out.meta).toEqual(meta);
  }
}

async function snapshotOf(convId: string, runId?: string): Promise<CaseSnapshot> {
  return takeSnapshot(db, orgId, convId, runId ?? (await lastRunId(convId)), 4_194_304);
}

const reset = () => capture.reset();

describe("reconstructRequest：基线零漂移", { timeout: 120_000 }, () => {
  it("多步工具、tool_search 加载、审批续跑、技能目录快照与变更、提醒、跨运行插话、工具不可用", async () => {
    reset();
    const alpha = await seedSkill("alpha", "Alpha body.");
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: PROBE_TOOLS, skills: { orgSkills: [alpha] } },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };

    // tool_search 加载 echo，再调用它（第 2 步带轮次提醒）
    await turn('tool:tool_search:{"query":"echo"}');
    const loaded = (await eventsOf(db, conv)).find((e) => e.type === "tool_result");
    expect(loaded?.type === "tool_result" && loaded.payload.loadedTools?.length).toBe(1);
    const echoKey = (loaded?.type === "tool_result" && loaded.payload.loadedTools?.[0]) as string;
    // 未注解的插件工具默认 ask：审批通过后续跑
    await postMessage(owner, orgId, conv, `tool:${echoKey}:{}`);
    const asked = await waitForEvent(db, conv, (e) => e.type === "approval_requested");
    const approvalId = asked.type === "approval_requested" && asked.payload.approvalId;
    const decided = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    await waitForTerminal(db, conv, ++n, 30_000);
    await turn('tool:skill_load:{"name":"alpha"}');

    // 技能新版本：下一轮写新快照（变更提醒）
    await seedSkill("alpha", "Alpha body v2.", alpha);
    await turn("echo:after skill update");

    // 插件在组织停用 → 工具不可用提醒（「已恢复」只在同一运行内写，这里是下一次运行，不写）
    await enableProbe(false);
    await turn("echo:probe off");
    await enableProbe(true);
    await turn("echo:probe back");

    // 运行进行中到达的消息：本次运行不吸收，由下一次运行放在吸收它的调用处
    const before = sent.length;
    await postMessage(owner, orgId, conv, "slow:400:thinking slowly");
    await waitFor(async () => sent.length > before, 10_000, "slow request sent");
    await postMessage(owner, orgId, conv, "echo:interjected");
    n += 2;
    await waitForTerminal(db, conv, n, 30_000);

    const events = await eventsOf(db, conv);
    const types = new Set(events.map((e) => e.type));
    expect(types).toContain("skills_catalog");
    expect(events.filter((e) => e.type === "skills_catalog")).toHaveLength(2);
    expect(types).toContain("reminder");
    const reminders = events.flatMap((e) => (e.type === "reminder" ? [e.payload.text] : []));
    expect(reminders.some((t) => t.startsWith("The following tools are unavailable"))).toBe(true);
    expect(reminders.some((t) => t.startsWith("You are close to the step limit"))).toBe(true);
    const calls = modelCalls(events);
    expect(calls.some((c) => c.payload.request.catalog !== undefined)).toBe(true);
    expect(calls.some((c) => c.payload.request.tools?.some((t) => t.key === echoKey))).toBe(true);

    // 跨运行插话：放在慢回复之后（由吸收它的下一次运行发出）
    const lastReq = sent.at(-1) as ModelRequest;
    const textAt = (role: string, text: string) =>
      lastReq.messages.findIndex(
        (m) =>
          m.role === role &&
          typeof m.content !== "string" &&
          m.content.some((b) => b.type === "text" && b.text.includes(text)),
      );
    expect(textAt("assistant", "thinking slowly")).toBeGreaterThan(-1);
    expect(textAt("user", "echo:interjected")).toBeGreaterThan(
      textAt("assistant", "thinking slowly"),
    );
    const interjected = events.find(
      (e) =>
        e.type === "user_message" &&
        e.payload.content.some((b) => b.type === "text" && b.text === "echo:interjected"),
    ) as ConversationEvent;
    const slowReply = events.find(
      (e) =>
        e.type === "assistant_message" &&
        e.payload.content.some((b) => b.type === "text" && b.text === "thinking slowly"),
    ) as ConversationEvent;
    expect(interjected.seq).toBeLessThan(slowReply.seq);

    const snap = await snapshotOf(conv);
    await expectZeroDrift(conv, snap);
    // 定义与工具定义都在快照里
    expect(Object.keys(snap.definitions)).toEqual(["1"]);
    for (const c of calls) {
      for (const t of [...(c.payload.request.tools ?? []), ...(c.payload.request.catalog ?? [])]) {
        expect(snap.toolSpecs[t.specHash]).toBeDefined();
      }
    }
  });

  it("运行内插话、轮次上限的收尾调用（toolChoice none）", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-looper", model: "loop-1" },
      { tools: PROBE_TOOLS },
    );
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "loop:400");
    await waitForEvent(db, conv, (e) => e.type === "model_call");
    await postMessage(owner, orgId, conv, "interjection while looping");
    await waitForTerminal(db, conv, 1, 30_000);
    await postMessage(owner, orgId, conv, "loop:1");
    await waitForTerminal(db, conv, 2, 30_000);

    const events = await eventsOf(db, conv);
    const calls = modelCalls(events);
    expect(calls.at(-1)?.payload.request.toolChoice).toBe("none");
    expect(sent.at(-1)?.messages.at(-1)).toEqual({ role: "system", content: WRAP_UP_REMINDER });
    // 插话在第 1 步进行中到达，第 2 步吸收（放在第 1 步回复之后）
    const interjection = events.find(
      (e) =>
        e.type === "user_message" &&
        e.payload.content.some((b) => b.type === "text" && b.text.startsWith("interjection")),
    ) as ConversationEvent;
    expect(interjection.seq).toBeGreaterThan(calls[0]?.seq ?? 0);
    expect(calls[0]?.payload.request.absorbedUpToSeq).toBeLessThan(interjection.seq);
    expect(calls[1]?.payload.request.absorbedUpToSeq).toBeGreaterThanOrEqual(interjection.seq);

    const first = await snapshotOf(conv, (await runsOf(db, conv))[0]?.id);
    await expectZeroDrift(conv, first, 2);
    const snap = await snapshotOf(conv);
    await expectZeroDrift(conv, snap);

    // 每步最后一次尝试（本次运行，含收尾调用）
    const runId = await lastRunId(conv);
    const own = calls.filter((c) => c.runId === runId);
    expect(replayableCalls(snap)).toEqual(
      own.map((c) => {
        const reply = events.find(
          (e) =>
            e.type === "assistant_message" &&
            e.runId === runId &&
            e.payload.step === c.payload.step,
        ) as ConversationEvent;
        return { seq: c.seq, step: c.payload.step, assistantSeq: reply.seq };
      }),
    );
    expect(replayableCalls(snap).length).toBe(5);
  });

  it("压缩摘要之后的请求", async () => {
    reset();
    const agentId = await createAgent({ provider: "model-fake", model: "fake-small" });
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    for (let i = 0; i < 5; i++) {
      await postMessage(owner, orgId, conv, `long:${300 + i}`);
      await waitForTerminal(db, conv, ++n, 30_000);
    }
    const events = await eventsOf(db, conv);
    expect(events.filter((e) => e.type === "compaction_summary").length).toBeGreaterThan(0);
    const calls = modelCalls(events);
    expect(calls.some((c) => c.payload.request.summarySeq !== null)).toBe(true);
    expect(compactions.length).toBeGreaterThan(0);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("图片：视觉模型收到字节、重试的尝试、供应商拒收后 media_excluded、附件不在的占位；之后被删 → media_missing", async () => {
    reset();
    const info = await modelInfo("model-fake", "fake-v");
    const agentId = await createAgent({ provider: "model-fake", model: "fake-v" });
    const conv = await createConv(owner, orgId, agentId);
    const keep = await attach("keep.png", PNG);
    const bad = await attach("bad.png", PNG);
    await postWithFiles(conv, "media: look", [keep]);
    await waitForTerminal(db, conv, 1, 30_000);
    await postMessage(owner, orgId, conv, "fail:overloaded");
    await waitForTerminal(db, conv, 2, 30_000);
    await postWithFiles(conv, "fail:invalid_request", [bad]);
    await waitForTerminal(db, conv, 3, 30_000);
    // 发送前对象就不在了：记录的就是「不再可用」
    const gone = await attach("gone.png", PNG);
    await k.storage.kernel(orgId).delete(`attachments/${gone}`);
    await postWithFiles(conv, "media: again", [gone]);
    await waitForTerminal(db, conv, 4, 30_000);

    const events = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "media_excluded")).toBe(true);
    const outcomes = modelCalls(events).flatMap((c) =>
      (c.payload.request.media ?? []).map((m) => m.outcome),
    );
    expect(outcomes).toContain("bytes");
    expect(outcomes).toContain("excluded");
    expect(outcomes).toContain("unavailable");
    // 可重试失败：同一步两次尝试，都可还原；没有回复的步骤不算可回放
    const failedRun = (await runsOf(db, conv))[1]?.id as string;
    expect(modelCalls(events).filter((c) => c.runId === failedRun)).toHaveLength(2);
    expect(replayableCalls(await snapshotOf(conv, failedRun))).toEqual([]);

    const snap = await snapshotOf(conv);
    await expectZeroDrift(conv, snap);

    // 基线里媒体结果与记录不同 → media_changed（按附件 id 比 outcome 与 etag）
    const head = modelCalls(toEvents(snap))[0] as ModelCallEvent;
    expect(head.payload.request.mediaBudgetBytes).toBe(k.config.attachments.requestMediaBytes);
    const headMedia = await mediaFor(conv, snap, head.seq, info);
    const swapped = new Map(headMedia.mediaInfo);
    swapped.set(keep, { ...(swapped.get(keep) as MediaInfo), etag: "replaced-object" });
    expect(
      reconstructRequest(snap, head.seq, { model: info, ...headMedia, mediaInfo: swapped }).drift,
    ).toEqual(["media_changed"]);
    // 预算不同（不传时用记录的预算）：图片被省略
    const tight = reconstructRequest(snap, head.seq, {
      model: info,
      ...headMedia,
      mediaBudgetBytes: 1,
    });
    expect(tight.drift).toEqual(["media_changed"]);
    expect(JSON.stringify(tight.request)).toContain("omitted to fit the request size limit");
    expect(reconstructRequest(snap, head.seq, { model: info, ...headMedia }).request).toEqual(
      sent[0],
    );
    // 较早的事件：没有记录预算 / 没有记录媒体结果 → legacy_event（不限预算，请求不变）
    for (const field of ["mediaBudgetBytes", "media"]) {
      const old = structuredClone(snap);
      const ev = old.events.find((e) => e.seq === head.seq) as { payload: unknown };
      delete (ev.payload as { request: Record<string, unknown> }).request[field];
      const out = reconstructRequest(old, head.seq, { model: info, ...headMedia });
      expect(out.drift, field).toEqual(["legacy_event"]);
      expect(out.request, field).toEqual(sent[0]);
    }

    // 附件对象被删：带过字节的请求还原时只能给占位，记 media_missing
    await k.storage.kernel(orgId).delete(`attachments/${keep}`);
    const first = modelCalls(toEvents(snap))[0] as ModelCallEvent;
    expect(first.payload.request.media?.map((m) => m.outcome)).toEqual(["bytes"]);
    const out = reconstructRequest(snap, first.seq, {
      model: info,
      ...(await mediaFor(conv, snap, first.seq, info)),
    });
    expect(out.drift).toEqual(["media_missing"]);
    expect(JSON.stringify(out.request)).toContain("is no longer available");
    // 已被排除的与本来就不在的，还原结果不变
    const last = modelCalls(toEvents(snap)).at(-1) as ModelCallEvent;
    expect(last.payload.request.media?.map((m) => m.outcome)).toEqual([
      "excluded",
      "excluded",
      "unavailable",
    ]);
    const again = reconstructRequest(snap, last.seq, {
      model: info,
      ...(await mediaFor(conv, snap, last.seq, info)),
    });
    expect(again.drift).toEqual([]);
    expect(again.request).toEqual(sent.at(-1));
  });

  it("不支持视觉的模型：图片换成占位，不取字节", async () => {
    reset();
    const agentId = await createAgent({ provider: "model-fake", model: "fake-1" });
    const conv = await createConv(owner, orgId, agentId);
    const img = await attach("cat.png", PNG);
    await postWithFiles(conv, "echo:see this", [img]);
    await waitForTerminal(db, conv, 1, 30_000);
    const snap = await snapshotOf(conv);
    const call = modelCalls(toEvents(snap))[0] as ModelCallEvent;
    expect(call.payload.request.media?.map((m) => m.outcome)).toEqual(["placeholder_unsupported"]);
    expect(snapshotMediaRefs(snap, call.seq, await modelInfo("model-fake", "fake-1"))).toEqual([]);
    await expectZeroDrift(conv, snap);
  });

  it("pinned skills, a pinned version change mid-conversation, a claude-code skill with the tool map, and a compaction: zero drift and equal to what the provider received", async () => {
    reset();
    const pinned = await seedSkill("pinned-rules", "Always answer in haiku.");
    const brain = await seedSkill("brainstorming", "Brainstorm first.", undefined, {
      format: "claude-code",
      plugin: "superpowers",
    });
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-small" },
      { skills: { orgSkills: [pinned, brain], pinned: [pinned] } },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    await turn("echo:first");
    await turn('tool:skill_load:{"name":"superpowers:brainstorming"}');
    // a new version of the pinned skill: the next run writes a snapshot with the new body
    await seedSkill("pinned-rules", "Always answer in limericks.", pinned);
    for (let i = 0; i < 5; i++) await turn(`long:${300 + i}`);

    const events = await eventsOf(db, conv);
    const snaps = events.filter(
      (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
        e.type === "skills_catalog",
    );
    expect(snaps.map((e) => e.payload.pinned?.map((p) => p.version))).toEqual([[1], [2]]);
    expect(snaps.every((e) => e.payload.toolMap === CLAUDE_CODE_TOOL_MAP)).toBe(true);
    expect(events.some((e) => e.type === "compaction_summary")).toBe(true);
    const first = sent[0] as ModelRequest;
    expect(first.system[0]?.text).toContain('<pinned_skill name="pinned-rules" version="1">');
    expect(first.system[0]?.text).toContain(CLAUDE_CODE_TOOL_MAP);
    const loaded = events.find((e) => e.type === "tool_result");
    expect(loaded?.type === "tool_result" && loaded.payload.isError).toBe(false);
    const texts = sent.flatMap((r) =>
      r.messages.flatMap((m) => (m.role === "system" ? [m.content as string] : [])),
    );
    expect(texts.some((t) => t.includes('<pinned_skill name="pinned-rules" version="2">'))).toBe(
      true,
    );
    // the compaction restores the current pinned set after the summary (the system segment still
    // holds version 1); without this a regression in the restore would drift baseline and
    // recording together and still reach zero drift
    const restored = sent.filter((r) =>
      r.messages.some(
        (m) =>
          m.role === "system" &&
          (m.content as string).includes(
            "Pinned skills now (this replaces any earlier pinned skills):",
          ) &&
          (m.content as string).includes('<pinned_skill name="pinned-rules" version="2">'),
      ),
    );
    expect(restored.length).toBeGreaterThan(0);
    // and no pinned skill is listed under "Updated skills" (M3)
    const updatedLists = texts.flatMap((t) => {
      const at = t.indexOf("Updated skills (");
      return at < 0 ? [] : [t.slice(at).split("\n\n")[0] as string];
    });
    expect(updatedLists.some((l) => l.includes("- pinned-rules:"))).toBe(false);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("a tool call denied by a tool.preExecute policy hook: zero drift, hook_denied not in requests", async () => {
    reset();
    const enable = async (enabled: boolean) => {
      const res = await owner({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
        payload: { enabled },
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    const key = "hooks-probe__probe_echo";
    await enable(true);
    try {
      const cfg = await owner({
        method: "POST",
        url: "/plugins/hooks-probe/config",
        payload: { orgId, denyTools: [key] },
      });
      expect(cfg.statusCode, cfg.body).toBe(200);
      const agentId = await createAgent(
        { provider: "model-fake", model: "fake-1" },
        { tools: [{ kind: "plugin", plugin: "hooks-probe", name: "probe_echo" }] },
      );
      const conv = await createConv(owner, orgId, agentId);
      await postMessage(owner, orgId, conv, `tool:${key}:{"text":"x"}`);
      await waitForTerminal(db, conv, 1, 30_000);
      const events = await eventsOf(db, conv);
      expect(events.some((e) => e.type === "hook_denied")).toBe(true);
      const result = events.find((e) => e.type === "tool_result");
      expect(result?.type === "tool_result" && result.payload.content).toBe(
        hookDeniedText("hooks-probe", "nope"),
      );
      // the second request carries the denied call's tool_result, and nothing of hook_denied
      expect(JSON.stringify(sent.at(-1))).not.toContain("hook_denied");
      const snap = await snapshotOf(conv);
      await expectZeroDrift(conv, snap);
      const [run] = buildTrajectory(toEvents(snap), new Map());
      expect(run?.steps[0]?.toolCalls[0]?.hookDenied).toEqual({
        plugin: "hooks-probe",
        reason: "nope",
        cause: "deny",
      });
    } finally {
      await enable(false);
    }
  });
});

describe("reconstructRequest：漂移原因", { timeout: 60_000 }, () => {
  let snap: CaseSnapshot;
  let seq: number;
  let info: ModelInfo;

  beforeAll(async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: PROBE_TOOLS },
    );
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, 'tool:tool_search:{"query":"second"}');
    await waitForTerminal(db, conv, 1, 30_000);
    snap = await snapshotOf(conv);
    const last = modelCalls(toEvents(snap)).at(-1) as ModelCallEvent;
    seq = last.seq;
    info = await modelInfo("model-fake", "fake-1");
    expect(reconstructRequest(snap, seq, { model: info }).drift).toEqual([]);
  }, 60_000);

  const clone = () => structuredClone(snap);

  it("快照里没有这个 model_call → eval.call_not_found", () => {
    let err: unknown;
    try {
      reconstructRequest(snap, 999_999, { model: info });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("eval.call_not_found");
    expect((err as ApiError).status).toBe(404);
  });

  it("没给候选参数：记录的参数按所用模型的声明清洗，丢了键 → params_changed", () => {
    const s = clone();
    const call = s.events.find((e) => e.seq === seq) as { payload: unknown };
    (call.payload as { request: { params: Record<string, unknown> } }).request.params = {
      effort: "high",
    };
    const same = reconstructRequest(s, seq, { model: info });
    expect(same.request.params).toEqual({ effort: "high" });
    expect(same.drift).toEqual([]);
    const swapped: ModelInfo = { ...info, id: "other", parameters: [] };
    const out = reconstructRequest(s, seq, { model: swapped });
    expect(out.drift).toEqual(["params_changed"]);
    expect(out.request.params).toEqual({});
    expect(out.request.model).toBe("other");
  });

  it("缺 agent 版本定义 → definition_missing（用空指令，system 也随之不同）", () => {
    const s = clone();
    s.definitions = {};
    const out = reconstructRequest(s, seq, { model: info });
    expect(out.drift).toEqual(["system_hash", "definition_missing"]);
    expect(out.request.system[0]?.text).not.toContain("Be helpful.");
  });

  it("缺工具定义 → tool_spec_missing，该工具从请求里去掉", () => {
    const s = clone();
    const call = s.events.find((e) => e.seq === seq) as { payload: unknown };
    const tools = (call.payload as { request: { tools: { key: string; specHash: string }[] } })
      .request.tools;
    // 内置的 tool_search 不在目录里：去掉它只影响工具列表，不影响 system
    const victim = tools.find((t) => t.key === "tool_search") as { key: string; specHash: string };
    delete s.toolSpecs[victim.specHash];
    const out = reconstructRequest(s, seq, { model: info });
    expect(out.drift).toEqual(["tool_spec_missing"]);
    expect(out.request.tools.map((t) => t.name)).not.toContain(victim.key);
  });

  it("记录缺 tools / params / absorbedUpToSeq / maxOutputTokens → legacy_event", () => {
    for (const field of ["tools", "params", "absorbedUpToSeq", "maxOutputTokens"]) {
      const s = clone();
      const call = s.events.find((e) => e.seq === seq) as { payload: unknown };
      delete (call.payload as { request: Record<string, unknown> }).request[field];
      const out = reconstructRequest(s, seq, { model: info });
      expect(out.drift, field).toContain("legacy_event");
    }
  });

  it("a candidate version that pins differently -> pinned_changed", () => {
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    const out = reconstructRequest(snap, seq, {
      model: info,
      definition: { ...def, skills: { orgSkills: [], pinned: ["some-skill"] } },
    });
    expect(out.drift).toEqual(["pinned_changed"]);
    // the request still uses the recorded snapshot: no pinned text
    expect(out.request.system[0]?.text).not.toContain("Pinned skills");
    const same = reconstructRequest(snap, seq, {
      model: info,
      definition: { ...def, instructions: "Be terse." },
    });
    expect(same.drift).toEqual([]);
  });

  it("pinned_changed compares the candidate with the original version's pins, not the effective snapshot", () => {
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    // the original version pinned a skill that has since been deleted: the recorded snapshot
    // carries no pinned skills, yet the pinning of a params-only candidate is unchanged
    const s = clone();
    s.definitions["1"] = { ...def, skills: { orgSkills: [], pinned: ["gone-skill"] } };
    const paramsOnly = reconstructRequest(s, seq, { model: info, params: { effort: "high" } });
    expect(paramsOnly.drift).toEqual([]);
    // an instructions-only candidate, with a duplicated pin, still pins the same
    const sameDef = s.definitions["1"] as typeof def;
    const dup = reconstructRequest(s, seq, {
      model: info,
      definition: {
        ...sameDef,
        instructions: "Be terse.",
        skills: { orgSkills: [], pinned: ["gone-skill", "gone-skill"] },
      },
    });
    expect(dup.drift).toEqual([]);
    // a real change still gives pinned_changed
    const changed = reconstructRequest(s, seq, {
      model: info,
      definition: { ...sameDef, skills: { orgSkills: [], pinned: ["other-skill"] } },
    });
    expect(changed.drift).toEqual(["pinned_changed"]);
  });

  it("definition_missing: the stub's empty pins add no pinned_changed; the snapshot ids are the fallback", () => {
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    // a recorded snapshot with one pinned skill, ahead of every other event
    const withPinned = () => {
      const s = clone();
      const first = s.events[0] as (typeof s.events)[number];
      const skill = { id: "p1", name: "p", description: "P.", version: 1, source: "src/p1" };
      s.events.unshift({
        ...first,
        seq: first.seq - 1,
        type: "skills_catalog",
        payload: { skills: [skill], pinned: [{ ...skill, body: "Pinned." }] },
      });
      s.definitions = {};
      return s;
    };
    const missing = reconstructRequest(withPinned(), seq, {
      model: info,
      params: { effort: "high" },
    });
    expect(missing.drift).toContain("definition_missing");
    expect(missing.drift).not.toContain("pinned_changed");
    // the original version's definition is missing, the candidate brings its own: compare with
    // the snapshot's pinned ids
    const pinsSame = reconstructRequest(withPinned(), seq, {
      model: info,
      definition: { ...def, skills: { orgSkills: [], pinned: ["p1"] } },
    });
    expect(pinsSame.drift).toEqual([]);
    const pinsOther = reconstructRequest(withPinned(), seq, {
      model: info,
      definition: { ...def, skills: { orgSkills: [], pinned: [] } },
    });
    expect(pinsOther.drift).toEqual(["pinned_changed"]);
  });

  it("候选（换定义或参数）不判定 system_hash / tools_changed", () => {
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    const out = reconstructRequest(snap, seq, {
      model: info,
      definition: { ...def, instructions: "Be terse." },
      params: { effort: "high" },
    });
    expect(out.drift).toEqual([]);
    expect(out.request.system[0]?.text).toContain("Be terse.");
    expect(out.request.params).toEqual({ effort: "high" });
    // 基线换了指令的定义 → system_hash
    const s = clone();
    s.definitions["1"] = { ...def, instructions: "Changed." };
    expect(reconstructRequest(s, seq, { model: info }).drift).toEqual(["system_hash"]);
    // 换成不支持工具的模型：基线记 tools_changed（目录块也随之没有，system 不同）
    const noTools: ModelInfo = { ...info, capabilities: { ...info.capabilities, tools: false } };
    expect(reconstructRequest(snap, seq, { model: noTools }).drift).toEqual([
      "system_hash",
      "tools_changed",
    ]);
  });
});

describe("takeSnapshot", { timeout: 60_000 }, () => {
  it("运行未到终态 → eval.run_not_finished 409；超过上限 → eval.case_too_large 413", async () => {
    reset();
    const agentId = await createAgent({ provider: "model-fake", model: "fake-1" });
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "slow:300:waiting for the end");
    await waitForEvent(db, conv, (e) => e.type === "model_call");
    const runId = await lastRunId(conv);
    const err = await takeSnapshot(db, orgId, conv, runId, 4_194_304).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("eval.run_not_finished");
    expect((err as ApiError).status).toBe(409);
    await waitForTerminal(db, conv, 1, 30_000);

    const snap = await takeSnapshot(db, orgId, conv, runId, 4_194_304);
    const size = Buffer.byteLength(JSON.stringify(snap));
    const big = await takeSnapshot(db, orgId, conv, runId, size - 1).catch((e) => e);
    expect((big as ApiError).code).toBe("eval.case_too_large");
    expect((big as ApiError).status).toBe(413);
    expect(await takeSnapshot(db, orgId, conv, runId, size)).toEqual(snap);
    // 读事件时一超过上限就停
    const tiny = await takeSnapshot(db, orgId, conv, runId, 10).catch((e) => e);
    expect((tiny as ApiError).code).toBe("eval.case_too_large");

    // 形状：事件截至终态，带运行与 agent 信息
    expect(snap).toMatchObject({ version: 1, orgId, conversationId: conv, runId, agentId });
    expect(snap.agentVersion).toBe(1);
    expect(snap.events.at(-1)?.type).toBe("run_finished");
    expect(typeof snap.events[0]?.createdAt).toBe("string");
    // 别的组织拿不到
    const other = await takeSnapshot(db, randomUUID(), conv, runId, 4_194_304).catch((e) => e);
    expect((other as ApiError).code).toBe("conversation.not_found");
  });
});
