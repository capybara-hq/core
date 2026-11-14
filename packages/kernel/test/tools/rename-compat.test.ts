import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { legacyScopeOf, recordedCalls } from "../../src/evals/recorded-tools.js";
import { runBaseline } from "../../src/evals/run-replay.js";
import { caseBase, versionDefinition } from "../../src/evals/runs.service.js";
import {
  type CaseSnapshot,
  readSnapshot,
  replayableCalls,
  toEvents,
} from "../../src/evals/snapshot.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { countLegacyToolKeys, warnLegacyToolKeys } from "../../src/tools/legacy-data.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  enableConnectorExtensions,
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
 * T22（D17 / C27 / C28）：「应用」改名「连接器」之后的兼容性。
 * - 改名前录制的会话（MCP 连接器工具、tool_search 加载、connection_required、审批）由日志还原零漂移；
 * - 已存 agent 版本里的 `{kind:"app", appId}` 能读、能跑，工具 key 不变；
 * - `/connectors` 路由可用，旧的 `/apps` 返回 404（无兼容别名）。
 */

type Fixture = { model: ModelInfo; snapshot: CaseSnapshot; requests: ModelRequest[] };
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../evals/fixtures/pre-rename/mcp-conversation.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

describe("改名前录制的会话：还原零漂移", () => {
  const calls = toEvents(fixture.snapshot).filter(
    (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
  );

  it("夹具覆盖连接器工具、tool_search、connection_required 与审批", () => {
    const types = new Set(fixture.snapshot.events.map((e) => e.type));
    for (const t of ["connection_required", "approval_requested", "approval_decided"]) {
      expect(types.has(t as ConversationEvent["type"]), t).toBe(true);
    }
    const keys = fixture.snapshot.events
      .filter((e) => e.type === "tool_result")
      .map((e) => (e.payload as { toolKey: string }).toolKey);
    expect(keys).toEqual(["tool_search", "docs__search", "priv__search", "docs__delete_doc"]);
    expect(calls).toHaveLength(fixture.requests.length);
    expect(replayableCalls(fixture.snapshot).length).toBeGreaterThan(0);
  });

  it("每次 model_call：reconstructRequest 无漂移，请求与供应商当时收到的逐项相等", () => {
    for (const [i, c] of calls.entries()) {
      const out = reconstructRequest(fixture.snapshot, c.seq, { model: fixture.model });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(fixture.requests[i]);
    }
  });
});

describe("a recording made before the tool rename (full-run replay input)", () => {
  const rc = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../evals/fixtures/pre-tool-rename/conversation.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as Fixture;

  /** The snapshot seen as each of its runs (replay reads one run's calls). */
  const perRun = [...new Set(rc.snapshot.events.flatMap((e) => (e.runId ? [e.runId] : [])))].map(
    (runId) => ({ ...rc.snapshot, runId }),
  );

  it("reads the connectors and extensions from the snapshot alone", () => {
    const scope = legacyScopeOf(rc.snapshot);
    expect([...scope.extensionNames]).toEqual(["tools-probe"]);
    expect([...scope.connectorSlugs]).toEqual(["docs"]);
  });

  it("recorded calls are keyed by the current names and parameters; nothing is left in rc form", () => {
    const calls = perRun.flatMap((snap) => recordedCalls(snap));
    const keys = calls.map((c) => c.toolKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Skill",
        "ToolSearch",
        "ReadToolOutput",
        "mcp__docs__search",
        "plugin__tools-probe__echo",
      ]),
    );
    expect(keys.filter((k) => /^(sandbox_|skill_|tool_search|read_tool_output)/.test(k))).toEqual(
      [],
    );
    expect(calls.every((c) => c.legacy === true)).toBe(true);
    const edit = calls.find((c) => c.toolKey === "Edit");
    expect(edit?.inputKey).toBe(
      '{"file_path":"/workspace/src/b.md","new_string":"gamma","old_string":"alpha","replace_all":true}',
    );
    // the timeout is milliseconds now; the display-only description is ignored when matching
    const bash = calls.find((c) => c.toolKey === "Bash" && c.inputKey.includes("timeout"));
    expect(bash?.inputKey).toBe(
      '{"command":"mkdir -p /workspace/src && echo hello > /workspace/src/a.txt","timeout":20000}',
    );
  });

  it("the baseline summary names the same current tools", () => {
    const names = perRun.flatMap((snap) => runBaseline(snap).toolCalls.map((c) => c.name));
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((n) => /^(sandbox_|skill_load|tool_search|read_tool_output)/.test(n)),
    ).toEqual([]);
  });
});

