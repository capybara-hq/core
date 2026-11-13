import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModelRequest, UsageReportPayload } from "@capybara-hq/plugin-sdk";
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
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import {
  boundMessages,
  CommandReviewService,
  parseReviewAnswer,
  REVIEW_ASK_REASON,
  REVIEW_MAX_OUTPUT_TOKENS,
  REVIEW_REASONS,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TRUNCATED_MARKER,
  REVIEW_UNAVAILABLE_PREFIX,
  type ReviewCall,
  type ReviewInput,
  type ReviewVerdict,
  reviewSystemPrompt,
} from "../../src/sandbox/review/index.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Auto mode spec §5.3–§5.5: the command-review classifier (one `review` purpose call for the
 * `unsure` rule hits) and the service the tool pipeline calls. `model-script` answers the classifier
 * call (its system is {@link REVIEW_SYSTEM_PROMPT}), `hooks-probe` observes the model hooks and the
 * `usage.report` delivery, both on a real kernel.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const HOOKS_PROBE = fixture("hooks-probe");

const SCRIPT_1 = { provider: "model-script", model: "script-1" };
const SCRIPT_2 = { provider: "model-script", model: "script-2" };
const REVIEW_USAGE = { inputTokens: 111, outputTokens: 7 };
const WORKSPACE = "/home/dev/workspace";
const PERSON_MESSAGE = "please tidy the build output in /tmp/build";
/** The model-script fallback reply to a person message (the agent's own text). */
const AGENT_REPLY = "You said:";
/** An unknown command no rule covers: the rule table says `unsure`. */
const UNSURE_COMMAND = "some-unknown-binary --flag";

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let review: CommandReviewService;
let purposes: ModelPurposesService;
let realChat: ModelPurposesService["chat"];
let chatSpy: MockInstance<ModelPurposesService["chat"]>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  destroyDb = () => raw.destroy();
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
  review = k.app.get(CommandReviewService);
  purposes = k.app.get(ModelPurposesService);
  realChat = purposes.chat.bind(purposes);
  chatSpy = vi.spyOn(purposes, "chat");
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
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
  orgId = await createOrg(owner);
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  agentId = await createAgent(owner, orgId, SCRIPT_1);
  await mapPurpose("review", SCRIPT_2);
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
  // the agent's own text is in the log: the classifier must never see it
  expect(AGENT_REPLY.length).toBeGreaterThan(0);
});

afterEach(() => {
  scriptRules([]);
  chatSpy.mockImplementation(realChat);
});

const mapPurpose = (purpose: string, ref: { provider: string; model: string }) =>
  db
    .insertInto("model_purpose_mappings")
    .values({ org_id: null, purpose, provider: ref.provider, model: ref.model, params: "{}" })
    .execute();

/** Scripts the classifier answer (and its usage). */
const answer = (decision: "allow" | "ask" | "deny", reason = "Scripted decision.") =>
  scriptRules([
    {
      when: { systemIncludes: REVIEW_SYSTEM_PROMPT },
      reply: { text: JSON.stringify({ decision, reason }), usage: REVIEW_USAGE },
    },
  ] as ScriptRule[]);

/** Scripts an answer the classifier must not trust. */
const answerText = (text: string) =>
  scriptRules([
    { when: { systemIncludes: REVIEW_SYSTEM_PROMPT }, reply: { text } },
  ] as ScriptRule[]);

let callSeq = 0;
const call = (over: Partial<ReviewInput & ReviewCall> = {}): Promise<ReviewVerdict> =>
  review.review({
    orgId,
    conversationId: conv,
    runId,
    accountId: ownerId,
    agentId,
    agentVersion: 1,
    conversationKind: "chat",
    toolKey: "Bash",
    input: { command: UNSURE_COMMAND },
    mode: "auto",
    workspace: WORKSPACE,
    attended: true,
    step: 3,
    callId: `call-${++callSeq}`,
    signal: new AbortController().signal,
    ...over,
  });

const reviewChats = () => chatSpy.mock.calls.filter((c) => c[1] === "review");
/** The request as the classifier sent it (the spy sees it before the model and params are added). */
const reviewRequest = (): ModelRequest => reviewChats().at(-1)?.[2] as ModelRequest;

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const reviewUsage = async () =>
  ofType(await eventsOf(db, conv), "usage").filter((e) => e.payload.purpose === "review");

