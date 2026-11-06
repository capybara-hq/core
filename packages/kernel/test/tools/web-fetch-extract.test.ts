import { fileURLToPath } from "node:url";
import {
  ModelError,
  type ModelRequest,
  type ToolResult,
  type UsageReportPayload,
} from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
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
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { usageTokens } from "../../src/evals/budget.js";
import type { EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { ModelPurposesService, PurposeAttemptError } from "../../src/models/purposes.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import {
  WEB_FETCH_DENIED_TEXT,
  WEB_FETCH_EXTRACT_FAILED_TEXT,
  WEB_FETCH_SYSTEM_PROMPT,
  webFetchSystemPrompt,
} from "../../src/tools/builtins/web/extract.js";
import { WEB_FETCH_SPEC } from "../../src/tools/builtins/web/fetch.js";
import { specHash } from "../../src/tools/registry.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
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
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { finishedDeliveries } from "../helpers/subagents.js";

/**
 * Web tools spec §5, §8: the `WebFetch` extraction call on the `web_fetch` model purpose, on a real
 * kernel. `model-script` scripts the agent's steps and answers the extraction call (rule on the
 * extraction system prompt), `fake-web` serves the page, `hooks-probe` observes and denies.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const HOOKS_PROBE = fixture("hooks-probe");

const CHILD = "You are a sub-agent";
const ANSWER = "EXTRACTED-ANSWER: the page says hello";
/** The extraction call's scripted usage (distinct from the steps' 10 / 5). */
const EXTRACT_USAGE = { inputTokens: 300, outputTokens: 20 };
const SCRIPT_1 = { provider: "model-script", model: "script-1" };
const SCRIPT_2 = { provider: "model-script", model: "script-2" };

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
const capture = captureProviderRequests();
let purposes: ModelPurposesService;
let realChat: ModelPurposesService["chat"];
let chatSpy: MockInstance<ModelPurposesService["chat"]>;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_SCRIPT, HOOKS_PROBE, fakeExtensionEntry("fake-web")],
      },
    ),
  );
  purposes = k.app.get(ModelPurposesService);
  realChat = purposes.chat.bind(purposes);
  chatSpy = vi.spyOn(purposes, "chat");
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.tool_grants, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts, capybara.model_purpose_mappings",
  );
  capture.reset();
  scriptRules([]);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  for (const plugin of ["fake-web", "hooks-probe"]) {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true, ...(plugin === "fake-web" && { config: { token: "tok" } }) },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Reader",
        instructions: "Read pages.",
        model: SCRIPT_1,
        tools: ["WebFetch", "Agent"].map((name) => ({ kind: "builtin", name })),
        subagents: {
          inline: [
            {
              name: "fetcher",
              description: "Fetches pages.",
              instructions: "You fetch pages.",
              tools: ["WebFetch"],
              model: "fast",
            },
          ],
        },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  // an "always" grant: WebFetch asks by default (the sub-agent runs as the same agent)
  await db
    .insertInto("tool_grants")
    .values({
      org_id: orgId,
      account_id: ownerId,
      agent_id: agentId,
      tool_key: "WebFetch",
      spec_hash: specHash(WEB_FETCH_SPEC),
      connector_id: null,
    })
    .execute();
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

const probeConfig = async (cfg: Record<string, unknown>) => {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
};

/** A URL no other test fetched (the page cache lives in Redis across tests). */
const unique = (script = "page") =>
  `https://example.com/${script}?n=${Math.random().toString(36).slice(2)}`;

/** The rules: the extraction call first (its system is the extraction prompt), then the steps. */
function rules(url: string): ScriptRule[] {
  const fetchCall = { name: "WebFetch", input: { url, prompt: "What does it say?" } };
  return [
    {
      when: { systemIncludes: WEB_FETCH_SYSTEM_PROMPT },
      reply: { text: ANSWER, usage: EXTRACT_USAGE },
    },
    // the sub-agent
    {
      when: { systemIncludes: CHILD, lastUserIncludes: "child-fetch", assistantTurns: 0 },
      reply: { toolCalls: [fetchCall] },
    },
    { when: { systemIncludes: CHILD }, reply: { text: "child done" } },
    // the parent
    {
      when: { lastUserIncludes: "SCENARIO child", assistantTurns: 0 },
      reply: {
        toolCalls: [
          {
            name: "Agent",
            input: { description: "Fetch", prompt: "child-fetch: go", subagent_type: "fetcher" },
          },
        ],
      },
    },
    // the Agent result is immediate (agent map spec §4.1): the parent goes on at once
    {
      when: { lastUserIncludes: "SCENARIO child", lastToolResultIncludes: "in the background" },
      reply: { text: "parent done" },
    },
    {
      when: { lastUserIncludes: "SCENARIO fetch", assistantTurns: 0 },
      reply: { toolCalls: [fetchCall] },
    },
    { when: { lastToolResultIncludes: "URL: " }, reply: { text: "fetch done" } },
  ];
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const webFetchUsage = (events: ConversationEvent[]) =>
  ofType(events, "usage").filter((e) => e.payload.purpose === "web_fetch");

/** Runs one conversation of the Reader agent on `text`; returns its events once the run ends. */
async function converse(
  text: string,
  url: string,
): Promise<{ conv: string; events: ConversationEvent[] }> {
  scriptRules(rules(url));
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 60_000);
  return { conv, events: await eventsOf(db, conv) };
}

