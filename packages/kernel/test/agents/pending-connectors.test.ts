import { randomUUID } from "node:crypto";
import { type AgentTemplate, connectorToolKey } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentView } from "../../src/agents/agents.service.js";
import { PendingConnectorRequests } from "../../src/agents/pending-connector-requests.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import {
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setDeployment,
  startOrgEnv,
} from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, enableExtensions, PW, type Req, session } from "../helpers/runs.js";

/**
 * Plugin scope phase 4, Task 6: pending connectors (rulings P4-6, P4-7). Binding a connector to a
 * pending entry writes a new agent version with the connector's tools and policies; a member's
 * create opens one `connector_setup` request per agent for the org admins, which a reject answers
 * with a reason in the owner's inbox and the last bind closes; the owner re-opens one; deleting the
 * agent closes it. Org admins add one more connector from a platform connector template.
 */

let env: OrgEnv;
let otherOrg: string;

beforeAll(async () => {
  env = await startOrgEnv();
  otherOrg = await createOrg(env.root, "other-org");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
  await enableExtensions(env.k.app.get(KernelDb).pool, env.orgId, "fake-tools-ui");
});

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function catalogItem(plugin: string): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("catalog_items")
    .values({
      id,
      name: plugin,
      package_name: `@acme/plugin-${plugin}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

/** A platform agent template on in every org. */
async function platformTemplate(template: AgentTemplate): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("platform_agent_templates")
    .values({
      id,
      catalog_item_id: null,
      plugin_name: null,
      name: template.name,
      description: template.description,
      current_version: 1,
      scope_mode: "own",
      scope: "all",
    })
    .execute();
  await env.db
    .insertInto("platform_agent_template_versions")
    .values({ template_id: id, version: 1, definition: JSON.stringify(template) })
    .execute();
  return id;
}

/** A platform connector template `<itemId>/<templateId>` (fake-connector). */
async function connectorTemplate(itemId: string, templateId: string): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("platform_connector_templates")
    .values({
      id,
      catalog_item_id: itemId,
      template_id: templateId,
      current_version: "1.0.0",
      file: JSON.stringify({
        displayName: { zh: templateId.toUpperCase(), en: templateId.toUpperCase() },
        template: { plugin: "fake-connector", endpoint: { url: "https://x.example.com" } },
      }),
    })
    .execute();
  return id;
}

/** A connector of `orgId` (made from `platformTemplateId` when given) with these tools. */
async function connector(
  slug: string,
  tools: string[],
  o: { platformTemplateId?: string; kind?: string; orgId?: string; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("connectors")
    .values({
      id,
      org_id: o.orgId ?? env.orgId,
      slug,
      name: `Conn ${slug}`,
      connector: o.kind ?? "fake",
      endpoint: JSON.stringify({}),
      auth: JSON.stringify({}),
      created_by: env.bossId,
      platform_template_id: o.platformTemplateId ?? null,
      ...(o.deleted && { deleted_at: new Date() }),
    })
    .execute();
  if (tools.length > 0) {
    await env.db
      .insertInto("connector_tools")
      .values(
        tools.map((name) => ({
          connector_id: id,
          name,
          spec: JSON.stringify({ name, description: "d", inputSchema: { type: "object" } }),
          spec_hash: "h",
          status: "enabled" as const,
          default_policy: "allow" as const,
        })),
      )
      .execute();
  }
  return id;
}

const tpl = (over: Partial<AgentTemplate> = {}): AgentTemplate => ({
  name: "helper",
  description: "Helps with things.",
  instructions: "Help.",
  ...over,
});

let mem2Session: Req | undefined;

/** Another member of the org (not the owner of the test agents). */
async function secondMember(): Promise<Req> {
  if (mem2Session) return mem2Session;
  const id = (
    await accountsFor(env.db).createLocal({ login: "mem2", password: PW, displayName: "M2" })
  ).id;
  await env.db
    .insertInto("memberships")
    .values({ org_id: env.orgId, account_id: id, role: "member" })
    .execute();
  mem2Session = await session(env.k, "mem2");
  return mem2Session;
}

async function createFrom(
  req: Req,
  templateId: string,
  extra: Record<string, unknown> = {},
): Promise<AgentView> {
  const p = await req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents/from-template/preview`,
    payload: { templateId },
  });
  expect(p.statusCode, p.body).toBe(200);
  const r = await req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents/from-template`,
    payload: { templateId, name: "From tpl", previewHash: p.json().previewHash, ...extra },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { agent: AgentView }).agent;
}

/** A template needing `crm:gh` (tools search + gone, policies) and a hand-configured MCP one. */
async function twoPending(): Promise<{ templateId: string; platformGh: string }> {
  const itemId = await catalogItem("crm");
  const platformGh = await connectorTemplate(itemId, "gh");
  const templateId = await platformTemplate(
    tpl({
      connectors: [
        {
          template: "crm:gh",
          tools: ["search", "gone"],
          policies: { search: "ask", gone: "deny" },
        },
        {
          needs: {
            protocol: "mcp",
            endpoint: "https://docs.example.com/mcp",
            tools: ["q"],
            label: "Docs",
          },
        },
      ],
    }),
  );
  return { templateId, platformGh };
}

const bind = (req: Req, agentId: string, key: string, connectorId: string) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents/${agentId}/pending-connectors/${key}/bind`,
    payload: { connectorId },
  });

