import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Plugin scope phase 4, Task 4 (spec §15, rulings P4-9 to P4-13): org templates. 另存为模板 maps
 * an agent into an org row (no plugin, a bare name, version 1) without credentials, leaving org
 * agents out; rule 10 refuses a name the org can already use; the owner org's admins write new
 * versions (optimistic `expectedVersion`), share and delete them under the P3 owner rules.
 */

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
/** The super admin, owner of orgs A and B. */
let root: Req;
let rootId: string;
/** An org admin of A. */
let boss: Req;
/** A member of A. */
let mem: Req;
let memId: string;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE] },
    ),
  );
  const accounts = accountsFor(db);
  rootId = (
    await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true })
  ).id;
  const bossId = (await accounts.createLocal({ login: "boss", password: PW, displayName: "B" })).id;
  memId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  root = await session(k, "root");
  boss = await session(k, "boss");
  mem = await session(k, "mem");
  orgA = await createOrg(root, "A");
  orgB = await createOrg(root, "B");
  await db
    .insertInto("memberships")
    .values([
      { org_id: orgA, account_id: bossId, role: "admin" },
      { org_id: orgA, account_id: memId, role: "member" },
    ])
    .execute();
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.component_org_switches, capybara.component_scope_orgs, capybara.platform_agent_template_versions, capybara.platform_agent_templates, capybara.platform_connector_templates, capybara.agent_template_versions, capybara.agent_templates, capybara.skill_versions, capybara.skills, capybara.connector_tools, capybara.connectors, capybara.catalog_items, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.org_notices, capybara.platform_notices, capybara.audit_events",
  );
});

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

/** An org-scope skill (or an agent's own skill) row with one version; no files are read. */
async function seedSkill(org: string, name: string, agentId?: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: org,
      scope: agentId === undefined ? "org" : "agent",
      agent_id: agentId ?? null,
      name,
      description: `Use for ${name}.`,
      current_version: 1,
      created_by: rootId,
    })
    .execute();
  await db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify({ name, description: `Use for ${name}.`, files: [] }),
      object_prefix: `skills/${id}/1/`,
      created_by: rootId,
    })
    .execute();
  return id;
}

/** A connector row with its tools (no extension runs: save-as reads only the rows). */
async function seedConnector(
  org: string,
  o: {
    name: string;
    connector: string;
    endpoint: Record<string, unknown>;
    platformTemplateId?: string;
    tools: { name: string; status: "enabled" | "disabled" }[];
  },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connectors")
    .values({
      id,
      org_id: org,
      slug: o.name.toLowerCase(),
      name: o.name,
      connector: o.connector,
      endpoint: JSON.stringify(o.endpoint),
      auth: JSON.stringify({ type: "bearer", ownership: "org", headerName: "X-Api-Key" }),
      created_by: rootId,
      platform_template_id: o.platformTemplateId ?? null,
    })
    .execute();
  for (const t of o.tools) {
    await db
      .insertInto("connector_tools")
      .values({
        connector_id: id,
        name: t.name,
        spec: JSON.stringify({ name: t.name, description: t.name, inputSchema: {} }),
        spec_hash: t.name,
        status: t.status,
        default_policy: "allow",
      })
      .execute();
  }
  return id;
}

/** An agent of `org` written directly (save-as reads the stored definition and profile). */
async function seedAgent(
  org: string,
  definition: Record<string, unknown>,
  quickActions: { title: string; body: string }[] = [],
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("agents")
    .values({
      id,
      org_id: org,
      owner_account_id: memId,
      visibility: "private",
      current_version: 1,
      profile_avatar: JSON.stringify({ kind: "preset", id: "p01" }),
      profile_quick_actions: JSON.stringify(quickActions),
    })
    .execute();
  await db
    .insertInto("agent_versions")
    .values({ agent_id: id, version: 1, definition: JSON.stringify(definition), created_by: memId })
    .execute();
  return id;
}

const simpleAgent = (org: string, name = "Lead") =>
  seedAgent(org, {
    name,
    instructions: "Lead the work.",
    model: { provider: "model-fake", model: "fake-1" },
    tools: [{ kind: "builtin", name: "Read" }],
  });

const saveAs = (as: Req, org: string, agentId: string, name: string, description = "Leads.") =>
  as({
    method: "POST",
    url: `/api/v1/orgs/${org}/agents/${agentId}/save-as-template`,
    payload: { name, description },
  });

/** Preview + PUT of a component scope change by the super admin. */
async function putScope(id: string, body: Record<string, unknown>) {
  const p = await root({
    method: "POST",
    url: `/api/v1/admin/components/agent_template/${id}/scope/preview`,
    payload: body,
  });
  expect(p.statusCode, p.body).toBe(200);
  return root({
    method: "PUT",
    url: `/api/v1/admin/components/agent_template/${id}/scope`,
    payload: { ...body, scopeHash: p.json().scopeHash },
  });
}

