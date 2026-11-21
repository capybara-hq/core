import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import {
  CommandReviewService,
  REVIEW_MAX_OUTPUT_TOKENS,
  REVIEW_SYSTEM_PROMPT,
} from "../../src/sandbox/review/index.js";
import {
  TOOL_REVIEW_ASK_REASON,
  TOOL_REVIEW_SYSTEM_PROMPT,
  TOOL_REVIEW_TRUNCATED_ASK_REASON,
  TOOL_REVIEW_TRUNCATED_MARKER,
  TOOL_REVIEW_UNAVAILABLE_PREFIX,
  ToolAskReview,
  type ToolReviewInput,
  type ToolReviewVerdict,
  toolReviewSystemPrompt,
} from "../../src/tools/tool-review.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Profiles govern every approval, ruling R3: the tool review judges one tool ask on the `review`
 * purpose with the command review's fail-closed rules. `model-script` answers the review call,
 * `hooks-probe` denies it on request, on a real kernel.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const HOOKS_PROBE = fixture("hooks-probe");

const SCRIPT_1 = { provider: "model-script", model: "script-1" };
const SCRIPT_2 = { provider: "model-script", model: "script-2" };
const REVIEW_USAGE = { inputTokens: 111, outputTokens: 7 };
const PERSON_MESSAGE = "please connect our Slack workspace to the ops agent";
/** The model-script fallback reply to a person message (the agent's own text). */
const AGENT_REPLY = "You said:";
const SECRET_VALUE = "xoxb-SECRET-never-sent";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string" },
    params: {
      type: "object",
      properties: {
        name: { type: "string" },
        botToken: { type: "string", "x-secret": true },
        signingSecret: { type: "string", writeOnly: true },
      },
    },
  },
};

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let raw: ReturnType<typeof createDb>;
let k: TestKernel;
let review: ToolAskReview;
let purposes: ModelPurposesService;
let realChat: ModelPurposesService["chat"];
let chatSpy: MockInstance<ModelPurposesService["chat"]>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_SCRIPT, HOOKS_PROBE],
        // short enough for the timeout case, long enough for the other calls
        sandbox: { review: { timeoutMs: 2_000, messageTokens: 200 } },
      },
    ),
  );
  review = k.app.get(ToolAskReview);
  purposes = k.app.get(ModelPurposesService);
  realChat = purposes.chat.bind(purposes);
  chatSpy = vi.spyOn(purposes, "chat");
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let conv: string;
let runId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.approvals, capybara.conversation_tool_grants, " +
      "capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, " +
      "capybara.tool_grants, capybara.agent_versions, capybara.agent_members, capybara.agents, " +
      "capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, " +
      "capybara.identities, capybara.accounts, capybara.model_purpose_mappings",
  );
  scriptRules([]);
  chatSpy.mockClear();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  agentId = await createAgent(owner, orgId, SCRIPT_1);
  await db
    .insertInto("model_purpose_mappings")
    .values({ org_id: null, purpose: "review", ...SCRIPT_2, params: "{}" })
    .execute();
  conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, PERSON_MESSAGE);
  await waitForTerminal(db, conv, 1, 60_000);
  runId = (
    await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow()
  ).id;
});

afterEach(() => {
  scriptRules([]);
  chatSpy.mockImplementation(realChat);
});

/** Scripts the tool review's answer (and its usage). */
const answer = (decision: "allow" | "ask" | "deny", reason = "Scripted decision.") =>
  scriptRules([
    {
      when: { systemIncludes: TOOL_REVIEW_SYSTEM_PROMPT },
      reply: { text: JSON.stringify({ decision, reason }), usage: REVIEW_USAGE },
    },
  ] as ScriptRule[]);

