import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationTopic } from "../../src/conversations/event-log.js";
import { PromptSuggestionStore } from "../../src/conversations/prompt-suggestion-store.js";
import {
  PROMPT_SUGGESTION_QUEUE,
  PromptSuggestionQueue,
  promptSuggestionJobId,
} from "../../src/conversations/prompt-suggestions.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../../src/runtime/run-jobs.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff, onlyBuiltins } from "../helpers/disabled-tools.js";
import { asUser, type CookieJar, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  gate,
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
import { openSse, type SseClient, type SseMessage } from "../helpers/sse.js";
import { childRunsOf } from "../helpers/subagents.js";

/**
 * Prompt suggestions end to end (spec 2026-11-19 §2, §4, §8): a message over HTTP, the run, the
 * worker-role job and the conversation stream, on one kernel running every role. The job's own
 * paths (hooks, timeouts, billing details) are in prompt-suggestion-job.test.ts.
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
/** The fake model calls the connector's echo tool, which asks for approval first. */
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let owner: Req;
let jar: CookieJar;
let orgId: string;
let agentId: string;
let adds: { mock: { calls: unknown[][] } };
/** Every `maybeEnqueue` call of the test, with its promise (so a test can wait for it). */
let enqueues: { conversationId: string; runId: string; done: Promise<void> }[] = [];
const capture = captureProviderRequests();
const streams: SseClient[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  capture.install();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MEM_CONNECTOR],
        extensionConfig: { "model-fake": { models: [{ id: "fake-1" }] } },
      },
    ),
  );
});
afterAll(async () => {
  capture.restore();
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  await sql`DELETE FROM capybara.deployment_settings WHERE key = 'promptSuggestions'`.execute(raw);
  capture.reset();
  enqueues = [];
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  jar = cookieJar();
  owner = asUser(k.http, jar);
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent(owner, orgId);
  adds = vi.spyOn(suggestionQueue(), "add");
  const q = k.app.get(PromptSuggestionQueue);
  const original = q.maybeEnqueue.bind(q);
  vi.spyOn(q, "maybeEnqueue").mockImplementation((conversationId, runId, kind) => {
    const done = original(conversationId, runId, kind);
    enqueues.push({ conversationId, runId, done });
    return done;
  });
});
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  vi.restoreAllMocks();
  // no job of this test outlives it (the next test counts requests from zero)
  await idle();
});

const suggestionQueue = () => k.app.get<Queue>(getQueueToken(PROMPT_SUGGESTION_QUEUE));

/**
 * Waits until no run job is queued or running, every `maybeEnqueue` the runs made has returned and
 * the suggestion queue is empty (jobs are removed when done): after it, what the tests assert was
 * not done is final.
 */
async function idle(): Promise<void> {
  const queues = [RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME, PROMPT_SUGGESTION_QUEUE].map((n) =>
    k.app.get<Queue>(getQueueToken(n)),
  );
  await waitFor(
    async () => {
      for (const q of queues) {
        const c = await q.getJobCounts("active", "waiting", "delayed", "prioritized");
        if (Object.values(c).some((n) => n > 0)) return false;
      }
      return true;
    },
    20_000,
    "queues idle",
  );
  await Promise.all(enqueues.map((e) => e.done));
  // an enqueue that came after the first look: wait for its job as well
  await waitFor(
    async () => {
      const c = await queues[2]?.getJobCounts("active", "waiting", "delayed", "prioritized");
      return Object.values(c ?? {}).every((n) => n === 0);
    },
    20_000,
    "suggestion queue empty",
  );
}