/** `lead` saved in `org` by `as`, made shareable and associated with `orgs`; ids of both rows. */
async function sharedLead(
  as: Req,
  org: string,
  orgs: string[],
  name = "lead",
): Promise<{ id: string; pid: string; definition: Record<string, unknown> }> {
  const saved = await saveAs(as, org, await simpleAgent(org), name);
  expect(saved.statusCode, saved.body).toBe(201);
  const id = saved.json().template.id as string;
  const share = await as({
    method: "PUT",
    url: `/api/v1/orgs/${org}/agent-templates/${id}/shareable`,
    payload: { shareable: true },
  });
  expect(share.statusCode, share.body).toBe(200);
  const scoped = await putScope(id, { scope: "named", orgs });
  expect(scoped.statusCode, scoped.body).toBe(200);
  return { id, pid: scoped.json().id as string, definition: saved.json().template.definition };
}

describe("org agent templates", { timeout: 120_000 }, () => {
  it("save-as maps every field without credentials (P4-10, P4-11)", async () => {
    // a platform connector template (of a catalog item) and a connector made from it
    const itemId = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "kit",
        package_name: "@acme/plugin-kit",
        publisher: "Acme",
        description: "d",
        latest_version: "1.0.0",
        policy: "allow",
      })
      .execute();
    const platformTpl = randomUUID();
    await db
      .insertInto("platform_connector_templates")
      .values({
        id: platformTpl,
        catalog_item_id: itemId,
        template_id: "kit-mcp",
        current_version: "1.0.0",
        file: JSON.stringify({}),
      })
      .execute();
    const fromTemplate = await seedConnector(orgA, {
      name: "Kit",
      connector: "mcp",
      endpoint: { url: "https://kit.example.com/mcp" },
      platformTemplateId: platformTpl,
      tools: [{ name: "search", status: "enabled" }],
    });
    // hand-configured: userinfo, query, fragment and headers must never reach the template
    const custom = await seedConnector(orgA, {
      name: "Wiki",
      connector: "mcp",
      endpoint: {
        url: "https://alice:hunter2@wiki.example.com/v1/mcp?token=sekrit#frag",
        headers: { Authorization: "Bearer sekrit-header" },
      },
      tools: [
        { name: "find", status: "enabled" },
        { name: "wipe", status: "disabled" },
      ],
    });
    const openapi = await seedConnector(orgA, {
      name: "Inline",
      connector: "openapi",
      endpoint: { specText: "{}" },
      tools: [{ name: "op", status: "enabled" }],
    });
    const gone = randomUUID();

    const s1 = await seedSkill(orgA, "report");
    const s2 = await seedSkill(orgA, "charts");
    const s3 = await seedSkill(orgA, "style");
    // a plugin template type in the roster
    const reviewer = randomUUID();
    await db
      .insertInto("agent_templates")
      .values({
        id: reviewer,
        org_id: orgA,
        name: "reviewer",
        plugin_name: "crm",
        current_version: 1,
      })
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: reviewer,
        version: 1,
        definition: JSON.stringify({
          name: "reviewer",
          description: "Reviews.",
          instructions: "R.",
        }),
      })
      .execute();
    const buddy = await simpleAgent(orgA, "Buddy");

    const agentId = await seedAgent(
      orgA,
      {
        name: "Lead",
        instructions: "# Lead\n\nLead the work.\n\n# Style\n\nBe brief.",
        instructionFiles: [
          { name: "AGENTS.md", content: "# Lead\n\nLead the work." },
          { name: "style.md", content: "# Style\n\nBe brief." },
        ],
        model: { provider: "model-fake", model: "fake-1" },
        modelParams: { effort: "high" },
        tools: [
          { kind: "builtin", name: "Bash" },
          { kind: "builtin", name: "Agent" },
          { kind: "plugin", plugin: "todo", name: "write" },
          { kind: "connector", connectorId: fromTemplate, tools: ["search"] },
          { kind: "connector", connectorId: custom, tools: "all" },
          { kind: "connector", connectorId: openapi, tools: "all" },
          { kind: "connector", connectorId: gone, tools: "all" },
        ],
        toolPolicies: {
          Bash: "ask",
          mcp__wiki__find: "deny",
          mcp__kit__search: "ask",
          // the Inline connector is left out: its policy cannot go anywhere
          mcp__inline__op: "deny",
        },
        skills: { orgSkills: [s1, s2, s3], pinned: [s1] },
        subagents: {
          general: false,
          templates: [reviewer, "missing-template"],
          inline: [
            {
              name: "helper",
              description: "Helps.",
              instructions: "Help out.",
              tools: ["Read", "mcp__wiki__find"],
              skills: [s2],
              model: "fast",
              effort: "low",
            },
            // no allowlist: all of the agent's tools; an empty one: none
            { name: "solo", description: "Alone.", instructions: "Work alone." },
            { name: "mute", description: "Talks only.", instructions: "Just talk.", tools: [] },
          ],
          agents: [{ agentId: buddy, as: "buddy", description: "A buddy." }],
        },
        pendingConnectors: [
          {
            key: "docs",
            label: "Docs",
            source: {
              needs: {
                protocol: "mcp",
                endpoint: "https://docs.example.com/mcp?k=1",
                tools: ["q"],
                label: "Docs",
              },
            },
          },
          {
            key: "crm",
            label: "CRM",
            source: { template: platformTpl },
            tools: ["x"],
            policies: { x: "deny" },
          },
        ],
      },
      [{ title: "Weekly", body: "Write the weekly report." }],
    );
    // an agent's own skill, pinned: not in the org library, so left out
    const own = await seedSkill(orgA, "own-notes", agentId);
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...(
            await db
              .selectFrom("agent_versions")
              .select("definition")
              .where("agent_id", "=", agentId)
              .executeTakeFirstOrThrow()
          ).definition,
          skills: { orgSkills: [s1, s2, s3], pinned: [s1, own] },
        }),
      })
      .where("agent_id", "=", agentId)
      .execute();

    const res = await saveAs(boss, orgA, agentId, "lead", "Leads the team.");
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as {
      template: Record<string, unknown> & { id: string; definition: Record<string, unknown> };
      omitted: unknown[];
    };
    expect(body.template).toMatchObject({
      name: "lead",
      plugin: null,
      type: "lead",
      version: 1,
      origin: "org",
      owner: { kind: "org", orgId: orgA, name: "A" },
      owned: true,
      shareable: false,
      promoted: false,
      usable: true,
    });
    expect(body.template.definition).toEqual({
      name: "lead",
      description: "Leads the team.",
      instructions: "# Lead\n\nLead the work.\n\n# Style\n\nBe brief.",
      tools: ["Bash", "Agent", "plugin__todo__write"],
      toolPolicies: { Bash: "ask" },
      model: "standard",
      modelRef: "model-fake/fake-1",
      effort: "high",
      skills: ["report"],
      selectedSkills: ["charts", "style"],
      connectors: [
        { template: platformTpl, tools: ["search"], policies: { search: "ask" } },
        {
          needs: {
            protocol: "mcp",
            endpoint: "https://wiki.example.com/v1/mcp",
            tools: ["find"],
            label: "Wiki",
          },
          policies: { find: "deny" },
        },
        {
          needs: {
            protocol: "mcp",
            endpoint: "https://docs.example.com/mcp",
            tools: ["q"],
            label: "Docs",
          },
        },
        { template: platformTpl, tools: ["x"], policies: { x: "deny" } },
      ],
      subagents: {
        general: false,
        types: ["crm:reviewer"],
        inline: [
          {
            name: "helper",
            description: "Helps.",
            instructions: "Help out.",
            tools: ["Read"],
            skills: ["charts"],
            model: "fast",
          },
          {
            name: "solo",
            description: "Alone.",
            instructions: "Work alone.",
            skills: [],
            model: "inherit",
          },
          {
            name: "mute",
            description: "Talks only.",
            instructions: "Just talk.",
            tools: [],
            skills: [],
            model: "inherit",
          },
        ],
      },
      quickActions: [{ title: "Weekly", body: "Write the weekly report." }],
      instructionFiles: [
        { name: "AGENTS.md", content: "# Lead\n\nLead the work." },
        { name: "style.md", content: "# Style\n\nBe brief." },
      ],
    });
    expect(body.omitted).toEqual(
      expect.arrayContaining([
        { kind: "skill", name: "own-notes", id: own, reason: "agent_skill" },
        { kind: "connector", name: "Inline", id: openapi, reason: "no_endpoint" },
        { kind: "connector", name: gone, id: gone, reason: "unavailable" },
        {
          kind: "subagent_template",
          name: "missing-template",
          id: "missing-template",
          reason: "unavailable",
        },
        { kind: "subagent_agent", name: "buddy", id: buddy, reason: "org_agent" },
        // nothing is dropped silently: connector-key policies and inline fields are listed
        { kind: "tool_policy", name: "mcp__inline__op", reason: "connector_tool" },
        { kind: "subagent_inline", name: "helper", field: "tools", reason: "connector_tool" },
        { kind: "subagent_inline", name: "helper", field: "effort", reason: "unsupported_field" },
      ]),
    );
    expect(body.omitted).toHaveLength(8);

    // no credential, header or secret query ever enters the stored template
    const stored = await db
      .selectFrom("agent_templates as t")
      .innerJoin("agent_template_versions as v", "v.template_id", "t.id")
      .select(["t.plugin_name", "t.catalog_item_id", "t.current_version", "v.definition"])
      .where("t.id", "=", body.template.id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ plugin_name: null, catalog_item_id: null, current_version: 1 });
    const text = JSON.stringify(stored.definition);
    for (const secret of ["alice", "hunter2", "sekrit", "frag", "k=1", "X-Api-Key", "Bearer"]) {
      expect(text).not.toContain(secret);
    }

    // the detail, for any member
    const got = await mem({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/agent-templates/${body.template.id}`,
    });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json().template.definition).toEqual(body.template.definition);
    // the list shows it under its bare type
    const list = await mem({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates` });
    expect(
      (list.json().templates as { type: string; origin: string }[]).map((t) => [t.type, t.origin]),
    ).toEqual([
      ["lead", "org"],
      ["crm:reviewer", "org"],
    ]);
    // another org cannot read it
    const elsewhere = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgB}/agent-templates/${body.template.id}`,
    });
    expect(errorOf(elsewhere)).toEqual([404, "component.not_found"]);
  });

  it("only org admins save, edit and delete; members read (P4-9, P4-12)", async () => {
    const agentId = await simpleAgent(orgA);
    expect(errorOf(await saveAs(mem, orgA, agentId, "lead"))).toEqual([403, "forbidden"]);
    const res = await saveAs(boss, orgA, agentId, "lead");
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().template.id as string;
    const definition = res.json().template.definition as Record<string, unknown>;
    expect(
      errorOf(
        await mem({
          method: "PUT",
          url: `/api/v1/orgs/${orgA}/agent-templates/${id}`,
          payload: { definition, expectedVersion: 1 },
        }),
      ),
    ).toEqual([403, "forbidden"]);
    expect(
      errorOf(await mem({ method: "DELETE", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` })),
    ).toEqual([403, "forbidden"]);
    expect(
      errorOf(
        await mem({
          method: "PUT",
          url: `/api/v1/orgs/${orgA}/agent-templates/${id}/shareable`,
          payload: { shareable: true },
        }),
      ),
    ).toEqual([403, "forbidden"]);
    expect(
      (await mem({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` })).statusCode,
    ).toBe(200);
    // an unknown agent
    expect(errorOf(await saveAs(boss, orgA, randomUUID(), "other"))).toEqual([
      404,
      "agent.not_found",
    ]);
  });

  it("a name the org can use already is refused, naming its owner (rule 10)", async () => {
    const agentId = await simpleAgent(orgA);
    expect((await saveAs(boss, orgA, agentId, "lead")).statusCode).toBe(201);
    const again = await saveAs(boss, orgA, agentId, "lead");
    expect(errorOf(again)).toEqual([409, "agent_template.name_taken"]);
    expect(again.json().error.details).toEqual([
      { owner: { kind: "org", orgId: orgA, name: "A" }, templateId: expect.any(String) },
    ]);

    // a template org B shared, on in A, holds the bare name `shared`
    const pid = randomUUID();
    await db
      .insertInto("platform_agent_templates")
      .values({
        id: pid,
        name: "shared",
        current_version: 1,
        owner_org_id: orgB,
        origin_org_id: orgB,
        shareable: true,
        scope_mode: "own",
        scope: "named",
      })
      .execute();
    await db
      .insertInto("platform_agent_template_versions")
      .values({
        template_id: pid,
        version: 1,
        definition: JSON.stringify({ name: "shared", description: "S.", instructions: "S." }),
      })
      .execute();
    await db
      .insertInto("component_scope_orgs")
      .values([
        { kind: "agent_template", component_id: pid, org_id: orgA },
        { kind: "agent_template", component_id: pid, org_id: orgB },
      ])
      .execute();
    const taken = await saveAs(boss, orgA, agentId, "shared");
    expect(errorOf(taken)).toEqual([409, "agent_template.name_taken"]);
    expect(taken.json().error.details).toEqual([
      { owner: { kind: "org", orgId: orgB, name: "B" }, templateId: pid },
    ]);
    // switched off in A, it is still offered there: switching it on would clash (P2-3)
    await db
      .insertInto("component_org_switches")
      .values({ kind: "agent_template", component_id: pid, org_id: orgA, enabled: false })
      .execute();
    const offered = await saveAs(boss, orgA, agentId, "shared");
    expect(errorOf(offered)).toEqual([409, "agent_template.name_taken"]);
    expect(offered.json().error.details).toEqual([
      { owner: { kind: "org", orgId: orgB, name: "B" }, templateId: pid },
    ]);
    // the roster's built-in type is reserved
    const reserved = await saveAs(boss, orgA, agentId, "general-purpose");
    expect(errorOf(reserved)).toEqual([409, "agent_template.name_taken"]);
    expect(reserved.json().error.details).toEqual([{ reserved: true }]);
    // a plugin type `<plugin>:<name>` is another type: the bare name stays free
    await db
      .insertInto("agent_templates")
      .values({
        id: randomUUID(),
        org_id: orgA,
        name: "reviewer",
        plugin_name: "crm",
        current_version: 1,
      })
      .execute();
    expect((await saveAs(boss, orgA, agentId, "reviewer")).statusCode).toBe(201);
    // another org may use the same bare name (P3-5)
    const agentB = await simpleAgent(orgB);
    expect((await saveAs(root, orgB, agentB, "lead")).statusCode).toBe(201);
  });

  it("PUT writes a new version with expectedVersion (P4-12)", async () => {
    const agentId = await simpleAgent(orgA);
    const res = await saveAs(boss, orgA, agentId, "lead");
    const id = res.json().template.id as string;
    const definition = res.json().template.definition as Record<string, unknown>;
    const put = (payload: Record<string, unknown>) =>
      boss({ method: "PUT", url: `/api/v1/orgs/${orgA}/agent-templates/${id}`, payload });

    const v2 = await put({
      definition: { ...definition, description: "Leads better.", selectedSkills: ["report"] },
      expectedVersion: 1,
    });
    expect(v2.statusCode, v2.body).toBe(200);
    expect(v2.json().template).toMatchObject({
      version: 2,
      description: "Leads better.",
      definition: expect.objectContaining({ selectedSkills: ["report"] }),
    });
    // a stale version
    const stale = await put({ definition, expectedVersion: 1 });
    expect(errorOf(stale)).toEqual([409, "agent_template.version_conflict"]);
    // the same definition again: no new version
    const same = await put({ definition: v2.json().template.definition, expectedVersion: 2 });
    expect(same.json().template.version).toBe(2);
    // invalid: renamed, or a field the format refuses
    expect(
      errorOf(await put({ definition: { ...definition, name: "other" }, expectedVersion: 2 })),
    ).toEqual([400, "validation_failed"]);
    expect(
      errorOf(await put({ definition: { ...definition, model: "huge" }, expectedVersion: 2 })),
    ).toEqual([400, "validation_failed"]);
    const versions = await db
      .selectFrom("agent_template_versions")
      .select("version")
      .where("template_id", "=", id)
      .orderBy("version")
      .execute();
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    // a plugin's template is not the org's to edit
    const plugin = randomUUID();
    await db
      .insertInto("agent_templates")
      .values({
        id: plugin,
        org_id: orgA,
        name: "reviewer",
        plugin_name: "crm",
        current_version: 1,
      })
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: plugin,
        version: 1,
        definition: JSON.stringify({
          name: "reviewer",
          description: "Reviews.",
          instructions: "R.",
        }),
      })
      .execute();
    expect(
      errorOf(
        await boss({
          method: "PUT",
          url: `/api/v1/orgs/${orgA}/agent-templates/${plugin}`,
          payload: {
            definition: { name: "reviewer", description: "X.", instructions: "X." },
            expectedVersion: 1,
          },
        }),
      ),
    ).toEqual([409, "catalog.not_owned"]);
    expect(
      errorOf(
        await boss({
          method: "PUT",
          url: `/api/v1/orgs/${orgA}/agent-templates/${plugin}/shareable`,
          payload: { shareable: true },
        }),
      ),
    ).toEqual([409, "catalog.not_owned"]);
  });

  it("an unshared template is removed by its owner", async () => {
    const agentId = await simpleAgent(orgA);
    const id = (await saveAs(boss, orgA, agentId, "lead")).json().template.id as string;
    const preview = await boss({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/agent-templates/${id}/delete-preview`,
    });
    expect(preview.json()).toEqual({ outcome: "removed", orgs: [], agents: [] });
    const del = await boss({ method: "DELETE", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ outcome: "removed" });
    expect(
      (await mem({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` })).statusCode,
    ).toBe(404);
  });

  it("shared: promoted on share, versions reach the users, owner delete transfers (P4-13, P3-19)", async () => {
    const agentId = await simpleAgent(orgA);
    const saved = await saveAs(boss, orgA, agentId, "lead");
    const id = saved.json().template.id as string;
    const definition = saved.json().template.definition as Record<string, unknown>;

    // not shareable yet: the super admin cannot associate it
    const blocked = await root({
      method: "POST",
      url: `/api/v1/admin/components/agent_template/${id}/scope/preview`,
      payload: { scope: "named", orgs: [orgA, orgB] },
    });
    const refused = await root({
      method: "PUT",
      url: `/api/v1/admin/components/agent_template/${id}/scope`,
      payload: { scope: "named", orgs: [orgA, orgB], scopeHash: blocked.json().scopeHash },
    });
    expect(errorOf(refused)).toEqual([409, "catalog.not_shareable"]);

    const share = await boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/agent-templates/${id}/shareable`,
      payload: { shareable: true },
    });
    expect(share.statusCode, share.body).toBe(200);
    const scoped = await putScope(id, { scope: "named", orgs: [orgA, orgB] });
    expect(scoped.statusCode, scoped.body).toBe(200);
    const pid = scoped.json().id as string;
    expect(pid).not.toBe(id);
    expect(
      await db
        .selectFrom("platform_agent_templates")
        .select(["owner_org_id", "origin_org_id", "plugin_name", "name", "current_version"])
        .where("id", "=", pid)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      owner_org_id: orgA,
      origin_org_id: orgA,
      plugin_name: null,
      name: "lead",
      current_version: 1,
    });
    // A keeps it under its own id; B uses the platform template under the same bare type
    const inA = await boss({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` });
    expect(inA.json().template).toMatchObject({
      owned: true,
      shareable: true,
      promoted: true,
      version: 1,
      usable: true,
    });
    const inB = await root({ method: "GET", url: `/api/v1/orgs/${orgB}/agent-templates/${pid}` });
    expect(inB.statusCode, inB.body).toBe(200);
    expect(inB.json().template).toMatchObject({
      type: "lead",
      owner: { kind: "org", orgId: orgA, name: "A" },
      owned: false,
    });

    // the owner's next version goes to the platform row; B is told
    const v2 = await boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/agent-templates/${id}`,
      payload: { definition: { ...definition, description: "Leads v2." }, expectedVersion: 1 },
    });
    expect(v2.statusCode, v2.body).toBe(200);
    expect(v2.json().template).toMatchObject({ id, version: 2, description: "Leads v2." });
    const inB2 = await root({ method: "GET", url: `/api/v1/orgs/${orgB}/agent-templates/${pid}` });
    expect(inB2.json().template).toMatchObject({ version: 2, description: "Leads v2." });
    const notices = await db
      .selectFrom("org_notices")
      .select(["org_id", "kind"])
      .where("kind", "=", "shared_item_updated")
      .execute();
    expect(notices).toEqual([{ org_id: orgB, kind: "shared_item_updated" }]);

    // the owner deletes it while B uses it: the platform's now
    const preview = await boss({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/agent-templates/${id}/delete-preview`,
    });
    expect(preview.json()).toMatchObject({
      outcome: "transferred",
      orgs: [{ id: orgB, name: "B" }],
    });
    const del = await boss({ method: "DELETE", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` });
    expect(del.json()).toEqual({ outcome: "transferred" });
    expect(
      await db
        .selectFrom("platform_agent_templates")
        .select(["owner_org_id", "deleted_at"])
        .where("id", "=", pid)
        .executeTakeFirstOrThrow(),
    ).toEqual({ owner_org_id: null, deleted_at: null });
    expect(
      (
        await db
          .selectFrom("agent_templates")
          .select("deleted_at")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).deleted_at,
    ).not.toBeNull();
    const stillInB = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgB}/agent-templates/${pid}`,
    });
    expect(stillInB.json().template).toMatchObject({ owner: { kind: "platform" }, version: 2 });
    expect(await db.selectFrom("platform_notices").select("kind").execute()).toEqual([
      { kind: "ownership_transferred" },
    ]);
  });

  it("sharing into an org that has the bare type already is refused (rule 10, P4-13)", async () => {
    const id = (await saveAs(boss, orgA, await simpleAgent(orgA), "lead")).json().template
      .id as string;
    const inB = (await saveAs(root, orgB, await simpleAgent(orgB), "lead")).json().template
      .id as string;
    await boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/agent-templates/${id}/shareable`,
      payload: { shareable: true },
    });
    const preview = await root({
      method: "POST",
      url: `/api/v1/admin/components/agent_template/${id}/scope/preview`,
      payload: { scope: "named", orgs: [orgA, orgB] },
    });
    expect(preview.json().conflicts).toEqual([
      {
        orgId: orgB,
        orgName: "B",
        name: "lead",
        skills: [inB],
        plugins: [],
        owners: [{ kind: "org", orgId: orgB, name: "B" }],
      },
    ]);
    const put = await root({
      method: "PUT",
      url: `/api/v1/admin/components/agent_template/${id}/scope`,
      payload: { scope: "named", orgs: [orgA, orgB], scopeHash: preview.json().scopeHash },
    });
    expect(errorOf(put)).toEqual([409, "agent_template.name_taken"]);
    expect(put.json().error.details).toEqual([
      {
        orgId: orgB,
        type: "lead",
        templateId: inB,
        owner: { kind: "org", orgId: orgB, name: "B" },
      },
    ]);
    // nothing was promoted
    expect(await db.selectFrom("platform_agent_templates").select("id").execute()).toEqual([]);
  });

  it("an edit never carries credentials in a needs endpoint (P4-11)", async () => {
    const id = (await saveAs(boss, orgA, await simpleAgent(orgA), "lead")).json().template
      .id as string;
    const definition = (
      await mem({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` })
    ).json().template.definition as Record<string, unknown>;
    const needs = (endpoint: string) => ({
      ...definition,
      connectors: [{ needs: { protocol: "mcp", endpoint, tools: ["find"], label: "Wiki" } }],
    });
    const put = (def: Record<string, unknown>, expectedVersion = 1) =>
      boss({
        method: "PUT",
        url: `/api/v1/orgs/${orgA}/agent-templates/${id}`,
        payload: { definition: def, expectedVersion },
      });
    // refused: what it carries, or why it is no endpoint, is named
    for (const [endpoint, says] of [
      ["https://alice:hunter2@wiki.example.com/mcp", "userinfo"],
      ["https://wiki.example.com/mcp?token=sekrit", "a query"],
      ["https://wiki.example.com/mcp#frag", "a fragment"],
      ["https://bob@wiki.example.com/mcp?x=1#y", "userinfo, a query, a fragment"],
      ["ftp://wiki.example.com/mcp", "http(s) URL"],
      ["not a url", "http(s) URL"],
    ] as const) {
      const r = await put(needs(endpoint));
      expect(errorOf(r), endpoint).toEqual([400, "validation_failed"]);
      expect(r.json().error.details).toEqual([
        {
          path: "definition.connectors.0.needs.endpoint",
          message: expect.stringContaining(says),
        },
      ]);
    }
    // only normalization differs (a bare host, the host's case): stored canonical, no error
    const bare = await put(needs("https://Wiki.Example.com"));
    expect(bare.statusCode, bare.body).toBe(200);
    expect(bare.json().template).toMatchObject({
      version: 2,
      definition: {
        connectors: [
          {
            needs: {
              protocol: "mcp",
              endpoint: "https://wiki.example.com/",
              tools: ["find"],
              label: "Wiki",
            },
          },
        ],
      },
    });
    const ok = await put(needs("https://wiki.example.com/mcp"), 2);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().template.version).toBe(3);
  });

  it("save-as keeps a connector entry's tools and policy keys within the SDK limit", async () => {
    const names = Array.from({ length: 150 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    const conn = await seedConnector(orgA, {
      name: "Big",
      connector: "mcp",
      endpoint: { url: "https://big.example.com/mcp" },
      tools: names.map((name) => ({ name, status: "enabled" as const })),
    });
    // 100 policies on a connector whose entry already names 150 tools: room for 50
    const toolPolicies = Object.fromEntries(
      names.slice(0, 100).map((n) => [`mcp__big__${n}`, "ask"] as const),
    );
    const agentId = await seedAgent(orgA, {
      name: "Big",
      instructions: "Use the big connector.",
      model: { provider: "model-fake", model: "fake-1" },
      tools: [{ kind: "connector", connectorId: conn, tools: "all" }],
      toolPolicies,
    });
    const res = await saveAs(boss, orgA, agentId, "big");
    expect(res.statusCode, res.body).toBe(201);
    const [entry] = res.json().template.definition.connectors as {
      needs: { tools: string[] };
      policies: Record<string, string>;
    }[];
    expect(entry?.needs.tools).toHaveLength(150);
    expect(Object.keys(entry?.policies ?? {})).toEqual(names.slice(0, 50));
    const capped = (res.json().omitted as { kind: string; reason: string; name: string }[]).filter(
      (o) => o.kind === "tool_policy",
    );
    expect(capped).toHaveLength(50);
    expect(capped.every((o) => o.reason === "limit")).toBe(true);
    expect(capped.map((o) => o.name)).toEqual(names.slice(50, 100));
  });

  it("the owner opens and edits its promoted template while switched off in its own org", async () => {
    const { id, pid, definition } = await sharedLead(boss, orgA, [orgA, orgB]);
    await db
      .insertInto("component_org_switches")
      .values({ kind: "agent_template", component_id: pid, org_id: orgA, enabled: false })
      .execute();
    const got = await boss({ method: "GET", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` });
    expect(got.statusCode, got.body).toBe(200);
    // served by the owner fallback: not usable in its own org
    expect(got.json().template).toMatchObject({
      id,
      owned: true,
      promoted: true,
      version: 1,
      usable: false,
    });
    const v2 = await boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/agent-templates/${id}`,
      payload: {
        definition: { ...definition, description: "Off but edited." },
        expectedVersion: 1,
      },
    });
    expect(v2.statusCode, v2.body).toBe(200);
    expect(v2.json().template).toMatchObject({ version: 2, description: "Off but edited." });
  });

  it("another org cannot change a template it only uses", async () => {
    const { pid, definition } = await sharedLead(boss, orgA, [orgA, orgB]);
    const base = `/api/v1/orgs/${orgB}/agent-templates/${pid}`;
    expect(
      errorOf(
        await root({ method: "PUT", url: base, payload: { definition, expectedVersion: 1 } }),
      ),
    ).toEqual([409, "catalog.not_owned"]);
    expect(errorOf(await root({ method: "DELETE", url: base }))).toEqual([
      409,
      "catalog.not_owned",
    ]);
    expect(
      errorOf(
        await root({ method: "PUT", url: `${base}/shareable`, payload: { shareable: false } }),
      ),
    ).toEqual([409, "catalog.not_owned"]);
    expect(errorOf(await root({ method: "GET", url: `${base}/delete-preview` }))).toEqual([
      409,
      "catalog.not_owned",
    ]);
  });

  it("the super admin cannot share a plugin's template; members cannot preview a delete", async () => {
    const plugin = randomUUID();
    await db
      .insertInto("agent_templates")
      .values({
        id: plugin,
        org_id: orgA,
        name: "reviewer",
        plugin_name: "crm",
        current_version: 1,
        shareable: true,
      })
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: plugin,
        version: 1,
        definition: JSON.stringify({ name: "reviewer", description: "R.", instructions: "R." }),
      })
      .execute();
    const shown = await root({
      method: "PUT",
      url: `/api/v1/admin/components/agent_template/${plugin}/shown`,
      payload: { shownToOthers: true },
    });
    expect(errorOf(shown)).toEqual([409, "catalog.not_owned"]);
    const preview = await root({
      method: "POST",
      url: `/api/v1/admin/components/agent_template/${plugin}/scope/preview`,
      payload: { scope: "named", orgs: [orgA, orgB] },
    });
    const scoped = await root({
      method: "PUT",
      url: `/api/v1/admin/components/agent_template/${plugin}/scope`,
      payload: { scope: "named", orgs: [orgA, orgB], scopeHash: preview.json().scopeHash },
    });
    expect(errorOf(scoped)).toEqual([409, "catalog.not_owned"]);
    expect(await db.selectFrom("platform_agent_templates").select("id").execute()).toEqual([]);

    const id = (await saveAs(boss, orgA, await simpleAgent(orgA), "lead")).json().template
      .id as string;
    expect(
      errorOf(
        await mem({
          method: "GET",
          url: `/api/v1/orgs/${orgA}/agent-templates/${id}/delete-preview`,
        }),
      ),
    ).toEqual([403, "forbidden"]);
  });

  it("a promoted template no other org uses is removed with its platform row", async () => {
    const { id, pid } = await sharedLead(boss, orgA, [orgA, orgB]);
    // narrowed back to the owner: nobody else uses it
    expect((await putScope(pid, { scope: "named", orgs: [orgA] })).statusCode).toBe(200);
    const del = await boss({ method: "DELETE", url: `/api/v1/orgs/${orgA}/agent-templates/${id}` });
    expect(del.json()).toEqual({ outcome: "removed" });
    const row = await db
      .selectFrom("platform_agent_templates")
      .select(["owner_org_id", "deleted_at"])
      .where("id", "=", pid)
      .executeTakeFirstOrThrow();
    expect(row.owner_org_id).toBe(orgA);
    expect(row.deleted_at).not.toBeNull();
    expect(await db.selectFrom("platform_notices").select("kind").execute()).toEqual([]);
  });

  it("deleting the owner org transfers its used promoted template and removes the unused one", async () => {
    const orgC = await createOrg(root, "C");
    const used = await sharedLead(root, orgC, [orgC, orgB], "c-used");
    const unused = await sharedLead(root, orgC, [orgC, orgB], "c-unused");
    expect((await putScope(unused.pid, { scope: "named", orgs: [orgC] })).statusCode).toBe(200);
    const d = await root({ method: "DELETE", url: `/api/v1/orgs/${orgC}` });
    expect(d.statusCode, d.body).toBe(204);
    const rows = await db
      .selectFrom("platform_agent_templates")
      .select(["id", "owner_org_id", "deleted_at"])
      .where("id", "in", [used.pid, unused.pid])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(used.pid)).toMatchObject({ owner_org_id: null, deleted_at: null });
    expect(byId.get(unused.pid)?.deleted_at).not.toBeNull();
    const inB = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgB}/agent-templates/${used.pid}`,
    });
    expect(inB.json().template).toMatchObject({ owner: { kind: "platform" }, type: "c-used" });
    expect(await db.selectFrom("platform_notices").select("kind").execute()).toEqual([
      { kind: "ownership_transferred" },
    ]);
  });
});
