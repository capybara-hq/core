import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_SUGGESTION_TTL_SECONDS,
  PromptSuggestionStore,
  promptSuggestionKey,
} from "../../src/conversations/prompt-suggestion-store.js";
import {
  PROMPT_SUGGESTION_QUEUE,
  PromptSuggestionQueue,
  promptSuggestionJobId,
} from "../../src/conversations/prompt-suggestions.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { UsageReportJobs } from "../../src/runtime/usage-report-jobs.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Prompt suggestions plan Task 5: the run worker enqueues `suggest-<runId>` on
 * `cap-kernel-suggestions` after a completed run; the worker-role job calls the run's own model
 * with `purpose: "suggestion"`, logs a run-less `usage` event owing its `usage.report`, and stores
 * the cleaned text in the conversation's Redis key. A policy denial is audited and makes no call.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let owner: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE],
        extensionConfig: { "model-fake": { models: [{ id: "fake-1" }] } },
      },
    ),
  );
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  const jar = cookieJar();
  owner = asUser(k.http, jar);
  const res = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent(owner, orgId);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const queue = () => k.app.get<Queue>(getQueueToken(PROMPT_SUGGESTION_QUEUE));

const suggestionUsage = async (id: string) =>
  (await eventsOf(db, id)).filter(
    (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "suggestion",
  );

/** One completed web run; returns its conversation, run and `run_finished` seq. */
async function completedRun(text: string): Promise<{ id: string; runId: string; seq: number }> {
  const id = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, id, text);
  const [end] = await waitForTerminal(db, id);
  expect(end?.type).toBe("run_finished");
  return { id, runId: end?.runId as string, seq: end?.seq as number };
}

/**
 * Waits until the run's suggestion job was added and has finished (jobs are removed on completion),
 * so a test can assert what the job did not do.
 */
async function settled(adds: { mock: { calls: unknown[][] } }, runId: string): Promise<void> {
  const jobId = promptSuggestionJobId(runId);
  await waitFor(
    async () =>
      adds.mock.calls.some((c) => (c[2] as { jobId?: string } | undefined)?.jobId === jobId),
    15_000,
    "suggestion job added",
  );
  await waitFor(async () => (await queue().getJob(jobId)) === undefined, 15_000, "job finished");
}

/** Denies `model.request` for the suggestion purpose only (the run's own steps pass). */
function denySuggestions(): void {
  const hooks = k.app.get(ExtensionHost).hooks;
  const has = hooks.has.bind(hooks);
  const run = hooks.run.bind(hooks);
  vi.spyOn(hooks, "has").mockImplementation((mount) => mount === "model.request" || has(mount));
  vi.spyOn(hooks, "run").mockImplementation(async (mount, payload, signal) => {
    if (mount === "model.request" && (payload as { purpose?: string }).purpose === "suggestion") {
      return { allowed: false, plugin: "dlp", reason: "nope", cause: "deny" };
    }
    return run(mount, payload, signal);
  });
}

