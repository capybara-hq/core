import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AgentDefinition, normalizeStoredDefinition } from "../../src/agents/definition.js";
import { AttachmentsService } from "../../src/conversations/attachments.service.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb, type SkillManifest } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import {
  reconstructRequest,
  snapshotMediaRefs,
  subagentChanged,
} from "../../src/evals/reconstruct.js";
import {
  type CaseSnapshot,
  replayableCalls,
  takeSnapshot,
  toEvents,
} from "../../src/evals/snapshot.js";
import { buildTrajectory } from "../../src/evals/trajectory.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import type { KernelLogger } from "../../src/log.js";
import type { MediaInfo } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { MORE_SKILLS_HEADER } from "../../src/runtime/context/skills.js";
import { WRAP_UP_REMINDER } from "../../src/runtime/model-call.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { RUN_CONTEXT_CLOCK } from "../../src/runtime/run-context.service.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import { catalogLineChars, SkillsCatalogService } from "../../src/skills/catalog.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { allowedOnceNote } from "../../src/tools/network-asks.js";
import { hookDeniedText, QUESTION_SKIPPED_TEXT } from "../../src/tools/pipeline.js";
import { specHash } from "../../src/tools/registry.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
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
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";
import { onlySkills } from "../helpers/skills.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";

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
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
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
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let sandboxRoot: string;

/** The run context clock (`RUN_CONTEXT_CLOCK`): real time unless a test sets a day. */
let clockMs: number | null = null;

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-reconstruct-sbx-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        // gateway: a connected device's network ask (network ask-to-allow P1.7)
        roles: ["api", "worker", "gateway"],
        sandbox: { limits: { egress: "allowlist", allowHosts: ["*.example.com"] } },
        extensions: [
          MODEL_FAKE,
          MODEL_LOOPER,
          OBJECT_STORE,
          TOOLS_PROBE,
          HOOKS_PROBE,
          SANDBOX_FAKE,
        ],
        runtime: { maxSteps: 4 },
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
          "sandbox-fake": { root: sandboxRoot },
        },
      },
    ),
    // run context spec §10: the day a run start reads (a test moves it forward)
    { overrides: [{ provide: RUN_CONTEXT_CLOCK, useValue: () => clockMs ?? Date.now() }] },
  );
  // the compaction settings this fixture used to set through `runtime.keepRecentTurns` (context
  // compaction spec §4.8 moved them to the deployment settings, read live per model step). The
  // zero reserve keeps the hard fit guard's target reachable for the small-window fake model
  await db
    .insertInto("deployment_settings")
    .values({
      key: "compaction",
      value: JSON.stringify({ keepRecentTurns: 1, reserveTokens: 0 }),
    })
    .execute();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await enableProbe(true);
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