const CONNECTOR = fakeExtensionEntry("fake-connector");

/**
 * One kernel and one fake MCP server for both legacy-key suites below (each suite makes its own
 * org): the rename compatibility tests and the release-candidate data after the upgrade.
 */
let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let mcp: FakeMcpServer;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  mcp = await startFakeMcpServer({
    tools: [
      {
        name: "search",
        description: "Search documents",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
        handler: ({ args }) => ({ content: [{ type: "text", text: `hits for ${args.q}` }] }),
      },
    ],
  });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CONNECTOR],
        extensionConfig: { "fake-connector": { allowInsecureLoopback: true } },
        roles: ["api", "worker"],
      },
    ),
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
});

afterAll(async () => {
  await k?.close();
  await mcp?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("改名后的路由与旧 agent 版本", () => {
  let req: Req;
  let orgId: string;

  beforeAll(async () => {
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    req = await session(k, "owner");
    orgId = await createOrg(req);
    await enableConnectorExtensions(k, orgId);
  });

  async function install(slug: string): Promise<string> {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: `Docs ${slug}`,
        slug,
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "none" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { connector: { id: string } }).connector.id;
  }

  it("/connectors 可用；旧路径 /apps 一律 404", async () => {
    const id = await install("docs");
    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { connectors: { id: string }[] }).connectors.map((c) => c.id)).toEqual([
      id,
    ]);
    const one = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${id}` });
    expect(one.statusCode, one.body).toBe(200);

    for (const [method, url] of [
      ["GET", `/api/v1/orgs/${orgId}/apps`],
      ["POST", `/api/v1/orgs/${orgId}/apps`],
      ["POST", `/api/v1/orgs/${orgId}/apps/preview`],
      ["GET", `/api/v1/orgs/${orgId}/apps/${id}`],
      ["POST", `/api/v1/orgs/${orgId}/apps/${id}/refresh`],
      ["GET", `/api/v1/orgs/${orgId}/apps/prompts`],
      ["POST", `/api/v1/orgs/${orgId}/apps/${id}/connect`],
    ] as const) {
      const r = await req({ method, url, ...(method === "POST" && { payload: {} }) });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("a stored version with {kind:'app', appId}: reads as nothing turned off, runs, the tool key is unchanged", async () => {
    const id = await install("kb");
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const stored = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();

    // 模拟改名前存下的版本：直接把旧形写回库
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...(stored.definition as Record<string, unknown>),
          tools: [{ kind: "app", appId: id, tools: "all" }],
        }),
      })
      .where("agent_id", "=", agentId)
      .execute();
    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    expect(got.statusCode, got.body).toBe(200);
    // an enabled list from before tools were on by default reads as nothing turned off
    const read = (got.json() as { agent: { definition: Record<string, unknown> } }).agent
      .definition;
    expect(read.tools).toBeUndefined();
    expect(read.disabledTools).toEqual([]);

    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, 'tool:mcp__kb__search:{"q":"x"}');
    await waitForTerminal(db, convId, 1, 20_000);
    const results = (await eventsOf(db, convId)).filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.payload)).toMatchObject([
      { toolKey: "mcp__kb__search", content: "hits for x", isError: false },
    ]);
  });

  it("改名前的评测快照：readSnapshot + caseBase 交给实时注册表，连接器工具都在（没有 app:undefined）", async () => {
    const docs = await install("fx_docs");
    const priv = await install("fx_priv");
    // 夹具定义引用的是录制库里的连接器 id：换成本库的 id，保持旧形 {kind:"app", appId}
    const raw = structuredClone(fixture.snapshot) as unknown as {
      definitions: Record<string, { tools: { kind: string; appId?: string }[] }>;
    };
    const def = raw.definitions[String(fixture.snapshot.agentVersion)];
    expect(def?.tools.map((t) => t.kind)).toEqual(["app", "app"]);
    const ids: string[] = [docs, priv];
    def?.tools.forEach((t, i) => {
      t.appId = ids[i] as string;
    });
    const snap = readSnapshot(raw);
    const base = await caseBase(db, snap);
    expect(base?.definition.disabledTools).toEqual([]);
    const resolved = await k.app
      .get(ToolRegistry)
      .forAgent(orgId, { ...(base?.definition ?? { disabledTools: [] }), source: "web" });
    const keys = resolved.tools.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["mcp__fx_docs__search", "mcp__fx_priv__search"]));
    expect(JSON.stringify(resolved.unavailable)).not.toContain("undefined");
    expect(resolved.unavailable).toEqual([]);
  });

  it("a pre-rename (rc) agent version and eval case: old builtin names read as the new ones and resolve", async () => {
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Rc",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const stored = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    const rc = {
      ...(stored.definition as Record<string, unknown>),
      tools: [
        { kind: "builtin", name: "tool_search" },
        { kind: "builtin", name: "ask_user" },
      ],
      toolPolicies: { ask_user: "ask" },
    };
    await db
      .updateTable("agent_versions")
      .set({ definition: JSON.stringify(rc) })
      .where("agent_id", "=", agentId)
      .execute();

    // the candidate agent version of an eval run
    const candidate = await versionDefinition(db, agentId, 1);
    expect(candidate?.disabledTools).toEqual([]);
    expect(candidate?.toolPolicies).toEqual({ AskUserQuestion: "ask" });
    // an eval case whose snapshot recorded the rc definition
    const snap = readSnapshot({
      ...structuredClone(fixture.snapshot),
      agentId,
      agentVersion: 1,
      definitions: { "1": rc },
    });
    const base = await caseBase(db, snap);
    expect(base?.definition.disabledTools).toEqual(candidate?.disabledTools);
    const resolved = await k.app
      .get(ToolRegistry)
      .forAgent(orgId, { ...(base?.definition ?? { disabledTools: [] }), source: "web" });
    expect(resolved.tools.map((t) => t.key)).toContain("AskUserQuestion");
    expect(resolved.unavailable).toEqual([]);

    // and it runs: a plain message completes on the rc version
    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, "echo:hello");
    const [end] = await waitForTerminal(db, convId, 1, 20_000);
    expect(end?.type).toBe("run_finished");
  });
});

/**
 * Tool naming spec §8: release-candidate data after the upgrade. Mutable state (grants, pending
 * approvals and questions) is rewritten once by migration 0063; immutable configuration (agent
 * versions, templates) is normalized on read; saving an old key is refused naming the new one.
 */
const MIGRATION = "0063_tool_keys_claude_code.sql";

describe("release-candidate tool keys in stored data", () => {
  let req: Req;
  let ownerId: string;
  let orgA: string;
  let orgB: string;
  let docsId: string;

  beforeAll(async () => {
    ownerId = (
      await accountsFor(db).createLocal({ login: "legacy", password: PW, displayName: "O" })
    ).id;
    req = await session(k, "legacy");
    orgA = await createOrg(req, "A");
    orgB = await createOrg(req, "B");
    await enableConnectorExtensions(k, orgA);
    await enableConnectorExtensions(k, orgB);
    docsId = await install(orgA, "docs");
    await install(orgB, "todo");
    // the deployment has an extension named `todo` (an rc key `todo__write` was its tool)
    await db
      .insertInto("extension_name_owners")
      .values({ name: "todo", package_name: "@example/plugin-todo" })
      .execute();
  });

  async function install(orgId: string, slug: string): Promise<string> {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: `Docs ${slug}`,
        slug,
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "none" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { connector: { id: string } }).connector.id;
  }

  /**
   * Runs migration 0063 again, as on a database that has the rc rows and not the migration. The
   * migrator refuses a migration numbered below an applied one, so the later migrations' records
   * are set aside while it runs (from a directory that ends at 0063) and put back afterwards.
   */
  async function rerunMigration(): Promise<string[]> {
    await sql`delete from capybara._migrations where name = ${MIGRATION}`.execute(raw);
    const later = await sql<{ name: string; checksum: string; applied_at: Date }>`
      select name, checksum, applied_at from capybara._migrations where name > ${MIGRATION}`.execute(
      raw,
    );
    await sql`delete from capybara._migrations where name > ${MIGRATION}`.execute(raw);
    const upTo = mkdtempSync(join(tmpdir(), "cap-mig-0063-"));
    try {
      for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
        if (f.endsWith(".sql") && f <= MIGRATION) {
          copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(upTo, f));
        }
      }
      return (await migrate(pgc.url, { schema: KERNEL_SCHEMA, dir: upTo })).applied;
    } finally {
      for (const r of later.rows) {
        await sql`insert into capybara._migrations (name, checksum, applied_at)
          values (${r.name}, ${r.checksum}, ${r.applied_at})`.execute(raw);
      }
      rmSync(upTo, { recursive: true, force: true });
    }
  }

  it("migration 0063 rewrites grants, pending approvals and questions; ambiguous keys stay and are reported", async () => {
    const agentA = await createAgent(req, orgA);
    const agentB = await createAgent(req, orgB);
    const conv = await createConv(req, orgA, agentA);
    await postMessage(req, orgA, conv, "hello");
    await waitForTerminal(db, conv, 1, 20_000);
    const runId = (await runsOf(db, conv))[0]?.id as string;

    const grant = (
      orgId: string,
      agentId: string,
      toolKey: string,
      connectorId: string | null,
    ) => ({
      org_id: orgId,
      account_id: ownerId,
      agent_id: agentId,
      tool_key: toolKey,
      spec_hash: "h",
      connector_id: connectorId,
    });
    await db
      .insertInto("tool_grants")
      .values([
        grant(orgA, agentA, "sandbox_bash", null),
        grant(orgA, agentA, "docs__search", docsId),
        grant(orgA, agentA, "todo__write", null),
        grant(orgA, agentA, "nope__thing", null),
        grant(orgA, agentA, "mcp__docs__other", docsId),
        grant(orgB, agentB, "todo__x", null),
      ])
      .execute();
    await db
      .insertInto("conversation_tool_grants")
      .values([
        { conversation_id: conv, tool_key: "sandbox_read", spec_hash: "h", connector_id: null },
        // no connector id recorded: the slug of the conversation's org decides
        { conversation_id: conv, tool_key: "docs__search", spec_hash: "h", connector_id: null },
      ])
      .execute();
    const approval = (callId: string, toolKey: string, status: "pending" | "approved") => ({
      id: randomUUID(),
      org_id: orgA,
      conversation_id: conv,
      run_id: runId,
      call_id: callId,
      tool_key: toolKey,
      input: JSON.stringify({ path: "/a.txt" }),
      requested_for: ownerId,
      approver_role: null,
      status,
      expires_at: new Date(Date.now() + 3_600_000),
      spec_hash: "h",
      connector_id: null,
    });
    await db
      .insertInto("approvals")
      .values([
        approval("c1", "sandbox_edit", "pending"),
        approval("c2", "sandbox_bash", "approved"),
      ])
      .execute();
    const question = (callId: string, toolKey: string, status: "pending" | "answered") => ({
      id: randomUUID(),
      org_id: orgA,
      conversation_id: conv,
      run_id: runId,
      call_id: callId,
      spec: JSON.stringify({ form: {}, state: null, toolKey, step: 1 }),
      status,
      answer: null,
      answered_by: null,
      expires_at: new Date(Date.now() + 3_600_000),
    });
    await db
      .insertInto("questions")
      .values([question("q1", "docs__search", "pending"), question("q2", "ask_user", "answered")])
      .execute();

    expect(await rerunMigration()).toEqual([MIGRATION]);

    const grants = async () =>
      (
        await db
          .selectFrom("tool_grants")
          .select(["org_id", "tool_key"])
          .where("org_id", "in", [orgA, orgB])
          .orderBy("org_id")
          .orderBy("tool_key")
          .execute()
      ).map((r) => `${r.org_id === orgA ? "A" : "B"}:${r.tool_key}`);
    const expected = [
      "A:Bash",
      "A:mcp__docs__other",
      "A:mcp__docs__search",
      "A:nope__thing",
      "A:plugin__todo__write",
      "B:todo__x",
    ].sort();
    expect((await grants()).sort()).toEqual(expected);
    const convGrants = async () =>
      (
        await db
          .selectFrom("conversation_tool_grants")
          .select("tool_key")
          .where("conversation_id", "=", conv)
          .execute()
      )
        .map((r) => r.tool_key)
        .sort();
    expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);
    const approvals = await db
      .selectFrom("approvals")
      .select(["call_id", "tool_key"])
      .where("conversation_id", "=", conv)
      .orderBy("call_id")
      .execute();
    // decided approvals are history and stay
    expect(approvals).toEqual([
      { call_id: "c1", tool_key: "Edit" },
      { call_id: "c2", tool_key: "sandbox_bash" },
    ]);
    const questions = await db
      .selectFrom("questions")
      .select(["call_id", "spec"])
      .where("conversation_id", "=", conv)
      .orderBy("call_id")
      .execute();
    expect(questions.map((q) => [q.call_id, (q.spec as { toolKey: string }).toolKey])).toEqual([
      ["q1", "mcp__docs__search"],
      ["q2", "ask_user"],
    ]);

    // a pending approval for sandbox_edit shows Edit in the inbox
    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgA}/approvals?status=pending` });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      (list.json() as { approvals: { callId: string; toolKey: string }[] }).approvals.map((a) => [
        a.callId,
        a.toolKey,
      ]),
    ).toEqual([["c1", "Edit"]]);

    // idempotent: a second run changes nothing
    expect(await rerunMigration()).toEqual([MIGRATION]);
    expect((await grants()).sort()).toEqual(expected);
    expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);

    // the startup notice: the unmapped rows (nope__thing, the ambiguous todo__x), once, as WARN
    expect(await countLegacyToolKeys(db)).toBe(2);
    const warned: { msg: string; fields: unknown }[] = [];
    await warnLegacyToolKeys(db, { warn: (msg, fields) => warned.push({ msg, fields }) });
    expect(warned).toEqual([{ msg: "tools.legacy_key_unmapped", fields: { count: 2 } }]);
    // a starting kernel logs it once (KernelLifecycle, right after the kernel migrations)
    const lines: string[] = [];
    const second = await startKernel(
      runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE], roles: ["api"] }),
      { logger: createLogger("warn", { write: (l) => lines.push(l) }) },
    );
    await second.close();
    expect(lines.filter((l) => l.includes("tools.legacy_key_unmapped"))).toEqual([
      expect.stringContaining('"count":2'),
    ]);
    await db
      .deleteFrom("tool_grants")
      .where("tool_key", "in", ["nope__thing", "todo__x"])
      .execute();
    warned.length = 0;
    await warnLegacyToolKeys(db, { warn: (msg, fields) => warned.push({ msg, fields }) });
    expect(warned).toEqual([]);
  });

  it("an agent version stored with rc keys reads with the new keys and runs with them", async () => {
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/agents`,
      payload: {
        definition: {
          name: "Legacy",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const stored = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    // an rc version: an enabled tool list with old builtin names (from before tools were on by
    // default), old connector and builtin policy keys, an inline template
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...(stored.definition as Record<string, unknown>),
          tools: [
            { kind: "connector", connectorId: docsId, tools: "all" },
            { kind: "builtin", name: "agent" },
          ],
          toolPolicies: { sandbox_bash: "deny", docs__search: "ask" },
          subagents: {
            inline: [
              {
                name: "reader",
                description: "Reads files",
                instructions: "Read what you are asked to.",
                tools: ["sandbox_read"],
                disallowedTools: ["docs__search"],
              },
            ],
          },
        }),
      })
      .where("agent_id", "=", agentId)
      .execute();

    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgA}/agents/${agentId}` });
    expect(got.statusCode, got.body).toBe(200);
    const def = (got.json() as { agent: { definition: Record<string, unknown> } }).agent.definition;
    // the enabled list reads as nothing turned off (tools default-on spec §2)
    expect(def.tools).toBeUndefined();
    expect(def.disabledTools).toEqual([]);
    expect(def.toolPolicies).toEqual({ Bash: "deny", mcp__docs__search: "ask" });
    expect(def.subagents).toMatchObject({
      inline: [{ name: "reader", tools: ["Read"], disallowedTools: ["mcp__docs__search"] }],
    });

    // runs: the normalized `ask` policy applies to the connector tool (its default is allow)
    const conv = await createConv(req, orgA, agentId);
    await postMessage(req, orgA, conv, 'tool:mcp__docs__search:{"q":"x"}');
    const asked = await waitFor(
      async () => (await eventsOf(db, conv)).find((e) => e.type === "approval_requested") ?? null,
      20_000,
      "approval_requested",
    );
    expect(asked.payload).toMatchObject({ toolKey: "mcp__docs__search" });
  });

  it("saving a definition with an rc key is 400 validation_failed naming the new key", async () => {
    const save = (definition: Record<string, unknown>) =>
      req({
        method: "POST",
        url: `/api/v1/orgs/${orgA}/agents`,
        payload: {
          definition: {
            name: "Old",
            instructions: "",
            model: { provider: "model-fake", model: "fake-1" },
            ...definition,
          },
          visibility: "org",
        },
      });
    const builtin = await save({ disabledTools: [{ kind: "builtin", name: "sandbox_bash" }] });
    expect(builtin.statusCode, builtin.body).toBe(400);
    expect(builtin.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(builtin.body).toContain('\\"Bash\\"');

    const policy = await save({
      toolPolicies: { sandbox_read: "ask", docs__search: "deny" },
    });
    expect(policy.statusCode, policy.body).toBe(400);
    expect(policy.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(policy.body).toContain('\\"Read\\"');
    expect(policy.body).toContain('\\"mcp__docs__search\\"');

    const inline = await save({
      subagents: {
        inline: [{ name: "r", description: "d", instructions: "i", tools: ["sandbox_read"] }],
      },
    });
    expect(inline.statusCode, inline.body).toBe(400);
    expect(inline.body).toContain('\\"Read\\"');
  });
});
