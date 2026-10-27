import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../src/agents/definition.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { RunReplayResult } from "../../src/evals/run-replay.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import {
  type CaseSnapshot,
  readSnapshot,
  takeSnapshot,
  toEvents,
} from "../../src/evals/snapshot.js";
import type { TrajectoryDetail } from "../../src/evals/trajectory.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { BEHAVIOR_RULES } from "../../src/runtime/context/build.js";
import { SUBAGENT_PREAMBLE } from "../../src/runtime/subagents/preamble.js";
import { type ScriptRule, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
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
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Phase C Task 17 (spec §15): replay and evals with sub-agents. A parent's full-run replay uses the
 * recorded `agent` results and never starts a child; a child's steps reconstruct from its own log
 * (definition and preamble from `subagent_started`); a candidate whose effective definition differs
 * reports `subagent_changed`; a child case's full-run replay runs the logged definition; the
 * trajectory links each `agent` call to its child and back, with the parent's access rule.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);

const CHILD = "You are a sub-agent";
const INSTRUCTIONS = "Lead the work.";
const SCRIPT = { provider: "model-script", model: "script-1" };
const FAKE = { provider: "model-fake", model: "fake-1" };

const agentCall = (input: Record<string, unknown>) => ({ name: "agent", input });

const RULES: ScriptRule[] = [
  // children (their system text carries the preamble)
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "what word" },
    reply: { text: "recalled kiwi" },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "par-" },
    reply: { text: "parallel ok", barrier: { name: "three", count: 3, timeoutMs: 8000 } },
  },
  // the parent: three parallel agent calls, then a follow-up of the last one, then a reply
  {
    when: { lastUserIncludes: "SCENARIO combo", assistantTurns: 0 },
    reply: {
      toolCalls: [1, 2, 3].map((n) =>
        agentCall({ description: `Part ${n}`, prompt: `par-${n}: remember kiwi ${n}` }),
      ),
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO combo", lastToolResultIncludes: "parallel ok" },
    reply: {
      toolCalls: [
        agentCall({
          description: "Follow up",
          prompt: "what word did I give you?",
          resume: "{{lastAgentId}}",
        }),
      ],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO combo", lastToolResultIncludes: "recalled kiwi" },
    reply: { text: "combo done" },
  },
  // an inline template on the fast tier (mapped to model-fake, which echoes the child's prompt)
  {
    when: { lastUserIncludes: "SCENARIO inline", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agentCall({ description: "Helper", prompt: "echo:inline ok", subagent_type: "helper" }),
      ],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO inline", lastToolResultIncludes: "inline ok" },
    reply: { text: "inline done" },
  },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let k: Kernel;
const capture = captureProviderRequests();

let owner: Req;
let other: Req;
let orgId: string;
let leadId: string;

/** The scenario's conversation, its children and the provider requests it caused. */
const state: {
  conv?: string;
  runId?: string;
  children?: { id: string; runs: string[] }[];
  sent?: ModelRequest[];
} = {};

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT],
        extensionConfig: { "model-script": { rules: RULES } },
      },
    ),
  );
  scriptRules([]);
  const accounts = new AccountsService(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  owner = await session(k, "owner");
  other = await session(k, "other");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: INSTRUCTIONS,
        model: SCRIPT,
        tools: [{ kind: "builtin", name: "agent" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  leadId = (res.json() as { agent: { id: string } }).agent.id;

  // the scenario, once: three parallel sub-agents, then a follow-up of the third
  const conv = await createConv(owner, orgId, leadId);
  await postMessage(owner, orgId, conv, "SCENARIO combo");
  await waitForTerminal(db, conv, 1, 60_000);
  const events = await eventsOf(db, conv);
  const final = events
    .filter((e) => e.type === "assistant_message")
    .at(-1) as Ev<"assistant_message">;
  expect(final.payload.content).toEqual([{ type: "text", text: "combo done" }]);
  const [run] = await runsOf(db, conv);
  const kids = await db
    .selectFrom("conversations")
    .select("id")
    .where("parent_conversation_id", "=", conv)
    .orderBy("created_at")
    .execute();
  const children: { id: string; runs: string[] }[] = [];
  for (const kid of kids) {
    children.push({ id: kid.id, runs: (await runsOf(db, kid.id)).map((r) => r.id) });
  }
  expect(children.map((c) => c.runs.length).sort()).toEqual([1, 1, 2]);
  Object.assign(state, {
    conv,
    runId: (run as { id: string }).id,
    children,
    sent: structuredClone(capture.sent),
  });
}, 240_000);

afterAll(async () => {
  capture.restore();
  await k?.stop();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};

const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const isChild = (r: ModelRequest) => r.system.some((s) => s.text.includes(CHILD));

/** Tool call ids are random per response: numbered by first appearance so requests compare. */
function normalizeIds(reqs: readonly ModelRequest[]): ModelRequest[] {
  return reqs.map((r) => {
    const ids = new Map<string, string>();
    const id = (x: string) => {
      if (!ids.has(x)) ids.set(x, `call-${ids.size}`);
      return ids.get(x) as string;
    };
    const copy = structuredClone(r);
    for (const m of copy.messages) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_call") b.id = id(b.id);
        else if (b.type === "tool_result") b.callId = id(b.callId);
      }
    }
    return copy;
  });
}

