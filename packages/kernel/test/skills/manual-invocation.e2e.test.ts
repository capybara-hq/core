import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { AgentTemplatesService } from "../../src/agents/templates.js";
import type { TranslationReport } from "../../src/catalog/claude/report.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { loadFixtureAsStrings } from "../catalog/claude-fixtures.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Phase D acceptance (plan Task 12), end to end on one kernel: an enterprise admin imports the
 * `commands-demo` Claude Code plugin (a checked-in fixture on a local fake git server, no network)
 * and an org installs it; an agent selects all its skills. The model's catalog lists the command
 * `fix-issue` and the forked `review`, never the manual-only `manual-script`; the model loads
 * `fix-issue` with `$ARGUMENTS` as written; the person invokes `/fix-issue 123` inline,
 * `/manual-script` (the model then copies its script to the sandbox) and the forked `/review src`
 * (a `commands-demo:code-reviewer` sub-agent reports, the parent answers); every model request of
 * the conversation and of the sub-agent reconstructs from the log with `drift: []`.
 * model-script (a fake provider driven by rules), the fake sandbox and SeaweedFS.
 * The `it`s run in order and share state.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SCRIPT = { provider: "model-script", model: "script-1" };

const CHILD = "You are a sub-agent";
const RULES: ScriptRule[] = [
  // the sub-agent that runs the forked skill
  { when: { systemIncludes: CHILD }, reply: { text: "child report: src/a.ts:1 is fine" } },
  // tool results first (the last message with text is still the request that called the tool)
  { when: { lastToolResultIncludes: "Fix GitHub issue" }, reply: { text: "loaded fix-issue" } },
  { when: { lastToolResultIncludes: "manual-script" }, reply: { text: "copied the script" } },
  { when: { lastUserIncludes: "Report from the sub-agent" }, reply: { text: "parent answered" } },
  {
    when: { lastUserIncludes: "LOAD fix-issue" },
    reply: { toolCalls: [{ name: "skill_load", input: { name: "fix-issue" } }] },
  },
  {
    when: { lastUserIncludes: '<skill_invocation name="manual-script"' },
    reply: { toolCalls: [{ name: "skill_load", input: { name: "manual-script" } }] },
  },
  { when: {}, reply: { text: "done" } },
];

const capture = captureProviderRequests();
const { sent } = capture;

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelDb;
let destroyDb: () => Promise<void>;
let srv: FakeGitServer;
let pluginsDir: string;
let root: string;
let k: Kernel;
let admin: Req;
let orgId: string;

