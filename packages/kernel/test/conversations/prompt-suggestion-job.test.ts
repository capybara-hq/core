import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_SUGGESTION_TIMEOUT_MS } from "../../src/conversations/prompt-suggestion-request.js";
import {
  PROMPT_SUGGESTION_TTL_SECONDS,
  PromptSuggestionStore,
  promptSuggestionKey,
} from "../../src/conversations/prompt-suggestion-store.js";
import {
  PROMPT_SUGGESTION_QUEUE,
  PROMPT_SUGGESTION_TIMEOUT,
  PromptSuggestionGenerator,
  PromptSuggestionQueue,
  promptSuggestionJobId,
} from "../../src/conversations/prompt-suggestions.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { HookRegistry } from "../../src/extensions/hooks.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import type { HookRunner } from "../../src/runtime/hook-calls.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { UsageReportJobs } from "../../src/runtime/usage-report-jobs.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
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
let ownerId: string;
/** The suggestion call's time limit the kernel reads at every call (a test shortens it). */
let suggestionTimeoutMs = PROMPT_SUGGESTION_TIMEOUT_MS;
const capture = captureProviderRequests();

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
        extensions: [MODEL_FAKE],
        extensionConfig: { "model-fake": { models: [{ id: "fake-1" }] } },
      },
    ),
    { overrides: [{ provide: PROMPT_SUGGESTION_TIMEOUT, useValue: () => suggestionTimeoutMs }] },
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
  capture.reset();
  suggestionTimeoutMs = PROMPT_SUGGESTION_TIMEOUT_MS;
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
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
    const { id, runId } = await completedRun("suggest-fail:server");
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

  it("a vendor refusal before processing logs no usage", async () => {
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun("suggest-fail:rate_limited");
    await settled(adds, runId);
    expect(await suggestionUsage(id)).toEqual([]);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
  });

  it("fires model.request with the run's scope and model.response; the request extends what the provider received", async () => {
    const fired = observeHooks();
    const { id, runId } = await completedRun("suggest:Ship it");
    await waitFor(
      async () => k.app.get(PromptSuggestionStore).get(id),
      15_000,
      "stored suggestion",
    );
    const started = (await eventsOf(db, id)).find((e) => e.type === "run_started");
    const agentVersion = (started?.payload as { agentVersion?: number } | undefined)?.agentVersion;
    const request = fired.find(
      (f) => f.mount === "model.request" && f.payload.purpose === "suggestion",
    );
    expect(request?.payload).toMatchObject({
      purpose: "suggestion",
      step: 0,
      attempt: 1,
      runId,
      orgId,
      agentId,
      agentVersion,
      accountId: ownerId,
      conversationId: id,
      provider: "model-fake",
      model: "fake-1",
    });
    expect((request?.payload.request as { purpose?: string } | undefined)?.purpose).toBe(
      "suggestion",
    );
    const response = await waitFor(
      async () =>
        fired.find((f) => f.mount === "model.response" && f.payload.purpose === "suggestion"),
      5_000,
      "model.response",
    );
    expect(response.payload).toMatchObject({ outcome: "ok", runId, step: 0, attempt: 1 });
    expect(response.aborted).toBe(false);

    // prefix identity: the run's last step request, then the final reply and the instruction
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

    // a rerun job (a stalled retry, an enqueue after removal) makes no second call
    await k.app
      .get(PromptSuggestionGenerator)
      .run(id, runId, Date.now(), new AbortController().signal);
    expect(capture.suggestions).toHaveLength(1);
    expect(await suggestionUsage(id)).toHaveLength(1);
  });

  it("a policy plugin expected on model.request but not loaded here denies the call (fail closed)", async () => {
    const host = k.app.get(ExtensionHost) as unknown as { hooks: HookRunner };
    const original = host.hooks;
    const lockRedis = new Redis(rd.url);
    host.hooks = new HookRegistry({
      instances: () => [],
      current: () => undefined,
      expectedPolicy: (mount) => (mount === "model.request" ? ["dlp"] : []),
      enabledPlugins: async () => new Set(["dlp"]),
      effectiveConfig: async () => ({ ok: true, config: {}, source: "platform" }),
      locks: new LockService(lockRedis, createLogger("error")),
      config: () => ({ hooks: { timeoutMs: 1000 } }),
      log: console,
    });
    try {
      const adds = vi.spyOn(queue(), "add");
      const { id, runId } = await completedRun("suggest:Blocked");
      await settled(adds, runId);
      const rows = await db
        .selectFrom("audit_events")
        .select(["detail"])
        .where("action", "=", "hook.denied")
        .where("target", "=", id)
        .execute();
      // the title call reads the same registry and is denied too: keep the suggestion's rows
      const suggestionRows = rows.filter(
        (r) => (r.detail as { purpose?: string }).purpose === "suggestion",
      );
      expect(suggestionRows.map((r) => r.detail)).toEqual([
        expect.objectContaining({ purpose: "suggestion", mount: "model.request" }),
      ]);
      expect(capture.suggestions).toEqual([]);
      expect(await suggestionUsage(id)).toEqual([]);
      expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
    } finally {
      host.hooks = original;
      lockRedis.disconnect();
    }
  });

  it("a timed-out call still fires model.response (failed) and logs its estimated usage", async () => {
    const fired = observeHooks();
    suggestionTimeoutMs = 200;
    const registry = k.app.get(ProviderRegistry);
    const resolve = registry.resolve.bind(registry);
    vi.spyOn(registry, "resolve").mockImplementation(async (org, ref, opts) => {
      const r = await resolve(org, ref, opts);
      return {
        ...r,
        provider: {
          ...r.provider,
          stream(req, o) {
            if (req.purpose !== "suggestion") return r.provider.stream(req, o);
            // never answers: the call's time limit ends it
            return (async function* () {
              await new Promise<void>((res) => o?.signal?.addEventListener("abort", () => res()));
              yield* [];
            })();
          },
        },
      };
    });
    const adds = vi.spyOn(queue(), "add");
    const { id, runId } = await completedRun("suggest:Too slow");
    await settled(adds, runId);
    const response = await waitFor(
      async () =>
        fired.find((f) => f.mount === "model.response" && f.payload.purpose === "suggestion"),
      5_000,
      "model.response",
    );
    expect(response.payload).toMatchObject({ outcome: "failed", errorCode: "model.timeout" });
    expect(response.aborted).toBe(false);
    expect(await suggestionUsage(id)).toHaveLength(1);
    expect(await k.app.get(PromptSuggestionStore).get(id)).toBeNull();
  });
});

/** Records every `model.request` / `model.response` the kernel fires (passing them through). */
function observeHooks(): { mount: string; payload: Record<string, unknown>; aborted: boolean }[] {
  // `aborted`: whether the signal was already aborted when the hooks ran (they would be skipped)
  const fired: { mount: string; payload: Record<string, unknown>; aborted: boolean }[] = [];
  const hooks = k.app.get(ExtensionHost).hooks;
  const has = hooks.has.bind(hooks);
  const run = hooks.run.bind(hooks);
  vi.spyOn(hooks, "has").mockImplementation(
    (mount) => mount === "model.request" || mount === "model.response" || has(mount),
  );
  vi.spyOn(hooks, "run").mockImplementation(async (mount, payload, signal) => {
    fired.push({
      mount,
      payload: payload as unknown as Record<string, unknown>,
      aborted: signal?.aborted ?? false,
    });
    return run(mount, payload, signal);
  });
  return fired;
}
