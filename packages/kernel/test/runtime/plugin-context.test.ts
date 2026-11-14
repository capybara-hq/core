import { createHash, randomUUID } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionDeploymentConfigService } from "../../src/extensions/deployment-config.js";
import { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import { createLogger } from "../../src/log.js";
import { PluginContextService } from "../../src/runtime/plugin-context.service.js";
import { RUN_JOB, RUN_QUEUE_NAME } from "../../src/runtime/run-jobs.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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

/**
 * Memory plugin spec §6.1: at a chat run's start the kernel asks every `context@1` provider enabled
 * in the org and appends a `plugin_context` event when a provider's text changed. `fake-context`
 * answers per its deployment config (`text`, `mode`) and records each request.
 */

const PLUGIN = "fake-context";
const NOTE = "plugin__fake-context__note";

type Call = {
  orgId: string;
  accountId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  runId: string;
  source: string;
  role: string;
  ownerAccountId: string;
  ownerName: string;
  tools: string[];
  config: unknown;
};
type Line = { level: string; msg: string; context?: string; plugin?: string; reason?: string };

const calls = (): Call[] => {
  const g = globalThis as { __fakeContext?: { calls: Call[] } };
  g.__fakeContext ??= { calls: [] };
  return g.__fakeContext.calls;
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
const lines: Line[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)] },
    ),
    { logger: createLogger("warn", { write: (l) => lines.push(JSON.parse(l) as Line) }) },
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let member: Req;
let ownerId: string;
let memberId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  // a super admin too: the fixture's deployment config is the platform's
  ownerId = (
    await accounts.createLocal({ login: "owner", password: PW, displayName: "O", superAdmin: true })
  ).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "Mia" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  member = await session(k, "mem");
  await setSwitch(true);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Keeper",
        instructions: "Be brief.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  await configure({});
  calls().length = 0;
  lines.length = 0;
});