const fetchResult = (events: ConversationEvent[]) =>
  ofType(events, "tool_result").find((e) => e.payload.toolKey === "WebFetch");

const isExtraction = (r: ModelRequest) =>
  r.system.some((s) => s.text.startsWith(WEB_FETCH_SYSTEM_PROMPT));
/** The extraction request's page tag, read from its system prompt. */
const pageTag = (r: ModelRequest): string =>
  /<(page-[0-9a-f]+)>/.exec(r.system[0]?.text ?? "")?.[1] ?? "";
const userText = (r: ModelRequest): string => {
  const c = r.messages[0]?.content;
  const b = Array.isArray(c) ? c[0] : undefined;
  return b?.type === "text" ? b.text : "";
};
const fakeWebCalls = () =>
  (
    (globalThis as { __fakeWeb?: { calls: { op: string; input: string }[] } }).__fakeWeb?.calls ??
    []
  ).filter((c) => c.op === "fetch").length;
const webFetchChats = () => chatSpy.mock.calls.filter((c) => c[1] === "web_fetch").length;

async function probeLast(purpose: string, mount: string): Promise<Record<string, unknown> | null> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=${purpose}`,
  });
  const last = (res.json() as { last: Record<string, Record<string, unknown>> }).last;
  return last[mount] ?? null;
}

describe("WebFetch extraction", { timeout: 120_000 }, () => {
  it("mapped purpose: its model answers; the result is the answer, never the page", async () => {
    await mapPurpose("web_fetch", SCRIPT_2);
    const url = unique();
    const { conv, events } = await converse("SCENARIO fetch", url);

    const result = fetchResult(events);
    expect(result?.payload).toMatchObject({ isError: false, content: `URL: ${url}\n\n${ANSWER}` });
    expect(ofType(events, "assistant_message").at(-1)?.payload.content).toEqual([
      { type: "text", text: "fetch done" },
    ]);

    // the extraction request: fixed system prompt, one user message, no tools, the answer cap
    expect(capture.webFetches).toHaveLength(1);
    const req = capture.webFetches[0] as ModelRequest;
    expect(req.model).toBe("script-2");
    // the page sits between a random per-call tag the system prompt names: page text cannot
    // close it or fake the prompt after it
    const tag = pageTag(req);
    expect(tag).toMatch(/^page-[0-9a-f]{16}$/);
    expect(req.system).toEqual([{ text: webFetchSystemPrompt(tag), cache: false }]);
    expect(webFetchSystemPrompt(tag)).toBe(
      `${WEB_FETCH_SYSTEM_PROMPT} The page is everything between <${tag}> and </${tag}> in the ` +
        `user message; the request to answer is the Prompt after </${tag}>.`,
    );
    expect(req.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `URL: ${url}\n<${tag}>\nTitle: fake-web page\n\n` +
              `# Page from fake-web\n\nFetched ${url} with fake-web.\n</${tag}>\n\n` +
              "Prompt: What does it say?",
          },
        ],
      },
    ]);
    expect(req.tools).toEqual([]);
    expect(req.toolChoice).toBe("none");
    const cap = k.app.get(KernelConfigService).get().web.fetch.maxAnswerTokens;
    expect(req.maxOutputTokens).toBe(Math.min(cap, 4096));

    // the raw page never reaches the agent's model
    const steps = capture.sent.filter((r) => !isExtraction(r));
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const r of steps) expect(JSON.stringify(r)).not.toContain("Page from fake-web");
    expect(JSON.stringify(steps.at(-1))).toContain(ANSWER);

    // its usage: purpose web_fetch, the call id, the run, the purpose's model
    const started = ofType(events, "tool_call_started").find(
      (e) => e.payload.toolKey === "WebFetch",
    );
    const [usage, ...more] = webFetchUsage(events);
    expect(more).toEqual([]);
    expect(usage?.runId).toBe(started?.runId);
    expect(usage?.payload).toMatchObject({
      purpose: "web_fetch",
      callId: started?.payload.callId,
      step: started?.payload.step,
      provider: "model-script",
      model: "script-2",
      inputTokens: 300,
      outputTokens: 20,
    });

    // hooks: model.request / model.response with purpose web_fetch; usage.report too
    const request = await waitFor(() => probeLast("web_fetch", "model.request"), 30_000);
    expect(request).toMatchObject({
      purpose: "web_fetch",
      conversationId: conv,
      runId: started?.runId,
      step: started?.payload.step,
      provider: "model-script",
      model: "script-2",
    });
    const response = await waitFor(() => probeLast("web_fetch", "model.response"), 30_000);
    expect(response).toMatchObject({ purpose: "web_fetch", outcome: "ok", conversationId: conv });
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
    expect(delivered).toMatchObject({ purpose: "web_fetch", conversationId: conv });
  });

  it("a page over the purpose model's context is cut to fit, ending with [truncated]", async () => {
    // model-script declares a 64 000-token context; 300 000 ASCII characters are ~75 000 tokens,
    // under web.fetch.maxPageChars, so only the context cap can cut it
    await mapPurpose("web_fetch", SCRIPT_2);
    const url = unique("big:300000");
    const { events } = await converse("SCENARIO fetch", url);
    expect(fetchResult(events)?.payload).toMatchObject({
      isError: false,
      content: `URL: ${url}\n\n${ANSWER}`,
    });
    expect(capture.webFetches).toHaveLength(1);
    const req = capture.webFetches[0] as ModelRequest;
    const tag = pageTag(req);
    const text = userText(req);
    expect(text.endsWith(`x\n[truncated]\n</${tag}>\n\nPrompt: What does it say?`)).toBe(true);
    const pageChars = /\n\n(x+)\n\[truncated\]\n/.exec(text)?.[1]?.length ?? 0;
    expect(pageChars).toBeLessThan(300_000);
    // not cut needlessly: most of the window is still the page
    expect(pageChars).toBeGreaterThan(150_000);
    expect(estimateTokens(req.messages, req.system, req.tools) + req.maxOutputTokens).toBeLessThan(
      64_000,
    );
  });

  it("each extraction call gets its own page tag", async () => {
    await mapPurpose("web_fetch", SCRIPT_2);
    await converse("SCENARIO fetch", unique());
    await converse("SCENARIO fetch", unique());
    const tags = capture.webFetches.map(pageTag);
    expect(tags).toHaveLength(2);
    expect(tags[0]).not.toBe(tags[1]);
  });

  it("unmapped purpose: the calling conversation's model (from its run_started)", async () => {
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: {
        definition: {
          name: "Reader",
          instructions: "Read pages.",
          model: SCRIPT_2,
          tools: [{ kind: "builtin", name: "WebFetch" }],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const url = unique();
    const { events } = await converse("SCENARIO fetch", url);
    expect(ofType(events, "run_started")[0]?.payload.model).toEqual(SCRIPT_2);
    expect(fetchResult(events)?.payload.content).toBe(`URL: ${url}\n\n${ANSWER}`);
    expect(webFetchUsage(events).map((e) => e.payload.model)).toEqual(["script-2"]);
    expect(capture.webFetches.map((r) => r.model)).toEqual(["script-2"]);
  });

  it("a sub-agent's call: the sub-agent's model, its tokens count on the parent run", async () => {
    // the fetcher's tier runs on script-2; the parent on script-1; web_fetch is unmapped
    await mapPurpose("subagent_fast", SCRIPT_2);
    const url = unique();
    const { conv } = await converse("SCENARIO child", url);
    // the sub-agent runs in the background: its finish delivery says it is done
    await finishedDeliveries(db, conv, 1);
    const events = await eventsOf(db, conv);
    const parentRun = ofType(events, "run_started")[0]?.runId as string;
    expect(
      ofType(events, "assistant_message")
        .filter((e) => e.runId === parentRun)
        .at(-1)?.payload.content,
    ).toEqual([{ type: "text", text: "parent done" }]);
    const child = await db
      .selectFrom("conversations")
      .select("id")
      .where("parent_conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const cev = await eventsOf(db, child.id);
    expect(ofType(cev, "run_started")[0]?.payload.model).toEqual(SCRIPT_2);
    expect(fetchResult(cev)?.payload.content).toBe(`URL: ${url}\n\n${ANSWER}`);
    const [usage] = webFetchUsage(cev);
    expect(usage?.payload).toMatchObject({ model: "script-2", inputTokens: 300 });
    expect(webFetchUsage(events)).toEqual([]);

    // the parent run's sub-agent tokens: every usage event of the child, the extraction included
    const run = await db
      .selectFrom("runs")
      .select("subagent_tokens_used")
      .where("id", "=", parentRun)
      .executeTakeFirstOrThrow();
    const childTokens = ofType(cev, "usage").reduce((n, e) => n + usageTokens(e.payload), 0);
    expect(Number(run.subagent_tokens_used)).toBe(childTokens);
    expect(Number(run.subagent_tokens_used)).toBeGreaterThanOrEqual(320);
  });

  it("a model.request policy denial: the policy error, hook.denied audit and hook_denied", async () => {
    await mapPurpose("web_fetch", SCRIPT_2);
    await probeConfig({ denyModelPurposes: ["web_fetch"] });
    const url = unique();
    const { conv, events } = await converse("SCENARIO fetch", url);
    const result = fetchResult(events);
    expect(result?.payload).toMatchObject({ isError: true, content: WEB_FETCH_DENIED_TEXT });
    expect(capture.webFetches).toEqual([]);
    expect(webFetchUsage(events)).toEqual([]);
    const denied = ofType(events, "hook_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      mount: "model.request",
      plugin: "hooks-probe",
      reason: "nope",
      cause: "deny",
      callId: result?.payload.callId,
    });
    const rows = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "hook.denied")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(conv);
    expect(rows[0]?.detail).toMatchObject({ purpose: "web_fetch", mount: "model.request" });
  });

  it("a model error: the extraction error, never the page; the sent call's usage is logged", async () => {
    await mapPurpose("web_fetch", SCRIPT_2);
    chatSpy.mockImplementation(async (...args) => {
      if (args[1] !== "web_fetch") return realChat(...args);
      throw new PurposeAttemptError(
        new ModelError("server", "boom"),
        42,
        "model-script",
        "script-2",
      );
    });
    const url = unique();
    const { events } = await converse("SCENARIO fetch", url);
    const result = fetchResult(events);
    expect(result?.payload).toMatchObject({
      isError: true,
      content: WEB_FETCH_EXTRACT_FAILED_TEXT,
    });
    expect(result?.payload.content).not.toContain("Page from fake-web");
    expect(webFetchUsage(events).map((e) => e.payload)).toEqual([
      expect.objectContaining({ inputTokens: 42, outputTokens: 0, purpose: "web_fetch" }),
    ]);
  });

  it("a full-run replay calls neither the provider nor the web_fetch model", async () => {
    await mapPurpose("web_fetch", SCRIPT_2);
    const url = unique();
    const { conv, events } = await converse("SCENARIO fetch", url);
    expect(fetchResult(events)?.payload.isError).toBe(false);
    const runId = ofType(events, "run_started")[0]?.runId as string;
    const fetchesBefore = fakeWebCalls();
    const chatsBefore = webFetchChats();
    expect(chatsBefore).toBeGreaterThanOrEqual(1);

    const sets = `/api/v1/orgs/${orgId}/eval-sets`;
    const set = await owner({ method: "POST", url: sets, payload: { agentId, name: "Replay" } });
    expect(set.statusCode, set.body).toBe(201);
    const setId = (set.json() as { set: EvalSetView }).set.id;
    const added = await owner({
      method: "POST",
      url: `${sets}/${setId}/cases`,
      payload: { conversationId: conv, runId },
    });
    expect(added.statusCode, added.body).toBe(201);
    const started = await owner({
      method: "POST",
      url: `${sets}/${setId}/runs`,
      payload: { mode: "run", candidate: {}, judge: false },
    });
    expect(started.statusCode, started.body).toBe(201);
    const evalRunId = (started.json() as { run: EvalRunView }).run.id;
    const done = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/api/v1/orgs/${orgId}/eval-runs/${evalRunId}`,
        });
        const r = (res.json() as { run: EvalRunView }).run;
        return ["queued", "running"].includes(r.status) ? null : r;
      },
      60_000,
      "eval run finished",
      100,
    );
    expect(done.status).toBe("completed");
    expect(fakeWebCalls()).toBe(fetchesBefore);
    expect(webFetchChats()).toBe(chatsBefore);
  });

  it("the production BuiltinTools WebFetch returns the extraction answer, not the page", async () => {
    await mapPurpose("web_fetch", SCRIPT_2);
    scriptRules(rules(""));
    const conv = await createConv(owner, orgId, agentId);
    const tool = k.app
      .get(BuiltinTools)
      .list()
      .find((t) => t.spec.name === "WebFetch");
    // a same-host redirect: the header names the final URL too
    const url = unique("redirect:https://example.com/moved");
    const r = (await tool?.run(
      { url, prompt: "What does it say?" },
      {
        orgId,
        accountId: ownerId,
        agentId,
        conversationId: conv,
        callId: "direct-call",
        signal: new AbortController().signal,
      },
    )) as ToolResult;
    const final = url.slice("https://example.com/redirect:".length);
    expect(r.content).toEqual([
      { type: "text", text: `URL: ${url}\nFinal URL: ${final}\n\n${ANSWER}` },
    ]);
    expect(JSON.stringify(r)).not.toContain("Moved to");
    expect(webFetchUsage(await eventsOf(db, conv)).map((e) => e.payload.callId)).toEqual([
      "direct-call",
    ]);
  });
});
