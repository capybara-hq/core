import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, type Harness, replicaOf } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { USAGE_REPORT_QUEUE } from "../../src/runtime/usage-report.js";
import { hookDeniedText } from "../../src/tools/pipeline.js";
import { packPluginDir } from "../helpers/plugin-packages.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";

/**
 * M7 segment 2 acceptance (dual replica): two kernel processes (both `api` + `worker`) share PG /
 * Redis / the plugin directory, `extensionPermissions.autoApprove: false`. model-fake, `plugins/todo` and
 * the `hooks-probe` fixture are packed with pack-plugin and installed as install records through the
 * admin HTTP API; everything else goes through HTTP too (the event log, the audit row, the usage
 * queue and the disabled probe's counters are read directly).
 *
 * 1. Install hooks-probe: the review shows the `hooks` group as sensitive; approve, enable on the
 *    deployment and in the org; both replicas load it without restarting.
 * 2. A shared agent runs two turns (the first calls todo): the probe saw as many `model.request` as
 *    `model.response` (one per model call), `tool.preExecute` / `tool.postExecute` once each, and one
 *    `usage.report` per `usage` event, each `eventId` exactly once.
 * 3. The probe denies `todo__write` (its org config): the tool result is `hookDeniedText`, the
 *    trajectory shows the denial, and a single-step eval replay of the run has `drift: []` (replay
 *    runs no hooks).
 * 4. The probe is disabled on the deployment: a full turn later, and after the usage queue has
 *    delivered that turn's events to another subscriber (`hooks-probe-b`, the barrier), the probe's
 *    counters have not moved.
 *
 * Step 5 of the plan (`pnpm check:sdk-api`) runs in CI and is not repeated here.
 */

const TODO_DIR = fileURLToPath(new URL("../../../../plugins/todo", import.meta.url));
const MODEL_FAKE_DIR = fileURLToPath(new URL("../../../../plugins/model-fake", import.meta.url));
const PROBE_DIR = fileURLToPath(new URL("../fixtures/plugins/hooks-probe", import.meta.url));
const PROBE = "hooks-probe";
/** A second copy of the probe under another name: the usage-queue barrier of step 4. */
const BARRIER = "hooks-probe-b";
const TODO_KEY = "todo__write";
const MOUNTS = [
  "model.request",
  "model.response",
  "tool.preExecute",
  "tool.postExecute",
  "usage.report",
] as const;

type Json = Record<string, unknown>;
type Counts = Record<(typeof MOUNTS)[number] | "handler", number>;
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>["payload"];
interface View {
  name: string;
  status: string;
  sha256: string | null;
  reviewHash: string;
  sensitive: boolean;
  permissions: { category: string; sensitive: boolean; items: string[] }[];
  replicas: { replicaId: string; state: string; version: string }[];
}

const todoInput = (content: string) => ({
  todos: [{ content, status: "pending", activeForm: `${content}ing` }],
});
const idOf = (e: ConversationEvent) => `${e.conversationId}/${e.seq}`;

