import { fileURLToPath } from "node:url";
import type {
  ModelProvider,
  ModelRequestHookPayload,
  ModelResponseHookPayload,
  ToolPostHookPayload,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import { takeSnapshot } from "../../src/evals/snapshot.js";
import type { TrajectoryDetail } from "../../src/evals/trajectory.service.js";
import type { Kernel } from "../../src/kernel.js";
import { hookRequestOf } from "../../src/runtime/hook-calls.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { hookDeniedText } from "../../src/tools/pipeline.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  sleep,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * T15: model and tool hooks in the runtime, with the `hooks-probe` test plugin (all five mount points,
 * counts in ctx.kv) and model-fake. Hooks observe or deny, never rewrite; denials are logged as
 * `hook_denied`; eval replays never fire hooks.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);
const TOOL = "hooks-probe__probe_echo";
const HOOK_TIMEOUT_MS = 400;

/** Requests model-fake actually received. */
let sentCount = 0;
const originalResolve = ProviderRegistry.prototype.resolve;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: Kernel;
let owner: Req;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  ProviderRegistry.prototype.resolve = async function (this: ProviderRegistry, ref) {
    const r = await originalResolve.call(this, ref);
    const inner = r.provider;
    const provider: ModelProvider = {
      listModels: () => inner.listModels(),
      stream(req, opts) {
        sentCount++;
        return inner.stream(req, opts);
      },
    };
    return { ...r, provider };
  };
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, HOOKS_PROBE],
        hooks: { timeoutMs: HOOK_TIMEOUT_MS },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await enableProbe(true);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Hooked",
        instructions: "Use tools.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "hooks-probe", name: "probe_echo" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  ProviderRegistry.prototype.resolve = originalResolve;
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function enableProbe(enabled: boolean): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function probe(cfg: Record<string, unknown>): Promise<void> {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
}

type Probe = { counts: Record<string, number>; last: Record<string, unknown> };

/** `purpose`: `last` holds that purpose's last payload (a title call may follow the step). */
async function counts(purpose?: string): Promise<Probe> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}${purpose ? `&purpose=${purpose}` : ""}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Probe;
}

/** Waits until a mount's count reaches `n` (observe hooks are fire-and-forget). */
const countReaches = (mount: string, n: number) =>
  waitFor(
    async () => {
      const c = await counts();
      return (c.counts[mount] ?? 0) >= n ? c : null;
    },
    10_000,
    `${mount} count ${n}`,
  );

/** One turn in a fresh conversation; returns its events. */
async function turn(text: string): Promise<{ conv: string; events: ConversationEvent[] }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 20_000);
  return { conv, events: await eventsOf(db, conv) };
}

const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