/** Switches the fixture on or off in the org. */
async function setSwitch(enabled: boolean): Promise<void> {
  const r = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${PLUGIN}`,
    payload: { enabled },
  });
  expect(r.statusCode, r.body).toBe(200);
}

/** Stores the fixture's deployment config, both fields (defaults: text "fake context", mode ok). */
const configure = (cfg: { text?: string; mode?: "ok" | "null" | "throw" | "hang" }) =>
  k.app
    .get(ExtensionDeploymentConfigService)
    .put(PLUGIN, { text: "fake context", mode: "ok", ...cfg }, ownerId);

/** Posts a message and waits for the conversation's `n`-th run to end. */
async function run(req: Req, conv: string, n: number, text = "echo:hi"): Promise<void> {
  await postMessage(req, orgId, conv, text);
  const ends = await waitForTerminal(db, conv, n, 20_000);
  expect(ends[n - 1]?.type).toBe("run_finished");
}

type ContextEvent = Extract<ConversationEvent, { type: "plugin_context" }>;
const contexts = async (conv: string) =>
  (await eventsOf(db, conv)).filter((e): e is ContextEvent => e.type === "plugin_context");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const warned = () =>
  lines.filter((l) => l.level === "warn" && l.context === "PluginContextService");

describe("context@1 providers at run start", () => {
  it("appends the text when it changes, nothing when it does not, an empty event for null", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    const [first] = await contexts(conv);
    expect(first?.payload).toEqual({
      plugin: PLUGIN,
      text: "fake context",
      hash: sha256("fake context"),
    });
    // written at run start: after the run context, before the run's model call
    const events = await eventsOf(db, conv);
    const at = (type: string) =>
      events.findIndex((e) => e.type === type && e.runId === first?.runId);
    expect(at("run_context")).toBeLessThan(at("plugin_context"));
    expect(at("plugin_context")).toBeLessThan(at("model_call"));

    await run(owner, conv, 2);
    expect(await contexts(conv)).toHaveLength(1);

    await configure({ text: "changed" });
    await run(owner, conv, 3);
    expect((await contexts(conv)).map((e) => e.payload.text)).toEqual(["fake context", "changed"]);

    await configure({ mode: "null" });
    await run(owner, conv, 4);
    await run(owner, conv, 5);
    expect((await contexts(conv)).map((e) => [e.payload.text, e.payload.hash])).toEqual([
      ["fake context", sha256("fake context")],
      ["changed", sha256("changed")],
      ["", sha256("")],
    ]);
    expect(calls()).toHaveLength(5);
    expect(warned()).toEqual([]);
  });

  it("a provider with nothing in a new conversation writes nothing", async () => {
    await configure({ mode: "null" });
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    expect(calls()).toHaveLength(1);
    expect(await contexts(conv)).toEqual([]);
  });

  it("a provider that throws or hangs is skipped and logged; the run goes on", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    for (const [mode, reason] of [
      ["throw", "threw: fake-context: scripted failure"],
      ["hang", "timed out"],
    ] as const) {
      await configure({ mode });
      lines.length = 0;
      const started = Date.now();
      await run(owner, conv, mode === "throw" ? 2 : 3);
      // the hang costs the 2 s limit, not the run
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(warned()).toMatchObject([{ plugin: PLUGIN, reason }]);
    }
    // the earlier text stays in effect: no new event
    expect((await contexts(conv)).map((e) => e.payload.text)).toEqual(["fake context"]);
  });

  it("text over 32 KB is dropped", async () => {
    await configure({ text: "x".repeat(32_769) });
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    expect(await contexts(conv)).toEqual([]);
    expect(warned()).toMatchObject([
      { plugin: PLUGIN, reason: "text of 32769 bytes is over 32768" },
    ]);
    await configure({ text: "x".repeat(32_768) });
    await run(owner, conv, 2);
    expect((await contexts(conv)).map((e) => e.payload.text.length)).toEqual([32_768]);
  });

  it("switching the plugin off in the org appends an empty event", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    await setSwitch(false);
    await run(owner, conv, 2);
    await run(owner, conv, 3);
    expect((await contexts(conv)).map((e) => e.payload.text)).toEqual(["fake context", ""]);
    expect(calls()).toHaveLength(1);
  });

  it("the request names the run, its people and the plugin's tools in this source", async () => {
    // a member's own web conversation
    const conv = await createConv(member, orgId, agentId);
    await run(member, conv, 1);
    const [req] = calls();
    expect(req).toMatchObject({
      orgId,
      accountId: memberId,
      agentId,
      agentName: "Keeper",
      conversationId: conv,
      source: "web",
      role: "member",
      ownerAccountId: memberId,
      ownerName: "Mia",
      tools: [NOTE],
      config: { text: "fake context", mode: "ok" },
    });
    // a group conversation: the tool limited to one-to-one sources is not in the run
    const group = await createConv(owner, orgId, agentId);
    await sql`UPDATE capybara.conversations SET source = 'channel_group' WHERE id = ${group}`.execute(
      raw,
    );
    await run(owner, group, 1);
    expect(calls()[1]).toMatchObject({
      source: "channel_group",
      role: "owner",
      ownerName: "O",
      tools: [],
    });
  });

  it("a sub-agent run never asks the providers", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await run(
      owner,
      conv,
      1,
      `tool:Agent:${JSON.stringify({ description: "Look", prompt: "echo:child", subagent_type: "general-purpose" })}`,
    );
    const dispatched = (await eventsOf(db, conv)).find((e) => e.type === "subagent_dispatched");
    const child = (dispatched?.payload as { subagentId?: string } | undefined)?.subagentId;
    expect(child).toBeTruthy();
    await waitFor(
      async () => (await waitForTerminal(db, child as string, 1, 20_000)).length > 0,
      20_000,
      "the child's run",
    );
    expect(calls().map((c) => c.conversationId)).toEqual([conv]);
    expect(await contexts(child as string)).toEqual([]);
  });

  it("a provider whose config cannot be read keeps its recorded text (fail open)", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    // the next run start's read of the fixture's effective config fails once (a transient error)
    const effective = k.app.get(EffectiveConfigs);
    const real = effective.get.bind(effective);
    let failed = 0;
    const spy = vi.spyOn(effective, "get").mockImplementation(async (org, plugin) => {
      if (plugin === PLUGIN && failed === 0) {
        failed++;
        throw new Error("connection terminated unexpectedly");
      }
      return real(org, plugin);
    });
    try {
      await run(owner, conv, 2);
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(1);
    // not asked, not switched off: the text stays as recorded
    expect(calls()).toHaveLength(1);
    expect((await contexts(conv)).map((e) => e.payload.text)).toEqual(["fake context"]);
    expect(
      lines.some(
        (l) =>
          l.level === "warn" &&
          l.context === "ExtensionPointDefaults" &&
          (l as { extension?: string }).extension === PLUGIN,
      ),
    ).toBe(true);
    await run(owner, conv, 3);
    expect(calls()).toHaveLength(2);
    expect(await contexts(conv)).toHaveLength(1);
  });

  it("a stored org config that no longer validates switches the provider off", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await run(owner, conv, 1);
    // e.g. after a plugin upgrade: the org's stored config no longer matches the schema
    await sql`UPDATE capybara.extension_org_configs SET config = '{"label": 5}'::jsonb
      WHERE plugin = ${PLUGIN} AND org_id = ${orgId}`.execute(raw);
    lines.length = 0;
    await run(owner, conv, 2);
    // not asked, and its recorded text is blanked (as for an invalid effective config)
    expect(calls()).toHaveLength(1);
    expect((await contexts(conv)).map((e) => e.payload.text)).toEqual(["fake context", ""]);
    expect(
      lines.some(
        (l) =>
          l.level === "warn" &&
          l.context === "ExtensionPointDefaults" &&
          (l as { extension?: string }).extension === PLUGIN &&
          l.msg.includes("stored org config is invalid"),
      ),
    ).toBe(true);
  });

  it("an eval conversation's run in the run worker never asks the providers", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await sql`UPDATE capybara.conversations SET kind = 'eval' WHERE id = ${conv}`.execute(raw);
    // the run worker executes a run of the row's kind: a message, a queued run and its job
    const [msg] = await k.app.get(EventLog).append(conv, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: "echo:hi" }], authorAccountId: ownerId },
      },
    ]);
    const runId = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conv,
        status: "queued",
        agent_version: 1,
        trigger_account_id: ownerId,
        trigger_seq: msg?.seq ?? 0,
      })
      .execute();
    // a hand-made run: its job is added directly (the kernel owes it through the outbox)
    await k.app
      .get<Queue>(getQueueToken(RUN_QUEUE_NAME))
      .add(RUN_JOB, { runId, conversationId: conv }, { jobId: `run-eval-${runId}` });
    const ends = await waitForTerminal(db, conv, 1, 20_000);
    expect(ends[0]?.runId).toBe(runId);
    expect(calls()).toEqual([]);
    expect(await contexts(conv)).toEqual([]);
  });

  it("an eval or sub-agent kind never asks the providers", async () => {
    const conv = await createConv(owner, orgId, agentId);
    for (const kind of ["eval", "subagent"] as const) {
      await k.app.get(PluginContextService).record({
        orgId,
        conversationId: conv,
        runId: crypto.randomUUID(),
        agentId,
        agentName: "Keeper",
        ownerAccountId: ownerId,
        ownerName: "O",
        triggerAccountId: ownerId,
        source: "web",
        role: "owner",
        kind,
        toolKeysByPlugin: async () => new Map(),
        signal: new AbortController().signal,
      });
    }
    expect(calls()).toEqual([]);
    expect(await contexts(conv)).toEqual([]);
  });
});