let callSeq = 0;
const call = (over: Partial<ToolReviewInput> = {}): Promise<ToolReviewVerdict> =>
  review.review({
    orgId,
    rootConversationId: conv,
    conversationId: conv,
    runId,
    step: 2,
    callId: `call-${++callSeq}`,
    accountId: ownerId,
    signal: new AbortController().signal,
    toolKey: "Platform",
    title: "Create a channel connection",
    summary: { zh: "创建渠道连接 Ops", en: "Create the channel connection Ops" },
    input: {
      operation: "channels.create",
      params: { name: "Ops", botToken: SECRET_VALUE, signingSecret: SECRET_VALUE },
    },
    inputSchema: INPUT_SCHEMA,
    hookFacts: { accountId: ownerId, agentId, agentVersion: 1, conversationKind: "chat" },
    ...over,
  });

const reviewChats = () => chatSpy.mock.calls.filter((c) => c[1] === "review");
/** The request as the review sent it (the spy sees it before the model and params are added). */
const reviewRequest = (): ModelRequest => reviewChats().at(-1)?.[2] as ModelRequest;
const userText = (req: ModelRequest): string => {
  const b = req.messages[0]?.content;
  return Array.isArray(b) ? (b[0]?.type === "text" ? b[0].text : "") : "";
};
const systemTag = (req: ModelRequest): string =>
  /<([^<>\s]+)>/.exec(req.system[0]?.text ?? "")?.[1] ?? "";

const reviewUsage = () =>
  db
    .selectFrom("conversation_events")
    .select(["idem_key", "run_id", "payload"])
    .where("conversation_id", "=", conv)
    .where("type", "=", "usage")
    .orderBy("seq")
    .execute()
    .then((rows) =>
      rows.filter((r) => (r.payload as { purpose?: string } | null)?.purpose === "review"),
    );