describe("model hooks", { timeout: 60_000 }, () => {
  it("model.request: observes exactly the request reconstructed from the model_call", async () => {
    await probe({});
    const before = (await counts()).counts["model.request"] ?? 0;
    const { conv, events } = await turn("echo:hello hooks");
    await countReaches("model.request", before + 1);
    // the step's request (the conversation's title call may come after it)
    const seen = (await counts("step")).last["model.request"] as ModelRequestHookPayload;
    const [call] = ofType(events, "model_call");
    expect(call).toBeDefined();
    expect(seen).toMatchObject({
      orgId,
      agentId,
      conversationId: conv,
      runId: call?.runId,
      purpose: "step",
      step: 1,
      attempt: 1,
      provider: "model-fake",
      model: "fake-1",
    });
    const snap = await takeSnapshot(db, orgId, conv, call?.runId as string, 4_194_304);
    const info = (await k.runs.registry.resolve({ provider: "model-fake", model: "fake-1" })).info;
    const out = reconstructRequest(snap, call?.seq as number, {
      model: info,
      mediaBudgetBytes: k.config.attachments.requestMediaBytes,
    });
    expect(out.drift).toEqual([]);
    // the request sent, projected for hooks (I-3: media blocks become placeholders)
    expect(seen.request).toEqual(JSON.parse(JSON.stringify(hookRequestOf(out.request))));
  });

  it("model.request policy deny: no model_call, hook_denied logged, run fails, provider not called", async () => {
    await probe({ denyModel: true });
    const sentBefore = sentCount;
    const { events } = await turn("echo:blocked");
    expect(ofType(events, "model_call")).toEqual([]);
    const [denied] = ofType(events, "hook_denied");
    expect(denied?.payload).toMatchObject({
      mount: "model.request",
      plugin: "hooks-probe",
      reason: "nope",
      cause: "deny",
      step: 1,
      attempt: 1,
    });
    const [failed] = ofType(events, "run_failed");
    expect(failed?.payload.error.code).toBe("run.hook_denied");
    expect(sentCount).toBe(sentBefore);
    // audit entry for the denial
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "hook.denied")
      .execute();
    expect(audits.length).toBeGreaterThan(0);
    await probe({});
  });

  it("model.response: success carries the usage of the usage event; a provider error is failed with errorCode", async () => {
    await probe({});
    const before = (await counts()).counts["model.response"] ?? 0;
    const { events } = await turn("echo:usage please");
    let c = await countReaches("model.response", before + 1);
    const ok = c.last["model.response"] as ModelResponseHookPayload;
    const [usage] = ofType(events, "usage");
    expect(ok.outcome).toBe("ok");
    expect(ok.usage).toEqual({
      inputTokens: usage?.payload.inputTokens,
      outputTokens: usage?.payload.outputTokens,
      cacheReadTokens: usage?.payload.cacheReadTokens,
      cacheWriteTokens: usage?.payload.cacheWriteTokens,
    });
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);

    const { events: failedEvents } = await turn("fail:invalid_request");
    expect(ofType(failedEvents, "run_failed")[0]?.payload.error.code).toBe("model.invalid_request");
    c = await countReaches("model.response", before + 2);
    const failed = c.last["model.response"] as ModelResponseHookPayload;
    expect(failed).toMatchObject({
      outcome: "failed",
      errorCode: "model.invalid_request",
      usage: null,
      stopReason: null,
      content: [],
    });
  });
});

describe("tool hooks", { timeout: 60_000 }, () => {
  it("tool.preExecute deny: denial text, no tool_call_started, handler not called, run continues", async () => {
    await probe({ denyTools: [TOOL] });
    const handlerBefore = (await counts()).counts.handler ?? 0;
    const { events } = await turn(`tool:${TOOL}:{"text":"x"}`);
    const [result] = ofType(events, "tool_result");
    expect(result?.payload.content).toBe(hookDeniedText("hooks-probe", "nope"));
    expect(result?.payload.isError).toBe(true);
    expect(ofType(events, "tool_call_started")).toEqual([]);
    expect((await counts()).counts.handler ?? 0).toBe(handlerBefore);
    const [denied] = ofType(events, "hook_denied");
    expect(denied?.payload).toMatchObject({
      mount: "tool.preExecute",
      plugin: "hooks-probe",
      cause: "deny",
      callId: result?.payload.callId,
    });
    // the run went on to the next step and ended normally
    expect(ofType(events, "model_call").length).toBe(2);
    expect(ofType(events, "run_finished")[0]?.payload.reason).toBe("completed");
    await probe({});
  });

  it("a policy hook timeout blocks the call with a policy hook error and does not hang the run", async () => {
    await probe({ sleepMs: 30_000, sleepIn: ["tool.preExecute"] });
    const t0 = Date.now();
    const { conv, events } = await turn(`tool:${TOOL}:{"text":"slow"}`);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const [result] = ofType(events, "tool_result");
    expect(result?.payload.content).toContain("policy hook");
    expect(result?.payload.isError).toBe(true);
    expect(ofType(events, "hook_denied").map((e) => e.payload.cause)).toEqual(["timeout"]);
    expect(ofType(events, "run_finished")[0]?.payload.reason).toBe("completed");
    // Ruling R12: the events API (seen by conversation participants) has no raw hook error;
    // the audit row keeps it
    const api = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/events`,
    });
    expect(api.statusCode, api.body).toBe(200);
    const apiDenied = (api.json() as { events: ConversationEvent[] }).events.find(
      (e) => e.type === "hook_denied",
    );
    expect(apiDenied?.payload).toBeDefined();
    expect(apiDenied?.payload).not.toHaveProperty("detail");
    expect(api.body).not.toContain("did not finish within");
    const rows = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "hook.denied")
      .where("target", "=", conv)
      .execute();
    expect(JSON.stringify(rows[0]?.detail)).toContain("did not finish within");
    await probe({});
  });

  it("tool.postExecute gets durationMs and the result content", async () => {
    await probe({});
    const before = (await counts()).counts["tool.postExecute"] ?? 0;
    await turn(`tool:${TOOL}:{"text":"post"}`);
    const c = await countReaches("tool.postExecute", before + 1);
    const post = c.last["tool.postExecute"] as ToolPostHookPayload;
    expect(post.durationMs).toBeGreaterThanOrEqual(0);
    expect(post.content).toBe("echo: post");
    expect(post.isError).toBe(false);
    expect(post.toolKey).toBe(TOOL);
  });

  it("the trajectory shows the denial on the tool call", async () => {
    await probe({ denyTools: [TOOL] });
    const { conv } = await turn(`tool:${TOOL}:{"text":"traj"}`);
    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${conv}` });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json() as TrajectoryDetail;
    const call = detail.runs[0]?.steps[0]?.toolCalls[0];
    expect(call?.hookDenied).toEqual({ plugin: "hooks-probe", reason: "nope", cause: "deny" });
    await probe({});
  });
});

