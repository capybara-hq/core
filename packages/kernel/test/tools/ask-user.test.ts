import { fileURLToPath } from "node:url";
import {
  type InputRequired,
  type ToolCallContext,
  type ToolResult,
  validateInputForm,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { TOOLS_UNAVAILABLE_PREFIX } from "../../src/runtime/model-call.js";
import { askUserTool } from "../../src/tools/builtins/ask-user.js";
import { validateInput } from "../../src/tools/validate.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 10：内置工具 `ask_user`（用通用的输入请求机制实现）与输入请求 HTTP 接口。
 * 双副本：A（api + worker）执行运行并暂停，回答经 B（只有 api）提交，续跑回到 A 的 worker。
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => base;
const tool = () => askUserTool({ config });

const ctx = (resume?: ToolCallContext["resume"]): ToolCallContext => ({
  orgId: "o",
  accountId: "a",
  agentId: "g",
  conversationId: "c",
  callId: "call",
  signal: new AbortController().signal,
  ...(resume !== undefined && { resume }),
});

const opt = (label: string, description = `${label} option`) => ({ label, description });
const question = (over: Record<string, unknown> = {}) => ({
  question: "Which database should I use?",
  header: "Database",
  multiSelect: false,
  options: [opt("Postgres", "Relational"), opt("Mongo", "Document store")],
  ...over,
});

describe("ask_user（单元）", () => {
  it("声明：名字、默认 allow、不要求审批", () => {
    const t = tool();
    expect(t.spec.name).toBe("ask_user");
    expect(t.defaultPolicy).toBe("allow");
    expect(t.spec.annotations?.requiresUserInteraction).not.toBe(true);
  });

  it("参数校验：问题 1–4 个、选项 2–4 个、header ≤ 12 字符", () => {
    const v = (input: unknown) => validateInput("ask_user", tool().spec, input);
    expect(v({ questions: [question()] })).toBeNull();
    expect(v({ questions: [question(), question(), question(), question()] })).toBeNull();
    expect(v({ questions: [] })).not.toBeNull();
    expect(v({ questions: Array.from({ length: 5 }, () => question()) })).not.toBeNull();
    expect(v({ questions: [question({ options: [opt("A")] })] })).toMatch(/options/);
    expect(
      v({ questions: [question({ options: ["A", "B", "C", "D", "E"].map((l) => opt(l)) })] }),
    ).toMatch(/options/);
    expect(v({ questions: [question({ header: "Thirteen char" })] })).toMatch(/header/);
    expect(v({ questions: [question({ multiSelect: undefined })] })).not.toBeNull();
    expect(v({ questions: [question({ options: [{ label: "A" }, opt("B")] })] })).not.toBeNull();
  });

  it("首次调用返回 input_required：每个问题一个枚举字段，multiSelect 照传，allowOther，选项说明写进字段说明", async () => {
    const r = (await tool().run(
      {
        questions: [
          question(),
          question({
            question: "Which features?",
            header: "Features",
            multiSelect: true,
            options: [opt("Auth"), opt("Search")],
          }),
        ],
      },
      ctx(),
    )) as InputRequired;
    expect(r.kind).toBe("input_required");
    expect(validateInputForm(r.form)).toEqual([]);
    expect(r.form.fields).toEqual([
      {
        key: "q0",
        label: "Which database should I use?",
        description: "Database\n- Postgres: Relational\n- Mongo: Document store",
        schema: { type: "string", enum: ["Postgres", "Mongo"] },
        multiSelect: false,
        allowOther: true,
        required: true,
      },
      {
        key: "q1",
        label: "Which features?",
        description: "Features\n- Auth: Auth option\n- Search: Search option",
        schema: { type: "string", enum: ["Auth", "Search"] },
        multiSelect: true,
        allowOther: true,
        required: true,
      },
    ]);
    expect(r.state).toEqual({ hours: 24 });
  });

  it("同一问题里选项标签重复 → 工具错误", async () => {
    await expect(
      tool().run({ questions: [question({ options: [opt("A"), opt("A")] })] }, ctx()),
    ).rejects.toThrow(/unique/);
  });

  it("续跑：由 ctx.resume.answer 生成结果文本；多选用逗号连接；Other 文本原样", async () => {
    const input = {
      questions: [
        question(),
        question({ question: "Which features?", header: "Features", multiSelect: true }),
      ],
    };
    const r = (await tool().run(
      input,
      ctx({ state: { hours: 24 }, answer: { q0: "SQLite, please", q1: ["Postgres", "Mongo"] } }),
    )) as ToolResult;
    expect(r).toEqual({
      content: [
        {
          type: "text",
          text: 'User answered: "Which database should I use?" = "SQLite, please"; "Which features?" = "Postgres, Mongo"',
        },
      ],
    });
  });

  it("续跑时 answer 为 null：超时说明（按提问时的小时数）；没有小时数 → 用户关闭了提问", async () => {
    const input = { questions: [question()] };
    const timedOut = (await tool().run(
      input,
      ctx({ state: { hours: 6 }, answer: null }),
    )) as ToolResult;
    expect(timedOut.content).toEqual([
      { type: "text", text: "The user did not answer within 6h." },
    ]);
    expect(timedOut.isError ?? false).toBe(false);
    const dismissed = (await tool().run(input, ctx({ state: null, answer: null }))) as ToolResult;
    expect(dismissed.content).toEqual([{ type: "text", text: "The user dismissed the question." }]);
  });
});

// ---- 端到端（双副本） ----

let pgc: TestContainer;
let rd: TestContainer;
let ka: Kernel;
let kb: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let reqA: Req;
let reqB: Req;
let orgId: string;
let ownerId: string;

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const urls = { pg: pgc.url, redis: rd.url };
  const plugins = [MODEL_FAKE, MEM_CONNECTOR];
  ka = await startKernel(runConfig(urls, { plugins, roles: ["api", "worker"] }));
  kb = await startKernel(runConfig(urls, { plugins, roles: ["api"] }));
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await kb?.stop();
  await ka?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const owner = await new AccountsService(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  ownerId = owner.id;
  memState().askCalls = [];
  reqA = await session(ka, "owner");
  reqB = await session(kb, "owner");
  orgId = await createOrg(reqA);
});

