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
import { caseBase } from "../../src/evals/runs.service.js";
import {
  type CaseSnapshot,
  readSnapshot,
  replayableCalls,
  toEvents,
} from "../../src/evals/snapshot.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA } from "../../src/kernel.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
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
    orgId = await createOrgWithProviders(k, req);
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
});

/**
 * Tool naming spec §8: release-candidate data after the upgrade. Mutable state (grants, pending
 * approvals and questions) is rewritten by migration 0063; agent versions and templates by
 * migration 0139 (no compatibility before 0.1.0: the kernel reads only current keys), which also
 * deletes the grants 0063 could not map. Saving an old key is refused.
 */
const MIGRATION = "0063_tool_keys_claude_code.sql";
const RETIRE = "0139_retire_legacy_forms.sql";

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
    orgA = await createOrgWithProviders(k, req, "A");
    orgB = await createOrgWithProviders(k, req, "B");
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
   * Runs migration `name` again, as on a database that has the rc rows and not the migration. The
   * migrator refuses a migration numbered below an applied one, so the later migrations' records
   * are set aside while it runs (from a directory that ends at `name`) and put back afterwards.
   */
  async function rerunMigration(name = MIGRATION): Promise<string[]> {
    await sql`delete from capybara._migrations where name = ${name}`.execute(raw);
    const later = await sql<{ name: string; checksum: string; applied_at: Date }>`
      select name, checksum, applied_at from capybara._migrations where name > ${name}`.execute(
      raw,
    );
    await sql`delete from capybara._migrations where name > ${name}`.execute(raw);
    const upTo = mkdtempSync(join(tmpdir(), "cap-mig-rerun-"));
    try {
      for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
        if (f.endsWith(".sql") && f <= name) {
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

  it("migration 0063 rewrites grants, pending approvals and questions; 0139 deletes the grants it could not map", async () => {
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

    // 0139: the rows 0063 could not map (nope__thing, the ambiguous todo__x) name no tool and go
    expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
    expect((await grants()).sort()).toEqual(
      expected.filter((g) => g !== "A:nope__thing" && g !== "B:todo__x"),
    );
    expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);
  });

  it("migration 0139 rewrites rc keys in agent versions and templates; the agent runs with them", async () => {
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
    // an rc version: old builtin and connector policy keys, an ambiguous key (`todo` is both an
    // extension of the deployment and, in org B only, a connector: here only an extension), the
    // removed skill_write, and an inline template
    const current = stored.definition as Record<string, unknown>;
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...current,
          toolPolicies: {
            sandbox_bash: "deny",
            docs__search: "ask",
            todo__write: "ask",
            skill_write: "deny",
            Read: "ask",
          },
          subagents: {
            inline: [
              {
                name: "reader",
                description: "Reads files",
                instructions: "Read what you are asked to.",
                tools: ["sandbox_read", "Read", "nope__x"],
                disallowedTools: ["docs__search"],
              },
            ],
          },
        }),
      })
      .where("agent_id", "=", agentId)
      .execute();
    // an org template with rc keys
    const tpl = { id: randomUUID() };
    await db
      .insertInto("agent_templates")
      .values({ id: tpl.id, org_id: orgA, name: "rc-template", current_version: 1 } as never)
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: tpl.id,
        version: 1,
        definition: JSON.stringify({
          name: "rc-template",
          description: "d",
          instructions: "i",
          tools: ["sandbox_read", "docs__search"],
          toolPolicies: { ask_user: "ask" },
          subagents: {
            inline: [
              {
                name: "helper",
                description: "d",
                instructions: "i",
                tools: ["sandbox_grep"],
                disallowedTools: ["docs__search"],
                toolPolicies: { sandbox_bash: "deny" },
              },
            ],
          },
        }),
      } as never)
      .execute();
    // a platform template (no org: only extension names resolve) with an inline sub-agent
    const ptpl = { id: randomUUID() };
    await db
      .insertInto("platform_agent_templates")
      .values({ id: ptpl.id, name: "rc-platform-template", current_version: 1 } as never)
      .execute();
    await db
      .insertInto("platform_agent_template_versions")
      .values({
        template_id: ptpl.id,
        version: 1,
        definition: JSON.stringify({
          name: "rc-platform-template",
          description: "d",
          instructions: "i",
          tools: ["sandbox_read", "docs__search"],
          subagents: {
            inline: [
              {
                name: "helper",
                description: "d",
                instructions: "i",
                tools: ["sandbox_glob", "todo__write"],
                toolPolicies: { ask_user: "deny", todo__write: "ask" },
              },
            ],
          },
        }),
      } as never)
      .execute();

    expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
    const after = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    const def = after.definition as Record<string, unknown>;
    expect(def.toolPolicies).toEqual({
      Bash: "deny",
      mcp__docs__search: "ask",
      plugin__todo__write: "ask",
      Read: "ask",
    });
    expect(def.subagents).toMatchObject({
      inline: [
        { name: "reader", tools: ["Read", "nope__x"], disallowedTools: ["mcp__docs__search"] },
      ],
    });
    expect(def.instructions).toBe(current.instructions);
    const tplAfter = await db
      .selectFrom("agent_template_versions")
      .select("definition")
      .where("template_id", "=", tpl.id)
      .executeTakeFirstOrThrow();
    expect(tplAfter.definition).toMatchObject({
      tools: ["Read", "mcp__docs__search"],
      toolPolicies: { AskUserQuestion: "ask" },
      subagents: {
        inline: [
          {
            name: "helper",
            tools: ["Grep"],
            disallowedTools: ["mcp__docs__search"],
            toolPolicies: { Bash: "deny" },
          },
        ],
      },
    });
    const ptplAfter = await db
      .selectFrom("platform_agent_template_versions")
      .select("definition")
      .where("template_id", "=", ptpl.id)
      .executeTakeFirstOrThrow();
    // no org connectors: `docs` stays as it is (inert), `todo` is an extension of the deployment
    expect(ptplAfter.definition).toMatchObject({
      tools: ["Read", "docs__search"],
      subagents: {
        inline: [
          {
            name: "helper",
            tools: ["Glob", "plugin__todo__write"],
            toolPolicies: { AskUserQuestion: "deny", plugin__todo__write: "ask" },
          },
        ],
      },
    });
    // idempotent: a second run leaves the rows as they are
    await db
      .insertInto("audit_events")
      .values([
        { org_id: orgA, action: "app.created", target: "c-1", detail: "{}" },
        { org_id: orgA, action: "app.credential.cleared", target: "c-1", detail: "{}" },
        { org_id: orgA, action: "app.installed", target: "x", detail: "{}" },
      ] as never)
      .execute();
    expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
    // connector actions written before the D17 rename take their current names; an `app.` action
    // that was never a connector's stays
    const actions = await db
      .selectFrom("audit_events")
      .select("action")
      .where("org_id", "=", orgA)
      .where("target", "in", ["c-1", "x"])
      .orderBy("id")
      .execute();
    expect(actions.map((r) => r.action)).toEqual([
      "connector.created",
      "connector.credential.cleared",
      "app.installed",
    ]);
    expect(
      (
        await db
          .selectFrom("agent_versions")
          .select("definition")
          .where("agent_id", "=", agentId)
          .executeTakeFirstOrThrow()
      ).definition,
    ).toEqual(after.definition);

    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgA}/agents/${agentId}` });
    expect(got.statusCode, got.body).toBe(200);
    // runs: the rewritten `ask` policy applies to the connector tool (its default is allow)
    const conv = await createConv(req, orgA, agentId);
    await postMessage(req, orgA, conv, 'tool:mcp__docs__search:{"q":"x"}');
    const asked = await waitFor(
      async () => (await eventsOf(db, conv)).find((e) => e.type === "approval_requested") ?? null,
      20_000,
      "approval_requested",
    );
    expect(asked.payload).toMatchObject({ toolKey: "mcp__docs__search" });
  });

  it("saving a definition with an rc key is 400 validation_failed", async () => {
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

    const policy = await save({
      toolPolicies: { sandbox_read: "ask", docs__search: "deny" },
    });
    expect(policy.statusCode, policy.body).toBe(400);
    expect(policy.json()).toMatchObject({ error: { code: "validation_failed" } });

    const inline = await save({
      subagents: {
        inline: [{ name: "r", description: "d", instructions: "i", tools: ["sandbox_read"] }],
      },
    });
    expect(inline.statusCode, inline.body).toBe(400);
  });
});