const setsUrl = () => `/api/v1/orgs/${orgId}/eval-sets`;
const runsUrl = () => `/api/v1/orgs/${orgId}/eval-runs`;

async function createSet(name: string, agentId = leadId): Promise<string> {
  const res = await owner({ method: "POST", url: setsUrl(), payload: { agentId, name } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { set: EvalSetView }).set.id;
}

async function addCase(setId: string, conversationId: string, runId: string): Promise<void> {
  const res = await owner({
    method: "POST",
    url: `${setsUrl()}/${setId}/cases`,
    payload: { conversationId, runId },
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function runEval(
  setId: string,
  body: Record<string, unknown>,
): Promise<{ run: EvalRunView; results: EvalResultView[] }> {
  const start = await owner({
    method: "POST",
    url: `${setsUrl()}/${setId}/runs`,
    payload: { judge: false, ...body },
  });
  expect(start.statusCode, start.body).toBe(201);
  const id = (start.json() as { run: EvalRunView }).run.id;
  const run = await waitFor(
    async () => {
      const r = await owner({ method: "GET", url: `${runsUrl()}/${id}` });
      const v = (r.json() as { run: EvalRunView }).run;
      return ["queued", "running"].includes(v.status) ? null : v;
    },
    60_000,
    "eval run finished",
    100,
  );
  const res = await owner({ method: "GET", url: `${runsUrl()}/${id}/results?limit=50` });
  expect(res.statusCode, res.body).toBe(200);
  return { run, results: (res.json() as { results: EvalResultView[] }).results };
}

async function counts() {
  const [convs, dispatches] = await Promise.all([
    db
      .selectFrom("conversations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("kind", "=", "subagent")
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("subagent_dispatches")
      .select((eb) => eb.fn.countAll().as("n"))
      .executeTakeFirstOrThrow(),
  ]);
  return { children: Number(convs.n), dispatches: Number(dispatches.n) };
}

async function modelInfo(): Promise<ModelInfo> {
  return (await k.runs.registry.resolve(SCRIPT)).info;
}

const snapshotOf = (conv: string, runId: string): Promise<CaseSnapshot> =>
  takeSnapshot(db, orgId, conv, runId, 4_194_304);

/** The child that was resumed (two runs) and its snapshot at its second run. */
async function resumedChild(): Promise<{ id: string; runs: string[]; snap: CaseSnapshot }> {
  const child = state.children?.find((c) => c.runs.length === 2) as { id: string; runs: string[] };
  return { ...child, snap: await snapshotOf(child.id, child.runs[1] as string) };
}

describe("full-run replay of a parent with sub-agent calls", { timeout: 120_000 }, () => {
  it("parent full-run replay with three parallel agent calls and a resume: same requests, zero tool_unmatched, no child conversation created, no subagent_* events", async () => {
    const original = normalizeIds((state.sent ?? []).filter((r) => !isChild(r)));
    expect(original).toHaveLength(3);
    const setId = await createSet("Parent");
    await addCase(setId, state.conv as string, state.runId as string);
    const before = await counts();
    capture.reset();

    const { run, results } = await runEval(setId, { mode: "run", candidate: {} });
    expect(run.status).toBe("completed");
    const [r] = results;
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    expect(r?.drift).toEqual([]);
    const cand = r?.candidate as RunReplayResult;
    expect(cand.unmatched).toBe(0);
    expect(cand.toolCalls.map((c) => c.name)).toEqual(["agent", "agent", "agent", "agent"]);
    // only the parent's requests, the same ones: no child was started
    expect(capture.sent.some(isChild)).toBe(false);
    expect(normalizeIds(capture.sent)).toEqual(original);
    expect(await counts()).toEqual(before);
    const evalEvents = await eventsOf(db, r?.evalConversationId as string);
    expect(evalEvents.filter((e) => e.type.startsWith("subagent_"))).toEqual([]);
    // the recorded results (with their status lines) came back, in the same step for the three
    const agentResults = ofType(evalEvents, "tool_result").filter(
      (e) => e.payload.toolKey === "agent",
    );
    expect(agentResults.map((e) => e.payload.step)).toEqual([1, 1, 1, 2]);
    for (const res of agentResults.slice(0, 3)) {
      expect(res.payload.content).toMatch(/^parallel ok\n\n\[agentId: /);
    }
  });
});

describe("child cases", { timeout: 120_000 }, () => {
  it("each child step reconstructs with drift [] and equals what the provider received", async () => {
    const info = await modelInfo();
    const sent = state.sent ?? [];
    let checked = 0;
    for (const child of state.children ?? []) {
      for (const runId of child.runs) {
        const snap = await snapshotOf(child.id, runId);
        const started = ofType(toEvents(snap), "subagent_started")[0];
        expect(snap.subagent).toEqual({
          definition: started?.payload.definition,
          preamble: SUBAGENT_PREAMBLE,
        });
        for (const c of ofType(toEvents(snap), "model_call")) {
          if (c.runId !== runId) continue;
          const out = reconstructRequest(snap, c.seq, { model: info });
          expect(out.drift, `${child.id} seq ${c.seq}`).toEqual([]);
          expect(sent).toContainEqual(out.request);
          expect(out.request.system[0]?.text).toBe(
            `${BEHAVIOR_RULES}\n\n${SUBAGENT_PREAMBLE}\n\n${INSTRUCTIONS}`,
          );
          checked++;
        }
      }
    }
    expect(checked).toBe(4);
  });

  it("a definitions-less child snapshot still reconstructs from subagent_started (definitions not consulted)", async () => {
    const { snap } = await resumedChild();
    const s = structuredClone(snap);
    s.definitions = {};
    const call = ofType(toEvents(s), "model_call").at(-1) as Ev<"model_call">;
    const out = reconstructRequest(s, call.seq, { model: await modelInfo() });
    expect(out.drift).toEqual([]);
  });

  it("a candidate instruction override, a candidate parent version and a candidate template version -> subagent_changed, request still from the log", async () => {
    const { snap } = await resumedChild();
    const info = await modelInfo();
    const call = ofType(toEvents(snap), "model_call").at(-1) as Ev<"model_call">;
    const baseline = reconstructRequest(snap, call.seq, { model: info });
    const logged = snap.subagent?.definition as NonNullable<CaseSnapshot["subagent"]>["definition"];

    // the logged definition with other instructions
    const changed = reconstructRequest(snap, call.seq, {
      model: info,
      definition: { ...logged, instructions: "Something else." },
    });
    expect(changed.drift).toEqual(["subagent_changed"]);
    expect(changed.request).toEqual(baseline.request);
    // the logged definition as is (another model only) is not a change of the sub-agent
    expect(
      reconstructRequest(snap, call.seq, { model: info, definition: { ...logged } }).drift,
    ).toEqual([]);

    // another parent version: general-purpose takes the parent's instructions
    const v1 = snap.definitions[String(snap.agentVersion)];
    if (!v1) throw new Error("parent definition missing");
    const parentV2 = normalizeStoredDefinition({ ...v1, instructions: "Lead differently." });
    const other = reconstructRequest(snap, call.seq, {
      model: info,
      definition: parentV2,
      agentVersion: snap.agentVersion + 1,
    });
    expect(other.drift).toEqual(["subagent_changed"]);
    expect(other.request).toEqual(baseline.request);
    const same = reconstructRequest(snap, call.seq, {
      model: info,
      definition: normalizeStoredDefinition({ ...v1, name: "Renamed lead" }),
      agentVersion: snap.agentVersion + 1,
    });
    expect(same.drift).toEqual([]);

    // a plugin template child: the template's current version differs from the logged one
    const s = structuredClone(snap);
    const ev = s.events.find((e) => e.type === "subagent_started") as { payload: unknown };
    (ev.payload as EventPayload<"subagent_started">).template = {
      source: "plugin",
      id: "tpl-1",
      version: 1,
      plugin: "superpowers",
    };
    expect(
      reconstructRequest(s, call.seq, {
        model: info,
        definition: { ...logged },
        subagentTemplate: { id: "tpl-1", version: 2 },
      }).drift,
    ).toEqual(["subagent_changed"]);
    expect(
      reconstructRequest(s, call.seq, {
        model: info,
        definition: { ...logged },
        subagentTemplate: { id: "tpl-1", version: 1 },
      }).drift,
    ).toEqual([]);
  });

  it("a child case is added under the parent's agent; a step replay with an instruction candidate reports subagent_changed", async () => {
    const child = await resumedChild();
    const setId = await createSet("Child steps");
    await addCase(setId, child.id, child.runs[1] as string);
    const row = await db
      .selectFrom("eval_cases")
      .select(["snapshot", "base_model"])
      .where("set_id", "=", setId)
      .executeTakeFirstOrThrow();
    const stored = readSnapshot(row.snapshot);
    expect(stored.subagent?.preamble).toBe(SUBAGENT_PREAMBLE);
    expect(stored.parent).toMatchObject({ conversationId: state.conv, runId: state.runId });
    expect(row.base_model).toEqual(SCRIPT);

    const base = await runEval(setId, { mode: "step", candidate: {} });
    expect(base.results.map((r) => [r.status, r.drift])).toEqual([["done", []]]);
    const cand = await runEval(setId, {
      mode: "step",
      candidate: { instructions: "Something else." },
    });
    expect(cand.results.map((r) => [r.status, r.drift])).toEqual([["done", ["subagent_changed"]]]);
  });

  it("a child case's full-run replay uses the logged definition", async () => {
    const child = await resumedChild();
    const childSent = (state.sent ?? []).filter(isChild);
    const original = childSent.filter((r) =>
      r.messages.some(
        (m) =>
          typeof m.content !== "string" &&
          m.content.some((b) => b.type === "text" && b.text.includes("what word")),
      ),
    );
    expect(original).toHaveLength(1);
    const setId = await createSet("Child run");
    await addCase(setId, child.id, child.runs[1] as string);
    capture.reset();
    const before = await counts();

    const { results } = await runEval(setId, {
      mode: "run",
      candidate: { instructions: "Something else." },
    });
    const [r] = results;
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    expect(r?.drift).toEqual(["subagent_changed"]);
    expect((r?.candidate as RunReplayResult | undefined)?.unmatched).toBe(0);
    // the logged preamble and instructions, not the candidate's
    expect(capture.sent).toEqual(original);
    const evalEvents = await eventsOf(db, r?.evalConversationId as string);
    const started = ofType(evalEvents, "run_started").at(-1);
    expect(started?.payload.model).toEqual(child.snap.subagent?.definition.model);
    expect(await counts()).toEqual(before);
  });
});

describe("candidates on child cases (batch 13 review I1, m1)", { timeout: 120_000 }, () => {
  it("the case's own version with another model is not a sub-agent change", async () => {
    const child = await resumedChild();
    const setId = await createSet("Own version");
    await addCase(setId, child.id, child.runs[1] as string);
    const { results } = await runEval(setId, {
      mode: "step",
      candidate: { agentVersion: child.snap.agentVersion, model: FAKE },
    });
    expect(results.map((r) => [r.status, r.drift])).toEqual([["done", []]]);
  });

  it("a tiered inline child under another parent version replays on the child's own model, priced on it", async () => {
    // map the fast tier to model-fake; only model-fake has a price
    const mapped = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/model-purposes/subagent_fast`,
      payload: { target: { model: FAKE } },
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    await db
      .insertInto("model_prices")
      .values({ ...FAKE, input_per_mtok: "1", output_per_mtok: "1" })
      .onConflict((oc) => oc.columns(["provider", "model"]).doNothing())
      .execute();
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Inline lead",
          instructions: INSTRUCTIONS,
          model: SCRIPT,
          tools: [{ kind: "builtin", name: "agent" }],
          subagents: {
            inline: [
              { name: "helper", description: "Helps.", instructions: "Help.", model: "fast" },
            ],
          },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; definition: object } }).agent;
    const conv = await createConv(owner, orgId, agent.id);
    await postMessage(owner, orgId, conv, "SCENARIO inline");
    await waitForTerminal(db, conv, 1, 60_000);
    const kid = await db
      .selectFrom("conversations")
      .select("id")
      .where("parent_conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const [kidRun] = await runsOf(db, kid.id);
    // v2 changes an unrelated field only
    const v2 = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { definition: { ...agent.definition, name: "Inline lead v2" } },
    });
    expect(v2.statusCode, v2.body).toBe(200);

    const setId = await createSet("Inline child", agent.id);
    await addCase(setId, kid.id, (kidRun as { id: string }).id);
    capture.reset();
    const { run, results } = await runEval(setId, { mode: "step", candidate: { agentVersion: 2 } });
    expect(results.map((r) => [r.status, r.drift])).toEqual([["done", []]]);
    expect(capture.sent.map((r) => r.model)).toEqual([FAKE.model]);
    // the estimate is priced on the child's model (the parent's has no price)
    expect(run.estimate.estimatedCost).not.toBeNull();
  });

  it("an inline template changed in another parent version (tools only) is a sub-agent change", async () => {
    const child = await resumedChild();
    const info = await modelInfo();
    const call = ofType(toEvents(child.snap), "model_call").at(-1) as Ev<"model_call">;
    const s = structuredClone(child.snap);
    const ev = s.events.find((e) => e.type === "subagent_started") as { payload: unknown };
    const started = ev.payload as EventPayload<"subagent_started">;
    started.template = { source: "inline" };
    started.agentType = "helper";
    const v1 = s.definitions[String(s.agentVersion)] as NonNullable<
      CaseSnapshot["definitions"][string]
    >;
    const tpl = { name: "helper", description: "Helps.", instructions: "Help." };
    s.definitions[String(s.agentVersion)] = { ...v1, subagents: { inline: [tpl] } };
    const v2 = (inline: object) =>
      normalizeStoredDefinition({ ...v1, subagents: { inline: [inline] } });
    const at = (definition: ReturnType<typeof v2>) =>
      reconstructRequest(s, call.seq, {
        model: info,
        definition: { ...(s.subagent?.definition as typeof definition) },
        agentVersion: s.agentVersion + 1,
        subagentVersion: definition,
      }).drift;
    expect(at(v2(tpl))).toEqual([]);
    expect(at(v2({ ...tpl, tools: ["sandbox_bash"] }))).toEqual(["subagent_changed"]);
  });

  it("a general child: another parent version that drops general or changes orgSkills is a change", async () => {
    const child = await resumedChild();
    const info = await modelInfo();
    const call = ofType(toEvents(child.snap), "model_call").at(-1) as Ev<"model_call">;
    const v1 = child.snap.definitions[String(child.snap.agentVersion)] as NonNullable<
      CaseSnapshot["definitions"][string]
    >;
    const at = (over: object) =>
      reconstructRequest(child.snap, call.seq, {
        model: info,
        definition: {
          ...(child.snap.subagent?.definition as ReturnType<typeof normalizeStoredDefinition>),
        },
        agentVersion: child.snap.agentVersion + 1,
        subagentVersion: normalizeStoredDefinition({ ...v1, ...over }),
      }).drift;
    expect(at({ name: "Renamed" })).toEqual([]);
    expect(at({ subagents: { general: false } })).toEqual(["subagent_changed"]);
    expect(at({ skills: { orgSkills: ["sk-1"] } })).toEqual(["subagent_changed"]);
  });
});

describe("trajectory links", { timeout: 60_000 }, () => {
  it("the trajectory of a parent links each agent call to its child and back; another user gets 404", async () => {
    const conv = state.conv as string;
    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${conv}` });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json() as TrajectoryDetail;
    expect(t.conversation.parent).toBeUndefined();
    const calls = t.runs.flatMap((r) => r.steps.flatMap((s) => s.toolCalls));
    expect(calls.map((c) => c.toolKey)).toEqual(["agent", "agent", "agent", "agent"]);
    const children = state.children ?? [];
    const resumed = children.find((c) => c.runs.length === 2) as { id: string; runs: string[] };
    expect(calls.map((c) => c.subagent?.subagentId)).toEqual([
      ...children.map((c) => c.id),
      resumed.id,
    ]);
    expect(calls.map((c) => c.subagent?.resumed)).toEqual([false, false, false, true]);
    expect(calls.map((c) => c.subagent?.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(calls[3]?.subagent?.childRunId).toBe(resumed.runs[1]);

    const auditCount = async (target: string) =>
      Number(
        (
          await db
            .selectFrom("audit_events")
            .select((eb) => eb.fn.countAll().as("n"))
            .where("action", "=", "trajectory.viewed")
            .where("target", "=", target)
            .executeTakeFirstOrThrow()
        ).n,
      );
    for (const [i, child] of children.entries()) {
      const viewed = await auditCount(child.id);
      const c = await owner({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/trajectories/${child.id}`,
      });
      expect(c.statusCode, c.body).toBe(200);
      const ct = c.json() as TrajectoryDetail;
      // viewing a child is audited like any trajectory (batch 13 review m4)
      expect(await auditCount(child.id)).toBe(viewed + 1);
      expect(ct.conversation.kind).toBe("subagent");
      expect(ct.conversation.parent).toEqual({
        conversationId: conv,
        runId: state.runId,
        callId: calls[i]?.callId,
      });
    }

    // a member who is neither the agent's owner nor an admin: 404 for the parent and each child
    for (const id of [conv, ...children.map((c) => c.id)]) {
      const r = await other({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${id}` });
      expect(r.statusCode, id).toBe(404);
    }
  });
});
