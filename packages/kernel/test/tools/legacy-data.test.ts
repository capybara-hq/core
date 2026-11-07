import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { countLegacyToolKeys, warnLegacyToolKeys } from "../../src/tools/legacy-data.js";
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
 * Tool naming spec §8: release-candidate data after the upgrade. Mutable state (grants, pending
 * approvals and questions) is rewritten once by migration 0063; immutable configuration (agent
 * versions, templates) is normalized on read; saving an old key is refused naming the new one.
 */

const CONNECTOR = fakeExtensionEntry("fake-connector");
const MIGRATION = "0063_tool_keys_claude_code.sql";

describe("release-candidate tool keys in stored data", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let k: TestKernel;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
  let mcp: FakeMcpServer;
  let req: Req;
  let ownerId: string;
  let orgA: string;
  let orgB: string;
  let docsId: string;

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
    ownerId = (
      await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" })
    ).id;
    req = await session(k, "owner");
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
  }, 180_000);

  afterAll(async () => {
    await k?.close();
    await mcp?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rd?.stop()]);
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
  }, 90_000);

  it("an agent version stored with rc keys reads with the new keys and runs with them", async () => {
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/agents`,
      payload: {
        definition: {
          name: "Legacy",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [
            { kind: "connector", connectorId: docsId, tools: "all" },
            { kind: "builtin", name: "Agent" },
          ],
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
    // an rc version: old builtin names, old connector and builtin policy keys, an inline template
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
    expect(def.tools).toEqual([
      { kind: "connector", connectorId: docsId, tools: "all" },
      { kind: "builtin", name: "Agent" },
    ]);
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
  }, 60_000);

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
    const builtin = await save({ tools: [{ kind: "builtin", name: "sandbox_bash" }] });
    expect(builtin.statusCode, builtin.body).toBe(400);
    expect(builtin.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(builtin.body).toContain('\\"Bash\\"');

    const policy = await save({
      tools: [
        { kind: "builtin", name: "Read" },
        { kind: "connector", connectorId: docsId, tools: "all" },
      ],
      toolPolicies: { sandbox_read: "ask", docs__search: "deny" },
    });
    expect(policy.statusCode, policy.body).toBe(400);
    expect(policy.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(policy.body).toContain('\\"Read\\"');
    expect(policy.body).toContain('\\"mcp__docs__search\\"');

    const inline = await save({
      tools: [
        { kind: "builtin", name: "Read" },
        { kind: "builtin", name: "Agent" },
      ],
      subagents: {
        inline: [{ name: "r", description: "d", instructions: "i", tools: ["sandbox_read"] }],
      },
    });
    expect(inline.statusCode, inline.body).toBe(400);
    expect(inline.body).toContain('\\"Read\\"');
  }, 60_000);
});