const suggestionUsage = async (id: string) =>
  (await eventsOf(db, id)).filter(
    (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "suggestion",
  );

const jobIds = () => adds.mock.calls.map((c) => (c[2] as { jobId?: string } | undefined)?.jobId);

const streamUrl = (convId: string) =>
  `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${convId}/stream`;

async function open(convId: string): Promise<SseClient> {
  const s = await openSse(streamUrl(convId), { cookie: jar.header() as string });
  streams.push(s);
  expect(s.status).toBe(200);
  return s;
}

type Frame = { runId: string; afterSeq: number; text: string };
const suggestionsIn = (msgs: SseMessage[]): Frame[] =>
  msgs.filter((m) => m.event === "suggestion").map((m) => JSON.parse(m.data as string) as Frame);

/** Resolves once the stream has processed everything queued before a `changed` hint. */
async function drained(convId: string, s: SseClient): Promise<void> {
  const before = s.messages.filter((m) => m.event === "changed").length;
  await redis.publish(
    `cap:kernel:${conversationTopic(convId)}`,
    JSON.stringify({ kind: "changed", what: "title" }),
  );
  await s.until(
    (m) => m.filter((x) => x.event === "changed").length > before,
    10_000,
    "changed frame",
  );
}

/** One completed web run; returns its conversation, run and `run_finished` seq. */
async function completedRun(text: string): Promise<{ id: string; runId: string; seq: number }> {
  const id = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, id, text);
  const [end] = await waitForTerminal(db, id);
  expect(end?.type).toBe("run_finished");
  return { id, runId: end?.runId as string, seq: end?.seq as number };
}

/** What a conversation with no suggestion looks like once everything settled. */
async function expectNoSuggestion(id: string): Promise<void> {
  await idle();
  expect(capture.suggestions).toEqual([]);
  expect(await suggestionUsage(id)).toEqual([]);
  expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
  const s = await open(id);
  await drained(id, s);
  expect(suggestionsIn(s.messages)).toEqual([]);
}