/** 不带 tools 字段新建 agent：得到默认的内置工具（ask_user、read_tool_output）。 */
async function createDefaultAgent(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await reqA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        ...extra,
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function askedQuestion(convId: string, text: string) {
  await postMessage(reqA, orgId, convId, text);
  const ev = (await waitForEvent(
    db,
    convId,
    (e) => e.type === "question_asked",
    10_000,
    "question_asked",
  )) as Extract<ConversationEvent, { type: "question_asked" }>;
  const runId = ev.runId as string;
  await waitFor(
    async () =>
      (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirst())
        ?.status === "waiting",
    10_000,
    "run waiting",
  );
  return { runId, questionId: ev.payload.questionId, event: ev };
}

const answer = (r: Req, id: string, body: Record<string, unknown>) =>
  r({ method: "POST", url: `/api/v1/orgs/${orgId}/questions/${id}/answer`, payload: body });

const ASK = `tool:ask_user:${JSON.stringify({
  questions: [question()],
})}`;

describe("ask_user 端到端", () => {
  it("默认工具的 agent：带 ask_user / read_tool_output 且没有不可用提醒；提问暂停，另一副本回答后续跑", async () => {
    const agentId = await createDefaultAgent();
    const convId = await createConv(reqA, orgId, agentId);
    const { runId, questionId, event } = await askedQuestion(convId, ASK);
    expect(event.payload.form.fields.map((f) => f.key)).toEqual(["q0"]);

    // 网页读取输入请求（发起人）
    const got = await reqB({ method: "GET", url: `/api/v1/orgs/${orgId}/questions/${questionId}` });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toMatchObject({
      question: {
        id: questionId,
        runId,
        conversationId: convId,
        status: "pending",
        toolKey: "ask_user",
      },
    });
    expect((got.json() as { question: Record<string, unknown> }).question).not.toHaveProperty(
      "state",
    );

    // 不合规的答案 → validation_failed
    const bad = await answer(reqB, questionId, { answer: { q0: ["Postgres"] } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");
    const missing = await answer(reqB, questionId, {});
    expect(missing.statusCode).toBe(400);

    // 回答落在 B（只有 api 角色），续跑由 A 的 worker 执行
    const ok = await answer(reqB, questionId, { answer: { q0: "Postgres" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ question: { id: questionId, status: "answered" } });
    const dup = await answer(reqB, questionId, { answer: { q0: "Mongo" } });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe("question.already_answered");

    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "tool_result").map((e) => e.payload)).toMatchObject([
      {
        toolKey: "ask_user",
        content: 'User answered: "Which database should I use?" = "Postgres"',
        isError: false,
      },
    ]);
    expect(ofType(evs, "question_answered").map((e) => e.payload)).toEqual([
      {
        questionId,
        callId: expect.any(String),
        answer: { q0: "Postgres" },
        byAccountId: ownerId,
        outcome: "answered",
      },
    ]);
    const calls = ofType(evs, "model_call");
    expect(calls[0]?.payload.request.tools?.map((t) => t.key).sort()).toEqual([
      "ask_user",
      "read_tool_output",
    ]);
    expect(
      ofType(evs, "reminder").filter((e) => e.payload.text.startsWith(TOOLS_UNAVAILABLE_PREFIX)),
    ).toEqual([]);
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([runId]);
  });

  it("非发起人回答 → 403，读取 → 403；别的组织的路径 → 404", async () => {
    const agentId = await createDefaultAgent();
    const convId = await createConv(reqA, orgId, agentId);
    const { questionId } = await askedQuestion(convId, ASK);
    const other = await new AccountsService(db).createLocal({
      login: "other",
      password: PW,
      displayName: "X",
    });
    await testMembers(db).add(orgId, other.id, "member", ownerId);
    const reqOther = await session(kb, "other");
    const res = await answer(reqOther, questionId, { answer: { q0: "Postgres" } });
    expect(res.statusCode, res.body).toBe(403);
    expect(errCode(res)).toBe("forbidden");
    const got = await reqOther({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/questions/${questionId}`,
    });
    expect(got.statusCode).toBe(403);
    // 另一个组织（other 是 owner）的路径下看不到
    const org2 = await createOrg(reqOther, "Other Org");
    const cross = await reqOther({
      method: "POST",
      url: `/api/v1/orgs/${org2}/questions/${questionId}/answer`,
      payload: { answer: { q0: "Postgres" } },
    });
    expect(cross.statusCode).toBe(404);
    expect(errCode(cross)).toBe("question.not_found");
    // 仍是 pending：发起人可以回答
    const ok = await answer(reqA, questionId, { answer: { q0: "Mongo" } });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1);
  });

  it("插件工具 input_required → 用户经另一副本提交 → 插件拿到 ctx.resume 继续", async () => {
    const en = await reqA({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/mem-connector`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
    const agentId = await createDefaultAgent({
      tools: [{ kind: "plugin", plugin: "mem-connector", name: "ask" }],
    });
    const convId = await createConv(reqA, orgId, agentId);
    const { questionId } = await askedQuestion(convId, 'tool:mem-connector__ask:{"rounds":1}');
    const ok = await answer(reqB, questionId, { answer: { color: "blue" } });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1);
    expect(memState().askCalls).toEqual([
      { input: { rounds: 1 }, resume: null },
      { input: { rounds: 1 }, resume: { state: { n: 1 }, answer: { color: "blue" } } },
    ]);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "tool_result").map((e) => e.payload.content)).toEqual([
      "color=blue after 1",
    ]);
  });
});
