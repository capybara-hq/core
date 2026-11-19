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
import {
  type ConversationEvent,
  type EventPayload,
  PermissionEscalationSchema,
} from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import {
  boundMessages,
  CommandReviewService,
  isSessionGrantableRule,
  parseReviewAnswer,
  REVIEW_ASK_REASON,
  REVIEW_MAX_OUTPUT_TOKENS,
  REVIEW_REASONS,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TRUNCATED_ASK_REASON,
  REVIEW_TRUNCATED_MARKER,
  REVIEW_UNAVAILABLE_PREFIX,
  type ReviewCall,
  type ReviewInput,
  type ReviewVerdict,
  reviewSystemPrompt,
} from "../../src/sandbox/review/index.js";
import { escalationAskReason } from "../../src/sandbox/review/review.service.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
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
let raw: ReturnType<typeof createDb>;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let review: CommandReviewService;
let purposes: ModelPurposesService;
let realChat: ModelPurposesService["chat"];
let chatSpy: MockInstance<ModelPurposesService["chat"]>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
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
});

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
  orgId = await createOrgWithProviders(k, owner);
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

describe("CommandReviewService", () => {
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

  it("without a mapped review purpose unsure is an ask with no grantable rule, and no classifier call is made", async () => {
    await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
    const verdict = await call();
    // the deciding hit is a catch-all (`unsure.*`), so it is never offered as a session grant
    expect(verdict).toMatchObject({ decision: "ask", by: "rule", rule: null });
    expect(reviewChats()).toEqual([]);
    expect(await reviewUsage()).toEqual([]);
  });

  it("a stored catch-all grant never suppresses an unsure ask, and only concrete rules are grantable", async () => {
    await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
    // a grant a deployment could have written before the catch-all was excluded: inert from now on
    await db
      .insertInto("conversation_tool_grants")
      .values({
        conversation_id: conv,
        tool_key: "command:unsure.uncovered",
        spec_hash: "command",
        connector_id: null,
      })
      .execute();
    await expect(call()).resolves.toMatchObject({ decision: "ask", by: "rule", rule: null });
    // only a concrete rule class can back 本会话允许同类
    expect(isSessionGrantableRule("ask.force-push")).toBe(true);
    expect(isSessionGrantableRule("unsure.uncovered")).toBe(false);
    expect(isSessionGrantableRule("unsure.unparsed")).toBe(false);
    expect(isSessionGrantableRule(null)).toBe(false);
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

    const outside = { input: { command: "rm /etc/hosts" } };
    await expect(call(outside)).resolves.toMatchObject({
      decision: "ask",
      rule: "ask.outside-write",
    });
    await grant("ask.outside-write");
    await expect(call(outside)).resolves.toEqual({
      decision: "allow",
      by: "rule",
      reason: REVIEW_REASONS.sessionGrant,
      rule: "ask.outside-write",
    });
    // another rule class is not covered by the grant, even in the same line
    await expect(
      call({ input: { command: "rm /etc/hosts; crontab /tmp/c" } }),
    ).resolves.toMatchObject({ decision: "ask", rule: "ask.persistence" });
    // a never-session class is asked every time, whatever was stored
    await grant("ask.sudo");
    await expect(call({ input: { command: "sudo apt-get update" } })).resolves.toMatchObject({
      decision: "ask",
      rule: "ask.sudo",
    });
    // a deny is never turned into an allow
    await grant("deny.root-destroy");
    await expect(call({ input: { command: "rm -rf /" } })).resolves.toMatchObject({
      decision: "deny",
      rule: "deny.root-destroy",
    });
  });

  it("an unattended run never uses a session grant", async () => {
    await db
      .insertInto("conversation_tool_grants")
      .values({
        conversation_id: conv,
        tool_key: "command:ask.outside-write",
        spec_hash: "command",
        connector_id: null,
      })
      .execute();
    await expect(
      call({ attended: false, input: { command: "rm /etc/hosts" } }),
    ).resolves.toMatchObject({ decision: "ask", rule: "ask.outside-write" });
  });

  it("running a file the conversation wrote is reviewed as code it cannot read", async () => {
    await expect(call({ input: { command: "python3 gen.py" } })).resolves.toMatchObject({
      decision: "allow",
    });
    // the agent wrote gen.py with the Write tool, then a helper script with a Bash redirection
    await k.app.get(EventLog).append(conv, [
      {
        type: "assistant_message",
        payload: {
          step: 1,
          stopReason: "tool_use",
          content: [
            {
              type: "tool_call",
              id: "w1",
              name: "Write",
              input: { file_path: `${WORKSPACE}/gen.py`, content: "print(1)" },
            },
            {
              type: "tool_call",
              id: "b1",
              name: "Bash",
              input: { command: "printf 'echo hi' > tools/run.sh" },
            },
          ],
        },
      },
    ]);
    for (const command of ["python3 gen.py", "bash tools/run.sh"]) {
      const verdict = await call({ input: { command } });
      expect(verdict.decision, command).not.toBe("allow");
    }
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

  it("a file a sub-agent wrote counts for every agent of the tree", async () => {
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
        type: "assistant_message",
        payload: {
          step: 1,
          stopReason: "tool_use",
          content: [
            {
              type: "tool_call",
              id: "w-child",
              name: "Write",
              input: { file_path: `${WORKSPACE}/child.sh`, content: "echo hi" },
            },
          ],
        },
      },
    ]);
    // the root's own call and the sub-agent's call both see the sub-agent's write
    for (const over of [
      {},
      {
        conversationId: child,
        conversationKind: "subagent" as const,
        parent: { conversationId: conv, runId, callId: "agent-call" },
      },
    ]) {
      const verdict = await call({ ...over, input: { command: "bash child.sh" } });
      expect(verdict.decision).not.toBe("allow");
    }
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
    // the model read only the beginning: its allow cannot cover the rest (hardening spec R8)
    expect(verdict).toMatchObject({ decision: "ask", reason: REVIEW_TRUNCATED_ASK_REASON });
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

import type { PermissionReviewSnapshot } from "../../src/sandbox/permission-call-types.js";
import {
  buildPermissionCandidate,
  ESCALATION_JUSTIFICATION_TOO_LONG_TEXT,
} from "../../src/sandbox/review/permission-candidate.js";

it.each(["allow", "ask", "deny", "malformed", "request"] as const)(
  "independent review transport preserves the exact directory candidate for %s",
  async (outcome) => {
    const input = { file_path: "/outside/reports/report.txt" };
    const facts: PermissionReviewSnapshot = {
      orgId,
      rootConversationId: conv,
      conversationId: conv,
      deviceId: "review-fixture",
      accountId: ownerId,
      runId,
      callId: "exact-candidate",
      profile: "approve-for-me",
      profileRevision: 0,
      scopeRevision: "scope",
      authorityRevision: "authority",
      baseReadDirectories: [WORKSPACE],
      baseWriteDirectories: [WORKSPACE],
      baseHosts: [],
      workingRoot: WORKSPACE,
      fullAccessCeiling: true,
      broadProjectReach: true,
      fullConsent: false,
      unattended: false,
      availability: { state: "supported" },
      policy: {
        mode: "auto",
        allowedMode: "auto",
        localAllowedDomains: [],
        network: { kind: "open-public", hosts: [] },
      },
    };
    const built = buildPermissionCandidate(
      { toolKey: "Write", specHash: "write-spec", rawInput: input, validatedInput: input },
      facts,
    );
    if (built.kind !== "proposal") throw new Error("Expected exact proposal");
    if (outcome === "malformed")
      answerText(
        JSON.stringify({
          decision: "allow",
          reason: "Replace scope",
          permissionScope: { writeDirectories: ["/"] },
        }),
      );
    else answer(outcome === "request" ? "allow" : outcome);
    const verdict = await call({
      toolKey: "Write",
      input,
      permissionProfile: outcome === "request" ? "request-approval" : "approve-for-me",
      permissionCandidate: built.candidate,
      callId: "exact-candidate",
    });
    expect(verdict.decision).toBe(
      outcome === "malformed" || outcome === "request" ? "ask" : outcome,
    );
    if (outcome === "request") {
      expect(reviewChats()).toEqual([]);
      return;
    }
    const request = reviewRequest(),
      tag = systemTag(request);
    expect(userText(request)).toContain(`<${tag}>\n${JSON.stringify(built.candidate)}\n</${tag}>`);
    expect(request.tools).toEqual([]);
    expect(verdict).not.toHaveProperty("permissionScope");
  },
);

import { ExtensionHost } from "../../src/extensions/host.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { ToolPipeline } from "../../src/tools/pipeline.js";
import { permissionFixture } from "../helpers/permission-policy.js";
import { enableModelProviders } from "../helpers/runs.js";

it("staged child classifier retains parent hooks and explicit budget accounting", async () => {
  const input = { file_path: "/outside/reports/report.txt" };
  const f = await permissionFixture(k, raw, "Write", input, true);
  // a model provider is on only in the orgs that enabled it: the classifier's too
  await enableModelProviders(k, f.orgId);
  const childId = randomUUID(),
    childRunId = randomUUID(),
    budgetRunId = randomUUID(),
    executionId = randomUUID();
  await f.db
    .insertInto("conversations")
    .values({
      id: childId,
      org_id: f.orgId,
      agent_id: f.agentId,
      account_id: f.accountId,
      title: null,
      last_seq: 0,
      consumed_seq: 0,
      created_at: new Date(),
      updated_at: new Date(),
      kind: "subagent",
      source: "subagent",
      parent_conversation_id: f.conversationId,
      subagent_depth: 1,
    })
    .execute();
  await f.db
    .insertInto("runs")
    .values({
      id: budgetRunId,
      conversation_id: f.conversationId,
      status: "completed",
      agent_version: 1,
      trigger_account_id: f.accountId,
      trigger_seq: 0,
    })
    .execute();
  await f.db
    .insertInto("runs")
    .values({
      id: childRunId,
      conversation_id: childId,
      execution_id: executionId,
      status: "running",
      agent_version: 1,
      trigger_account_id: f.accountId,
      trigger_seq: 0,
      budget_run_id: budgetRunId,
    })
    .execute();
  await k.app.get(EventLog).append(childId, [
    {
      type: "assistant_message",
      runId: childRunId,
      idemKey: assistantIdemKey(childRunId, 1),
      payload: {
        step: 1,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: f.callId, name: "Write", input }],
      },
    },
  ]);
  const parent = {
    conversationId: f.conversationId,
    runId: f.runId,
    callId: "dispatch-child",
    depth: 0,
    rootConversationId: f.conversationId,
    budgetRunId,
  };
  const hooks = vi.spyOn(k.app.get(ExtensionHost).hooks, "run");
  answer("ask", "Require the exact directory decision.");
  try {
    const result = await k.app.get(RunExecution).withClaim(
      { ...f.claim, conversationId: childId, runId: childRunId, executionId },
      () => true,
      () =>
        k.app.get(ToolPipeline).runStep({
          ...f.ctx,
          conversationId: childId,
          runId: childRunId,
          parent,
          conversationKind: "subagent",
          source: "subagent",
          agent: { ...f.ctx.agent, model: SCRIPT_1 },
        }),
    );
    expect(
      result.kind,
      JSON.stringify(
        await f.db
          .selectFrom("conversation_events")
          .select(["type", "payload"])
          .where("run_id", "=", childRunId)
          .execute(),
      ),
    ).toBe("suspended");
    const counters = await f.db
      .selectFrom("runs")
      .select(["id", "subagent_tokens_used"])
      .where("id", "in", [f.runId, budgetRunId])
      .execute();
    expect(Number(counters.find((row) => row.id === budgetRunId)?.subagent_tokens_used)).toBe(
      REVIEW_USAGE.inputTokens + REVIEW_USAGE.outputTokens,
    );
    expect(Number(counters.find((row) => row.id === f.runId)?.subagent_tokens_used)).toBe(0);
    for (const mount of ["model.request", "model.response"]) {
      const calls = hooks.mock.calls.filter(
        ([name, payload]) =>
          name === mount && (payload as { purpose?: string }).purpose === "review",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toMatchObject({
        conversationId: f.conversationId,
        runId: childRunId,
        parent: { conversationId: f.conversationId, runId: f.runId, callId: "dispatch-child" },
      });
    }
    expect(
      await f.db
        .selectFrom("conversation_events")
        .select("seq")
        .where("run_id", "=", childRunId)
        .where("type", "=", "usage")
        .execute(),
    ).toHaveLength(1);
    expect(f.effects()).toBe(0);
  } finally {
    hooks.mockRestore();
  }
});

it("a proposed host outside the applied cloud outer allowlist is cut like admission cuts it (B-15)", () => {
  type Outer = NonNullable<PermissionReviewSnapshot["outerNetwork"]>;
  const facts = (outerNetwork: Outer): PermissionReviewSnapshot => ({
    orgId,
    rootConversationId: conv,
    conversationId: conv,
    deviceId: "review-fixture",
    accountId: ownerId,
    runId,
    callId: "outer-cut",
    profile: "approve-for-me",
    profileRevision: 0,
    scopeRevision: "scope",
    authorityRevision: "authority",
    baseReadDirectories: [WORKSPACE],
    baseWriteDirectories: [WORKSPACE],
    baseHosts: [],
    workingRoot: WORKSPACE,
    fullAccessCeiling: true,
    broadProjectReach: true,
    fullConsent: false,
    unattended: false,
    availability: { state: "supported" },
    outerNetwork,
    policy: {
      mode: "auto",
      allowedMode: "auto",
      localAllowedDomains: [],
      network: { kind: "open-public", hosts: [] },
    },
  });
  const input = { command: "curl https://b.example/data https://a.example/data" };
  const build = (outer: Outer) =>
    buildPermissionCandidate(
      { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
      facts(outer),
    );
  const hostsOf = (r: ReturnType<typeof build>) =>
    r.kind === "proposal" ? r.candidate.permissionScope.hosts : r.kind;
  expect(hostsOf(build({ kind: "open-public" }))).toEqual(["a.example", "b.example"]);
  expect(hostsOf(build({ kind: "allowlist", hosts: ["a.example"] }))).toEqual(["a.example"]);
  expect(hostsOf(build({ kind: "none" }))).toBe("in-scope");
});

describe("the permission review of a managed call", () => {
  const INLINE_PUSH = `python3 -c "import os; os.system('git push --force origin main')"`;
  const NESTED_SUDO = `sh -c "sh -c 'sudo ls /root'"`;
  const READ_PACKAGE = `python3 -c "import json; print(json.load(open('package.json'))['name'])"`;

  it.each([INLINE_PUSH, NESTED_SUDO])(
    "Request approval asks the person about an unsure line, with no review model call: %s",
    async (command) => {
      const verdict = await call({ input: { command }, permissionProfile: "request-approval" });
      expect(verdict.decision).toBe("ask");
      expect(reviewChats()).toEqual([]);
    },
  );

  it.each([INLINE_PUSH, NESTED_SUDO])(
    "Approve for me sends an unsure line to the review model, whose deny stays a deny: %s",
    async (command) => {
      answer("deny", "Not what the person asked for.");
      const verdict = await call({ input: { command }, permissionProfile: "approve-for-me" });
      expect(verdict).toMatchObject({ decision: "deny", by: "classifier" });
      expect(reviewChats()).toHaveLength(1);
    },
  );

  it("Approve for me: the package.json-reading Python is allowed by the review model", async () => {
    answer("allow", "Reads the project's own manifest.");
    const verdict = await call({
      input: { command: READ_PACKAGE },
      permissionProfile: "approve-for-me",
    });
    expect(verdict).toMatchObject({ decision: "allow", by: "classifier" });
  });

  it("Approve for me without a review model asks; Full access runs the line unreviewed", async () => {
    await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
    expect(
      await call({ input: { command: INLINE_PUSH }, permissionProfile: "approve-for-me" }),
    ).toMatchObject({ decision: "ask" });
    expect(
      await call({ input: { command: INLINE_PUSH }, permissionProfile: "full-access" }),
    ).toMatchObject({ decision: "allow" });
    expect(reviewChats()).toEqual([]);
  });

  it("a Read gets no write-rule consent: a git hook reads with no ask, a credential read asks", async () => {
    const hook = await call({
      toolKey: "Read",
      input: { file_path: `${WORKSPACE}/.git/hooks/pre-commit` },
      home: "/home/dev",
      permissionProfile: "request-approval",
    });
    expect(hook.decision).toBe("allow");
    const key = await call({
      toolKey: "Read",
      input: { file_path: "/home/dev/.ssh/id_ed25519" },
      home: "/home/dev",
      permissionProfile: "request-approval",
    });
    expect(key).toMatchObject({ decision: "ask", rule: "ask.ssh" });
    // the review model is told it is a read
    answer("allow");
    await call({
      toolKey: "Read",
      input: { file_path: "/home/dev/.ssh/id_ed25519" },
      home: "/home/dev",
      permissionProfile: "approve-for-me",
    });
    expect(JSON.stringify(reviewRequest().messages)).toContain("File read path");
  });

  it("a command's own outside write cannot be approved: refused with what works instead", async () => {
    const verdict = await call({
      input: { command: "touch /etc/capybara-outside.txt" },
      permissionProfile: "request-approval",
    });
    expect(verdict).toMatchObject({ decision: "deny", rule: "ask.outside-write" });
    expect(verdict.reason).toContain("Write or Edit");
    expect(verdict.reason).toContain(`keep it inside ${WORKSPACE}`);
  });

  it("a `.` segment is normalized before extraction: /outside/./x proposes /outside", () => {
    const input = { file_path: "/outside/./report.txt" };
    const facts: PermissionReviewSnapshot = {
      orgId,
      rootConversationId: conv,
      conversationId: conv,
      deviceId: "review-fixture",
      accountId: ownerId,
      runId,
      callId: "dot-segment",
      profile: "request-approval",
      profileRevision: 0,
      scopeRevision: "scope",
      authorityRevision: "authority",
      baseReadDirectories: [WORKSPACE],
      baseWriteDirectories: [WORKSPACE],
      baseHosts: [],
      workingRoot: WORKSPACE,
      fullAccessCeiling: true,
      broadProjectReach: true,
      fullConsent: false,
      unattended: false,
      availability: { state: "supported" },
      policy: {
        mode: "auto",
        allowedMode: "auto",
        localAllowedDomains: [],
        network: { kind: "open-public", hosts: [] },
      },
    };
    const built = buildPermissionCandidate(
      { toolKey: "Write", specHash: "write-spec", rawInput: input, validatedInput: input },
      facts,
    );
    expect(built.kind === "proposal" && built.candidate.permissionScope.writeDirectories).toEqual([
      "/outside",
    ]);
    expect(built.kind === "proposal" && built.candidate.targetPath).toBe("/outside/report.txt");
  });
});

/**
 * Image generation spec §5.3 on a permission profile: a `GenerateImage` call with `file_path` is a
 * permission candidate exactly like `Write` (every path it writes judged, the worst outcome
 * deciding); one without `file_path` writes nothing into the device and proposes nothing.
 */
describe("GenerateImage under a permission profile", () => {
  const facts: PermissionReviewSnapshot = {
    orgId: "o",
    rootConversationId: "c",
    conversationId: "c",
    deviceId: "review-fixture",
    accountId: "a",
    runId: "r",
    callId: "image-candidate",
    profile: "approve-for-me",
    profileRevision: 0,
    scopeRevision: "scope",
    authorityRevision: "authority",
    baseReadDirectories: [WORKSPACE],
    baseWriteDirectories: [WORKSPACE],
    baseHosts: [],
    workingRoot: WORKSPACE,
    fullAccessCeiling: true,
    broadProjectReach: true,
    fullConsent: false,
    unattended: false,
    availability: { state: "supported" },
    policy: {
      mode: "auto",
      allowedMode: "auto",
      localAllowedDomains: [],
      network: { kind: "open-public", hosts: [] },
    },
  };
  const build = (toolKey: string, input: Record<string, unknown>) =>
    buildPermissionCandidate(
      { toolKey, specHash: "spec", rawInput: input, validatedInput: input },
      facts,
    );

  it("proposes the write directory of every path it writes, as Write does", () => {
    const write = build("Write", { file_path: "/outside/art/a.png", content: "x" });
    const one = build("GenerateImage", { prompt: "p", file_path: "/outside/art/a.png" });
    if (write.kind !== "proposal" || one.kind !== "proposal") throw new Error("expected proposals");
    expect(one.candidate.permissionScope).toEqual(write.candidate.permissionScope);
    expect(one.candidate.targetPath).toBe("/outside/art/a.png");
    const two = build("GenerateImage", { prompt: "p", n: 2, file_path: "/outside/art/a.png" });
    if (two.kind !== "proposal") throw new Error("expected a proposal");
    expect(two.candidate.permissionScope.writeDirectories).toEqual(["/outside/art"]);
    expect(two.candidate.targetPath).toBe("/outside/art/a-1.png, /outside/art/a-2.png");
  });

  it("in scope inside the workspace, and without file_path", () => {
    expect(build("GenerateImage", { prompt: "p", file_path: "out/a.png" }).kind).toBe("in-scope");
    expect(build("GenerateImage", { prompt: "p" }).kind).toBe("in-scope");
  });

  it("an unbounded path is unsupported, as for Write", () => {
    expect(build("GenerateImage", { prompt: "p", file_path: "/outside/*.png" }).kind).toBe(
      "unsupported",
    );
  });

  it("the review judges every suffixed path as a Write: the device directory is denied", async () => {
    const allowed = await call({
      toolKey: "GenerateImage",
      input: { prompt: "p", n: 2, file_path: `${WORKSPACE}/out/a.png` },
      permissionProfile: "approve-for-me",
    });
    expect(allowed.decision).toBe("allow");
    const write = await call({
      toolKey: "Write",
      input: { file_path: "/etc/capybara-device/a-1.png", content: "x" },
      permissionProfile: "approve-for-me",
    });
    expect(write).toMatchObject({ decision: "deny", rule: "deny.tooling-edit" });
    const denied = await call({
      toolKey: "GenerateImage",
      input: { prompt: "p", n: 2, file_path: "/etc/capybara-device/a.png" },
      permissionProfile: "approve-for-me",
    });
    expect(denied).toMatchObject({ decision: "deny", rule: "deny.tooling-edit" });
  });

  it("request-approval asks for a GenerateImage candidate as for a Write candidate", async () => {
    const input = { prompt: "p", file_path: "/outside/art/a.png" };
    const built = build("GenerateImage", input);
    if (built.kind !== "proposal") throw new Error("expected a proposal");
    const verdict = await call({
      toolKey: "GenerateImage",
      input,
      permissionProfile: "request-approval",
      permissionCandidate: built.candidate,
    });
    expect(verdict.decision).toBe("ask");
    // without file_path: nothing to review
    const none = await call({
      toolKey: "GenerateImage",
      input: { prompt: "p" },
      permissionProfile: "request-approval",
    });
    expect(none).toMatchObject({
      decision: "allow",
      reason: "This tool call needs no command review.",
    });
  });
});

// Per-call sandbox escalation under Approve for me: the review model decides with the
// justification; unavailable, unsure, failing, truncated or unmapped asks; its deny stays a deny.
// Under Request approval the person is asked, the review model never called.
it.each([
  "allow",
  "deny",
  "ask",
  "malformed",
  "failing",
  "truncated",
  "unmapped",
  "request",
] as const)("an escalation reviewed under %s", async (outcome) => {
  const command = outcome === "truncated" ? `npm run dev ${"A".repeat(300_000)}` : "npm run dev";
  const input = {
    command,
    sandbox: "escalated",
    justification: "The dev server must bind port 3000 on the machine.",
  };
  const facts: PermissionReviewSnapshot = {
    orgId,
    rootConversationId: conv,
    conversationId: conv,
    deviceId: "review-fixture",
    accountId: ownerId,
    runId,
    callId: `escalation-${outcome}`,
    profile: outcome === "request" ? "request-approval" : "approve-for-me",
    profileRevision: 0,
    scopeRevision: "scope",
    authorityRevision: "authority",
    baseReadDirectories: [WORKSPACE],
    baseWriteDirectories: [WORKSPACE],
    baseHosts: [],
    workingRoot: WORKSPACE,
    fullAccessCeiling: true,
    broadProjectReach: true,
    fullConsent: false,
    unattended: false,
    availability: { state: "supported" },
    escalationRefusal: null,
    policy: {
      mode: "auto",
      allowedMode: "auto",
      localAllowedDomains: [],
      network: { kind: "open-public", hosts: [] },
    },
  };
  const built = buildPermissionCandidate(
    { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
    facts,
  );
  if (built.kind !== "proposal") throw new Error(JSON.stringify(built));
  if (outcome === "malformed") answerText("I think it is fine");
  else if (outcome === "failing") chatSpy.mockRejectedValueOnce(new Error("provider down"));
  else if (outcome === "unmapped")
    await db.deleteFrom("model_purpose_mappings").where("purpose", "=", "review").execute();
  else answer(outcome === "request" || outcome === "truncated" ? "allow" : outcome);
  const verdict = await call({
    input,
    permissionProfile: facts.profile,
    permissionCandidate: built.candidate,
    callId: facts.callId,
  });
  const expected = outcome === "allow" ? "allow" : outcome === "deny" ? "deny" : "ask";
  expect(verdict.decision).toBe(expected);
  if (expected === "ask") {
    // every ask keeps the escalation statement first (the person's card and an IM card show
    // only the reason), whoever asked: the rules, the review model, or a failed answer
    expect(verdict.reason).toMatch(
      /^Run this command outside the sandbox for this call only.*Justification \(from the agent\): "The dev server/,
    );
    // the review model's own reason follows the statement, never replaces it
    if (outcome === "ask") expect(verdict.reason).toMatch(/Review: Scripted decision\.$/);
  }
  if (outcome === "request" || outcome === "unmapped") {
    expect(reviewChats()).toEqual([]);
    return;
  }
  if (outcome === "failing") return;
  const request = reviewRequest(),
    tag = systemTag(request);
  expect(userText(request)).toContain("Sandbox escalation requested");
  expect(userText(request)).toContain(`<${tag}>\n${input.justification}\n</${tag}>`);
});

it("an escalation of a sensitive command asks once, stating both the crossing and the consent", async () => {
  const input = {
    command: "sudo npm install -g pnpm",
    sandbox: "escalated",
    justification: "Install pnpm globally as the person asked.",
  };
  const built = buildPermissionCandidate(
    { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
    {
      orgId,
      rootConversationId: conv,
      conversationId: conv,
      deviceId: "review-fixture",
      accountId: ownerId,
      runId,
      callId: "escalation-sudo",
      profile: "request-approval",
      profileRevision: 0,
      scopeRevision: "scope",
      authorityRevision: "authority",
      baseReadDirectories: [WORKSPACE],
      baseWriteDirectories: [WORKSPACE],
      baseHosts: [],
      workingRoot: WORKSPACE,
      fullAccessCeiling: true,
      broadProjectReach: true,
      fullConsent: false,
      unattended: false,
      availability: { state: "supported" },
      escalationRefusal: null,
      policy: {
        mode: "auto",
        allowedMode: "auto",
        localAllowedDomains: [],
        network: { kind: "open-public", hosts: [] },
      },
    },
  );
  if (built.kind !== "proposal") throw new Error(JSON.stringify(built));
  const verdict = await call({
    input,
    permissionProfile: "request-approval",
    permissionCandidate: built.candidate,
    callId: "escalation-sudo",
  });
  expect(verdict).toMatchObject({ decision: "ask", rule: "ask.sudo" });
  expect(verdict.reason).toMatch(/outside the sandbox for this call only/);
  expect(verdict.reason).toMatch(/also a sensitive command/);
});

it("a fixed deny stays a deny for an escalated command", async () => {
  const input = { command: "rm -rf /", sandbox: "escalated", justification: "Clean up." };
  const verdict = await call({
    input,
    permissionProfile: "approve-for-me",
    callId: "escalation-deny",
  });
  expect(verdict.decision).toBe("deny");
  expect(reviewChats()).toEqual([]);
});

/** The facts of an attended escalation under `profile` (the candidate builder's input). */
const escalationFacts = (
  callId: string,
  profile: "approve-for-me" | "request-approval" = "approve-for-me",
): PermissionReviewSnapshot => ({
  orgId,
  rootConversationId: conv,
  conversationId: conv,
  deviceId: "review-fixture",
  accountId: ownerId,
  runId,
  callId,
  profile,
  profileRevision: 0,
  scopeRevision: "scope",
  authorityRevision: "authority",
  baseReadDirectories: [WORKSPACE],
  baseWriteDirectories: [WORKSPACE],
  baseHosts: [],
  workingRoot: WORKSPACE,
  fullAccessCeiling: true,
  broadProjectReach: true,
  fullConsent: false,
  unattended: false,
  availability: { state: "supported" },
  escalationRefusal: null,
  policy: {
    mode: "auto",
    allowedMode: "auto",
    localAllowedDomains: [],
    network: { kind: "open-public", hosts: [] },
  },
});

it("a review that fails outright still asks with the escalation statement", async () => {
  const input = { command: "npm run dev", sandbox: "escalated", justification: "Bind port 3000." };
  const built = buildPermissionCandidate(
    { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
    escalationFacts("escalation-crash"),
  );
  if (built.kind !== "proposal") throw new Error(JSON.stringify(built));
  const crash = vi
    .spyOn(review as unknown as { decidePermission: () => Promise<never> }, "decidePermission")
    .mockRejectedValueOnce(new Error("boom"));
  const verdict = await call({
    input,
    permissionProfile: "approve-for-me",
    permissionCandidate: built.candidate,
    callId: "escalation-crash",
  });
  crash.mockRestore();
  expect(verdict.decision).toBe("ask");
  expect(verdict.reason).toMatch(
    /^Run this command outside the sandbox for this call only.*"Bind port 3000\."/,
  );
  expect(verdict.reason).toContain(REVIEW_ASK_REASON);
});

it("a background escalation says so to the person and to the review model", async () => {
  const input = {
    command: "npm run dev",
    sandbox: "escalated",
    justification: "Serve the app.",
    run_in_background: true,
  };
  const built = buildPermissionCandidate(
    { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
    escalationFacts("escalation-background"),
    [],
    { backgroundMaxSeconds: 7200 },
  );
  if (built.kind !== "proposal") throw new Error(JSON.stringify(built));
  expect(built.candidate.escalation).toEqual({
    justification: "Serve the app.",
    background: true,
    maxSeconds: 7200,
  });
  answer("ask");
  const verdict = await call({
    input,
    permissionProfile: "approve-for-me",
    permissionCandidate: built.candidate,
    callId: "escalation-background",
  });
  expect(verdict.reason).toMatch(
    /starts a background process that keeps running outside the sandbox until it exits or is stopped, at most 120 minutes/,
  );
  expect(userText(reviewRequest())).toMatch(
    /starts a background process that keeps running outside the sandbox.*at most 120 minutes/,
  );
});

it("the justification is quoted as the agent's and cleaned of line breaks and bidi controls", () => {
  expect(escalationAskReason({ justification: "  Bind\nport\u202E 3000\u2066.\r\n " })).toBe(
    'Run this command outside the sandbox for this call only (full access to the device\'s files and network). Justification (from the agent): "Bind port 3000."',
  );
});

describe("the justification length counts code points, as the tool schema does", () => {
  const build = (justification: string) => {
    const input = { command: "npm run dev", sandbox: "escalated", justification };
    return buildPermissionCandidate(
      { toolKey: "Bash", specHash: "bash-spec", rawInput: input, validatedInput: input },
      escalationFacts("escalation-length"),
    );
  };
  it("500 emoji (1000 UTF-16 units) is within the limit", () => {
    expect(build("\u{1F600}".repeat(500)).kind).toBe("proposal");
  });
  it("501 code points get their own actionable text", () => {
    const r = build("a".repeat(501));
    expect(r).toMatchObject({
      kind: "unsupported",
      message: ESCALATION_JUSTIFICATION_TOO_LONG_TEXT,
    });
    expect(ESCALATION_JUSTIFICATION_TOO_LONG_TEXT).toMatch(/500 characters.*Retry/);
  });
  it("the log schema accepts what the candidate accepts", () => {
    expect(
      PermissionEscalationSchema.safeParse({ justification: "\u{1F600}".repeat(500) }).success,
    ).toBe(true);
    expect(PermissionEscalationSchema.safeParse({ justification: "a".repeat(501) }).success).toBe(
      false,
    );
  });
});