describe("prompt suggestions end to end", () => {
  it("a completed web run sends one suggestion on the stream; a later open gets it too", async () => {
    const id = await createConv(owner, orgId, agentId);
    const live = await open(id);
    await postMessage(owner, orgId, id, "suggest:Run the tests");
    const [end] = await waitForTerminal(db, id);
    await live.until((m) => m.some((x) => x.event === "suggestion"), 15_000, "suggestion frame");
    const runId = end?.runId as string;
    expect(suggestionsIn(live.messages)).toEqual([
      { runId, afterSeq: end?.seq, text: "Run the tests" },
    ]);

    const late = await open(id);
    await late.until((m) => m.some((x) => x.event === "suggestion"), 10_000, "suggestion frame");
    expect(suggestionsIn(late.messages)).toEqual(suggestionsIn(live.messages));

    await idle();
    const usage = await suggestionUsage(id);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.runId).toBeNull();
    expect(usage[0]?.payload).toMatchObject({ purpose: "suggestion", step: 0 });
    expect((await eventsOf(db, id)).some((e) => e.type === "run_failed")).toBe(false);

    // the side request extends the run's last step request: only the cap, the purpose and the two
    // appended messages (the final reply and the instruction) differ
    expect(capture.suggestions).toHaveLength(1);
    const side = capture.suggestions[0];
    const last = capture.sent.at(-1);
    if (side === undefined || last === undefined) throw new Error("no captured requests");
    const n = last.messages.length;
    expect(side.messages).toHaveLength(n + 2);
    expect(side.messages.slice(0, n)).toEqual(last.messages);
    expect(side.messages[n]?.role).toBe("assistant");
    expect(side.messages[n + 1]?.role).toBe("user");
    expect(side.system).toEqual(last.system);
    expect(side.tools).toEqual(last.tools);
    expect(side.toolChoice).toEqual(last.toolChoice);
    expect(side.params).toEqual(last.params);
    expect(side.purpose).toBe("suggestion");
    expect(side.maxOutputTokens).toBe(Math.min(last.maxOutputTokens, 2048));
  });

  it("a channel conversation gets no suggestion", async () => {
    const id = await createConv(owner, orgId, agentId);
    await sql`UPDATE capybara.conversations SET source = 'channel_dm' WHERE id = ${id}`.execute(
      raw,
    );
    await postMessage(owner, orgId, id, "suggest:From a chat app");
    const [end] = await waitForTerminal(db, id);
    expect(end?.type).toBe("run_finished");
    await expectNoSuggestion(id);
    expect(jobIds()).not.toContain(promptSuggestionJobId(end?.runId as string));
  });

  it("a sub-agent conversation gets no suggestion", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Lead",
          instructions: "Lead the work.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: builtinsOff("Agent"),
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const lead = (res.json() as { agent: { id: string } }).agent.id;
    const parent = await createConv(owner, orgId, lead);
    await postMessage(
      owner,
      orgId,
      parent,
      'tool:Agent:{"description":"Look around","prompt":"suggest:Child text"}',
    );
    const child = await waitFor(
      async () => (await childRunsOf(db, parent))[0],
      20_000,
      "the dispatched child",
    );
    await waitForTerminal(db, child.conversationId, 1, 20_000);
    await idle();
    expect(jobIds()).not.toContain(promptSuggestionJobId(child.runId));
    expect(enqueues.some((e) => e.runId === child.runId)).toBe(true);
    expect(await suggestionUsage(child.conversationId)).toEqual([]);
    expect(await k.app.get(PromptSuggestionStore).get(child.conversationId)).toBeNull();
  });

  it("a scheduled run gets no suggestion", async () => {
    const task = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/schedules`,
      payload: {
        agentId,
        name: "Digest",
        prompt: "suggest:Unattended",
        trigger: { kind: "cron", expr: "0 9 * * *" },
        mode: "new",
      },
    });
    expect(task.statusCode, task.body).toBe(201);
    const taskId = (task.json() as { task: { id: string } }).task.id;
    const run = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/schedules/${taskId}/run`,
      payload: {},
    });
    expect(run.statusCode, run.body).toBe(202);
    const row = await waitFor(
      async () => {
        const r = await owner({
          method: "GET",
          url: `/api/v1/orgs/${orgId}/schedules/${taskId}/runs?limit=5`,
        });
        const items = (r.json() as { items: { conversationId: string | null }[] }).items;
        return items.find((i) => i.conversationId !== null);
      },
      20_000,
      "the task run's conversation",
    );
    const id = row.conversationId as string;
    const [end] = await waitForTerminal(db, id, 1, 20_000);
    expect(end?.type).toBe("run_finished");
    const started = (await eventsOf(db, id)).find((e) => e.type === "run_started");
    expect(started?.payload).toMatchObject({ trigger: "schedule" });
    await expectNoSuggestion(id);
  });

  it("a failed run gets no suggestion", async () => {
    const id = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, id, "fail:invalid_request");
    const [end] = await waitForTerminal(db, id);
    expect(end?.type).toBe("run_failed");
    await expectNoSuggestion(id);
    expect(jobIds()).toEqual([]);
  });

  it("an aborted run gets no suggestion", async () => {
    const id = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, id, "stall");
    await waitForEvent(db, id, (e) => e.type === "run_started", 15_000, "run_started");
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${id}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    const [end] = await waitForTerminal(db, id);
    expect(end?.type).toBe("run_aborted");
    await expectNoSuggestion(id);
    expect(jobIds()).toEqual([]);
  });

  it("a run waiting for an approval gets no suggestion", async () => {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
    const ag = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Asker",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "echo" }]),
          toolPolicies: { "plugin__mem-connector__echo": "ask" },
        },
        visibility: "org",
      },
    });
    expect(ag.statusCode, ag.body).toBe(201);
    const askerId = (ag.json() as { agent: { id: string } }).agent.id;
    const id = await createConv(owner, orgId, askerId);
    await postMessage(owner, orgId, id, ECHO);
    await waitFor(
      async () => (await runsOf(db, id)).some((r) => r.status === "waiting"),
      20_000,
      "run waiting",
    );
    await expectNoSuggestion(id);
    expect(jobIds()).toEqual([]);
    expect((await eventsOf(db, id)).some((e) => e.type === "run_finished")).toBe(false);
  });

  it("the org switch off gets no suggestion", async () => {
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { promptSuggestions: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { id } = await completedRun("suggest:Not now");
    await expectNoSuggestion(id);
  });

  it("the platform switch off gets no suggestion", async () => {
    await accountsFor(db).createLocal({
      login: "admin",
      password: PW,
      displayName: "A",
      superAdmin: true,
    });
    const admin = await session(k, "admin");
    const res = await admin({
      method: "PUT",
      url: "/api/v1/admin/settings",
      payload: { promptSuggestions: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { id } = await completedRun("suggest:Not now");
    await expectNoSuggestion(id);
  });

  it("a message sent while the call is in flight leaves no suggestion for the old run", async () => {
    // hold the first suggestion call (the old run's) at the provider until the test opens the gate
    const hold = gate();
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    let held = false;
    const registry = k.app.get(ProviderRegistry);
    const resolve = registry.resolve.bind(registry);
    vi.spyOn(registry, "resolve").mockImplementation(async (org, ref, opts) => {
      const r = await resolve(org, ref, opts);
      return {
        ...r,
        provider: {
          ...r.provider,
          stream(req, o) {
            if (req.purpose !== "suggestion" || held) return r.provider.stream(req, o);
            held = true;
            return (async function* () {
              entered();
              await hold.promise;
              yield* r.provider.stream(req, o);
            })();
          },
        },
      };
    });

    const id = await createConv(owner, orgId, agentId);
    const live = await open(id);
    await postMessage(owner, orgId, id, "suggest:Old next step");
    const [first] = await waitForTerminal(db, id);
    const oldRun = first?.runId as string;
    await inFlight;

    await postMessage(owner, orgId, id, "echo:more");
    await waitForTerminal(db, id, 2);
    hold.open();
    await idle();

    // the held call was sent and billed, but its text was never stored or sent
    expect((await suggestionUsage(id)).length).toBeGreaterThanOrEqual(1);
    const store = k.app.get(PromptSuggestionStore);
    expect(await store.isFresh(id, { runId: oldRun, afterSeq: first?.seq as number })).toBe(false);
    const stored = await store.get(id);
    if (stored !== null) expect(stored.runId).not.toBe(oldRun);
    await drained(id, live);
    expect(suggestionsIn(live.messages).map((f) => f.runId)).not.toContain(oldRun);
    const late = await open(id);
    await drained(id, late);
    expect(suggestionsIn(late.messages).map((f) => f.runId)).not.toContain(oldRun);
    expect((await eventsOf(db, id)).some((e) => e.type === "run_failed")).toBe(false);
  });

  it.each([
    ["suggest:NONE", "a NONE reply"],
    ['suggest:tool:Read:{"path":"/tmp/x"}', "a reply with a tool call"],
    ["suggest-fail:server", "a failed call"],
  ])("%s: %s sends no suggestion, logs its usage and leaves the run alone", async (text) => {
    const id = await createConv(owner, orgId, agentId);
    const live = await open(id);
    await postMessage(owner, orgId, id, text);
    const [end] = await waitForTerminal(db, id);
    expect(end?.type).toBe("run_finished");
    await idle();
    expect(capture.suggestions).toHaveLength(1);
    expect(await suggestionUsage(id)).toHaveLength(1);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
    await drained(id, live);
    expect(suggestionsIn(live.messages)).toEqual([]);
    expect(live.messages.some((m) => m.event === "error")).toBe(false);
    const types = (await eventsOf(db, id)).map((e) => e.type);
    expect(types).not.toContain("run_failed");
    expect((await runsOf(db, id)).map((r) => r.status)).toEqual(["completed"]);
  });
});
