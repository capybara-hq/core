import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  type FakeGitServer,
  fakeExtensionEntry,
  startFakeGitServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { usageTokens } from "../../src/evals/budget.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { RunReplayResult } from "../../src/evals/run-replay.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { BEHAVIOR_RULES } from "../../src/runtime/context/build.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { SUBAGENT_PREAMBLE } from "../../src/runtime/subagents/preamble.js";
import { loadFixtureAsStrings } from "../catalog/claude-fixtures.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { agentTemplatesFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
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
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Phase C acceptance (sub-agents spec §21 "End to end on fakes", ecosystem spec §12): superpowers'
 * `subagent-driven-development` runs a two-task plan in Capybara. The superpowers fixture (7.0.1,
 * with the SDD, requesting-code-review and dispatching-parallel-agents skills) is imported from a
 * fake git marketplace and installed; `model-script` plays the controller and every sub-agent from
 * `sdd-script.json`; `sandbox-fake` runs the skill's real bash scripts and git in the shared
 * workspace. The controller loads the skill, runs `scripts/task-brief`, dispatches an implementer
 * (`fast`), runs `scripts/review-package`, dispatches a task reviewer that finds one issue, resumes
 * the implementer with the fix, dispatches a scoped re-review, repeats for task 2, then dispatches
 * the final review (`superpowers:code-reviewer`, `capable`) and a file check in parallel. The
 * conversation then replays with zero drift. The `it`s run in order and share state.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

const SCRIPT = { provider: "model-script", model: "script-1" };
const INSTRUCTIONS = "You run implementation plans with the superpowers skills.";
const SDD = JSON.parse(
  readFileSync(fileURLToPath(new URL("./sdd-script.json", import.meta.url)), "utf8"),
) as { plan: string; rules: ScriptRule[] };

const capture = captureProviderRequests();
const { sent } = capture;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let sandboxRoot: string;
let k: TestKernel;
let admin: Req;
let orgId: string;