describe("prompt suggestion job", () => {
  it("a completed web run enqueues suggest-<runId>, logs owed usage and stores the cleaned text", async () => {
    const adds = vi.spyOn(queue(), "add");
    const owe = vi.spyOn(k.app.get(UsageReportJobs), "oweEvents");
    const { id, runId, seq } = await completedRun("suggest:  Run the tests  ");

    const stored = await waitFor(
      async () => k.app.get(PromptSuggestionStore).get(id),
      15_000,
      "stored suggestion",
    );
    expect(stored).toMatchObject({ runId, afterSeq: seq, text: "Run the tests" });
    expect(adds.mock.calls.map((c) => c[2]?.jobId)).toEqual([promptSuggestionJobId(runId)]);
    expect(promptSuggestionJobId(runId)).toBe(`suggest-${runId}`);
    expect(await redis.ttl(promptSuggestionKey(id))).toBeGreaterThan(
      PROMPT_SUGGESTION_TTL_SECONDS - 60,
    );

    const usage = await waitFor(async () => {
      const u = await suggestionUsage(id);
      return u.length > 0 ? u : undefined;
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.runId).toBeNull();
    expect(usage[0]?.payload).toMatchObject({
      step: 0,
      provider: "model-fake",
      model: "fake-1",
      purpose: "suggestion",
    });
    const owedUsage = owe.mock.calls.filter((c) =>
      c[1].some((e) => e.type === "usage" && e.payload.purpose === "suggestion"),
    );
    expect(owedUsage).toHaveLength(1);
    expect(owedUsage[0]?.[0]).toBe(id);

    // a second enqueue for the same run is a no-op: no job, no second call
    adds.mockClear();
    await k.app.get(PromptSuggestionQueue).maybeEnqueue(id, runId, "completed");
    expect(adds).not.toHaveBeenCalled();
    expect(await suggestionUsage(id)).toHaveLength(1);
  });

  it("max_duration and budget outcomes never enqueue", async () => {
    const { id, runId } = await completedRun("echo:hello");
    // the completed run's own job may be in flight: count only the calls below
    const adds = vi.spyOn(queue(), "add");
    await k.app.get(PromptSuggestionQueue).maybeEnqueue(id, runId, "max_duration");
    await k.app.get(PromptSuggestionQueue).maybeEnqueue(id, runId, "budget");
    expect(adds).not.toHaveBeenCalled();
  });

  it("a denied model.request is audited and makes no call and stores nothing", async () => {
    denySuggestions();
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun("suggest:Never sent");

    const rows = await waitFor(
      async () => {
        const r = await db
          .selectFrom("audit_events")
          .select(["action", "detail"])
          .where("action", "=", "hook.denied")
          .where("target", "=", id)
          .execute();
        return r.length > 0 ? r : undefined;
      },
      15_000,
      "hook.denied audit row",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      purpose: "suggestion",
      plugin: "dlp",
      mount: "model.request",
    });
    await settled(adds, runId);
    expect(await suggestionUsage(id)).toEqual([]);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
    expect((await eventsOf(db, id)).some((e) => e.type === "hook_denied")).toBe(false);
  });

  it("a NONE reply stores nothing; its usage is logged", async () => {
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun("suggest:NONE");
    await settled(adds, runId);
    expect(await suggestionUsage(id)).toHaveLength(1);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
  });

  it("a reply with a tool call is discarded; its usage is logged", async () => {
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun('suggest:tool:Read:{"path":"/tmp/x"}');
    await settled(adds, runId);
    expect(await suggestionUsage(id)).toHaveLength(1);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
  });

  it("a failed sent call logs its estimated input, stores nothing and leaves the run alone", async () => {
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun("suggest-fail:server_error");
    await settled(adds, runId);
    const usage = await suggestionUsage(id);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload).toMatchObject({ outputTokens: 0, purpose: "suggestion" });
    expect(
      (usage[0]?.payload as { inputTokens?: number } | undefined)?.inputTokens,
    ).toBeGreaterThan(0);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
    const events = await eventsOf(db, id);
    expect(events.some((e) => e.type === "run_failed")).toBe(false);
  });

  it("the org switch off makes no call", async () => {
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { promptSuggestions: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun("suggest:Not now");
    await settled(adds, runId);
    expect(await suggestionUsage(id)).toEqual([]);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
  });

  it("a message after the run makes the stored suggestion stale", async () => {
    const { id, runId, seq } = await completedRun("suggest:Next step");
    const store = k.app.get(PromptSuggestionStore);
    await waitFor(async () => store.get(id), 15_000, "stored suggestion");
    expect(await store.isFresh(id, { runId, afterSeq: seq })).toBe(true);
    await postMessage(owner, orgId, id, "echo:more");
    expect(await store.isFresh(id, { runId, afterSeq: seq })).toBe(false);
    await waitForTerminal(db, id, 2);
    expect(await store.isFresh(id, { runId, afterSeq: seq })).toBe(false);
  });
});