const requestsOf = (agentId: string) =>
  env.db
    .selectFrom("catalog_requests")
    .select([
      "id",
      "status",
      "pending_keys",
      "requested_by",
      "decided_by",
      "reason",
      "dismissed_at",
    ])
    .where("agent_id", "=", agentId)
    .orderBy("created_at")
    .execute();

interface InboxItem {
  type: string;
  id: string;
  request?: {
    kind: string;
    status: string;
    reason: string | null;
    item: unknown;
    entry: unknown;
    agent: { id: string; name: string; deleted: boolean } | null;
    connectors: { key: string; label: string; kind: string }[] | null;
  };
}

async function inbox(req: Req): Promise<InboxItem[]> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/inbox` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: InboxItem[] }).items;
}

const decide = (req: Req, id: string, body: Record<string, unknown>) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/catalog-requests/${id}/decide`,
    payload: body,
  });

const requestUrl = (agentId: string) =>
  `/api/v1/orgs/${env.orgId}/agents/${agentId}/pending-connectors/request`;

describe("binding a pending connector (P4-6)", { timeout: 60_000 }, () => {
  it("adds the connector's tools and policies, removes the key, closes the request on the last bind", async () => {
    const { templateId, platformGh } = await twoPending();
    const agent = await createFrom(env.mem, templateId);
    expect(agent.definition.pendingConnectors?.map((c) => c.key)).toEqual([
      "connector-1",
      "connector-2",
    ]);
    const [open] = await requestsOf(agent.id);
    expect(open).toMatchObject({
      status: "pending",
      pending_keys: ["connector-1", "connector-2"],
      requested_by: env.memId,
    });

    const gh = await connector("gh", ["search", "delete_all"], { platformTemplateId: platformGh });
    // the owner (a member) binds an existing connector of the template
    const r1 = await bind(env.mem, agent.id, "connector-1", gh);
    expect(r1.statusCode, r1.body).toBe(200);
    const a1 = (r1.json() as { agent: AgentView; dropped: string[] }).agent;
    expect(r1.json().dropped).toEqual(["tools.gone", "policies.gone"]);
    expect(a1.currentVersion).toBe(2);
    expect(a1.definition.tools).toContainEqual({
      kind: "connector",
      connectorId: gh,
      tools: ["search"],
    });
    expect(a1.definition.toolPolicies[connectorToolKey("gh", "search")]).toBe("ask");
    expect(a1.definition.pendingConnectors?.map((c) => c.key)).toEqual(["connector-2"]);
    expect((await requestsOf(agent.id))[0]).toMatchObject({
      status: "pending",
      pending_keys: ["connector-2"],
    });

    // an org admin binds the hand-configured one with an MCP connector of the org
    const docs = await connector("docs", ["q", "r"], { kind: "mcp" });
    const r2 = await bind(env.boss, agent.id, "connector-2", docs);
    expect(r2.statusCode, r2.body).toBe(200);
    const a2 = (r2.json() as { agent: AgentView }).agent;
    expect(a2.currentVersion).toBe(3);
    expect(a2.definition.pendingConnectors).toBeUndefined();
    expect(a2.definition.tools).toContainEqual({
      kind: "connector",
      connectorId: docs,
      tools: ["q"],
    });
    const [closed] = await requestsOf(agent.id);
    expect(closed).toMatchObject({ status: "approved", decided_by: env.bossId, pending_keys: [] });
    // the owner hears about it; the admins' inbox no longer lists it
    const notice = (await inbox(env.mem)).find((i) => i.id === closed?.id);
    expect(notice?.type).toBe("catalog_request_decided");
    expect(notice?.request).toMatchObject({
      kind: "connector_setup",
      status: "approved",
      item: null,
      entry: null,
      agent: { id: agent.id, name: "From tpl", deleted: false },
      connectors: [],
    });
    expect((await inbox(env.boss)).some((i) => i.id === closed?.id)).toBe(false);
  });

  it("binds all tools when the entry names none and merges into an existing connector ref", async () => {
    const itemId = await catalogItem("crm");
    const platformGh = await connectorTemplate(itemId, "gh");
    const templateId = await platformTemplate(tpl({ connectors: [{ template: "crm:gh" }] }));
    const agent = await createFrom(env.boss, templateId);
    expect(await requestsOf(agent.id)).toEqual([]);
    const gh = await connector("gh", ["search", "delete_all"], { platformTemplateId: platformGh });
    const r = await bind(env.boss, agent.id, "connector-1", gh);
    expect(r.statusCode, r.body).toBe(200);
    const a = (r.json() as { agent: AgentView }).agent;
    expect(a.definition.tools.filter((t) => t.kind === "connector")).toEqual([
      { kind: "connector", connectorId: gh, tools: "all" },
    ]);
    expect(r.json().dropped).toEqual([]);
  });

  it("refuses a connector that does not fit, each case", async () => {
    const { templateId, platformGh } = await twoPending();
    const agent = await createFrom(env.mem, templateId);
    const itemId = (
      await env.db
        .selectFrom("platform_connector_templates")
        .select("catalog_item_id")
        .where("id", "=", platformGh)
        .executeTakeFirstOrThrow()
    ).catalog_item_id;
    const otherTemplate = await connectorTemplate(itemId, "other");
    const fromOther = await connector("other", ["search"], { platformTemplateId: otherTemplate });
    const custom = await connector("custom", ["search"]);
    const elsewhere = await connector("gh", ["search"], {
      platformTemplateId: platformGh,
      orgId: otherOrg,
    });
    const deleted = await connector("gh-old", ["search"], {
      platformTemplateId: platformGh,
      deleted: true,
    });
    const noTools = await connector("gh-bare", ["delete_all"], { platformTemplateId: platformGh });
    const fakeKind = await connector("fake-docs", ["q"]);
    const mcpNoTools = await connector("mcp-docs", ["x"], { kind: "mcp" });

    const cases: [string, string, number, string, string?][] = [
      ["connector-1", fromOther, 400, "agent.pending_connector_mismatch", "template"],
      ["connector-1", custom, 400, "agent.pending_connector_mismatch", "template"],
      ["connector-1", elsewhere, 404, "connector.not_found"],
      ["connector-1", deleted, 404, "connector.not_found"],
      ["connector-1", randomUUID(), 404, "connector.not_found"],
      ["connector-1", noTools, 400, "agent.pending_connector_mismatch", "tools"],
      ["connector-2", fakeKind, 400, "agent.pending_connector_mismatch", "protocol"],
      ["connector-2", mcpNoTools, 400, "agent.pending_connector_mismatch", "tools"],
      ["connector-9", custom, 404, "agent.pending_connector_not_found"],
    ];
    for (const [key, id, status, code, reason] of cases) {
      const r = await bind(env.mem, agent.id, key, id);
      expect(r.statusCode, `${key} ${r.body}`).toBe(status);
      expect(errCode(r)).toBe(code);
      if (reason !== undefined) expect(r.json().error.details).toEqual([{ reason }]);
    }
    // nothing changed
    const a = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/agents/${agent.id}` });
    expect((a.json() as { agent: AgentView }).agent.currentVersion).toBe(1);
    // only an editor binds: a member who is not the owner gets 404 (private) or 403 (shared)
    const mem2 = await secondMember();
    const hidden = await bind(mem2, agent.id, "connector-1", custom);
    expect(errCode(hidden)).toBe("agent.not_found");
    const shared = await createFrom(env.boss, templateId, { visibility: "org" });
    const forbidden = await bind(mem2, shared.id, "connector-1", custom);
    expect(forbidden.statusCode).toBe(403);
    expect(errCode(forbidden)).toBe("forbidden");
    expect(errCode(await env.mem({ method: "POST", url: requestUrl(shared.id) }))).toBe(
      "forbidden",
    );
  });
});

describe("connector setup requests (P4-7)", { timeout: 60_000 }, () => {
  it("opens one request per agent, only for a creator without connectors.manage", async () => {
    const { templateId } = await twoPending();
    const byAdmin = await createFrom(env.boss, templateId);
    expect(await requestsOf(byAdmin.id)).toEqual([]);
    const byMember = await createFrom(env.mem, templateId);
    expect(await requestsOf(byMember.id)).toHaveLength(1);
    // opening again keeps the one pending request
    await env.k.app.get(PendingConnectorRequests).openFor({
      orgId: env.orgId,
      agentId: byMember.id,
      ownerAccountId: env.memId,
      keys: ["connector-1"],
    });
    const rows = await requestsOf(byMember.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending_keys).toEqual(["connector-1", "connector-2"]);
    const audits = await env.db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "catalog.requested")
      .execute();
    expect(audits).toEqual([
      {
        action: "catalog.requested",
        detail: {
          kind: "connector_setup",
          agentId: byMember.id,
          keys: ["connector-1", "connector-2"],
        },
      },
    ]);
    // the admins' inbox lists it with the agent and the labels of what it waits for
    const item = (await inbox(env.boss)).find((i) => i.id === rows[0]?.id);
    expect(item?.type).toBe("catalog_request");
    expect(item?.request).toMatchObject({
      kind: "connector_setup",
      status: "pending",
      item: null,
      agent: { id: byMember.id, name: "From tpl", deleted: false },
      connectors: [
        { key: "connector-1", label: "GH", kind: "template" },
        { key: "connector-2", label: "Docs", kind: "needs" },
      ],
    });
    // members do not see others' requests
    expect((await inbox(env.mem)).some((i) => i.id === rows[0]?.id)).toBe(false);
  });

  it("a reject takes a reason and tells the owner; approving is refused", async () => {
    const { templateId } = await twoPending();
    const agent = await createFrom(env.mem, templateId);
    const [row] = await requestsOf(agent.id);
    const id = row?.id as string;
    const approve = await decide(env.boss, id, { approve: true });
    expect(approve.statusCode).toBe(409);
    expect(errCode(approve)).toBe("catalog.request_invalid");
    expect((await decide(env.mem, id, { approve: false })).statusCode).toBe(403);
    const r = await decide(env.boss, id, { approve: false, reason: "No budget this quarter" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().request).toMatchObject({
      kind: "connector_setup",
      status: "rejected",
      reason: "No budget this quarter",
      agent: { id: agent.id },
    });
    const notice = (await inbox(env.mem)).find((i) => i.id === id);
    expect(notice?.type).toBe("catalog_request_decided");
    expect(notice?.request).toMatchObject({
      status: "rejected",
      reason: "No budget this quarter",
      connectors: [
        { key: "connector-1", label: "GH", kind: "template" },
        { key: "connector-2", label: "Docs", kind: "needs" },
      ],
    });
    expect((await decide(env.boss, id, { approve: false })).statusCode).toBe(409);
    // the owner dismisses it like any decided request
    const dismissed = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/catalog-requests/${id}/dismiss`,
    });
    expect(dismissed.statusCode).toBe(204);
    expect((await inbox(env.mem)).some((i) => i.id === id)).toBe(false);
  });

  it("re-opens a request after a reject and when none exists; GET shows the latest", async () => {
    const { templateId } = await twoPending();
    const agent = await createFrom(env.mem, templateId);
    const [first] = await requestsOf(agent.id);
    await decide(env.boss, first?.id as string, { approve: false, reason: "later" });
    const seen = await env.mem({ method: "GET", url: requestUrl(agent.id) });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().request).toMatchObject({ id: first?.id, status: "rejected" });

    const again = await env.mem({ method: "POST", url: requestUrl(agent.id) });
    expect(again.statusCode, again.body).toBe(201);
    const second = again.json().request as { id: string; status: string };
    expect(second.status).toBe("pending");
    expect(second.id).not.toBe(first?.id);
    // idempotent while one is pending
    const same = await env.mem({ method: "POST", url: requestUrl(agent.id) });
    expect(same.statusCode).toBe(200);
    expect(same.json().request.id).toBe(second.id);
    expect((await env.mem({ method: "GET", url: requestUrl(agent.id) })).json().request.id).toBe(
      second.id,
    );

    // an agent an admin created, then handed to a member, has none: the member opens one
    const handed = await createFrom(env.boss, templateId);
    const none = await env.mem({ method: "GET", url: requestUrl(handed.id) });
    expect(none.statusCode).toBe(404);
    const owner = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents/${handed.id}/owner`,
      payload: { accountId: env.memId },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect((await env.mem({ method: "GET", url: requestUrl(handed.id) })).json().request).toBe(
      null,
    );
    const opened = await env.mem({ method: "POST", url: requestUrl(handed.id) });
    expect(opened.statusCode, opened.body).toBe(201);
    expect((await requestsOf(handed.id))[0]).toMatchObject({
      status: "pending",
      requested_by: env.memId,
      pending_keys: ["connector-1", "connector-2"],
    });

    // nothing pending: refused
    const plain = await createFrom(env.mem, await platformTemplate(tpl({ name: "plain" })));
    const nothing = await env.mem({ method: "POST", url: requestUrl(plain.id) });
    expect(nothing.statusCode).toBe(409);
    expect(errCode(nothing)).toBe("agent.no_pending_connectors");
  });

  it("deleting the agent closes its request; an edit removing entries narrows or cancels it", async () => {
    const { templateId } = await twoPending();
    const doomed = await createFrom(env.mem, templateId);
    const del = await env.mem({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/agents/${doomed.id}`,
    });
    expect(del.statusCode).toBe(204);
    expect((await requestsOf(doomed.id))[0]?.status).toBe("cancelled");
    expect((await inbox(env.boss)).some((i) => i.request?.agent?.id === doomed.id)).toBe(false);

    const edited = await createFrom(env.mem, templateId);
    const url = `/api/v1/orgs/${env.orgId}/agents/${edited.id}`;
    const { pendingConnectors, ...rest } = edited.definition;
    const one = await env.mem({
      method: "PATCH",
      url,
      payload: { definition: { ...rest, pendingConnectors: [pendingConnectors?.[1]] } },
    });
    expect(one.statusCode, one.body).toBe(200);
    expect((await requestsOf(edited.id))[0]).toMatchObject({
      status: "pending",
      pending_keys: ["connector-2"],
    });
    const none = await env.mem({
      method: "PATCH",
      url,
      payload: { definition: { ...rest, pendingConnectors: [] } },
    });
    expect(none.statusCode, none.body).toBe(200);
    expect((await requestsOf(edited.id))[0]).toMatchObject({ status: "cancelled" });
  });

  it("closes without a notice when the owner binds the last connector", async () => {
    const itemId = await catalogItem("crm");
    const platformGh = await connectorTemplate(itemId, "gh");
    const templateId = await platformTemplate(tpl({ connectors: [{ template: "crm:gh" }] }));
    const agent = await createFrom(env.mem, templateId);
    const gh = await connector("gh", ["search"], { platformTemplateId: platformGh });
    expect((await bind(env.mem, agent.id, "connector-1", gh)).statusCode).toBe(200);
    const [row] = await requestsOf(agent.id);
    expect(row).toMatchObject({ status: "approved", decided_by: env.memId });
    expect(row?.dismissed_at).not.toBeNull();
    expect((await inbox(env.mem)).some((i) => i.id === row?.id)).toBe(false);
  });
});

