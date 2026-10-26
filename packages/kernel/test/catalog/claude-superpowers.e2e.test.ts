import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillMd } from "@capybara-hq/plugin-sdk";
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
import type { TranslationReport } from "../../src/catalog/claude/report.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { RunReplayResult } from "../../src/evals/run-replay.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { pinnedBlock } from "../../src/runtime/context/skills.js";
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
import { CLAUDE_FIXTURES, loadFixtureAsStrings } from "./claude-fixtures.js";

/**
 * Spec §12, phase B acceptance, end to end on one kernel: an enterprise admin adds the superpowers
 * repository (the checked-in fixture on a local fake git server, no network) as a git marketplace
 * and imports superpowers through the one review; an org installs it; an agent pins
 * using-superpowers; model-fake loads brainstorming by its qualified and its plain name; replaying
 * the conversation (step reconstruction and a full-run replay) reproduces its requests exactly.
 * The `it`s run in order and share state.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

const capture = captureProviderRequests();
const { sent } = capture;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let k: Kernel;
let admin: Req;
let orgId: string;

/** Shared between the steps. */
const state: {
  itemId?: string;
  skillIds?: Record<string, string>;
  agentId?: string;
  convId?: string;
  /** Provider requests of the original conversation (copied before the replay adds its own). */
  original?: typeof sent;
} = {};

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-claude-e2e-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensionHost: { dir: pluginsDir },
        marketplaces: { allowInsecureLoopback: true, allowedHosts: ["127.0.0.1"] },
        extensions: [MODEL_FAKE, OBJECT_STORE],
        extensionConfig: {
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
  await new AccountsService(db).createLocal({
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
  await k?.stop();
  await destroyDb?.();
  await srv?.stop();
  if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

const body = (skill: string): string => {
  const parsed = parseSkillMd(
    readFileSync(join(CLAUDE_FIXTURES, "superpowers", "skills", skill, "SKILL.md"), "utf8"),
  );
  if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
  return parsed.body;
};

const item = (r: TranslationReport, code: string, name: string) =>
  r.items.find((i) => i.code === code && i.name === name);

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;
type ModelCall = Extract<ConversationEvent, { type: "model_call" }>;

describe("phase B acceptance: superpowers from a git marketplace", { timeout: 120_000 }, () => {
  it("adding the superpowers repo as a git marketplace and importing superpowers; the report lists hooks, commands and the other ignored parts", async () => {
    const files = loadFixtureAsStrings("superpowers");
    await srv.commit("superpowers", files);
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
    expect(refreshed.json()).toMatchObject({ lastStatus: "ok", entryCount: 1, skipped: [] });
    const listed = await admin({
      method: "GET",
      url: `/api/v1/admin/marketplaces/entries?sourceId=${mkt}`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items).toMatchObject([
      { name: "superpowers", version: "7.0.1", format: "claude-code", importable: true },
    ]);

    const prepared = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${mkt}/entries/superpowers/import`,
      payload: {},
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const { stagingId, review } = prepared.json();
    expect(review).toMatchObject({
      name: "superpowers",
      version: "7.0.1",
      format: "claude-code",
      license: "MIT",
      licenseText: files.LICENSE,
    });
    expect(review.extension).toBeUndefined();
    const report = review.translation as TranslationReport;
    expect(report.format).toBe("claude-code");
    expect(report.sessionStart).toBe(true);
    expect(item(report, "hooks_not_run", "SessionStart")?.group).toBe("ignored");
    expect(item(report, "command_manual_invocation", "brainstorm")?.group).toBe("ignored");
    expect(item(report, "agent_needs_subagents", "code-reviewer")?.group).toBe("ignored");
    expect(item(report, "other_harness", ".codex-plugin")?.group).toBe("ignored");
    expect(report.items.filter((i) => i.code === "skill_imported").map((i) => i.name)).toEqual([
      "brainstorming",
      "test-driven-development",
      "using-superpowers",
      "writing-plans",
    ]);

    // the admin ticks using-superpowers as pinned in the same review
    const confirmed = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      payload: {
        reviewHash: review.reviewHash,
        deployExtension: false,
        pinnedSuggestions: ["using-superpowers"],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    state.itemId = confirmed.json().item.id as string;
  });

  it("the admin ticks using-superpowers as pinned and the org installs it; an agent selects the skills and pins using-superpowers", async () => {
    const installed = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog/${state.itemId}/install`,
      payload: {},
    });
    expect(installed.statusCode, installed.body).toBe(201);
    const listed = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    expect(listed.statusCode, listed.body).toBe(200);
    const skills = listed.json().skills as {
      id: string;
      name: string;
      plugin?: string;
      sourceFormat?: string;
      suggestPinned?: boolean;
    }[];
    expect(skills.map((s) => [s.name, s.plugin, s.sourceFormat, s.suggestPinned])).toEqual([
      ["brainstorming", "superpowers", "claude-code", false],
      ["test-driven-development", "superpowers", "claude-code", false],
      ["using-superpowers", "superpowers", "claude-code", true],
      ["writing-plans", "superpowers", "claude-code", false],
    ]);
    const ids = Object.fromEntries(skills.map((s) => [s.name, s.id]));
    state.skillIds = ids;
    const created = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Builder",
          instructions: "Help build features.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [],
          skills: {
            orgSkills: skills.map((s) => s.id),
            pinned: [ids["using-superpowers"]],
          },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = created.json().agent as {
      id: string;
      definition: { skills: { pinned: string[] } };
    };
    expect(agent.definition.skills.pinned).toEqual([ids["using-superpowers"]]);
    state.agentId = agent.id;
  });

  it("asked for a new feature, the model loads brainstorming first (superpowers:brainstorming also loads)", async () => {
    capture.reset();
    const conv = await createConv(admin, orgId, state.agentId as string);
    state.convId = conv;
    await postMessage(admin, orgId, conv, 'tool:skill_load:{"name":"superpowers:brainstorming"}');
    await waitForTerminal(db, conv, 1, 30_000);
    await postMessage(admin, orgId, conv, 'tool:skill_load:{"name":"brainstorming"}');
    await waitForTerminal(db, conv, 2, 30_000);

    const first = sent[0];
    const system = first?.system[0]?.text ?? "";
    const pinned = pinnedBlock({
      id: state.skillIds?.["using-superpowers"] as string,
      version: 1,
      name: "using-superpowers",
      source: "",
      body: body("using-superpowers"),
    });
    expect(system).toContain('<pinned_skill name="using-superpowers" version="1">');
    expect(system).toContain(pinned);
    expect(system).toContain(CLAUDE_CODE_TOOL_MAP);

    const events = await eventsOf(db, conv);
    const results = events.filter((e): e is ToolResult => e.type === "tool_result");
    expect(results).toHaveLength(2);
    const brainstorming = body("brainstorming").trim();
    for (const r of results) {
      expect(r.payload.toolKey).toBe("skill_load");
      expect(r.payload.isError, r.payload.content).toBe(false);
      expect(r.payload.content).toContain(brainstorming);
    }
    const runs = await runsOf(db, conv);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    state.original = structuredClone(sent);
  });

  it("replaying that conversation reproduces its requests exactly", async () => {
    const conv = state.convId as string;
    const runs = await runsOf(db, conv);
    const last = runs.at(-1) as { id: string };
    const snap = await takeSnapshot(db, orgId, conv, last.id, 4_194_304);
    const calls = toEvents(snap).filter((e): e is ModelCall => e.type === "model_call");
    const original = state.original as typeof sent;
    expect(calls).toHaveLength(original.length);
    expect(calls.length).toBe(4);
    for (const [i, c] of calls.entries()) {
      const info = (
        await k.runs.registry.resolve({ provider: c.payload.provider, model: c.payload.model })
      ).info;
      const out = reconstructRequest(snap, c.seq, { model: info });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(original[i]);
    }

    // a full-run replay of the last run: recorded tool results only, the same requests
    const set = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets`,
      payload: { agentId: state.agentId, name: "Superpowers" },
    });
    expect(set.statusCode, set.body).toBe(201);
    const setId = set.json().set.id as string;
    const added = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
      payload: { conversationId: conv, runId: last.id },
    });
    expect(added.statusCode, added.body).toBe(201);
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
        const run = r.json().run as EvalRunView;
        return ["queued", "running"].includes(run.status) ? null : run;
      },
      60_000,
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
    const candidate = r?.candidate as RunReplayResult;
    expect(candidate.unmatched).toBe(0);
    expect(candidate.toolCalls).toEqual([{ name: "skill_load", input: { name: "brainstorming" } }]);
    // the replayed run sends exactly the requests of the original last run (its two steps)
    expect(sent).toEqual(original.slice(2));
  });
});