describe("ToolAskReview", () => {
  it("an allow is the verdict; the request has the call and the person, no secret, no agent text", async () => {
    answer("allow", "The person asked to connect Slack.");
    const verdict = await call();
    expect(verdict).toEqual({ decision: "allow", reason: "The person asked to connect Slack." });

    const req = reviewRequest();
    expect(req.system).toHaveLength(1);
    expect(req.system[0]?.text).toBe(toolReviewSystemPrompt(systemTag(req)));
    expect(req.tools).toEqual([]);
    expect(req.toolChoice).toBe("none");
    expect(req.maxOutputTokens).toBe(REVIEW_MAX_OUTPUT_TOKENS);
    const user = userText(req);
    expect(user).toContain("Tool: Platform");
    expect(user).toContain("Title: Create a channel connection");
    expect(user).toContain("Summary: Create the channel connection Ops");
    expect(user).toContain('"operation":"channels.create"');
    expect(user).toContain('"name":"Ops"');
    expect(user).toContain(PERSON_MESSAGE);
    expect(user).not.toContain(AGENT_REPLY);
    // the scrubbed values and their field names never reach the model
    expect(JSON.stringify(req)).not.toContain(SECRET_VALUE);
    expect(user).not.toContain("botToken");
    expect(user).not.toContain("signingSecret");

    // one usage event: purpose review, the tool review's own idempotency key
    const usage = await reviewUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.idem_key).toBe(`usage_review_tool:${runId}:call-${callSeq}`);
    expect(usage[0]?.run_id).toBe(runId);
    expect(usage[0]?.payload).toMatchObject({
      purpose: "review",
      step: 2,
      callId: `call-${callSeq}`,
      model: "script-2",
      ...REVIEW_USAGE,
    });
  });

  it("a deny is the verdict with the model's reason", async () => {
    answer("deny", "Sends the workspace token to a party the person did not choose.");
    await expect(call()).resolves.toEqual({
      decision: "deny",
      reason: "Sends the workspace token to a party the person did not choose.",
    });
  });

  it("a malformed answer is an ask", async () => {
    scriptRules([
      { when: { systemIncludes: TOOL_REVIEW_SYSTEM_PROMPT }, reply: { text: "Looks fine." } },
    ] as ScriptRule[]);
    await expect(call()).resolves.toEqual({ decision: "ask", reason: TOOL_REVIEW_ASK_REASON });
  });

  it("a delay past the timeout is an ask, billed at its estimate", async () => {
    scriptRules([
      {
        when: { systemIncludes: TOOL_REVIEW_SYSTEM_PROMPT },
        // waits for a second request that never comes; the review's own timeout aborts it
        reply: {
          text: "late",
          barrier: { name: "tool-review-timeout", count: 2, timeoutMs: 30_000 },
        },
      },
    ] as ScriptRule[]);
    await expect(call()).resolves.toEqual({ decision: "ask", reason: TOOL_REVIEW_ASK_REASON });
    const usage = await reviewUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload).toMatchObject({ purpose: "review", outputTokens: 0 });
  });

  it("without a mapped review purpose it asks and sends nothing", async () => {
    await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
    await expect(call()).resolves.toEqual({ decision: "ask", reason: TOOL_REVIEW_ASK_REASON });
    expect(reviewChats()).toEqual([]);
    expect(await reviewUsage()).toEqual([]);
  });

  it("a model.request policy hook denial is an ask saying the review is unavailable", async () => {
    const res = await owner({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, denyModelPurposes: ["review"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const verdict = await call();
    expect(verdict).toEqual({ decision: "ask", reason: `${TOOL_REVIEW_UNAVAILABLE_PREFIX}nope` });
    const denied = await db
      .selectFrom("conversation_events")
      .select("idem_key")
      .where("conversation_id", "=", conv)
      .where("type", "=", "hook_denied")
      .execute();
    expect(denied.map((d) => d.idem_key)).toEqual([
      `hook_denied_review_tool:${runId}:call-${callSeq}`,
    ]);
    expect(await reviewUsage()).toEqual([]);
  });

  it("an input larger than the model's room is cut, and the allow becomes an ask", async () => {
    answer("allow");
    // model-script declares a 64 000-token context; 300 000 ASCII characters are ~75 000 tokens
    const verdict = await call({
      input: { operation: "channels.create", params: { name: "A".repeat(300_000) } },
    });
    expect(verdict).toEqual({ decision: "ask", reason: TOOL_REVIEW_TRUNCATED_ASK_REASON });
    const req = reviewRequest();
    const limits = await purposes.chatLimits(orgId, "review");
    expect(estimateTokens(req.messages, req.system, [])).toBeLessThanOrEqual(
      limits.contextWindow -
        Math.min(REVIEW_MAX_OUTPUT_TOKENS, limits.maxOutputTokens) -
        Math.max(1024, Math.ceil(limits.contextWindow / 10)),
    );
    const user = userText(req);
    expect(user).toContain(TOOL_REVIEW_TRUNCATED_MARKER);
    expect(user).toContain(PERSON_MESSAGE);
  });

  it("a command review of the same call keeps its own usage event", async () => {
    scriptRules([
      {
        when: { systemIncludes: TOOL_REVIEW_SYSTEM_PROMPT },
        reply: { text: JSON.stringify({ decision: "allow", reason: "ok" }), usage: REVIEW_USAGE },
      },
      {
        when: { systemIncludes: REVIEW_SYSTEM_PROMPT },
        reply: { text: JSON.stringify({ decision: "allow", reason: "ok" }), usage: REVIEW_USAGE },
      },
    ] as ScriptRule[]);
    const callId = `bash-${randomUUID()}`;
    const command = "some-unknown-binary --flag";
    await call({
      callId,
      toolKey: "Bash",
      title: null,
      summary: null,
      input: { command },
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
    });
    await k.app.get(CommandReviewService).review({
      orgId,
      conversationId: conv,
      runId,
      accountId: ownerId,
      agentId,
      agentVersion: 1,
      conversationKind: "chat",
      toolKey: "Bash",
      input: { command },
      mode: "auto",
      workspace: "/home/dev/workspace",
      attended: true,
      step: 2,
      callId,
      signal: new AbortController().signal,
    });
    const keys = (await reviewUsage()).map((u) => u.idem_key).sort();
    expect(keys).toEqual([
      `usage_review:${runId}:${callId}`,
      `usage_review_tool:${runId}:${callId}`,
    ]);
  });
});