describe("one more connector from a connector template (P4-7)", { timeout: 120_000 }, () => {
  const tokenInput = () => ({ endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } });
  const platformIdOf = async (itemId: string) =>
    (
      await env.db
        .selectFrom("platform_connector_templates")
        .select("id")
        .where("catalog_item_id", "=", itemId)
        .where("template_id", "=", "gh")
        .executeTakeFirstOrThrow()
    ).id;
  const create = (req: Req, id: string, body: Record<string, unknown>) =>
    req({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connector-templates/${id}/connectors`,
      payload: body,
    });

  it("creates a connector linked to the template, refused when off, not usable or not an admin", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [] });
    const platformGh = await platformIdOf(item);
    // the plugin is offered but not installed: the template follows it, so it is off here
    const off = await create(env.boss, platformGh, { config: tokenInput() });
    expect(off.statusCode, off.body).toBe(409);
    expect(errCode(off)).toBe("component.off");
    expect(errCode(await create(env.boss, randomUUID(), { config: tokenInput() }))).toBe(
      "component.not_found",
    );
    expect(errCode(await create(env.boss, "not-a-uuid", { config: tokenInput() }))).toBe(
      "component.not_found",
    );

    const installed = await install(env.boss, env, item, { connectors: { gh: tokenInput() } });
    expect(installed.statusCode, installed.body).toBe(201);
    const installId = installed.json().installed.pluginInstallId as string;
    expect((await create(env.mem, platformGh, { config: tokenInput() })).statusCode).toBe(403);
    // the default name's slug is the first connector's
    const taken = await create(env.boss, platformGh, { config: tokenInput() });
    expect(errCode(taken)).toBe("connector.slug_taken");
    const missing = await create(env.boss, platformGh, {
      name: "GitHub 2",
      config: { endpoint: { url: env.mcp.url } },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details[0].path).toBe("config.credential");

    const r = await create(env.boss, platformGh, { name: "GitHub 2", config: tokenInput() });
    expect(r.statusCode, r.body).toBe(201);
    const made = r.json().connector as { id: string; name: string; tools: { name: string }[] };
    expect(made.name).toBe("GitHub 2");
    expect(made.tools.map((t) => t.name).sort()).toEqual(["delete_all", "search"]);
    const row = await env.db
      .selectFrom("connectors")
      .select(["platform_template_id"])
      .where("id", "=", made.id)
      .executeTakeFirstOrThrow();
    expect(row.platform_template_id).toBe(platformGh);
    const ledger = await env.db
      .selectFrom("plugin_install_components")
      .select(["ref", "template_id"])
      .where("install_id", "=", installId)
      .where("kind", "=", "connector")
      .where("ref", "=", made.id)
      .execute();
    expect(ledger).toEqual([{ ref: made.id, template_id: "gh" }]);

    // the org admin switches the template off: refused again
    const sw = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/components/connector_template/${platformGh}/switch`,
      payload: { enabled: false },
    });
    expect(sw.statusCode, sw.body).toBe(200);
    const confirm = sw.json().confirm as string | undefined;
    if (confirm !== undefined) {
      const c = await env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/components/connector_template/${platformGh}/switch`,
        payload: { enabled: false, confirm },
      });
      expect(c.statusCode, c.body).toBe(200);
    }
    const afterOff = await create(env.boss, platformGh, { name: "GitHub 3", config: tokenInput() });
    expect(errCode(afterOff)).toBe("component.off");
  });

  it("with customConnectors = deny the request flow still ends in a bound template connector", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [] });
    const platformGh = await platformIdOf(item);
    await setDeployment(env, { customConnectors: "deny" });
    const templateId = await platformTemplate(
      tpl({ connectors: [{ template: "crm:gh", tools: ["search"] }] }),
    );
    const agent = await createFrom(env.mem, templateId);
    const [open] = await requestsOf(agent.id);
    expect(open?.status).toBe("pending");
    // a hand-configured connector is refused, as before
    const custom = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors`,
      payload: {
        name: "Custom",
        connector: "fake",
        endpoint: { url: env.mcp.url },
        auth: { type: "none" },
      },
    });
    expect(errCode(custom)).toBe("catalog.custom_disabled");
    // the admin installs the plugin with its connector and binds it
    const installed = await install(env.boss, env, item, { connectors: { gh: tokenInput() } });
    expect(installed.statusCode, installed.body).toBe(201);
    const gh = (
      await env.db
        .selectFrom("connectors")
        .select("id")
        .where("org_id", "=", env.orgId)
        .where("platform_template_id", "=", platformGh)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow()
    ).id;
    const r = await bind(env.boss, agent.id, "connector-1", gh);
    expect(r.statusCode, r.body).toBe(200);
    expect((await requestsOf(agent.id))[0]?.status).toBe("approved");
  });
});