async function enableProbe(enabled: boolean): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/tools-probe`,
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const ASK_INPUT = {
  questions: [
    {
      question: "Which database should I use?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "Relational" },
        { label: "Mongo", description: "Document store" },
      ],
    },
  ],
};

const PROBE_TOOLS = [
  { kind: "plugin", plugin: "tools-probe", name: "echo" },
  { kind: "plugin", plugin: "tools-probe", name: "second" },
];

/**
 * An agent with only the tools `extra.tools` names (refs as the old enabled list wrote them):
 * every other builtin and the probe extensions it does not name turned off (tools default-on
 * spec), so the recorded requests carry what each case set up.
 */
async function createAgent(
  model: { provider: string; model: string },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { tools, skills, ...rest } = extra as {
    tools?: Record<string, unknown>[];
    skills?: string[];
  };
  // only the skills the test names: the org's other skills (seeded by earlier tests) are off
  const disabledSkills = await onlySkills(db, orgId, skills);
  const named = new Set((tools ?? []).flatMap((r) => (r.kind === "plugin" ? [r.plugin] : [])));
  const extensionsOff = ["tools-probe", "hooks-probe"]
    .filter((p) => !named.has(p))
    .map((plugin) => ({ kind: "plugin", plugin, tools: "all" }));
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model,
        disabledTools: [...onlyBuiltins(tools ?? []), ...extensionsOff],
        disabledSkills,
        ...rest,
      },
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
  opts: {
    format?: "claude-code";
    plugin?: string;
    invocation?: SkillManifest["invocation"];
    /** Files besides SKILL.md. */
    files?: Record<string, string>;
  } = {},
): Promise<string> {
  const prefix = `skills/${randomUUID()}/`;
  const text = `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;
  const files: { path: string; size: number; sha256: string }[] = [];
  for (const [path, content] of Object.entries({ "SKILL.md": text, ...opts.files })) {
    const data = new TextEncoder().encode(content);
    await k.app.get(StorageService).kernel(orgId).put(`${prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    files.push({ path, size: data.byteLength, sha256: sha(data) });
  }
  const manifest = {
    name,
    description: `Use for ${name} work.`,
    files,
    ...(opts.invocation !== undefined && { invocation: opts.invocation }),
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
  return (await k.app.get(ProviderRegistry).resolve(orgId, { provider, model })).info;
}

/** 还原用的媒体：按快照里的引用取当前的附件行与字节（与运行时一样，只取该模型用得到的）。 */
async function mediaFor(convId: string, snap: CaseSnapshot, seq: number, info: ModelInfo) {
  const ids = snapshotMediaRefs(snap, seq, info);
  if (ids.length === 0) return {};
  const mediaInfo = await k.app.get(AttachmentsService).mediaInfo(orgId, convId, ids);
  const media = await k.app
    .get(AttachmentsService)
    .fetchMedia(orgId, convId, [...mediaInfo.keys()]);
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
      mediaBudgetBytes: k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
      ...(await mediaFor(convId, snap, c.seq, info)),
    });
    expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
    expect(out.request, `model_call seq ${c.seq}`).toEqual(sent[i]);
    const {
      maxOutputTokens: _m,
      droppedParams: _d,
      estimatedInputTokens: _e,
      fit: _f,
      ...meta
    } = c.payload.request;
    expect(out.meta).toEqual(meta);
  }
}

async function snapshotOf(convId: string, runId?: string): Promise<CaseSnapshot> {
  return takeSnapshot(db, orgId, convId, runId ?? (await lastRunId(convId)), 4_194_304);
}

const reset = () => capture.reset();

/**
 * A definition's pins from before skills were on by default (skills default-on spec §4): no
 * longer in the type, still in old definitions.
 */
const oldPins = (pinned: string[]) =>
  ({ orgSkills: [], pinned }) as unknown as NonNullable<AgentDefinition["skills"]>;

describe("reconstructRequest：基线零漂移", { timeout: 120_000 }, () => {
  it("多步工具、ToolSearch 加载、审批续跑、技能目录快照与变更、提醒、跨运行插话、工具不可用", async () => {
    reset();
    const alpha = await seedSkill("alpha", "Alpha body.");
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: PROBE_TOOLS, skills: [alpha] },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };

    // ToolSearch 加载 echo，再调用它（第 2 步带轮次提醒）
    await turn('tool:ToolSearch:{"query":"echo"}');
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
    await turn('tool:Skill:{"skill":"alpha"}');

    // 技能新版本：下一轮写新快照（变更提醒）
    await seedSkill("alpha", "Alpha body v2.", alpha);
    await turn("echo:after skill update");

    // the extension switched off in the org: its tools go (tools default-on spec §4: no
    // unavailable reminder, the next run's tools_changed tells the model), then come back
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
    expect(reminders.some((t) => t.startsWith("The following tools are unavailable"))).toBe(false);
    expect(reminders.some((t) => t.startsWith("You are close to the step limit"))).toBe(true);
    // the probe switched off and on: each run's first request tells the model (tool naming spec
    // §9.1), rendered as a system message and rebuilt from the log below
    const changes = events.flatMap((e) => (e.type === "tools_changed" ? [e.payload] : []));
    expect(changes).toHaveLength(2);
    expect(changes[0]?.added).toEqual([]);
    expect(changes[0]?.removed).toContain(echoKey);
    expect(changes[1]?.added).toEqual(changes[0]?.removed);
    expect(changes[1]?.removed).toEqual([]);
    const notices = sent.flatMap((r) =>
      r.messages.filter(
        (m) =>
          m.role === "system" &&
          typeof m.content === "string" &&
          m.content.startsWith("Your tools changed."),
      ),
    );
    expect(notices.length).toBeGreaterThan(0);
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

    // a recording made after the tool rename: its system texts name the new builtins (and the
    // reconstruction below renders the same texts, zero drift)
    const systemTexts = [
      ...lastReq.system.map((s) => s.text),
      ...lastReq.messages.flatMap((m) => (m.role === "system" ? [m.content as string] : [])),
    ].join("\n");
    expect(systemTexts).toContain("call Skill with the skill's name");
    expect(systemTexts).toContain("call Skill again before relying on earlier instructions");
    expect(systemTexts).toContain("first call ToolSearch with keywords");
    expect(systemTexts).not.toMatch(/skill_load|tool_search/);

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

  it("a parent request with a subagent_delivery rebuilds with zero drift", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-looper", model: "loop-1" },
      { tools: PROBE_TOOLS },
    );
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "loop:400");
    await waitForEvent(db, conv, (e) => e.type === "model_call");
    // a child's report lands while the parent's step 1 runs (agent map spec §5.2)
    const [delivery] = await k.app.get(EventLog).append(conv, [
      {
        type: "subagent_delivery",
        idemKey: `test_delivery:${conv}`,
        payload: {
          subagentId: "sa_child",
          childRunId: randomUUID(),
          description: "Survey the module",
          kind: "report",
          text: "Three call sites.",
          triggerAccountId: ownerId,
        },
      },
      {
        type: "subagent_delivery",
        idemKey: `test_delivery_failed:${conv}`,
        payload: {
          subagentId: "sa_other",
          childRunId: randomUUID(),
          description: "Check the build",
          kind: "finished",
          status: "failed",
          errorCode: "model.unavailable",
          text: "The model provider is unavailable.",
          triggerAccountId: ownerId,
        },
      },
    ]);
    await waitForTerminal(db, conv, 1, 30_000);

    const calls = modelCalls(await eventsOf(db, conv));
    const absorbing = calls.findIndex(
      (c) => (c.payload.request.absorbedUpToSeq ?? 0) >= (delivery?.seq ?? Infinity),
    );
    expect(absorbing).toBeGreaterThan(0);
    expect(sent[absorbing]?.messages).toContainEqual({
      role: "system",
      content: 'Sub-agent sa_child ("Survey the module") handed back a report:\nThree call sites.',
    });
    expect(sent[absorbing]?.messages).toContainEqual({
      role: "system",
      content:
        'Sub-agent sa_other ("Check the build") failed (model.unavailable): The model provider is unavailable.',
    });
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("a handed-back finish: an old log's delivery keeps its line, a new log has only subagent_finished; zero drift", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-looper", model: "loop-1" },
      { tools: PROBE_TOOLS },
    );
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "loop:400");
    await waitForEvent(db, conv, (e) => e.type === "model_call");
    const report = (subagentId: string, childRunId: string) => ({
      type: "subagent_delivery" as const,
      idemKey: `test_report:${childRunId}`,
      payload: {
        subagentId,
        childRunId,
        description: "Survey the module",
        kind: "report" as const,
        text: `Report of ${subagentId}.`,
        triggerAccountId: ownerId,
      },
    });
    const finished = (subagentId: string, childRunId: string) => ({
      type: "subagent_finished" as const,
      idemKey: `subagent_finished:${childRunId}`,
      payload: {
        subagentId,
        childRunId,
        callId: `call-${subagentId}`,
        status: "completed" as const,
        toolCalls: 1,
        durationMs: 10,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    const oldRun = randomUUID();
    const newRun = randomUUID();
    const appended = await k.app.get(EventLog).append(conv, [
      // written before 2026-11-07: report, subagent_finished and a handed-back finished delivery
      report("sa_old", oldRun),
      finished("sa_old", oldRun),
      {
        type: "subagent_delivery",
        idemKey: `test_finished:${oldRun}`,
        payload: {
          subagentId: "sa_old",
          childRunId: oldRun,
          description: "Survey the module",
          kind: "finished",
          status: "completed",
          text: "",
          handedBack: true,
          triggerAccountId: ownerId,
        },
      },
      // written now: no finished delivery after a handback that completed
      report("sa_new", newRun),
      finished("sa_new", newRun),
    ]);
    await waitForTerminal(db, conv, 1, 30_000);

    // the newest absorbable event (subagent_finished is not one)
    const last = appended.at(-2)?.seq ?? Infinity;
    const calls = modelCalls(await eventsOf(db, conv));
    const absorbing = calls.findIndex((c) => (c.payload.request.absorbedUpToSeq ?? 0) >= last);
    expect(absorbing).toBeGreaterThan(0);
    const system = (sent[absorbing]?.messages ?? []).filter(
      (m) => m.role === "system" && String(m.content).startsWith("Sub-agent "),
    );
    expect(system).toEqual([
      {
        role: "system",
        content: 'Sub-agent sa_old ("Survey the module") handed back a report:\nReport of sa_old.',
      },
      {
        role: "system",
        content:
          'Sub-agent sa_old ("Survey the module") completed; its report was already delivered.',
      },
      {
        role: "system",
        content: 'Sub-agent sa_new ("Survey the module") handed back a report:\nReport of sa_new.',
      },
    ]);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("a question skipped by a message: the skipped result, then the message; zero drift and equal to what the provider received", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: [{ kind: "builtin", name: "AskUserQuestion" }] },
    );
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, `tool:AskUserQuestion:${JSON.stringify(ASK_INPUT)}`);
    const asked = await waitForEvent(db, conv, (e) => e.type === "question_asked");
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("runs")
            .select("status")
            .where("id", "=", asked.runId as string)
            .executeTakeFirst()
        )?.status === "waiting",
      10_000,
      "run waiting",
    );
    await postMessage(owner, orgId, conv, "echo:never mind, use SQLite");
    await waitForTerminal(db, conv, 1, 30_000);

    const events = await eventsOf(db, conv);
    expect(
      events.flatMap((e) => (e.type === "question_answered" ? [e.payload.outcome] : [])),
    ).toEqual(["skipped"]);
    const last = sent.at(-1) as ModelRequest;
    // the tool results turn (the skipped result), then the message
    const resultAt = last.messages.findIndex(
      (m) =>
        typeof m.content !== "string" &&
        m.content.some((b) => b.type === "tool_result" && b.content === QUESTION_SKIPPED_TEXT),
    );
    const messageAt = last.messages.findIndex(
      (m) =>
        m.role === "user" &&
        typeof m.content !== "string" &&
        m.content.some((b) => b.type === "text" && b.text === "echo:never mind, use SQLite"),
    );
    expect(resultAt).toBeGreaterThan(-1);
    expect(messageAt).toBeGreaterThanOrEqual(resultAt);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("a message sent while the asking step streamed: not a skip, the answer then the message; zero drift", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: [{ kind: "builtin", name: "AskUserQuestion" }] },
    );
    const conv = await createConv(owner, orgId, agentId);
    const before = sent.length;
    await postMessage(
      owner,
      orgId,
      conv,
      `slowtool:500:AskUserQuestion:${JSON.stringify(ASK_INPUT)}`,
    );
    await waitFor(async () => sent.length > before, 10_000, "asking step sent");
    const early = await postMessage(owner, orgId, conv, "echo:sent early");
    const asked = await waitForEvent(db, conv, (e) => e.type === "question_asked");
    expect(asked.seq).toBeGreaterThan(early);
    const questionId = asked.type === "question_asked" ? asked.payload.questionId : "";
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("runs")
            .select("status")
            .where("id", "=", asked.runId as string)
            .executeTakeFirst()
        )?.status === "waiting",
      10_000,
      "run waiting",
    );
    const ok = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/questions/${questionId}/answer`,
      payload: { answer: { q0: "Postgres" } },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const events = await eventsOf(db, conv);
    expect(
      events.flatMap((e) => (e.type === "question_answered" ? [e.payload.outcome] : [])),
    ).toEqual(["answered"]);
    await expectZeroDrift(conv, await snapshotOf(conv));
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

  it("plugin_context events before and after a summary (memory spec §6.1): zero drift", async () => {
    reset();
    const agentId = await createAgent({ provider: "model-fake", model: "fake-small" });
    const conv = await createConv(owner, orgId, agentId);
    // written directly: nothing calls context@1 providers here; the runtime only renders the log
    const context = async (key: string, plugin: string, text: string) => {
      await k.app.get(EventLog).append(conv, [
        {
          type: "plugin_context",
          idemKey: `test_plugin_context:${conv}:${key}`,
          payload: { plugin, text, hash: createHash("sha256").update(text).digest("hex") },
        },
      ]);
    };
    await context("1", "notes", "- notes v1");
    await context("2", "memory", "- prefers tea");
    let n = 0;
    for (let i = 0; i < 5; i++) {
      if (i === 1) await context("3", "notes", "- notes v2");
      if (i === 4) await context("4", "memory", "");
      await postMessage(owner, orgId, conv, `long:${300 + i}`);
      await waitForTerminal(db, conv, ++n, 30_000);
    }
    const events = await eventsOf(db, conv);
    const summarySeq = events.findLast((e) => e.type === "compaction_summary")?.seq;
    expect(summarySeq).toBeDefined();
    const tag = (plugin: string, text: string) =>
      `<plugin-context plugin="${plugin}">\n${text}\n</plugin-context>`;
    // before any summary: at their positions
    expect(sent[0]?.messages.slice(0, 2)).toEqual([
      { role: "system", content: tag("notes", "- notes v1") },
      { role: "system", content: tag("memory", "- prefers tea") },
    ]);
    // after a summary covering them: the latest non-empty one per plugin, in plugin-name order
    const afterSummary = sent.filter((r) =>
      JSON.stringify(r.messages[0]?.content ?? "").includes("<conversation_summary>"),
    );
    expect(afterSummary.length).toBeGreaterThan(0);
    const covered = afterSummary.find((r) =>
      r.messages.some((m) => m.role === "system" && m.content === tag("notes", "- notes v2")),
    );
    // right after the summary and the run context
    expect(String(covered?.messages[1]?.content)).toMatch(/^Context from the platform:/);
    expect(covered?.messages.slice(2, 4)).toEqual([
      { role: "system", content: tag("memory", "- prefers tea") },
      { role: "system", content: tag("notes", "- notes v2") },
    ]);
    // the empty memory context, once logged, stops the old text in every later request
    const lastSys = (sent.at(-1)?.messages ?? []).filter((m) => m.role === "system");
    expect(lastSys.some((m) => String(m.content).includes("prefers tea"))).toBe(false);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("run context: snapshots, a rename, a day change, sender lines and a compaction over them: zero drift", async () => {
    reset();
    clockMs = Date.parse("2026-11-08T10:00:00Z");
    try {
      const agentId = await createAgent(
        { provider: "model-fake", model: "fake-small" },
        { name: "Grant", description: "Answers HR questions." },
      );
      const conv = await createConv(owner, orgId, agentId);
      const send = async (text: string, n: number, extra: Record<string, unknown> = {}) => {
        const res = await owner({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
          payload: { text, timeZone: "Asia/Shanghai", locale: "zh", ...extra },
        });
        expect(res.statusCode, res.body).toBe(202);
        await waitForTerminal(db, conv, n, 30_000);
      };
      await send("long:300", 1);
      await send("long:301", 2);
      // a rename of the agent: the next run start writes the new name
      const agent = (
        await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` })
      ).json() as { agent: { currentVersion: number; definition: Record<string, unknown> } };
      const renamed = await owner({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
        payload: { definition: { ...agent.agent.definition, name: "Grant 2" } },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      await send("long:302", 3);
      // the next day; and the sender renamed (a changed sender line)
      clockMs = Date.parse("2026-11-09T10:00:00Z");
      await db
        .updateTable("accounts")
        .set({ display_name: "O2" })
        .where("id", "=", ownerId)
        .execute();
      await send("long:303", 4);
      await send("long:304", 5);

      const events = await eventsOf(db, conv);
      const ctxs = events.filter((e) => e.type === "run_context");
      expect(ctxs.map((e) => e.payload)).toEqual([
        {
          agent: { name: "Grant", description: "Answers HR questions." },
          org: { name: "Acme" },
          date: "2026-11-08",
          timeZone: "Asia/Shanghai",
          locale: "zh",
        },
        { agent: { name: "Grant 2", description: "Answers HR questions." } },
        { date: "2026-11-09" },
      ]);
      const users = events.filter((e) => e.type === "user_message");
      expect(users.map((e) => (e.payload as { sender?: { name: string } }).sender?.name)).toEqual([
        "O",
        "O",
        "O",
        "O2",
        "O2",
      ]);
      expect(events.some((e) => e.type === "compaction_summary")).toBe(true);
      // after a summary that covers snapshots: the current context follows it whole, and the
      // first message after it carries its sender line
      const afterSummary = sent.filter((r) =>
        JSON.stringify(r.messages[0]?.content ?? "").includes("<conversation_summary>"),
      );
      expect(afterSummary.length).toBeGreaterThan(0);
      const last = afterSummary.at(-1) as (typeof sent)[number];
      expect(last.messages[1]?.role).toBe("system");
      expect(String(last.messages[1]?.content)).toMatch(
        /^Context from the platform:\n- You are "Grant 2"/,
      );
      const firstUser = last.messages.find((m) => m.role === "user" && m !== last.messages[0]);
      const firstBlocks = (firstUser?.content ?? []) as { text?: string }[];
      expect(firstBlocks[0]?.text).toMatch(/^From O2? \(owner\)$/);
      // the system text never carries the run context (the cached prefix stays stable)
      expect(
        sent.every((r) => !r.system.some((b) => b.text.includes("Context from the platform"))),
      ).toBe(true);
      await expectZeroDrift(conv, await snapshotOf(conv));
    } finally {
      clockMs = null;
      // the owner is shared by the other cases
      await db
        .updateTable("accounts")
        .set({ display_name: "O" })
        .where("id", "=", ownerId)
        .execute();
    }
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
    await k.app.get(StorageService).kernel(orgId).delete(`attachments/${gone}`);
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
    expect(head.payload.request.mediaBudgetBytes).toBe(
      k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
    );
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
    await k.app.get(StorageService).kernel(orgId).delete(`attachments/${keep}`);
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

  it("a skill version change mid-conversation, a claude-code skill with the tool map, and a compaction: nothing pinned, zero drift and equal to what the provider received", async () => {
    reset();
    // pinning is gone (skills default-on spec §8): the old pinned cases live on in the
    // pre-skills-default-on fixture
    const rules = await seedSkill("house-rules", "Always answer in haiku.");
    const brain = await seedSkill("brainstorming", "Brainstorm first.", undefined, {
      format: "claude-code",
      plugin: "superpowers",
    });
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-small" },
      { skills: [rules, brain] },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    await turn("echo:first");
    await turn('tool:Skill:{"skill":"superpowers:brainstorming"}');
    // a new version of a skill: the next run writes a snapshot with it
    await seedSkill("house-rules", "Always answer in limericks.", rules);
    for (let i = 0; i < 5; i++) await turn(`long:${300 + i}`);

    const events = await eventsOf(db, conv);
    const snaps = events.filter(
      (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
        e.type === "skills_catalog",
    );
    expect(snaps.map((e) => e.payload.pinned)).toEqual([undefined, undefined]);
    expect(
      snaps.map((e) => e.payload.skills.find((x) => x.name === "house-rules")?.version),
    ).toEqual([1, 2]);
    expect(snaps.every((e) => e.payload.toolMap === CLAUDE_CODE_TOOL_MAP)).toBe(true);
    expect(events.some((e) => e.type === "compaction_summary")).toBe(true);
    const first = sent[0] as ModelRequest;
    expect(first.system[0]?.text).not.toContain("<pinned_skill");
    expect(first.system[0]?.text).toContain(CLAUDE_CODE_TOOL_MAP);
    const loaded = events.find((e) => e.type === "tool_result");
    expect(loaded?.type === "tool_result" && loaded.payload.isError).toBe(false);
    const texts = sent.flatMap((r) =>
      r.messages.flatMap((m) => (m.role === "system" ? [m.content as string] : [])),
    );
    // the new version is an ordinary catalog update
    const updatedLists = texts.flatMap((t) => {
      const at = t.indexOf("Updated skills (");
      return at < 0 ? [] : [t.slice(at).split("\n\n")[0] as string];
    });
    expect(updatedLists.some((l) => l.includes("- house-rules:"))).toBe(true);
    expect(texts.some((t) => t.includes("Pinned skill"))).toBe(false);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("a catalog budget change between runs: a new snapshot with name-only entries and an updated notice, then back; zero drift", async () => {
    reset();
    // org skills rank before plugin skills, whatever their names (skills default-on spec §7)
    const plugged = await seedSkill("budget-a", "A.", undefined, { plugin: "budgetplug" });
    const b = await seedSkill("budget-b", "B.");
    const c = await seedSkill("budget-c", "C.");
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-small" },
      { skills: [plugged, b, c] },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    await turn("echo:first");
    // a smaller budget (below the schema's minimum, so set directly): budget-b and budget-c fit
    const config = k.app.get(KernelConfigService);
    const real = config.get();
    const line = (name: string) => catalogLineChars({ name, description: `Use for ${name} work.` });
    const spy = vi.spyOn(config, "get").mockReturnValue({
      ...real,
      skills: { catalogBudgetChars: line("budget-b") + line("budget-c") },
    });
    // the service's own logger (KERNEL_LOGGER is transient: one instance per consumer)
    const serviceLog = (k.app.get(SkillsCatalogService) as unknown as { log: KernelLogger }).log;
    const info = vi.spyOn(serviceLog, "info");
    try {
      await turn("echo:second");
    } finally {
      spy.mockRestore();
    }
    const overBudget = info.mock.calls.filter(([msg]) => msg === "skills.catalog_over_budget");
    info.mockRestore();
    expect(overBudget).toHaveLength(1);
    expect(overBudget[0]?.[1]).toMatchObject({
      orgId,
      agentId,
      entries: 3,
      nameOnly: 1,
      characters: line("budget-a") + line("budget-b") + line("budget-c"),
    });
    await turn("echo:third");

    const snaps = (await eventsOf(db, conv)).filter(
      (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
        e.type === "skills_catalog",
    );
    expect(
      snaps.map((e) => e.payload.skills.filter((s) => s.nameOnly === true).map((s) => s.name)),
    ).toEqual([[], ["budget-a"], []]);
    const first = sent[0] as ModelRequest;
    expect(first.system[0]?.text).toContain("- budget-a: Use for budget-a work.");
    expect(first.system[0]?.text).not.toContain(MORE_SKILLS_HEADER);
    const notices = sent.map((r) =>
      r.messages.flatMap((m) => (m.role === "system" ? [m.content as string] : [])),
    );
    expect(notices[1]).toContain(
      "The skills available in this conversation have changed.\n\n" +
        `Updated skills (call Skill again before relying on earlier instructions):\n${MORE_SKILLS_HEADER}\nbudget-a`,
    );
    expect(notices[2]?.at(-1)).toBe(
      "The skills available in this conversation have changed.\n\n" +
        "Updated skills (call Skill again before relying on earlier instructions):\n" +
        "- budget-a: Use for budget-a work.",
    );
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  // The map texts written before the tool-naming change, before background Bash and before the
  // versioned skill directories of environments, frozen: old snapshots keep them
  const OLD_MAPS: [string, string][] = [
    [
      "the tool-naming change",
      [
        "Some skills in this conversation were written for Claude Code and name its tools. Use these tools instead:",
        "- Bash -> sandbox_bash",
        "- Read -> sandbox_read; Write -> sandbox_write; Edit and MultiEdit -> sandbox_edit; Glob -> sandbox_glob; Grep -> sandbox_grep",
        '- Skill -> skill_load (a name such as "superpowers:brainstorming" also works)',
        "- TodoWrite -> plugin__todo__write when it is in your tools; otherwise keep the task list in your replies",
        "- AskUserQuestion -> ask_user",
        "- ToolSearch -> tool_search when it is in your tools",
        "- Task and Agent (sub-agents) -> agent when it is in your tools (subagent_type names one of the types its description lists; model names haiku / sonnet / opus -> fast / standard / capable; SendMessage to a sub-agent -> agent with resume); otherwise not available: do the steps yourself, in order",
        "- TaskOutput, TaskStop -> not available",
        "- Any other tool a skill names (for example WebFetch, WebSearch, NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code variable the model reads
        "The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after skill_load has copied that skill into the sandbox.",
      ].join("\n"),
    ],
    [
      "background Bash",
      [
        "Some skills in this conversation were written for Claude Code. Its tools Bash, Read, Write, Edit,",
        "Glob, Grep, Skill, AskUserQuestion, ToolSearch and Agent have the same names here, when they are",
        "in your tools. For the others:",
        "- MultiEdit -> several Edit calls",
        "- TodoWrite -> plugin__todo__write when it is in your tools; otherwise keep the task list in your replies",
        "- Task -> Agent; SendMessage to a sub-agent -> Agent with resume; model names haiku / sonnet / opus -> fast / standard / capable",
        "- TaskOutput, TaskStop -> not available",
        "- Any other tool a skill names (for example WebFetch, WebSearch, NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code variable the model reads
        "The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after Skill has copied that skill into the sandbox.",
      ].join("\n"),
    ],
    [
      "environments (skills in /skills/<name>@<version-id>/)",
      [
        "Some skills in this conversation were written for Claude Code. Its tools Bash, Read, Write, Edit,",
        "Glob, Grep, Skill, AskUserQuestion, ToolSearch, Agent, SendMessage, WebFetch and WebSearch have the same names here, when they are",
        "in your tools. For the others:",
        "- MultiEdit -> several Edit calls",
        "- TodoWrite -> plugin__todo__write when it is in your tools; otherwise keep the task list in your replies",
        "- Task -> Agent; model names haiku / sonnet / opus -> fast / standard / capable",
        "- TaskOutput -> TaskOutput, TaskStop -> TaskStop",
        "- Any other tool a skill names (for example NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code variable the model reads
        "The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after Skill has copied that skill into the sandbox.",
      ].join("\n"),
    ],
  ];

  it.each(OLD_MAPS)(
    "an old snapshot keeps its old map text (before %s); a new snapshot gets the new one; both reconstruct with zero drift",
    async (_before, OLD_MAP) => {
      expect(OLD_MAP).not.toBe(CLAUDE_CODE_TOOL_MAP);
      reset();
      const brain = await seedSkill(
        `planning-map-${OLD_MAPS.findIndex((m) => m[1] === OLD_MAP)}`,
        "Plan first.",
        undefined,
        {
          format: "claude-code",
          plugin: "superpowers",
        },
      );
      const agentId = await createAgent(
        { provider: "model-fake", model: "fake-small" },
        { skills: [brain] },
      );
      // a conversation whose skills snapshot was written before phase C: the same skills, the old map
      const probe = await createConv(owner, orgId, agentId);
      await postMessage(owner, orgId, probe, "echo:probe");
      await waitForTerminal(db, probe, 1, 30_000);
      const written = (await eventsOf(db, probe)).find(
        (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
          e.type === "skills_catalog",
      );
      expect(written?.payload.toolMap).toBe(CLAUDE_CODE_TOOL_MAP);
      const conv = await createConv(owner, orgId, agentId);
      await k.app
        .get(EventLog)
        .append(conv, [
          { type: "skills_catalog", payload: { ...written?.payload, toolMap: OLD_MAP } },
        ]);
      reset();
      await postMessage(owner, orgId, conv, "echo:hello");
      await waitForTerminal(db, conv, 1, 30_000);
      const snaps = (await eventsOf(db, conv)).filter(
        (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
          e.type === "skills_catalog",
      );
      expect(snaps.map((e) => e.payload.toolMap)).toEqual([OLD_MAP, CLAUDE_CODE_TOOL_MAP]);
      const first = sent[0] as ModelRequest;
      expect(first.system[0]?.text).toContain(OLD_MAP);
      expect(
        first.messages.some(
          (m) =>
            m.role === "system" &&
            (m.content as string).includes(
              `The following tool-name map now applies:\n${CLAUDE_CODE_TOOL_MAP}`,
            ),
        ),
      ).toBe(true);
      await expectZeroDrift(conv, await snapshotOf(conv));
    },
  );

  it("phase D: two inline invocations, a Skill of the manual one and a compaction over them: the line after the summary, zero drift", async () => {
    reset();
    const fix = await seedSkill("fix-issue", "Fix GitHub issue $ARGUMENTS.");
    const brainstorm = await seedSkill("brainstorm", "Brainstorm before building.", undefined, {
      invocation: { model: false, user: true },
    });
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-small" },
      { skills: [fix, brainstorm] },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const invoke = async (name: string, text: string) => {
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
        payload: { text, skill: { name } },
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    await invoke("fix-issue", "12");
    await invoke("brainstorm", "");
    await turn('tool:Skill:{"skill":"brainstorm"}');
    for (let i = 0; i < 5; i++) await turn(`long:${300 + i}`);

    const events = await eventsOf(db, conv);
    const loaded = events.filter((e) => e.type === "tool_result").at(-1);
    expect(loaded?.type === "tool_result" && loaded.payload.content).toContain(
      "Brainstorm before building.",
    );
    const summary = events.filter((e) => e.type === "compaction_summary").at(-1);
    const invokedSeqs = events
      .filter((e) => e.type === "user_message" && e.payload.skill !== undefined)
      .map((e) => e.seq);
    expect(invokedSeqs).toHaveLength(2);
    expect(
      summary?.type === "compaction_summary" && summary.payload.coversUpToSeq,
    ).toBeGreaterThanOrEqual(invokedSeqs[1] as number);
    const line =
      "Skills the user invoked earlier in this conversation: brainstorm, fix-issue. Call Skill with a name to read its instructions again.";
    const withLine = sent.filter((r) =>
      r.messages.some((m) => m.role === "system" && m.content === line),
    );
    expect(withLine.length).toBeGreaterThan(0);
    // requests before the first summary never carry it
    const firstSummarized = sent.findIndex((r) =>
      r.messages.some(
        (m) =>
          m.role === "user" &&
          (m.content as { type: string; text?: string }[]).some((b) =>
            b.text?.startsWith("<conversation_summary>"),
          ),
      ),
    );
    expect(firstSummarized).toBeGreaterThan(0);
    expect(sent.slice(0, firstSummarized).some((r) => withLine.includes(r))).toBe(false);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("phase D: an agent with only a manual-only skill gets Skill once it is invoked, copies its files, zero drift", async () => {
    reset();
    const deploy = await seedSkill("deploy", "Run scripts/deploy.sh.", undefined, {
      invocation: { model: false, user: true },
      files: { "scripts/deploy.sh": "echo deploy" },
    });
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { skills: [deploy] },
    );
    const conv = await createConv(owner, orgId, agentId);
    // before any invocation: no snapshot (the model's catalog is empty), so no Skill
    await postMessage(owner, orgId, conv, "hello");
    await waitForTerminal(db, conv, 1, 30_000);
    expect(sent[0]?.tools.map((t) => t.name)).not.toContain("Skill");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
      payload: { text: "", skill: { name: "deploy" } },
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 2, 30_000);
    const invoked = (await eventsOf(db, conv)).filter((e) => e.type === "user_message").at(-1);
    const first = invoked?.type === "user_message" ? invoked.payload.content[0] : undefined;
    expect(first?.type === "text" && first.text).toMatch(
      /call Skill with "deploy" to copy them to \/skills\/deploy@[0-9a-f]{12}\//,
    );
    expect(sent[1]?.tools.map((t) => t.name)).toContain("Skill");
    await postMessage(owner, orgId, conv, 'tool:Skill:{"skill":"deploy"}');
    await waitForTerminal(db, conv, 3, 30_000);
    const loaded = (await eventsOf(db, conv)).filter((e) => e.type === "tool_result").at(-1);
    expect(loaded?.type === "tool_result" && loaded.payload.isError).toBe(false);
    expect(loaded?.type === "tool_result" && loaded.payload.content).toContain("deploy.sh");
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("phase D: a fork invocation with its report, then a message: the report follows the invocation, zero drift", async () => {
    reset();
    const review = await seedSkill("review", "Review $ARGUMENTS.", undefined, {
      invocation: { model: false, user: true, fork: {} },
    });
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { skills: [review] },
    );
    const conv = await createConv(owner, orgId, agentId);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
      payload: { text: "src", skill: { name: "review" } },
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 1, 30_000);
    await postMessage(owner, orgId, conv, "echo:thanks");
    await waitForTerminal(db, conv, 2, 30_000);
    const events = await eventsOf(db, conv);
    const report = events.find((e) => e.type === "skill_fork_result");
    expect(report?.type === "skill_fork_result" && report.payload.text).toContain(
      'Report from the sub-agent that ran the skill "review":',
    );
    // the parent's requests (the child's go to the same provider)
    const parent = sent.filter(
      (r) => !r.system.some((b) => b.text.includes("You are a sub-agent")),
    );
    const first = parent[0]?.messages[0]?.content as { type: string; text?: string }[];
    expect(first.map((b) => b.text)).toEqual([
      // the sender line first (run context spec §4), then the invocation, then its report
      "From O (owner)",
      'The user ran the skill "review" in a sub-agent (general-purpose) with /review src. The sub-agent gets the skill\'s instructions as its task; its report follows. Do not do the task yourself.',
      report?.type === "skill_fork_result" ? report.payload.text : "",
    ]);
    const snap = await snapshotOf(conv);
    const calls = modelCalls(toEvents(snap));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(parent.length);
    for (const [i, c] of calls.entries()) {
      const info = await modelInfo(c.payload.provider, c.payload.model);
      const out = reconstructRequest(snap, c.seq, {
        model: info,
        mediaBudgetBytes: k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
      });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(parent[i]);
    }
  });

  it("phase D: an inline invocation with arguments and files, its Skill, a fork invocation with its report and a compaction over both: zero drift; a candidate that deselects the skills still replays the recorded text", async () => {
    reset();
    const fix = await seedSkill(
      "fix-bug",
      "Fix the bug $ARGUMENTS with scripts/fix.sh.",
      undefined,
      {
        files: { "scripts/fix.sh": "echo fix" },
      },
    );
    const audit = await seedSkill("audit", "Audit $ARGUMENTS.", undefined, {
      invocation: { model: false, user: true, fork: {} },
    });
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-small" },
      { skills: [fix, audit] },
    );
    const conv = await createConv(owner, orgId, agentId);
    let n = 0;
    const invoke = async (name: string, text: string) => {
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
        payload: { text, skill: { name } },
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    const turn = async (text: string) => {
      await postMessage(owner, orgId, conv, text);
      await waitForTerminal(db, conv, ++n, 30_000);
    };
    /** Arguments that look like placeholders (Review Focus 1), written without a template literal. */
    const args = `12 '$1' $${"{CLAUDE_SKILL_DIR}"}`;
    await invoke("fix-bug", args);
    await turn('tool:Skill:{"skill":"fix-bug"}');
    await invoke("audit", "src");
    for (let i = 0; i < 5; i++) await turn(`long:${400 + i}`);

    const events = await eventsOf(db, conv);
    const inline = events.find(
      (e) => e.type === "user_message" && e.payload.skill?.mode === "inline",
    );
    const first = inline?.type === "user_message" ? inline.payload.content[0] : undefined;
    // arguments that look like placeholders appear as typed
    expect(first?.type === "text" && first.text).toContain(
      `Fix the bug ${args} with scripts/fix.sh.`,
    );
    // the person's Skill (model-fake may also call the first tool on its own)
    expect(
      events.some(
        (e) =>
          e.type === "tool_result" &&
          e.payload.toolKey === "Skill" &&
          !e.payload.isError &&
          e.payload.content.includes("fix.sh"),
      ),
    ).toBe(true);
    const forkSeq = events.find(
      (e) => e.type === "user_message" && e.payload.skill?.mode === "fork",
    )?.seq as number;
    expect(events.some((e) => e.type === "skill_fork_result")).toBe(true);
    const summary = events.filter((e) => e.type === "compaction_summary").at(-1);
    expect(
      summary?.type === "compaction_summary" && summary.payload.coversUpToSeq,
    ).toBeGreaterThanOrEqual(forkSeq);
    const parent = sent.filter(
      (r) => !r.system.some((b) => b.text.includes("You are a sub-agent")),
    );
    // the line names the inline invocation only (a fork's instructions went to its sub-agent)
    const line =
      "Skills the user invoked earlier in this conversation: fix-bug. Call Skill with a name to read its instructions again.";
    expect(
      parent.some((r) => r.messages.some((m) => m.role === "system" && m.content === line)),
    ).toBe(true);

    const snap = await snapshotOf(conv);
    const calls = modelCalls(toEvents(snap));
    expect(calls).toHaveLength(parent.length);
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    for (const [i, c] of calls.entries()) {
      const info = await modelInfo(c.payload.provider, c.payload.model);
      const opts = {
        model: info,
        mediaBudgetBytes: k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
        // the run's reserve (the fixture's deployment setting): the candidate's fit recomputes
        // against the same target, so it matches the recorded request
        reserveTokens: 0,
      };
      const out = reconstructRequest(snap, c.seq, opts);
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(parent[i]);
      // a candidate version without the invoked skills: the person's messages are recorded input
      const cand = reconstructRequest(snap, c.seq, {
        ...opts,
        definition: {
          ...def,
          disabledSkills: [
            { kind: "skill", skillId: fix },
            { kind: "skill", skillId: audit },
          ],
        },
        agentVersion: 2,
      });
      expect(cand.drift, `candidate seq ${c.seq}`).toEqual([]);
      expect(cand.request, `candidate seq ${c.seq}`).toEqual(parent[i]);
    }
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
    const key = "plugin__hooks-probe__probe_echo";
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

  it("a command refused a domain on a device: the network ask and its kept result + note: zero drift, network_blocked and the ask's hosts not in requests", async () => {
    reset();
    const { deviceId, credential, machineId } = await k.app.get(TransactionHost).run(async () => {
      const { id } = await k.app.get(DevicesService).createLocal(orgId, ownerId, "Box");
      const issued = await k.app.get(MachinesService).issue({
        orgId,
        deviceId: id,
        accountId: ownerId,
        name: "box",
        os: "linux",
        arch: "x64",
        programVersion: "0.1.0",
      });
      return { deviceId: id, ...issued };
    });
    const machine = new FakeMachine(
      `ws://127.0.0.1:${k.port}/device/connect`,
      credential,
      (req) => {
        if (req.op === "create") return { ok: true, result: { roots: { ...HELLO.roots } } };
        if (req.op !== "exec") return { ok: true, result: null };
        return {
          ok: true,
          result: {
            exitCode: 56,
            stdout: "",
            stderr: "curl: (56) CONNECT tunnel failed, response 403\n",
            truncated: false,
            timedOut: false,
            network: { blocked: [{ host: "files.example.com", port: 443, layer: "device" }] },
          },
        };
      },
      { hello: false },
    );
    try {
      await machine.opened;
      machine.send({
        ...HELLO,
        features: ["networkReport", "policyOp", "policyOpId"],
        policy: {
          effectiveTier: "strict",
          isolation: "sandbox",
          localhost: "off",
          unixSockets: "off",
          allowedDomains: [],
          remoteGrants: "owner",
        },
      });
      await waitFor(
        async () =>
          (
            await db
              .selectFrom("device_machines")
              .select("roots")
              .where("id", "=", machineId)
              .executeTakeFirst()
          )?.roots != null,
        10_000,
        "hello recorded",
      );
      const agentId = await createAgent(
        { provider: "model-fake", model: "fake-1" },
        { tools: [{ kind: "builtin", name: "Bash" }] },
      );
      const conv = await createConv(owner, orgId, agentId);
      await db
        .updateTable("conversations")
        .set({ device_id: deviceId })
        .where("id", "=", conv)
        .execute();
      const bash = { command: "curl https://files.example.com/x", description: "Fetch" };
      await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(bash)}`);
      const asked = await waitForEvent(db, conv, (e) => e.type === "approval_requested");
      const approvalId = asked.type === "approval_requested" && asked.payload.approvalId;
      const decided = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
        payload: { decision: "approve", scope: "once" },
      });
      expect(decided.statusCode, decided.body).toBe(200);
      await waitForTerminal(db, conv, 1, 30_000);
      const events = await eventsOf(db, conv);
      expect(events.some((e) => e.type === "network_blocked")).toBe(true);
      const result = events.find((e) => e.type === "tool_result");
      expect(result?.type === "tool_result" && result.payload.content).toContain(
        allowedOnceNote(["files.example.com"]),
      );
      // the second request carries the call's tool_result with the note, nothing display-only
      const last = JSON.stringify(sent.at(-1));
      expect(last).toContain(allowedOnceNote(["files.example.com"]));
      expect(last).not.toContain("network_blocked");
      expect(last).not.toContain('"layer"');
      expect(last).not.toContain('"hosts"');
      const snap = await snapshotOf(conv);
      await expectZeroDrift(conv, snap);
      const [run] = buildTrajectory(toEvents(snap), new Map());
      expect(run?.steps[0]?.toolCalls[0]).toMatchObject({
        networkBlocked: [{ host: "files.example.com", port: 443, layer: "device" }],
        approval: { approvalId, decision: "approved", scope: "once" },
      });
    } finally {
      machine.close();
    }
  });

  it("a trimmed request records its fit and replays byte-for-byte; a smaller candidate window is context_fit", async () => {
    reset();
    // A window where the fit target W - O - R is reachable but proactive compaction does not fire:
    // enabled: false leaves only the hard line (estimate + output > window), so the hard fit guard
    // trims instead of compacting. fake-1: W 32000, O 4096, R 20000 -> target 7904.
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ enabled: false, reserveTokens: 20_000 }) })
      .where("key", "=", "compaction")
      .execute();
    try {
      const agentId = await createAgent({ provider: "model-fake", model: "fake-1" });
      const conv = await createConv(owner, orgId, agentId);
      // The fake model's reply to long:6000 is capped at 16384 characters (~4k tokens): the third
      // request carries two of them (~8k), over the 7904 target and below the hard line
      // (estimate + 4096 <= 32000), so the hard fit guard trims instead of compacting
      await postMessage(owner, orgId, conv, "long:6000");
      await waitForTerminal(db, conv, 1, 30_000);
      await postMessage(owner, orgId, conv, "long:6000");
      await waitForTerminal(db, conv, 2, 30_000);
      await postMessage(owner, orgId, conv, "echo:after");
      await waitForTerminal(db, conv, 3, 30_000);

      const events = await eventsOf(db, conv);
      const calls = modelCalls(events);
      expect(calls).toHaveLength(3);
      // the earlier requests fit: no plan (old logs without fit rebuild as before)
      expect(calls[0]?.payload.request.fit).toBeUndefined();
      expect(calls[1]?.payload.request.fit).toBeUndefined();
      const fit = calls[2]?.payload.request.fit;
      expect(fit).toBeDefined();
      // the oldest assistant text is dropped
      expect(fit?.droppedMessageIndexes.length).toBeGreaterThan(0);
      // the provider received the trimmed request, not the huge replies
      expect(JSON.stringify(sent[2])).not.toContain("word6000");
      expect(JSON.stringify(sent[2])).toContain("echo:after");

      const info = await modelInfo("model-fake", "fake-1");
      const snap = await snapshotOf(conv);
      // every call reconstructs with zero drift and equals what the provider got: the recorded plan
      // is applied to the rebuilt request
      await expectZeroDrift(conv, snap);
      const first = reconstructRequest(snap, calls[0]?.seq as number, { model: info });
      expect(first.drift).toEqual([]);
      expect(first.request).toEqual(sent[0]);

      // a candidate model with a smaller window recomputes the fit: a different plan -> context_fit
      const smaller: ModelInfo = { ...info, contextWindow: 24_000 };
      const cand = reconstructRequest(snap, calls[2]?.seq as number, {
        model: smaller,
        params: {},
        reserveTokens: 20_000,
      });
      expect(cand.drift).toEqual(["context_fit"]);
    } finally {
      await db
        .updateTable("deployment_settings")
        .set({ value: JSON.stringify({ keepRecentTurns: 1, reserveTokens: 0 }) })
        .where("key", "=", "compaction")
        .execute();
    }
  });

  it("a clamped output cap under the agent's maxOutputTokens knob replays byte-for-byte; a smaller window is context_fit", async () => {
    reset();
    // The reserve makes the fit target W - O - R reachable; the policy hook denies the compaction
    // calls, so a request over the hard line is clamped and trimmed instead of summarized (the
    // same request the reactive path sends after a failed compaction). fake-1: W 32000, O 4000.
    await db
      .updateTable("deployment_settings")
      .set({ value: JSON.stringify({ reserveTokens: 20_000 }) })
      .where("key", "=", "compaction")
      .execute();
    const enableProbe = async (enabled: boolean) => {
      const res = await owner({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
        payload: { enabled },
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    await enableProbe(true);
    try {
      const cfg = await owner({
        method: "POST",
        url: "/plugins/hooks-probe/config",
        payload: { orgId, denyModelPurposes: ["compaction"] },
      });
      expect(cfg.statusCode, cfg.body).toBe(200);
      const agentId = await createAgent(
        { provider: "model-fake", model: "fake-1" },
        { modelParams: { maxOutputTokens: 4000 } },
      );
      const conv = await createConv(owner, orgId, agentId);
      // three long replies (~4k tokens each) and a 90k-character turn put the fourth request over
      // W - O (28000); the fifth adds a 20k-character latest turn
      let n = 0;
      const turn = async (text: string) => {
        await postMessage(owner, orgId, conv, text);
        await waitForTerminal(db, conv, ++n, 30_000);
      };
      await turn("long:6000");
      await turn("long:6000");
      await turn("long:6000");
      await turn("x".repeat(90_000));
      await turn("y".repeat(20_000));

      const events = await eventsOf(db, conv);
      const calls = modelCalls(events);
      expect(calls).toHaveLength(5);
      // an over-window request is refused, not summarized, and the step trims instead
      expect(events.filter((e) => e.type === "compaction_failed").length).toBeGreaterThan(0);
      // the knob is recorded as a parameter and the clamp lowered the cap below it
      const last = calls[4];
      expect(last?.payload.request.params).toEqual({ maxOutputTokens: 4000 });
      expect(last?.payload.request.maxOutputTokens).toBe(1);
      // the latest turn fits once the older messages are gone: a trim, no truncation note
      const fit = last?.payload.request.fit;
      expect(fit?.droppedMessageIndexes.length).toBeGreaterThan(0);
      expect(fit?.truncated).toEqual([]);

      const info = await modelInfo("model-fake", "fake-1");
      const snap = await snapshotOf(conv);
      // every call reconstructs with zero drift and equals what the provider got: the baseline
      // replays the recorded cap, not the cap recomputed from the knob
      await expectZeroDrift(conv, snap);

      // a candidate model with a smaller window leaves less room, so it trims the latest turn too
      const smaller: ModelInfo = { ...info, contextWindow: 24_000 };
      const cand = reconstructRequest(snap, last?.seq as number, {
        model: smaller,
        params: { maxOutputTokens: 4000 },
        reserveTokens: 20_000,
      });
      expect(cand.drift).toEqual(["context_fit"]);
    } finally {
      await owner({
        method: "POST",
        url: "/plugins/hooks-probe/config",
        payload: { orgId },
      });
      await enableProbe(false);
      await db
        .updateTable("deployment_settings")
        .set({ value: JSON.stringify({ keepRecentTurns: 1, reserveTokens: 0 }) })
        .where("key", "=", "compaction")
        .execute();
    }
  });
});

describe("reconstructRequest: UI refresh B model switches", { timeout: 120_000 }, () => {
  it("two mid-conversation switches (model, then back with an effort): zero drift, equal to what the provider received", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { modelParams: { "model-fake.style": "shout" } },
    );
    const conv = await createConv(owner, orgId, agentId);
    const say = async (n: number, payload: Record<string, unknown>) => {
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
        payload,
      });
      expect(res.statusCode, res.body).toBe(202);
      await waitForTerminal(db, conv, n, 30_000);
    };
    await say(1, { text: "echo:first" });
    await say(2, { text: "echo:second", model: { provider: "model-fake", model: "fake-v" } });
    await say(3, {
      text: "echo:third",
      model: { provider: "model-fake", model: "fake-1" },
      effort: "high",
    });
    const events = await eventsOf(db, conv);
    expect(events.filter((e) => e.type === "model_switched")).toHaveLength(2);
    const calls = modelCalls(events);
    expect(calls.map((c) => [c.payload.model, c.payload.request.params])).toEqual([
      ["fake-1", { "model-fake.style": "shout" }],
      ["fake-v", {}],
      ["fake-1", { "model-fake.style": "shout", effort: "high" }],
    ]);
    // the switch events never reach a request
    expect(JSON.stringify(sent)).not.toContain("model_switched");
    await expectZeroDrift(conv, await snapshotOf(conv));
  });
});

describe("reconstructRequest: UI refresh B tool views", { timeout: 120_000 }, () => {
  it("Bash with description, a failing exit and an edit diff: zero drift, views not in requests", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      {
        tools: ["Bash", "Write"].map((name) => ({ kind: "builtin", name })),
      },
    );
    const conv = await createConv(owner, orgId, agentId);
    const bash = { command: "echo hi && exit 3", description: "Greet and fail" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(bash)}`);
    await waitForTerminal(db, conv, 1, 30_000);
    const write = { file_path: "/workspace/n.txt", content: "a\nb\n" };
    await postMessage(owner, orgId, conv, `tool:Write:${JSON.stringify(write)}`);
    await waitForTerminal(db, conv, 2, 30_000);
    const views = (await eventsOf(db, conv)).flatMap((e) =>
      e.type === "tool_result" && e.payload.view !== undefined ? [e.payload.view] : [],
    );
    expect(views.map((v) => v.kind)).toEqual(["command", "edit"]);
    // the description reaches the model in the call's input; the views never do
    expect(JSON.stringify(sent)).toContain("Greet and fail");
    expect(JSON.stringify(sent)).not.toContain('"exitCode"');
    expect(JSON.stringify(sent)).not.toContain('"hunks"');
    const snap = await snapshotOf(conv);
    await expectZeroDrift(conv, snap);
  });

  it("a pre-B log: Bash recorded without description reconstructs with zero drift", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: [{ kind: "builtin", name: "Bash" }] },
    );
    const conv = await createConv(owner, orgId, agentId);
    const bash = { command: "echo old", description: "Old call" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(bash)}`);
    await waitForTerminal(db, conv, 1, 30_000);
    const live = await snapshotOf(conv);

    // Rewrite it as a log from before B: the old Bash definition (no description
    // argument) under its own fingerprint, and a call whose input has no description.
    const s = structuredClone(live);
    const hashes = new Map<string, string>();
    for (const [hash, spec] of Object.entries(s.toolSpecs)) {
      if (spec.name !== "Bash") continue;
      const schema = structuredClone(spec.inputSchema) as {
        properties: Record<string, unknown>;
        required: string[];
      };
      delete schema.properties.description;
      schema.required = schema.required.filter((r) => r !== "description");
      const { keyArgs: _k, ...rest } = spec;
      const old = { ...rest, inputSchema: schema };
      const oldHash = specHash(old);
      s.toolSpecs[oldHash] = old;
      delete s.toolSpecs[hash];
      hashes.set(hash, oldHash);
    }
    expect(hashes.size).toBe(1);
    const strip = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) strip(x);
        return;
      }
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (typeof o.specHash === "string" && hashes.has(o.specHash))
        o.specHash = hashes.get(o.specHash);
      if (o.name === "Bash" && o.input !== null && typeof o.input === "object")
        delete (o.input as Record<string, unknown>).description;
      // pre-B tool results carry no view
      if (o.toolKey === "Bash") delete o.view;
      for (const x of Object.values(o)) strip(x);
    };
    strip(s.events);
    // only the fake model's trigger text (the user message) still names it
    expect(JSON.stringify(s.events.filter((e) => e.type !== "user_message"))).not.toContain(
      "Old call",
    );
    const callInputs = (v: unknown): unknown[] =>
      Array.isArray(v)
        ? v.flatMap(callInputs)
        : v !== null && typeof v === "object"
          ? [
              ...((v as { name?: unknown }).name === "Bash" && "input" in v
                ? [(v as { input: unknown }).input]
                : []),
              ...Object.values(v).flatMap(callInputs),
            ]
          : [];

    const info = await modelInfo("model-fake", "fake-1");
    const calls = modelCalls(toEvents(s));
    expect(calls.length).toBeGreaterThan(1);
    let seen = 0;
    for (const c of calls) {
      const out = reconstructRequest(s, c.seq, { model: info });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      const tool = out.request.tools.find((t) => t.name === "Bash");
      expect(JSON.stringify(tool?.inputSchema)).not.toContain('"description":{');
      for (const input of callInputs(out.request.messages)) {
        expect(input).toEqual({ command: "echo old" });
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("reconstructRequest: sandbox level (sandbox dev tiers spec §11.5)", {
  timeout: 120_000,
}, () => {
  it("a device whose tier changes between runs: two device_paths lines, each in the requests, zero drift", async () => {
    reset();
    const agentId = await createAgent(
      { provider: "model-fake", model: "fake-1" },
      { tools: [{ kind: "builtin", name: "Bash" }] },
    );
    const conv = await createConv(owner, orgId, agentId);
    const bash = { command: "echo one", description: "One" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(bash)}`);
    await waitForTerminal(db, conv, 1, 30_000);
    const { device_id: deviceId } = await db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    const patched = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/devices/${deviceId}`,
      payload: { tier: "strict" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const again = { command: "echo two", description: "Two" };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(again)}`);
    await waitForTerminal(db, conv, 2, 30_000);
    const levels = (await eventsOf(db, conv)).flatMap((e) =>
      e.type === "device_paths" ? [e.payload.tier] : [],
    );
    expect(levels).toEqual(["dev", "strict"]);
    const last = JSON.stringify(sent.at(-1));
    expect(last).toContain("Sandbox level: development.");
    expect(last).toContain("Sandbox level: strict.");
    const snap = await snapshotOf(conv);
    await expectZeroDrift(conv, snap);
  });
});