describe("scope", { timeout: 60_000 }, () => {
  it("after the organization disables the plugin, a turn does not fire its hooks", async () => {
    await probe({});
    await sleep(300); // let earlier observe hooks settle
    const before = (await counts()).counts;
    await enableProbe(false);
    try {
      // without the plugin its tool is unavailable; a plain turn still runs model calls
      await turn("echo:disabled");
      await sleep(300);
      const after = (await counts()).counts;
      expect(after["model.request"]).toBe(before["model.request"]);
      expect(after["model.response"]).toBe(before["model.response"]);
      expect(after["tool.preExecute"]).toBe(before["tool.preExecute"]);
    } finally {
      await enableProbe(true);
    }
  });

  it("an eval full-run replay fires no hooks", async () => {
    await probe({});
    const { conv } = await turn(`tool:${TOOL}:{"text":"for eval"}`);
    const [src] = await runsOf(db, conv);
    const setRes = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets`,
      payload: { agentId, name: "Hooks" },
    });
    expect(setRes.statusCode, setRes.body).toBe(201);
    const setId = (setRes.json() as { set: EvalSetView }).set.id;
    const caseRes = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
      payload: { conversationId: conv, runId: src?.id },
    });
    expect(caseRes.statusCode, caseRes.body).toBe(201);
    await sleep(300);
    const before = (await counts()).counts;
    const runRes = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/runs`,
      payload: { mode: "run", candidate: {}, judge: false },
    });
    expect(runRes.statusCode, runRes.body).toBe(201);
    const run = (runRes.json() as { run: EvalRunView }).run;
    const done = await waitFor(
      async () => {
        const r = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/eval-runs/${run.id}` });
        const v = (r.json() as { run: EvalRunView }).run;
        return ["queued", "running"].includes(v.status) ? null : v;
      },
      30_000,
      "eval run finished",
      100,
    );
    expect(done.status).toBe("completed");
    const results = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/eval-runs/${run.id}/results?limit=10`,
    });
    const [r] = (results.json() as { results: EvalResultView[] }).results;
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    // the replay made model calls (in the eval conversation), yet no hook fired
    const evalEvents = await eventsOf(db, r?.evalConversationId as string);
    expect(evalEvents.some((e) => e.type === "model_call")).toBe(true);
    await sleep(300);
    // model and tool hooks never fire in replays; usage.report does (the replay logs usage, P-17),
    // with conversationKind "eval"
    const after = await waitFor(
      async () => {
        const c = await counts();
        return (c.counts["usage.report"] ?? 0) > (before["usage.report"] ?? 0) ? c : null;
      },
      15_000,
      "eval usage reported",
    );
    const { "usage.report": _afterUsage, ...afterRest } = after.counts;
    const { "usage.report": _beforeUsage, ...beforeRest } = before;
    expect(afterRest).toEqual(beforeRest);
    expect((after.last["usage.report"] as { conversationKind: string }).conversationKind).toBe(
      "eval",
    );
  });
});