const state: { itemId?: string; agentId?: string; convId?: string } = {};

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  srv = await startFakeGitServer();
  pluginsDir = await mkdtemp(join(tmpdir(), "kernel-phase-d-e2e-"));
  root = await mkdtemp(join(tmpdir(), "kernel-phase-d-sandbox-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensionHost: { dir: pluginsDir },
        marketplaces: { allowInsecureLoopback: true, allowedHosts: ["127.0.0.1"] },
        extensions: [MODEL_SCRIPT, OBJECT_STORE, SANDBOX_FAKE],
        extensionConfig: {
          "model-script": { rules: RULES },
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
          "sandbox-fake": { root },
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
  if (root) await rm(root, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const texts = (content: readonly { type: string; text?: string }[] | string): string[] =>
  typeof content === "string"
    ? [content]
    : content.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : []));
const lastReply = (events: ConversationEvent[]) =>
  texts(ofType(events, "assistant_message").at(-1)?.payload.content ?? []).join("");
const isChild = (r: { system: { text: string }[] }) => r.system.some((s) => s.text.includes(CHILD));

async function send(payload: { text: string; skill?: { name: string } }): Promise<number> {
  const res = await admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${state.convId}/messages`,
    payload,
  });
  expect(res.statusCode, res.body).toBe(202);
  return (res.json() as { event: { seq: number } }).event.seq;
}

async function sandboxFile(convId: string, path: string): Promise<string | null> {
  const row = await db
    .selectFrom("sandboxes")
    .select("handle")
    .where("conversation_id", "=", convId)
    .executeTakeFirstOrThrow();
  const id = (row.handle as { id: string }).id;
  return readFile(join(root, "instances", id, "fs", path), "utf8").catch(() => null);
}

describe("phase D acceptance: commands, manual-only and forked skills", {
  timeout: 120_000,
}, () => {
  it("importing commands-demo from git: the command, the manual-only and the forked skill are imported", async () => {
    await srv.commit("commands-demo", loadFixtureAsStrings("commands-demo"));
    const added = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces",
      payload: { name: "Demo", url: srv.url("commands-demo"), form: "git" },
    });
    expect(added.statusCode, added.body).toBe(201);
    const mkt = added.json().id as string;
    const refreshed = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${mkt}/refresh`,
    });
    expect(refreshed.json()).toMatchObject({ lastStatus: "ok", entryCount: 1 });
    const prepared = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${mkt}/entries/commands-demo/import`,
      payload: {},
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const { stagingId, review } = prepared.json();
    const report = review.translation as TranslationReport;
    const codes = report.items.map((i) => [i.code, i.name]);
    expect(codes).toContainEqual(["command_imported", "fix-issue"]);
    expect(codes).toContainEqual(["skill_imported", "manual-script"]);
    expect(codes).toContainEqual(["skill_imported", "review"]);
    expect(codes).toContainEqual(["agent_imported", "code-reviewer"]);
    const confirmed = await admin({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${stagingId}/confirm`,
      payload: { reviewHash: review.reviewHash, deployExtension: false },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    state.itemId = confirmed.json().item.id as string;
  });

  it("the org installs it; an agent selects all its skills and the code-reviewer template", async () => {
    const installed = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog/${state.itemId}/install`,
      payload: {},
    });
    expect(installed.statusCode, installed.body).toBe(201);
    const listed = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    const skills = listed.json().skills as {
      id: string;
      name: string;
      plugin?: string;
      manual?: boolean;
      fork?: boolean;
    }[];
    expect(skills.map((s) => [s.name, s.plugin, s.manual, s.fork])).toEqual([
      ["fix-issue", "commands-demo", false, false],
      ["manual-script", "commands-demo", true, false],
      ["review", "commands-demo", false, true],
    ]);
    const templates = await new AgentTemplatesService(db).listForOrg(orgId);
    expect(templates.map((t) => t.type)).toEqual(["commands-demo:code-reviewer"]);
    const created = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Fixer",
          instructions: "Fix what you are asked to.",
          model: SCRIPT,
          // a sandbox tool: skill_load copies a skill's files only for an agent that can run them
          tools: [{ kind: "builtin", name: "sandbox_bash" }],
          skills: { orgSkills: skills.map((s) => s.id) },
          subagents: { templates: templates.map((t) => t.id) },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.agentId = (created.json().agent as { id: string }).id;

    // the / menu lists all three, with the hint and the tags
    const menu = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/${state.agentId}/invocable-skills`,
    });
    expect(menu.statusCode, menu.body).toBe(200);
    expect(
      (
        menu.json().skills as {
          name: string;
          argumentHint?: string;
          manual: boolean;
          fork: boolean;
        }[]
      ).map((s) => [s.name, s.argumentHint, s.manual, s.fork]),
    ).toEqual([
      ["fix-issue", "[issue-number]", false, false],
      ["manual-script", undefined, true, false],
      ["review", "[path]", false, true],
    ]);
  });

  it("the catalog lists fix-issue and review, not manual-script; the model's skill_load returns $ARGUMENTS as written", async () => {
    capture.reset();
    state.convId = await createConv(admin, orgId, state.agentId as string);
    await send({ text: "LOAD fix-issue" });
    await waitForTerminal(db, state.convId, 1, 30_000);
    const events = await eventsOf(db, state.convId);
    const catalog = ofType(events, "skills_catalog")[0];
    expect(catalog?.payload.skills.map((s) => s.name)).toEqual(["fix-issue", "review"]);
    const system = sent[0]?.system.map((s) => s.text).join("\n") ?? "";
    expect(system).toContain("fix-issue");
    expect(system).not.toContain("manual-script");
    const loaded = ofType(events, "tool_result")[0];
    expect(loaded?.payload.toolKey).toBe("skill_load");
    expect(loaded?.payload.isError, loaded?.payload.content).toBe(false);
    expect(loaded?.payload.content).toContain(
      "Fix GitHub issue $ARGUMENTS following our coding standards.",
    );
    expect(lastReply(events)).toBe("loaded fix-issue");
  });

  it("/fix-issue 123 renders the command with its arguments inside <skill_invocation>", async () => {
    const seq = await send({ text: "123", skill: { name: "fix-issue" } });
    await waitForTerminal(db, state.convId as string, 2, 30_000);
    const events = await eventsOf(db, state.convId as string);
    const msg = ofType(events, "user_message").find((e) => e.seq === seq);
    expect(msg?.payload.skill).toMatchObject({
      name: "fix-issue",
      arguments: "123",
      mode: "inline",
    });
    const text = texts(msg?.payload.content ?? [])[0] ?? "";
    expect(text).toMatch(
      /<skill_invocation name="fix-issue" version="1">\n+Fix GitHub issue 123 following our coding standards\./,
    );
    expect(lastReply(events)).toBe("done");
  });

  it("/manual-script, then the model's skill_load copies scripts/run.sh to the sandbox", async () => {
    const seq = await send({ text: "", skill: { name: "manual-script" } });
    await waitForTerminal(db, state.convId as string, 3, 30_000);
    const events = await eventsOf(db, state.convId as string);
    const msg = ofType(events, "user_message").find((e) => e.seq === seq);
    expect(msg?.payload.skill).toMatchObject({ name: "manual-script", mode: "inline" });
    expect(texts(msg?.payload.content ?? [])[0]).toContain(
      'call skill_load with "manual-script" to copy them to /skills/manual-script/',
    );
    const loaded = ofType(events, "tool_result").at(-1);
    expect(loaded?.payload.toolKey).toBe("skill_load");
    expect(loaded?.payload.isError, loaded?.payload.content).toBe(false);
    expect(loaded?.payload.content).toContain("/skills/manual-script/");
    expect(await sandboxFile(state.convId as string, "skills/manual-script/scripts/run.sh")).toBe(
      '#!/bin/sh\necho "manual-script ok"\n',
    );
    expect(lastReply(events)).toBe("copied the script");
    // still never in the model's catalog
    for (const c of ofType(events, "skills_catalog")) {
      expect(c.payload.skills.map((s) => s.name)).not.toContain("manual-script");
    }
  });

  it("/review src runs commands-demo:code-reviewer; the parent answers its report", async () => {
    const seq = await send({ text: "src", skill: { name: "review" } });
    await waitForTerminal(db, state.convId as string, 4, 60_000);
    const events = await eventsOf(db, state.convId as string);
    const msg = ofType(events, "user_message").find((e) => e.seq === seq);
    expect(msg?.payload.skill).toMatchObject({
      name: "review",
      mode: "fork",
      agentType: "commands-demo:code-reviewer",
      arguments: "src",
    });
    const dispatched = ofType(events, "subagent_dispatched").find(
      (d) => d.payload.invokedSeq === seq,
    );
    expect(dispatched?.payload.agentType).toBe("commands-demo:code-reviewer");
    const report = ofType(events, "skill_fork_result").find((r) => r.payload.invokedSeq === seq);
    expect(report?.payload.text).toContain("child report: src/a.ts:1 is fine");
    expect(lastReply(events)).toBe("parent answered");
    const child = sent.filter(isChild)[0];
    expect(JSON.stringify(child?.messages)).toContain(
      "Review src carefully and report the problems you find.",
    );
  });

  it("the whole conversation, the sub-agent included, reconstructs with drift []", async () => {
    const conv = state.convId as string;
    const runs = await runsOf(db, conv);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed", "completed", "completed"]);
    const last = runs.at(-1) as { id: string };
    const snap = await takeSnapshot(db, orgId, conv, last.id, 4_194_304);
    const calls = ofType(toEvents(snap), "model_call");
    const parentSent = sent.filter((r) => !isChild(r));
    expect(calls).toHaveLength(parentSent.length);
    const info = (await k.runs.registry.resolve(SCRIPT)).info;
    for (const [i, c] of calls.entries()) {
      const out = reconstructRequest(snap, c.seq, { model: info });
      expect(out.drift, `parent model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `parent model_call seq ${c.seq}`).toEqual(parentSent[i]);
    }
    const kid = await db
      .selectFrom("conversations")
      .select("id")
      .where("parent_conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const [childRun] = await runsOf(db, kid.id);
    const childSnap = await takeSnapshot(
      db,
      orgId,
      kid.id,
      (childRun as { id: string }).id,
      4_194_304,
    );
    const childCalls = ofType(toEvents(childSnap), "model_call");
    const childSent = sent.filter(isChild);
    expect(childCalls).toHaveLength(childSent.length);
    for (const [i, c] of childCalls.entries()) {
      const out = reconstructRequest(childSnap, c.seq, { model: info });
      expect(out.drift, `child model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `child model_call seq ${c.seq}`).toEqual(childSent[i]);
    }
  });
});