const state: {
  agentId?: string;
  conv?: string;
  /** Provider requests of the original conversation (before the replay adds its own). */
  original?: ModelRequest[];
} = {};

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-sdd-e2e-"));
  sandboxRoot = await mkdtemp(join(tmpdir(), "kernel-sdd-sandbox-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensionHost: { dir: pluginsDir },
        marketplaces: { allowInsecureLoopback: true, allowedHosts: ["127.0.0.1"] },
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE, OBJECT_STORE],
        extensionConfig: {
          "model-script": { rules: SDD.rules },
          "sandbox-fake": { root: sandboxRoot },
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
  await accountsFor(db).createLocal({
    login: "root",
    password: PW,
    displayName: "R",
    enterpriseAdmin: true,
  });
  admin = await session(k, "root");
  orgId = await createOrg(admin);
}, 240_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await srv?.stop();
  for (const d of [pluginsDir, sandboxRoot]) if (d) await rm(d, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const isChildRequest = (r: ModelRequest) =>
  r.system.some((s) => s.text.includes(SUBAGENT_PREAMBLE));

const textOf = (r: ModelRequest, i: number): string => {
  const c = r.messages[i]?.content;
  return typeof c === "string"
    ? c
    : (c ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
};

/** The fake sandbox's workspace directory of the conversation's only instance. */
function workspaceDir(): string {
  const ids = readdirSync(join(sandboxRoot, "instances"));
  expect(ids).toHaveLength(1);
  return join(sandboxRoot, "instances", ids[0] as string, "fs", "workspace");
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

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

async function childConversations(parent: string) {
  return db
    .selectFrom("conversations")
    .select(["id", "subagent_type"])
    .where("parent_conversation_id", "=", parent)
    .orderBy("created_at")
    .execute();
}

describe("phase C acceptance: superpowers subagent-driven-development", {
  timeout: 180_000,
}, () => {
  it("superpowers is imported from a git marketplace and installed; an agent gets the SDD skills, the agent tool and the code-reviewer template", async () => {
    await srv.commit("superpowers", loadFixtureAsStrings("superpowers"));
    const added = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces",
      payload: { name: "Superpowers", url: srv.url("superpowers"), form: "git" },
    });
    expect(added.statusCode, added.body).toBe(201);
    const mkt = added.json().id as string;
    const refreshed = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${mkt}/refresh`,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const prepared = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${mkt}/entries/superpowers/import`,
      payload: {},
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const { stagingId, review } = prepared.json();
    const confirmed = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      payload: { reviewHash: review.reviewHash, deployExtension: false },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const installed = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog/${confirmed.json().item.id}/install`,
      payload: {},
    });
    expect(installed.statusCode, installed.body).toBe(201);

    const listed = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(listed.statusCode, listed.body).toBe(200);
    const skills = listed.json().skills as { id: string; name: string }[];
    const skillId = (n: string) => skills.find((s) => s.name === n)?.id as string;
    const [reviewer] = await agentTemplatesFor(db).listForOrg(orgId);
    expect(reviewer?.type).toBe("superpowers:code-reviewer");

    // the fast tier is mapped (to model-script); capable stays unmapped and falls back
    const mapped = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/model-purposes/subagent_fast`,
      payload: { target: { model: SCRIPT } },
    });
    expect(mapped.statusCode, mapped.body).toBe(200);

    const created = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Builder",
          instructions: INSTRUCTIONS,
          model: SCRIPT,
          tools: ["agent", "sandbox_bash", "sandbox_read", "sandbox_write", "sandbox_edit"].map(
            (name) => ({ kind: "builtin", name }),
          ),
          skills: {
            orgSkills: [
              "subagent-driven-development",
              "requesting-code-review",
              "dispatching-parallel-agents",
            ].map(skillId),
          },
          subagents: { templates: [reviewer?.id as string] },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.agentId = created.json().agent.id as string;
  });

  it("the controller runs the two-task plan: implementer, reviewer, resumed fix, re-review, task 2, parallel final review", async () => {
    capture.reset();
    const conv = await createConv(admin, orgId, state.agentId as string);
    state.conv = conv;
    await postMessage(
      admin,
      orgId,
      conv,
      "SDD-RUN: execute the plan /workspace/plan.md with subagent-driven-development.",
    );
    const [terminal] = await waitForTerminal(db, conv, 1, 150_000);
    expect(terminal?.type, JSON.stringify(terminal?.payload)).toBe("run_finished");
    state.original = structuredClone(sent);

    const events = await eventsOf(db, conv);
    const last = ofType(events, "assistant_message").at(-1);
    expect(last?.payload.content).toEqual([
      {
        type: "text",
        text: "Plan complete: both tasks are implemented, reviewed and committed.",
      },
    ]);

    // the skill's scripts ran in the sandbox
    const results = ofType(events, "tool_result");
    for (const r of results) expect(r.payload.isError, r.payload.content).toBe(false);
    const loads = results.filter((r) => r.payload.toolKey === "skill_load");
    // (the first one also starts the sandbox, whose notice comes first)
    expect(
      loads.map((r) => /Loaded skill "[^"]+" \(version \d+\)\./.exec(r.payload.content)?.[0]),
    ).toEqual([
      'Loaded skill "subagent-driven-development" (version 1).',
      'Loaded skill "dispatching-parallel-agents" (version 1).',
    ]);
    const bash = results.filter((r) => r.payload.toolKey === "sandbox_bash");
    expect(bash.map((r) => r.payload.content.split("\n").at(-1))).toEqual(
      Array(bash.length).fill("[exit code: 0]"),
    );
    const out = bash.map((r) => r.payload.content).join("\n");
    expect(out).toMatch(/wrote \/workspace\/\.superpowers\/sdd\/plan\/task-1-brief\.md: \d+ lines/);
    expect(out).toMatch(/wrote \/workspace\/\.superpowers\/sdd\/plan\/task-2-brief\.md: \d+ lines/);
    expect(out).toContain("wrote /workspace/.superpowers/sdd/plan/review-1.diff: 1 commit(s)");
    expect(out).toContain("wrote /workspace/.superpowers/sdd/plan/review-2.diff: 1 commit(s)");
    expect(out).toContain("wrote /workspace/.superpowers/sdd/plan/final.diff: 3 commit(s)");

    // seven dispatches; the fix is a follow-up of the first implementer
    const dispatched = ofType(events, "subagent_dispatched").map((e) => e.payload);
    expect(dispatched.map((d) => [d.description, d.agentType, d.resumed])).toEqual([
      ["Implement Task 1", "general-purpose", false],
      ["Review Task 1", "general-purpose", false],
      ["Fix Task 1", "general-purpose", true],
      ["Re-review Task 1", "general-purpose", false],
      ["Implement Task 2", "general-purpose", false],
      ["Review Task 2", "general-purpose", false],
      ["Final review", "superpowers:code-reviewer", false],
      ["Check files", "general-purpose", false],
    ]);
    expect(dispatched[2]?.subagentId).toBe(dispatched[0]?.subagentId);
    // tiers: fast is mapped; capable is unmapped and falls back to the parent's model
    const fast = dispatched.filter((d) => d.description.startsWith("Implement"));
    for (const d of fast) {
      expect(d.model).toEqual(SCRIPT);
      expect(d.tierFallback ?? false).toBe(false);
    }
    const final = dispatched.find((d) => d.description === "Final review");
    expect(final?.model).toEqual(SCRIPT);
    expect(final?.tierFallback).toBe(true);

    // every agent result is the child's reply plus the status line
    const agentResults = results.filter((r) => r.payload.toolKey === "agent");
    expect(agentResults).toHaveLength(8);
    for (const r of agentResults) {
      expect(r.payload.content).toMatch(
        /\n\n\[agentId: [^ ]+ · completed · \d+ tool calls? · \d+s · \d+ tokens\. Pass the agentId as resume to send this sub-agent a follow-up\.\]$/,
      );
    }
    expect(agentResults[1]?.payload.content).toContain("greeting.txt has no trailing newline");
    expect(agentResults[2]?.payload.content).toContain("now ends with a newline");
    const finished = ofType(events, "subagent_finished").map((e) => e.payload);
    expect(finished.map((f) => f.status)).toEqual(Array(8).fill("completed"));

    // the parallel pair ran concurrently (the barrier in both first requests needs both)
    expect(agentResults.slice(-2).map((r) => r.payload.content.split("\n")[0])).toEqual([
      "Both tasks match the plan. Ready to merge.",
      "Both files are present with the planned content.",
    ]);
  });

  it("each child's first request holds only its system text and the prompt", async () => {
    const conv = state.conv as string;
    const original = state.original as ModelRequest[];
    const events = await eventsOf(db, conv);
    const prompts = ofType(events, "subagent_dispatched").map((d) => {
      const call = ofType(events, "assistant_message")
        .flatMap((m) => m.payload.content)
        .find((b) => b.type === "tool_call" && b.id === d.payload.callId);
      return {
        resumed: d.payload.resumed,
        type: d.payload.agentType,
        prompt: (call as { input: { prompt: string } }).input.prompt,
      };
    });
    const fresh = prompts.filter((p) => !p.resumed);
    expect(fresh).toHaveLength(7);
    const reviewerBody = (await agentTemplatesFor(db).listForOrg(orgId))[0];
    for (const p of fresh) {
      const first = original.find(
        (r) => isChildRequest(r) && r.messages.length === 1 && textOf(r, 0) === p.prompt,
      );
      expect(first, p.prompt).toBeDefined();
      expect(first?.messages).toEqual([
        { role: "user", content: [{ type: "text", text: p.prompt }] },
      ]);
      const system = first?.system.map((s) => s.text) ?? [];
      expect(system).toHaveLength(1);
      expect(system[0]?.startsWith(`${BEHAVIOR_RULES}\n\n${SUBAGENT_PREAMBLE}\n\n`)).toBe(true);
      if (p.type === "general-purpose") {
        // a copy of the parent: its instructions, no pinned skills
        expect(system[0]).toContain(`${SUBAGENT_PREAMBLE}\n\n${INSTRUCTIONS}`);
        expect(system[0]).not.toContain("<pinned_skill");
      } else {
        expect(reviewerBody?.type).toBe(p.type);
        expect(system[0]).toContain("You are a Senior Code Reviewer");
        expect(system[0]).not.toContain(INSTRUCTIONS);
      }
      // children never see the agent tool
      expect(first?.tools?.map((t) => t.name)).not.toContain("agent");
    }
    // the follow-up's request carries the implementer's earlier history
    const followUp = original.find(
      (r) => isChildRequest(r) && r.messages.some((_m, i) => textOf(r, i).startsWith("FIX-1")),
    );
    expect(textOf(followUp as ModelRequest, 0)).toMatch(/^IMPL-1:/);
  });

  it("the commits are in the shared workspace", async () => {
    const ws = workspaceDir();
    expect(git(ws, "log", "--format=%s").split("\n")).toEqual([
      "feat: farewell file",
      "fix: end greeting.txt with a newline",
      "feat: greeting file",
      "docs: plan",
    ]);
    expect(readFileSync(join(ws, "greeting.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(ws, "farewell.txt"), "utf8")).toBe("bye\n");
    // the SDD workspace stays out of git (sdd-workspace writes its own .gitignore)
    expect(git(ws, "status", "--porcelain")).toBe("");
    // one sandbox, owned by the parent conversation
    const boxes = await db.selectFrom("sandboxes").select("conversation_id").execute();
    expect(boxes.map((b) => b.conversation_id)).toEqual([state.conv]);
  });

  it("the children's usage sums into the parent run's counter", async () => {
    const conv = state.conv as string;
    const kids = await childConversations(conv);
    expect(kids.map((c) => c.subagent_type)).toEqual([
      "general-purpose",
      "general-purpose",
      "general-purpose",
      "general-purpose",
      "general-purpose",
      "superpowers:code-reviewer",
      "general-purpose",
    ]);
    let total = 0;
    for (const c of kids) {
      for (const u of ofType(await eventsOf(db, c.id), "usage")) total += usageTokens(u.payload);
    }
    const [run] = await db
      .selectFrom("runs")
      .select(["subagent_tokens_used", "status"])
      .where("conversation_id", "=", conv)
      .execute();
    expect(run?.status).toBe("completed");
    expect(total).toBeGreaterThan(0);
    expect(Number(run?.subagent_tokens_used)).toBe(total);
    const finished = ofType(await eventsOf(db, conv), "subagent_finished").map((e) => e.payload);
    const fromResults = finished.reduce(
      (n, f) =>
        n +
        f.usage.inputTokens +
        f.usage.outputTokens +
        f.usage.cacheReadTokens +
        f.usage.cacheWriteTokens,
      0,
    );
    expect(fromResults).toBe(total);
  });

  it("each child's steps reconstruct with zero drift", async () => {
    const original = state.original as ModelRequest[];
    const kids = await childConversations(state.conv as string);
    let steps = 0;
    for (const c of kids) {
      for (const run of await runsOf(db, c.id)) {
        const snap = await takeSnapshot(db, orgId, c.id, run.id, 4_194_304);
        const calls = toEvents(snap).filter((e) => e.type === "model_call");
        for (const call of calls) {
          const p = call.payload as EventPayload<"model_call">;
          const info = (
            await k.app.get(ProviderRegistry).resolve({ provider: p.provider, model: p.model })
          ).info;
          const r = reconstructRequest(snap, call.seq, { model: info });
          expect(r.drift, `${c.id} seq ${call.seq}`).toEqual([]);
          expect(
            original.some((o) => isDeepStrictEqual(o, r.request)),
            `${c.id} seq ${call.seq}`,
          ).toBe(true);
          steps += 1;
        }
      }
    }
    expect(steps).toBeGreaterThanOrEqual(16);
  });

  it("a full-run replay of the parent sends the same requests with zero tool_unmatched and starts no sub-agent", async () => {
    const conv = state.conv as string;
    const [run] = await runsOf(db, conv);
    const set = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets`,
      payload: { agentId: state.agentId, name: "SDD" },
    });
    expect(set.statusCode, set.body).toBe(201);
    const setId = set.json().set.id as string;
    const added = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
      payload: { conversationId: conv, runId: run?.id },
    });
    expect(added.statusCode, added.body).toBe(201);
    const countKids = async () =>
      (
        await db
          .selectFrom("conversations")
          .select(db.fn.countAll<string>().as("n"))
          .where("kind", "=", "subagent")
          .executeTakeFirstOrThrow()
      ).n;
    const kidsBefore = await countKids();
    capture.reset();
    const started = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/runs`,
      payload: { mode: "run", candidate: {}, judge: false },
    });
    expect(started.statusCode, started.body).toBe(201);
    const runId = (started.json().run as EvalRunView).id;
    const done = await waitFor(
      async () => {
        const r = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/eval-runs/${runId}` });
        const v = r.json().run as EvalRunView;
        return ["queued", "running"].includes(v.status) ? null : v;
      },
      90_000,
      "eval run finished",
      100,
    );
    expect(done.status).toBe("completed");
    const res = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/eval-runs/${runId}/results?limit=10`,
    });
    const [r] = res.json().results as EvalResultView[];
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    expect(r?.drift).toEqual([]);
    expect((r?.candidate as RunReplayResult | undefined)?.unmatched).toBe(0);
    // the replay sends exactly the parent's requests, none of a child's
    const parentRequests = (state.original as ModelRequest[]).filter((q) => !isChildRequest(q));
    expect(parentRequests).toHaveLength(16);
    expect(normalizeIds(sent)).toEqual(normalizeIds(parentRequests));
    expect(await countKids()).toBe(kidsBefore);
  });
});