async function probeLast(purpose: string, mount: string): Promise<Record<string, unknown> | null> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=${purpose}`,
  });
  const last = (res.json() as { last: Record<string, Record<string, unknown>> }).last;
  return last[mount] ?? null;
}

describe("the classifier's answer parsing", () => {
  it("takes a strict JSON answer, plain or fenced", () => {
    expect(parseReviewAnswer('{"decision":"allow","reason":"Reads a file."}')).toEqual({
      decision: "allow",
      reason: "Reads a file.",
    });
    expect(
      parseReviewAnswer('```json\n{"decision": "deny", "reason": "Sends a secret."}\n```'),
    ).toEqual({ decision: "deny", reason: "Sends a secret." });
  });

  it("rejects anything else: a missing reason, an unknown decision, extra fields, prose", () => {
    for (const bad of [
      '{"decision":"allow"}',
      '{"decision":"allow","reason":"  "}',
      '{"decision":"maybe","reason":"x"}',
      '{"decision":"allow","reason":"x","extra":1}',
      "allow it",
      "",
    ]) {
      expect(parseReviewAnswer(bad), bad).toBeNull();
    }
  });

  it("bounds the person's messages to the token budget, newest last", () => {
    const long = "a".repeat(4_000);
    const bounded = boundMessages([long, "second request", "third request"], 50);
    expect(bounded.endsWith("third request")).toBe(true);
    expect(bounded).toContain("second request");
    expect(bounded).not.toContain(long);
    // the estimate is ASCII / 4: at most 50 tokens
    expect(bounded.length).toBeLessThanOrEqual(50 * 4 + "second request".length + 2);
    expect(boundMessages(["only"], 0)).toBe("");
  });
});

describe("CommandReviewService", { timeout: 120_000 }, () => {
  it("an unsure command: the classifier's allow is the verdict; the request has no agent text", async () => {
    answer("allow", "An unknown helper that only reads.");
    let sent: { target: { provider: string; model: string }; request: ModelRequest } | undefined;
    const verdict = await call({
      beforeSend: async (target, request) => {
        sent = { target, request };
      },
    });

    expect(verdict).toEqual({
      decision: "allow",
      by: "classifier",
      reason: "An unknown helper that only reads.",
      rule: null,
    });
    expect(sent?.target).toEqual(SCRIPT_2);
    const req = sent?.request as ModelRequest;
    // the purpose's model, one bounded user message, no tools, the output cap
    expect(req.model).toBe("script-2");
    expect(req.system).toHaveLength(1);
    expect(req.system[0]?.text.startsWith(REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(req.system[0]?.text).toBe(reviewSystemPrompt(systemTag(req)));
    expect(req.tools).toEqual([]);
    expect(req.toolChoice).toBe("none");
    expect(req.maxOutputTokens).toBe(REVIEW_MAX_OUTPUT_TOKENS);
    // the command and the root conversation's person message, never the agent's own text
    const user = userText(req);
    expect(user).toContain(UNSURE_COMMAND);
    expect(user).toContain(PERSON_MESSAGE);
    expect(user).toContain("unsure.uncovered");
    expect(user).toContain(`Mode: auto`);
    expect(user).toContain(`Working directory: ${WORKSPACE}`);
    expect(user).not.toContain(AGENT_REPLY);

    // its usage: purpose review, step, the call's run and id, the purpose model's tokens
    const [usage, ...more] = await reviewUsage();
    expect(more).toEqual([]);
    expect(usage?.runId).toBe(runId);
    expect(usage?.payload).toMatchObject({
      purpose: "review",
      step: 3,
      callId: `call-${callSeq}`,
      provider: "model-script",
      model: "script-2",
      ...REVIEW_USAGE,
    });

    // the hooks fire with purpose review; the usage is delivered through usage.report
    const request = await waitFor(() => probeLast("review", "model.request"), 30_000);
    expect(request).toMatchObject({
      purpose: "review",
      conversationId: conv,
      runId,
      step: 3,
      provider: "model-script",
      model: "script-2",
    });
    const response = await waitFor(() => probeLast("review", "model.response"), 30_000);
    expect(response).toMatchObject({ purpose: "review", outcome: "ok", conversationId: conv });
    const eventId = `${conv}/${usage?.seq}`;
    const delivered = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/plugins/hooks-probe/usage?eventIds=${eventId}`,
        });
        const d = (res.json() as Record<string, { last: UsageReportPayload | null }>)[eventId];
        return d?.last ?? null;
      },
      30_000,
      "usage.report delivery",
    );
    expect(delivered).toMatchObject({ purpose: "review", conversationId: conv });
  });

  it("an ask and a deny answer become the verdict, by classifier, with no rule", async () => {
    answer("ask", "Needs a person's decision.");
    await expect(call()).resolves.toMatchObject({
      decision: "ask",
      by: "classifier",
      reason: "Needs a person's decision.",
      rule: null,
    });

    answer("deny", "Sends a secret away.");
    await expect(call()).resolves.toMatchObject({
      decision: "deny",
      by: "classifier",
      reason: "Sends a secret away.",
      rule: null,
    });
  });

  it("an unparseable answer is an ask", async () => {
    answerText("Yes, that looks fine to me.");
    await expect(call()).resolves.toEqual({
      decision: "ask",
      by: "classifier",
      reason: REVIEW_ASK_REASON,
      rule: null,
    });
  });

  it("a delay past the timeout is an ask, and the sent call is billed at its estimate", async () => {
    scriptRules([
      {
        when: { systemIncludes: REVIEW_SYSTEM_PROMPT },
        // waits for a second request that never comes; the review's own timeout aborts it
        reply: { text: "late", barrier: { name: "review-timeout", count: 2, timeoutMs: 30_000 } },
      },
    ]);
    const verdict = await call();
    expect(verdict).toMatchObject({ decision: "ask", by: "classifier", rule: null });
    const usages = await reviewUsage();
    expect(usages).toHaveLength(1);
    expect(usages[0]?.payload).toMatchObject({
      purpose: "review",
      outputTokens: 0,
      callId: `call-${callSeq}`,
    });
    expect(usages[0]?.payload.inputTokens).toBeGreaterThan(0);
  });

  it("without a mapped review purpose unsure is an ask, and no classifier call is made", async () => {
    await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
    const verdict = await call();
    expect(verdict).toMatchObject({ decision: "ask", by: "rule", rule: "unsure.uncovered" });
    expect(reviewChats()).toEqual([]);
    expect(await reviewUsage()).toEqual([]);
  });

  it("a session grant suppresses a repeated rule ask, but never a different rule or a deny", async () => {
    const grant = (rule: string) =>
      db
        .insertInto("conversation_tool_grants")
        .values({
          conversation_id: conv,
          tool_key: `command:${rule}`,
          spec_hash: "command",
          connector_id: null,
        })
        .execute();

    const sudo = { input: { command: "sudo apt-get update" } };
    await expect(call(sudo)).resolves.toMatchObject({ decision: "ask", rule: "ask.sudo" });
    await grant("ask.sudo");
    await expect(call(sudo)).resolves.toEqual({
      decision: "allow",
      by: "rule",
      reason: REVIEW_REASONS.sessionGrant,
      rule: "ask.sudo",
    });
    // another rule class is not covered by the grant
    await expect(call({ input: { command: "rm /etc/hosts" } })).resolves.toMatchObject({
      decision: "ask",
      rule: "ask.outside-write",
    });
    // a deny is never turned into an allow
    await grant("deny.root-delete");
    await expect(call({ input: { command: "rm -rf /" } })).resolves.toMatchObject({
      decision: "deny",
      rule: "deny.root-delete",
    });
  });

  it("a model.request policy hook denial is an ask: the tool result says review is unavailable", async () => {
    const res = await owner({
      method: "POST",
      url: "/plugins/hooks-probe/config",
      payload: { orgId, denyModelPurposes: ["review"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const verdict = await call();
    expect(verdict.decision).toBe("ask");
    expect(verdict.by).toBe("classifier");
    expect(verdict.reason.startsWith(REVIEW_UNAVAILABLE_PREFIX)).toBe(true);
    // the denial is recorded, nothing was sent, so no usage is owed
    const denied = ofType(await eventsOf(db, conv), "hook_denied").filter(
      (e) => e.payload.mount === "model.request",
    );
    expect(denied).toHaveLength(1);
    expect(await reviewUsage()).toEqual([]);
  });

  it("reviews only Bash and file writes; sandbox writes and a missing device are skipped", async () => {
    answer("allow");
    await expect(call({ toolKey: "Read", input: { file_path: "/etc/hosts" } })).resolves.toEqual({
      decision: "allow",
      by: "rule",
      reason: REVIEW_REASONS.notReviewed,
      rule: null,
    });
    await expect(
      call({ toolKey: "Write", input: { file_path: "/etc/motd" }, mode: "sandbox" }),
    ).resolves.toEqual({
      decision: "allow",
      by: "rule",
      reason: REVIEW_REASONS.sandboxWrite,
      rule: null,
    });
    await expect(call({ workspace: undefined })).resolves.toEqual({
      decision: "allow",
      by: "rule",
      reason: REVIEW_REASONS.noDevice,
      rule: null,
    });
    expect(reviewChats()).toEqual([]);
  });

  it("a file write outside the workspace in auto mode is an ask", async () => {
    answer("allow");
    const verdict = await call({ toolKey: "Write", input: { file_path: "/etc/motd" } });
    expect(verdict).toMatchObject({ decision: "ask", by: "rule", rule: "ask.outside-write" });
  });

  it("the usage event is idempotent per run and call id", async () => {
    answer("allow");
    const callId = `idem-${randomUUID()}`;
    await call({ callId });
    await call({ callId });
    expect(await reviewUsage()).toHaveLength(1);
  });

  it("a sub-agent's conversation resolves to the root: its task text is never seen", async () => {
    answer("allow", "Fine.");
    const child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: ownerId,
        kind: "subagent",
        source: "subagent",
        parent_conversation_id: conv,
        subagent_depth: 1,
      })
      .execute();
    await k.app.get(EventLog).append(child, [
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: "child task: only the sub-agent sees this" }],
          authorAccountId: ownerId,
        },
      },
    ]);

    // even a caller that names the sub-agent's conversation is reviewed against the root's
    // person messages; the child's agent-authored task text is never read
    const verdict = await call({
      conversationId: child,
      conversationKind: "subagent",
      parent: { conversationId: conv, runId, callId: "agent-call" },
    });
    expect(verdict.decision).toBe("allow");
    const user = userText(reviewRequest());
    expect(user).toContain(PERSON_MESSAGE);
    expect(user).not.toContain("only the sub-agent sees this");
  });

  it("cuts a command too large for the review model's context instead of overflowing it", async () => {
    answer("allow");
    // model-script declares a 64 000-token context; 300 000 ASCII characters are ~75 000 tokens
    const huge = `${UNSURE_COMMAND} ${"A".repeat(300_000)}`;
    let sent: ModelRequest | undefined;
    const verdict = await call({
      input: { command: huge },
      beforeSend: async (_target, request) => {
        sent = request;
      },
    });
    expect(verdict.decision).toBe("allow");
    const req = sent as ModelRequest;
    const limits = await purposes.chatLimits(orgId, "review");
    expect(estimateTokens(req.messages, req.system, [])).toBeLessThanOrEqual(
      limits.contextWindow -
        Math.min(REVIEW_MAX_OUTPUT_TOKENS, limits.maxOutputTokens) -
        Math.max(1024, Math.ceil(limits.contextWindow / 10)),
    );
    const user = userText(req);
    expect(user).toContain(UNSURE_COMMAND);
    expect(user).toContain(REVIEW_TRUNCATED_MARKER);
    expect(user).toContain(PERSON_MESSAGE);
  });
});

/** The data tag in the classifier's system prompt. */
function systemTag(req: ModelRequest): string {
  const m = /<([^<>\s]+)>/.exec(req.system[0]?.text ?? "");
  return m?.[1] ?? "";
}

/** The classifier request's user text. */
function userText(req: ModelRequest): string {
  const b = req.messages[0]?.content;
  return Array.isArray(b) ? (b[0]?.type === "text" ? b[0].text : "") : "";
}