describe("reconstructRequest: scheduled tasks", { timeout: 120_000 }, () => {
  const store = new ScheduledTaskStore();
  const task = (
    agentId: string,
    over: Partial<Parameters<ScheduledTaskStore["insertTask"]>[1]>,
  ): Parameters<ScheduledTaskStore["insertTask"]>[1] => ({
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Digest",
    prompt: "echo:the daily digest",
    trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: new Date(Date.now() + 86_400_000),
    jitterSeconds: 0,
    expiresAt: null,
    ...over,
  });
  /** Fires one run of `taskId` as the scan does; returns the task run id. */
  const fireOnce = async (taskId: string): Promise<string> => {
    const run = await store.insertRun(db, {
      id: randomUUID(),
      taskId,
      orgId,
      scheduledFor: new Date(),
      trial: false,
    });
    if (!run) throw new Error("tick taken");
    await k.app.get(ScheduledTaskFirer).fire(run.id);
    return run.id;
  };

  it("a conversation task runs with the conversation's selection, with zero drift", async () => {
    reset();
    const agentId = await createAgent({ provider: "model-fake", model: "fake-1" });
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "echo:before the task");
    await waitForTerminal(db, conv, 1, 30_000);

    // a task posting into this conversation; model and effort are a new-conversation task's only
    // (the service refuses them here): even a row carrying them fires without a switch
    const t = await store.insertTask(
      db,
      task(agentId, {
        mode: "conversation",
        conversationId: conv,
        model: { provider: "model-fake", model: "fake-v" },
        effort: "high",
      }),
    );
    const runId = await fireOnce(t.id);
    await waitForTerminal(db, conv, 2, 30_000);
    // a person's message after the scheduled run
    await postMessage(owner, orgId, conv, "echo:after the task");
    await waitForTerminal(db, conv, 3, 30_000);

    const events = await eventsOf(db, conv);
    const scheduled = events.find(
      (e) => e.type === "user_message" && e.payload.schedule !== undefined,
    );
    expect(scheduled?.type === "user_message" && scheduled.payload.schedule).toMatchObject({
      taskId: t.id,
      taskRunId: runId,
      trial: false,
    });
    // the conversation's selection throughout: the task switches nothing for the person
    const calls = modelCalls(events);
    expect(calls.map((c) => c.payload.model)).toEqual(["fake-1", "fake-1", "fake-1"]);
    expect(events.some((e) => e.type === "model_switched")).toBe(false);
    // the marker is not model-visible
    expect(JSON.stringify(sent)).not.toContain(runId);
    expect(JSON.stringify(sent)).not.toContain(t.id);
    const runs = await runsOf(db, conv);
    await expectZeroDrift(conv, await snapshotOf(conv, runs[1]?.id), 2);
    await expectZeroDrift(conv, await snapshotOf(conv));
  });

  it("a new-conversation task runs with its own model and effort, with zero drift", async () => {
    reset();
    const agentId = await createAgent({ provider: "model-fake", model: "fake-1" });
    const t = await store.insertTask(
      db,
      task(agentId, { model: { provider: "model-fake", model: "fake-v" }, effort: "high" }),
    );
    const runId = await fireOnce(t.id);
    const row = await db
      .selectFrom("conversations")
      .select("id")
      .where("scheduled_task_id", "=", t.id)
      .where("create_request_id", "=", runId)
      .executeTakeFirstOrThrow();
    await waitForTerminal(db, row.id, 1, 30_000);
    const calls = modelCalls(await eventsOf(db, row.id));
    expect(calls.map((c) => c.payload.model)).toEqual(["fake-v"]);
    expect(calls[0]?.payload.request.params).toMatchObject({ effort: "high" });
    await expectZeroDrift(row.id, await snapshotOf(row.id));
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
    await postMessage(owner, orgId, conv, 'tool:ToolSearch:{"query":"second"}');
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
    // 内置的 ToolSearch 不在目录里：去掉它只影响工具列表，不影响 system
    const victim = tools.find((t) => t.key === "ToolSearch") as { key: string; specHash: string };
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

  it("pinned_changed: a non-baseline call whose snapshot in effect pinned skills, whatever the candidate", () => {
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    // a recorded snapshot with one pinned skill, ahead of every other event
    const withPinned = (pinned: boolean) => {
      const s = clone();
      const first = s.events[0] as (typeof s.events)[number];
      const skill = { id: "p1", name: "p", description: "P.", version: 1, source: "src/p1" };
      s.events.unshift({
        ...first,
        seq: first.seq - 1,
        type: "skills_catalog",
        payload: { skills: [skill], ...(pinned && { pinned: [{ ...skill, body: "Pinned." }] }) },
      });
      return s;
    };
    // the baseline never reports it
    expect(reconstructRequest(withPinned(true), seq, { model: info }).drift).not.toContain(
      "pinned_changed",
    );
    // no candidate pins any more: params-only, instructions-only, another version alike
    const paramsOnly = reconstructRequest(withPinned(true), seq, {
      model: info,
      params: { effort: "high" },
    });
    expect(paramsOnly.drift).toContain("pinned_changed");
    const instructions = reconstructRequest(withPinned(true), seq, {
      model: info,
      definition: { ...def, instructions: "Be terse." },
    });
    expect(instructions.drift).toContain("pinned_changed");
    // the request still renders the recorded pinned body (a step replay never reads storage)
    expect(instructions.request.system[0]?.text).toContain("Pinned.");
    // a snapshot without pins: nothing, even when the candidate's raw definition carries old pins
    const unpinned = reconstructRequest(withPinned(false), seq, {
      model: info,
      definition: { ...def, skills: oldPins(["p1"]) },
    });
    expect(unpinned.drift).not.toContain("pinned_changed");
  });

  it("pinned_changed follows the snapshot in effect at the call: a later unpinned snapshot ends it", () => {
    const def = snap.definitions["1"];
    if (!def) throw new Error("definition missing");
    const s = clone();
    const first = s.events[0] as (typeof s.events)[number];
    const skill = { id: "p1", name: "p", description: "P.", version: 1, source: "src/p1" };
    // pinned at first, then a snapshot without pins (the "Pinned skills removed" notice) before
    // the call
    s.events.unshift(
      {
        ...first,
        seq: first.seq - 1,
        type: "skills_catalog",
        payload: { skills: [skill], pinned: [{ ...skill, body: "Pinned." }] },
      },
      { ...first, seq: first.seq - 0.5, type: "skills_catalog", payload: { skills: [skill] } },
    );
    const out = reconstructRequest(s, seq, { model: info, params: { effort: "high" } });
    expect(out.drift).not.toContain("pinned_changed");
  });

  it("definition_missing: no pinned_changed, even under a pinned snapshot", () => {
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
    const missing = reconstructRequest(s, seq, { model: info, params: { effort: "high" } });
    expect(missing.drift).toContain("definition_missing");
    expect(missing.drift).not.toContain("pinned_changed");
  });

  it("a candidate model replacing the run's model switch -> model_switched (never for a baseline)", () => {
    const s = clone();
    const started = s.events.find((e) => e.type === "run_started" && e.runId === s.runId);
    if (!started) throw new Error("no run_started");
    const switched = { provider: "model-fake", model: "fake-v" };
    s.events.splice(s.events.indexOf(started), 0, {
      ...started,
      seq: started.seq - 0.5,
      type: "model_switched",
      runId: null,
      payload: { model: switched, effort: null, byAccountId: ownerId, reason: "user" },
    });
    const def = s.definitions[String(s.agentVersion)];
    if (!def) throw new Error("no definition");
    // baseline: no candidate, no drift
    expect(reconstructRequest(s, seq, { model: info }).drift).toEqual([]);
    const other = reconstructRequest(s, seq, {
      model: info,
      definition: { ...def, instructions: "Changed." },
      modelRef: { provider: "model-fake", model: "fake-1" },
    });
    expect(other.drift).toContain("model_switched");
    const kept = reconstructRequest(s, seq, {
      model: info,
      definition: { ...def, instructions: "Changed." },
      modelRef: switched,
    });
    expect(kept.drift).not.toContain("model_switched");
    // a run with no switch never reports it
    const plain = reconstructRequest(snap, seq, {
      model: info,
      definition: { ...def, instructions: "Changed." },
      modelRef: { provider: "model-fake", model: "fake-1" },
    });
    expect(plain.drift).not.toContain("model_switched");
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

describe("reconstructRequest: a recording from before the tool rename", () => {
  type Fixture = { model: ModelInfo; snapshot: CaseSnapshot; requests: ModelRequest[] };
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/pre-tool-rename/conversation.json", import.meta.url)),
      "utf8",
    ),
  ) as Fixture;

  it("covers every old builtin, a connector key, an extension key, a pinned skill, a notice, an invoked skill and a compaction", () => {
    const events = fixture.snapshot.events;
    const keys = new Set(
      events.flatMap((e) =>
        e.type === "tool_result" ? [(e.payload as { toolKey: string }).toolKey] : [],
      ),
    );
    for (const k of [
      "sandbox_bash",
      "sandbox_read",
      "sandbox_write",
      "sandbox_edit",
      "sandbox_glob",
      "sandbox_grep",
      "skill_load",
      "tool_search",
      "read_tool_output",
      "docs__search",
      "tools-probe__echo",
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
    const types = new Set(events.map((e) => e.type));
    for (const t of ["compaction_summary", "skills_catalog", "approval_decided"]) {
      expect(types.has(t as ConversationEvent["type"]), t).toBe(true);
    }
    const catalogs = events.filter((e) => e.type === "skills_catalog");
    expect(catalogs).toHaveLength(2);
    const first = catalogs[0]?.payload as { pinned?: unknown[]; toolMap?: string };
    expect(first.pinned).toHaveLength(1);
    expect(first.toolMap).toBeDefined();
    expect(
      events.some((e) => e.type === "user_message" && (e.payload as { skill?: unknown }).skill),
    ).toBe(true);
  });

  it("every model_call reconstructs with zero drift and equals what the provider received, with the legacy skill texts", () => {
    const calls = modelCalls(toEvents(fixture.snapshot));
    expect(calls).toHaveLength(fixture.requests.length);
    const texts = new Set<string>();
    for (const [i, c] of calls.entries()) {
      const out = reconstructRequest(fixture.snapshot, c.seq, { model: fixture.model });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(fixture.requests[i]);
      for (const m of out.request.messages) {
        if (m.role === "system" && typeof m.content === "string") texts.add(m.content);
      }
    }
    const all = [...texts].join("\n");
    // the legacy texts name the old tools and appear in the real recording
    expect(all).toContain("Skills the user invoked earlier in this conversation: fix-bug.");
    expect(all).toContain("Updated skills (");
    expect(all).toMatch(/skill_load/);
    expect(all).not.toMatch(/\bcall Skill\b/);
  });
});

describe("reconstructRequest: a recording from before background sub-agents", () => {
  type Recorded = { snapshot: CaseSnapshot; requests: ModelRequest[] };
  type Fixture = { model: ModelInfo; parent: Recorded; child: Recorded };
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("./fixtures/pre-background-subagents/conversation.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as Fixture;

  it("holds a foreground Agent call with resume and a parent the subagents wait resumed", () => {
    const parent = fixture.parent.snapshot.events;
    const calls = parent.flatMap((e) =>
      e.type === "assistant_message"
        ? (e.payload as { content: { type: string; name?: string; input?: unknown }[] }).content
        : [],
    );
    const agentCalls = calls.filter((b) => b.type === "tool_call" && b.name === "Agent");
    expect(agentCalls).toHaveLength(4);
    expect(agentCalls.some((b) => (b.input as { resume?: string }).resume !== undefined)).toBe(
      true,
    );
    // the replies came back as the Agent results (the wait), not as deliveries
    expect(parent.filter((e) => e.type === "subagent_finished")).toHaveLength(4);
    expect(parent.some((e) => e.type === "subagent_delivery")).toBe(false);
    expect(fixture.child.snapshot.events.filter((e) => e.type === "run_started")).toHaveLength(2);
  });

  it("subagentChanged: Agent follows the logged child and the candidate's subagents block is ignored", () => {
    const started = fixture.child.snapshot.events.find((e) => e.type === "subagent_started")
      ?.payload as EventPayload<"subagent_started">;
    const logged = normalizeStoredDefinition(started.definition);
    const noAgent = { ...logged, disabledTools: [{ kind: "builtin" as const, name: "Agent" }] };
    // the general child stays listed: only the roster around it changes
    const roster = { ...logged, subagents: { ...logged.subagents, templates: ["x"] } };
    // a roster-only change is no change, in the same version or another one
    expect(subagentChanged(started, logged, roster, true)).toBe(false);
    expect(subagentChanged(started, logged, roster, false, logged)).toBe(false);
    // an org agent child logged without Agent (depth limit, or before nesting): a candidate that
    // offers it is the same child
    const asAgent = { ...started, template: { source: "agent" as const, id: "a", version: 1 } };
    expect(subagentChanged(asAgent, noAgent, logged, false)).toBe(false);
    // a child logged with Agent keeps it in the comparison: a candidate without it differs
    expect(subagentChanged(asAgent, logged, noAgent, false)).toBe(true);
  });

  it("foreground-era log replays with zero drift", () => {
    for (const side of [fixture.parent, fixture.child]) {
      const calls = modelCalls(toEvents(side.snapshot));
      expect(calls).toHaveLength(side.requests.length);
      for (const [i, c] of calls.entries()) {
        const out = reconstructRequest(side.snapshot, c.seq, { model: fixture.model });
        expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
        expect(out.request, `model_call seq ${c.seq}`).toEqual(side.requests[i]);
      }
    }
  });
});