describe("M7 segment 2: plugin hooks and usage.report (dual replica)", { timeout: 180_000 }, () => {
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let redis: Redis;
  let usageQueue: Queue;
  let pluginsDir: string;
  let pkgs: Record<"todo" | "model-fake" | typeof PROBE | typeof BARRIER, Uint8Array>;
  const bootPids: number[] = [];
  const jar = new Map<string, string>();

  async function at(i: 0 | 1, method: string, path: string, body?: unknown) {
    const binary = body instanceof Uint8Array;
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && {
          "content-type": binary ? "application/octet-stream" : "application/json",
        }),
      },
      ...(body !== undefined && { body: binary ? Buffer.from(body) : JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text === "" ? {} : (JSON.parse(text) as Json);
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  }
  const ok = async (i: 0 | 1, method: string, path: string, body?: unknown) => {
    const r = await at(i, method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json;
  };
  const view = async (name: string, i: 0 | 1 = 0) =>
    (await ok(i, "GET", `/api/v1/admin/extensions/${name}`)) as unknown as View;
  const approve = async (i: 0 | 1, name: string) => {
    const v = await view(name, i);
    await ok(i, "POST", `/api/v1/admin/extensions/${name}/approve`, {
      sha256: v.sha256,
      reviewHash: v.reviewHash,
    });
  };
  /** Replica rows whose replica id (`<host>-<pid>-<hex>`) belongs to each of the boot processes. */
  const onBoth = (v: View, state: string) =>
    bootPids.every((pid) =>
      v.replicas.some(
        (r) => r.state === state && Number(/-(\d+)-[0-9a-f]{6}$/.exec(r.replicaId)?.[1]) === pid,
      ),
    );
  const loadedOnBoth = async (name: string) => {
    const v = await view(name);
    return v.status === "enabled" && onBoth(v, "loaded") ? v : undefined;
  };
  const unloadedOnBoth = async (name: string) => {
    const v = await view(name);
    return v.status === "disabled" && onBoth(v, "unloaded") ? v : undefined;
  };
  /** Upload on replica 0, install on replica 1 (pending approval, returned for review). */
  const install = async (name: keyof typeof pkgs) => {
    const up = (await ok(0, "POST", "/api/v1/admin/extensions/packages/file", pkgs[name])) as {
      sha256: string;
    };
    await ok(1, "POST", `/api/v1/admin/extensions/${name}/install`, { sha256: up.sha256 });
    const v = await view(name, 1);
    expect(v.status).toBe("pending_approval");
    return v;
  };

  beforeAll(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), "cap-m7s2-plugins-"));
    const [todo, modelFake, probe, barrier] = await Promise.all([
      packPluginDir(TODO_DIR),
      packPluginDir(MODEL_FAKE_DIR),
      packPluginDir(PROBE_DIR),
      packPluginDir(PROBE_DIR, async (dir) => {
        // the same probe under another name (its own kv namespace, routes and hook registrations)
        const pkgPath = join(dir, "package.json");
        const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Json;
        await writeFile(pkgPath, JSON.stringify({ ...pkg, name: `${pkg.name as string}-b` }));
        // the plugin name equals the extension name
        const manifestPath = join(dir, ".capybara-plugin", "plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Json;
        await writeFile(manifestPath, JSON.stringify({ ...manifest, name: BARRIER }));
        const srcPath = join(dir, "src", "index.ts");
        const src = await readFile(srcPath, "utf8");
        const next = src.replace(`name: "${PROBE}"`, `name: "${BARRIER}"`);
        expect(next).toContain(`name: "${BARRIER}"`);
        await writeFile(srcPath, next);
      }),
    ]);
    pkgs = { todo, "model-fake": modelFake, [PROBE]: probe, [BARRIER]: barrier } as typeof pkgs;
    h = await createDualReplicaHarness({
      extensions: [],
      extensionConfig: { "model-fake": { models: [{ id: "fake-1" }] } },
      config: {
        auth: { cookieSecure: false },
        extensionPermissions: { autoApprove: false },
        extensionHost: { dir: pluginsDir, reconcileIntervalSeconds: 2 },
      },
    });
    bootPids.push(h.replicas[0].pid, h.replicas[1].pid);
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    redis = new Redis(h.redisUrl, { maxRetriesPerRequest: null });
    usageQueue = new Queue(USAGE_REPORT_QUEUE, { connection: redis });
    await new AccountsService(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      enterpriseAdmin: true,
    });
    const r = await at(0, "POST", "/api/v1/auth/login", { login: "root", password: PW });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }, 600_000);

  afterAll(async () => {
    await usageQueue?.close();
    redis?.disconnect();
    await raw?.destroy();
    await h?.stop();
    if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  }, 120_000);

  let orgId: string;
  let base: string;
  let agentId: string;
  let conv: string;
  /** Terminal events seen so far in {@link conv}. */
  let turns = 0;

  const send = async (i: 0 | 1, text: string) => {
    const r = await at(i, "POST", `${base}/conversations/${conv}/messages`, { text });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
  };
  /** Sends one turn and waits for it to finish `completed`; returns that run's events. */
  const turn = async (i: 0 | 1, text: string) => {
    await send(i, text);
    turns++;
    const term = await waitForTerminal(db, conv, turns, 60_000);
    const last = term[turns - 1] as ConversationEvent;
    expect(last.type, JSON.stringify(last.payload)).toBe("run_finished");
    expect(last.payload).toMatchObject({ reason: "completed" });
    return {
      runId: last.runId as string,
      events: (await eventsOf(db, conv)).filter((e) => e.runId === last.runId),
    };
  };
  const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
    events.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);
  /** Every `usage` event of the org's chat conversations (one conversation here). */
  const usageIds = async () => ofType(await eventsOf(db, conv), "usage").map(idOf);

  const counts = async (plugin: string, i: 0 | 1 = 0) =>
    (await ok(i, "GET", `/plugins/${plugin}/counts?orgId=${orgId}`)).counts as Counts;
  /** The probe's counters straight from its kv (`cap:<plugin>:kv:<key>`): readable while disabled. */
  const kvCounts = async (plugin: string) => {
    const out: Partial<Counts> = {};
    for (const m of [...MOUNTS, "handler"] as const) {
      out[m] = Number((await redis.get(`cap:${plugin}:kv:count:${orgId}:${m}`)) ?? 0);
    }
    return out as Counts;
  };
  const deliveries = async (plugin: string, ids: string[]) =>
    (await ok(1, "GET", `/plugins/${plugin}/usage?eventIds=${ids.join(",")}`)) as Record<
      string,
      { calls: number; last: { eventId: string } | null }
    >;
  /** Full convergence: `plugin` got every id in `ids` exactly once. */
  const deliveredOnce = async (plugin: string, ids: string[]) => {
    const d = await deliveries(plugin, ids);
    return ids.every((id) => d[id]?.calls === 1 && d[id]?.last?.eventId === id) ? d : undefined;
  };
  const orgEnable = async (plugin: string) => {
    await ok(1, "PUT", `${base}/extensions/${plugin}`, { enabled: true });
    await waitFor(
      async () => {
        const list = (await ok(0, "GET", `${base}/extensions`)).extensions as {
          plugin: string;
          available: boolean;
        }[];
        return list.find((p) => p.plugin === plugin)?.available === true;
      },
      10_000,
      `${plugin} available in the org`,
      100,
    );
  };

  it("1. install hooks-probe: hooks marked sensitive at review; approved and enabled, loaded on both replicas", async () => {
    // the agent's model and tool plugins, installed the same way
    for (const name of ["model-fake", "todo"] as const) {
      await install(name);
      await approve(1, name);
      await ok(0, "POST", `/api/v1/admin/extensions/${name}/enable`);
    }

    const review = await install(PROBE);
    expect(review.sensitive).toBe(true);
    const hooks = review.permissions.find((g) => g.category === "hooks");
    expect(hooks).toMatchObject({ sensitive: true });
    // the mounts, plus the policy mounts (`permissions.policyHooks`, M-1)
    expect([...(hooks?.items ?? [])].sort()).toEqual(
      [...MOUNTS, "policy:model.request", "policy:tool.preExecute"].sort(),
    );
    await approve(1, PROBE);
    await ok(0, "POST", `/api/v1/admin/extensions/${PROBE}/enable`);
    for (const name of ["model-fake", "todo", PROBE]) {
      await waitFor(() => loadedOnBoth(name), 30_000, `${name} loaded on both`, 100);
    }

    const org = await ok(0, "POST", "/api/v1/orgs", { name: "Acme" });
    orgId = (org.org as { id: string }).id;
    base = `/api/v1/orgs/${orgId}`;
    await orgEnable("todo");
    await orgEnable(PROBE);
    // each replica runs its own instance of the probe, loaded in place (same processes)
    const [w0, w1] = [
      await ok(0, "GET", `/plugins/${PROBE}/whoami`),
      await ok(1, "GET", `/plugins/${PROBE}/whoami`),
    ];
    expect(w0.instanceId).toEqual(expect.any(String));
    expect(w0.instanceId).not.toBe(w1.instanceId);
    expect([h.replicas[0].pid, h.replicas[1].pid]).toEqual(bootPids);
    expect(await counts(PROBE)).toMatchObject({ "model.request": 0, "usage.report": 0 });
  });

  it("2. a shared agent runs two turns: model / tool hooks counted, usage.report once per usage event on both replicas", async () => {
    const ag = await ok(0, "POST", `${base}/agents`, {
      definition: {
        name: "Planner",
        instructions: "Keep a todo list.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "todo", name: "write" }],
      },
      visibility: "org",
    });
    agentId = (ag.agent as { id: string }).id;
    conv = ((await ok(1, "POST", `${base}/conversations`, { agentId })).conversation as Json)
      .id as string;

    const first = await turn(0, `tool:${TODO_KEY}:${JSON.stringify(todoInput("plan"))}`);
    const result = ofType(first.events, "tool_result")[0]?.payload as ToolResult;
    expect(result.isError, String(result.content)).toBe(false);
    expect(String(result.content)).toContain("Todo list updated (1 items)");
    await turn(1, "echo:second turn");

    // usage.report is asynchronous: wait until every usage event was delivered exactly once. Each
    // replica's probe instance counts its own deliveries (`/whoami` on that replica); the queue may
    // hand every job to one worker, so more echo turns run (bounded) until both instances delivered.
    const delivered = async (i: 0 | 1) =>
      (await ok(i, "GET", `/plugins/${PROBE}/whoami`)) as { instanceId: string; delivered: number };
    let extra = 0;
    const [d0, d1] = await waitFor(
      async () => {
        const all = await usageIds();
        await waitFor(
          () => deliveredOnce(PROBE, all),
          30_000,
          "usage.report for every usage event",
        );
        const both = [await delivered(0), await delivered(1)] as const;
        if (both[0].delivered > 0 && both[1].delivered > 0) return both;
        extra++;
        await turn(extra % 2 === 0 ? 0 : 1, `echo:extra turn ${extra}`);
        return undefined;
      },
      120_000,
      "both replicas' probe instances delivered usage.report",
      0,
    );
    expect(d0.instanceId).not.toBe(d1.instanceId);

    const all = await eventsOf(db, conv);
    const modelCalls = ofType(all, "model_call").length;
    const ids = await usageIds();
    expect(modelCalls).toBe(3 + extra); // tool call + answer, the echo, then any extra echo turns
    expect(ids).toHaveLength(modelCalls);
    expect(new Set(ids).size).toBe(ids.length);
    // every delivery ran on exactly one of the two instances
    expect(d0.delivered + d1.delivered).toBe(ids.length);

    const c = await waitFor(
      async () => {
        const v = await counts(PROBE, 1);
        return v["model.response"] >= modelCalls && v["usage.report"] >= ids.length ? v : undefined;
      },
      10_000,
      "model.response and usage.report counted",
      100,
    );
    expect(c).toMatchObject({
      "model.request": modelCalls,
      "model.response": modelCalls,
      "tool.preExecute": 1,
      "tool.postExecute": 1,
      "usage.report": ids.length,
    });
    // both replicas read the same (shared) counters
    expect(await counts(PROBE, 0)).toEqual(c);
  });

  it("3. the probe denies todo__write: hookDeniedText result, denial in the trajectory, step replay has no drift", async () => {
    const before = await counts(PROBE);
    await ok(0, "POST", `/plugins/${PROBE}/config`, { orgId, denyTools: [TODO_KEY] });
    const { runId, events } = await turn(1, `tool:${TODO_KEY}:${JSON.stringify(todoInput("x"))}`);

    const [result] = ofType(events, "tool_result");
    expect(result?.payload).toMatchObject({
      isError: true,
      content: hookDeniedText(PROBE, "nope"),
    });
    const [denied] = ofType(events, "hook_denied");
    expect(denied?.payload).toEqual({
      mount: "tool.preExecute",
      plugin: PROBE,
      reason: "nope",
      cause: "deny",
      step: 1,
      callId: result?.payload.callId,
    });
    const audit = await db
      .selectFrom("audit_events")
      .select(["detail"])
      .where("action", "=", "hook.denied")
      .where("target", "=", conv)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ plugin: PROBE, reason: "nope", runId });
    expect((await counts(PROBE))["tool.preExecute"]).toBe(before["tool.preExecute"] + 1);

    const traj = await ok(0, "GET", `${base}/trajectories/${conv}?runId=${runId}`);
    const run = (traj.runs as { runId: string; steps: { toolCalls: Json[] }[] }[])[0];
    expect(run?.runId).toBe(runId);
    expect(run?.steps[0]?.toolCalls[0]).toMatchObject({
      toolKey: TODO_KEY,
      hookDenied: { plugin: PROBE, reason: "nope", cause: "deny" },
      result: { content: hookDeniedText(PROBE, "nope"), isError: true },
    });

    // single-step replay of the run (the second step carries the denied call's result)
    const modelRequests = (await counts(PROBE))["model.request"];
    const set = await ok(1, "POST", `${base}/eval-sets`, { agentId, name: "Hook denial" });
    const setId = (set.set as { id: string }).id;
    await ok(0, "POST", `${base}/eval-sets/${setId}/cases`, { conversationId: conv, runId });
    const started = await ok(1, "POST", `${base}/eval-sets/${setId}/runs`, {
      mode: "step",
      candidate: { model: { provider: "model-fake", model: "fake-1" } },
    });
    const evalRunId = (started.run as EvalRunView).id;
    const done = await waitFor(
      async () => {
        const v = (await ok(0, "GET", `${base}/eval-runs/${evalRunId}`)).run as EvalRunView;
        return v.status === "queued" || v.status === "running" ? undefined : v;
      },
      60_000,
      "step eval run finished",
      200,
    );
    expect(done).toMatchObject({ status: "completed", error: null, casesDone: 1 });
    const results = (
      (await ok(1, "GET", `${base}/eval-runs/${evalRunId}/results?limit=200`)) as {
        results: EvalResultView[];
      }
    ).results;
    const calls = ofType(events, "model_call").map((e) => e.seq);
    expect(calls).toHaveLength(2);
    expect(results.map((r) => r.modelCallSeq).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(calls);
    expect(results.map((r) => [r.status, r.drift])).toEqual(results.map(() => ["done", []]));
    expect(done.summary).toMatchObject({ drifted: 0 });
    // replay runs no hooks (model.request is a policy hook: it would have run before each request)
    expect((await counts(PROBE))["model.request"]).toBe(modelRequests);
  });

  it("4. probe disabled on the deployment: its counters stay put through a full turn and its usage deliveries", async () => {
    // the barrier subscriber: delivered the same usage events as the probe would be
    await install(BARRIER);
    await approve(1, BARRIER);
    await ok(0, "POST", `/api/v1/admin/extensions/${BARRIER}/enable`);
    await waitFor(() => loadedOnBoth(BARRIER), 30_000, `${BARRIER} loaded on both`, 100);
    await orgEnable(BARRIER);

    // the probe has caught up with everything so far (step 3's usage events included)
    const sofar = await usageIds();
    await waitFor(() => deliveredOnce(PROBE, sofar), 30_000, "probe caught up");
    // the observe hooks are fire-and-forget: wait for every expected call (one model.request /
    // model.response per model_call; two tool calls, the denied one had no tool.postExecute)
    const modelCallsSoFar = ofType(await eventsOf(db, conv), "model_call").length;
    const expected = {
      "model.request": modelCallsSoFar,
      "model.response": modelCallsSoFar,
      "tool.preExecute": 2,
      "tool.postExecute": 1,
      "usage.report": sofar.length,
    };
    const settled = await waitFor(
      async () => {
        const v = await counts(PROBE);
        return MOUNTS.every((m) => v[m] >= expected[m]) ? v : undefined;
      },
      10_000,
      "probe counters settled",
      100,
    );
    expect(settled).toMatchObject(expected);
    // the counters as read from the probe's kv match its own route
    expect(await kvCounts(PROBE)).toEqual(settled);

    await ok(1, "POST", `/api/v1/admin/extensions/${PROBE}/disable`);
    await waitFor(() => unloadedOnBoth(PROBE), 30_000, "probe unloaded on both", 100);
    for (const i of [0, 1] as const) {
      expect((await at(i, "GET", `/plugins/${PROBE}/whoami`)).status).not.toBe(200);
    }

    const barrierBefore = await counts(BARRIER);
    // the probe's org config still denies todo__write: the call goes through, so no probe hook ran
    const { events } = await turn(0, `tool:${TODO_KEY}:${JSON.stringify(todoInput("after"))}`);
    const [result] = ofType(events, "tool_result");
    expect(result?.payload.isError, String(result?.payload.content)).toBe(false);
    expect(ofType(events, "hook_denied")).toEqual([]);
    const ids = ofType(events, "usage").map(idOf);
    const modelCalls = ofType(events, "model_call").length;
    expect(modelCalls).toBe(2);
    expect(ids).toHaveLength(modelCalls);

    // the queue delivered this turn's usage events (to the barrier) and holds no delivery job
    await waitFor(() => deliveredOnce(BARRIER, ids), 30_000, "barrier got the turn's usage");
    await waitFor(
      async () =>
        (await usageQueue.getJobs(["waiting", "active", "delayed", "prioritized"])).every(
          (j) => j.name !== "usage-report",
        ),
      30_000,
      "usage queue drained",
      100,
    );
    // the barrier's hooks ran through the whole turn (observe hooks are fire-and-forget: wait)
    const barrierExpected = {
      "model.request": barrierBefore["model.request"] + modelCalls,
      "model.response": barrierBefore["model.response"] + modelCalls,
      "tool.preExecute": barrierBefore["tool.preExecute"] + 1,
      "tool.postExecute": barrierBefore["tool.postExecute"] + 1,
    };
    const barrierAfter = await waitFor(
      async () => {
        const v = await counts(BARRIER);
        return (Object.keys(barrierExpected) as (keyof typeof barrierExpected)[]).every(
          (m) => v[m] >= barrierExpected[m],
        )
          ? v
          : undefined;
      },
      10_000,
      "barrier hooks counted",
      100,
    );
    expect(barrierAfter).toMatchObject(barrierExpected);
    // ... and the disabled probe's did not
    expect(await kvCounts(PROBE)).toEqual(settled);

    // no restart from start to end
    expect([h.replicas[0].pid, h.replicas[1].pid]).toEqual(bootPids);
  });
});
