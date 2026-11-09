import { randomUUID } from "node:crypto";
import { setupGuideHash } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  importPlugin,
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  setScope,
  startOrgEnv,
} from "../catalog/org-env.js";
import { mcpTemplate, templateFiles } from "../catalog/packages.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, enableExtensions } from "../helpers/runs.js";

// Setup guides v2, the connector-template place (spec 2026-11-09-setup-guides-v2-design.md §9.3,
// §11): a template's guide renders for the org's connector made from it, the connector records the
// guide it was set up with when it is created from the template, drift appears when the guide's
// code blocks or checks change, and 「我已更新应用」 records the current guide.

const PUBLIC_URL = "https://capybara.example.com";
const TEMPLATE = "github-mcp";

/** The English document; `manifest` is the code block (the drift hash covers it, not the prose). */
const doc = (o: { manifest?: string; prose?: string } = {}) =>
  [
    "# Set up the {{templateName}} connector",
    "",
    o.prose ?? "For {{orgName}}.",
    "",
    "::: audience admin",
    "Register `{{oauthCallbackUrl}}`; connector {{connectorName}}.",
    "",
    '```yaml title="App manifest"',
    o.manifest ?? "scopes: [repo]",
    "```",
    "",
    "::check capybara:oauth-token-endpoint Token endpoint answers",
    ":::",
    "",
    "::: audience member",
    "Connect your account to {{connectorName}}.",
    ":::",
    "",
  ].join("\n");

/** The templates-only plugin `gh-guide` whose template `github-mcp` has the `gh` guide. */
const ghPlugin = (o: { version?: string; manifest?: string; prose?: string } = {}) =>
  pluginTgz({
    manifest: {
      name: "gh-guide",
      ...(o.version !== undefined && { version: o.version }),
      setupGuides: [{ id: "gh", place: "connector-template", template: TEMPLATE }],
    },
    files: {
      ...templateFiles(TEMPLATE, mcpTemplate(), {
        displayName: { zh: "GitHub 连接器", en: "GitHub MCP" },
      }),
      "guides/gh.md": doc(o),
    },
  });

const adminHash = (source: string) =>
  setupGuideHash(source, {
    place: "connector-template",
    guideId: "gh",
    mode: null,
    audience: "admin",
  });

type Rendered = {
  title: string;
  blocks: { kind: string; text?: string }[];
  audience: string;
  unresolved: { name: string; reason: string }[];
  target: { kind: string; id: string } | null;
  hash: string;
};
type ConnectorPage = {
  id: string;
  name: string;
  setupGuide: { itemId: string; guideId: string; version: string } | null;
  guideDrift: { from: string; to: string } | null;
};

let env: OrgEnv;
let otherOrgId: string;

beforeAll(async () => {
  env = await startOrgEnv();
  otherOrgId = await createOrg(env.root, "Globex");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  // the other org creates connectors of the fake-connector kind too
  await enableExtensions(env.db, otherOrgId, "fake-connector");
});

const connectorsUrl = (orgId = env.orgId) => `/api/v1/orgs/${orgId}/connectors`;

/** Installs `gh-guide` in the org with a connector from its template; returns the connector id. */
async function installWithConnector(itemId: string, orgId = env.orgId): Promise<string> {
  const req = orgId === env.orgId ? env.boss : env.root;
  const r =
    orgId === env.orgId
      ? await install(req, env, itemId, {
          connectors: {
            [TEMPLATE]: {
              name: "Team GitHub",
              endpoint: { url: env.mcp.url },
              credential: { token: MCP_TOKEN },
            },
          },
        })
      : await env.root({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/catalog/${itemId}/install`,
          payload: {
            connectors: {
              [TEMPLATE]: {
                name: "Other GitHub",
                endpoint: { url: env.mcp.url },
                credential: { token: MCP_TOKEN },
              },
            },
          },
        });
  expect(r.statusCode, r.body).toBe(201);
  const c = await env.db
    .selectFrom("connectors")
    .select("id")
    .where("org_id", "=", orgId)
    .where("catalog_item_id", "=", itemId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return c.id;
}

const renderReq = (itemId: string, query: string, req = env.boss, orgId = env.orgId) =>
  req({ method: "GET", url: `/api/v1/orgs/${orgId}/catalog/${itemId}/guides/gh${query}` });

async function render(itemId: string, query: string, req = env.boss): Promise<Rendered> {
  const r = await renderReq(itemId, query, req);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { guide: Rendered }).guide;
}

const prose = (g: Rendered) =>
  g.blocks
    .filter((b) => b.kind === "markdown")
    .map((b) => (b.text ?? "").replaceAll("⁠", ""))
    .join("\n");

async function page(connectorId: string, req = env.boss): Promise<ConnectorPage> {
  const r = await req({ method: "GET", url: `${connectorsUrl()}/${connectorId}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { connector: ConnectorPage }).connector;
}

const ack = (connectorId: string, hash: string, req = env.boss) =>
  req({
    method: "POST",
    url: `${connectorsUrl()}/${connectorId}/guide-ack`,
    payload: { hash },
  });

describe("setup guides v2: connector templates", { timeout: 60_000 }, () => {
  it("renders the connector guide for admin and member audiences", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    const connectorId = await installWithConnector(itemId);

    const admin = await render(itemId, `?connectorId=${connectorId}`);
    expect(admin.target).toEqual({ kind: "connector", id: connectorId });
    expect(admin.unresolved).toEqual([]);
    const text = prose(admin);
    expect(text).toContain(`${PUBLIC_URL}/api/v1/oauth/callback`);
    expect(text).toContain("connector Team GitHub.");
    expect(admin.title).toBe("Set up the GitHub MCP connector");
    expect(admin.blocks.some((b) => b.kind === "code")).toBe(true);

    const zh = await render(itemId, `?connectorId=${connectorId}&locale=zh`);
    // no zh document: the English one, with the English template name
    expect(zh.title).toBe("Set up the GitHub MCP connector");

    const member = await render(itemId, `?connectorId=${connectorId}&audience=member`, env.mem);
    expect(member.audience).toBe("member");
    expect(prose(member)).toContain("Connect your account to Team GitHub.");
    expect(prose(member)).not.toContain("Register");
    expect(member.blocks.some((b) => b.kind === "code" || b.kind === "check")).toBe(false);
  });

  it("member gets 403 on admin audience", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    const connectorId = await installWithConnector(itemId);
    const r = await renderReq(itemId, `?connectorId=${connectorId}`, env.mem);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
  });

  it("refuses another org's connector (404 connector.not_found)", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    await installWithConnector(itemId);
    const foreign = await installWithConnector(itemId, otherOrgId);
    for (const id of [foreign, randomUUID(), "not-a-uuid"]) {
      const r = await renderReq(itemId, `?connectorId=${id}`);
      expect(r.statusCode, id).toBe(404);
      expect(r.json().error.code).toBe("connector.not_found");
    }
    // a custom connector of the org (made from no template) is no target either
    const custom = await env.boss({
      method: "POST",
      url: connectorsUrl(),
      payload: {
        name: "Custom",
        connector: "fake",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(custom.statusCode, custom.body).toBe(201);
    const r = await renderReq(itemId, `?connectorId=${custom.json().connector.id}`);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("connector.not_found");
  });

  it("refuses a connector made from another template of the same plugin", async () => {
    // `gh-two` has the guided `github-mcp` and the unguided `jira-mcp`
    const itemId = await importPlugin(
      env,
      await pluginTgz({
        manifest: {
          name: "gh-two",
          setupGuides: [{ id: "gh", place: "connector-template", template: TEMPLATE }],
        },
        files: {
          ...templateFiles(TEMPLATE, mcpTemplate()),
          ...templateFiles("jira-mcp", mcpTemplate()),
          "guides/gh.md": doc(),
        },
      }),
    );
    const conn = (name: string) => ({
      name,
      endpoint: { url: env.mcp.url },
      credential: { token: MCP_TOKEN },
    });
    const r = await install(env.boss, env, itemId, {
      connectors: { [TEMPLATE]: conn("GitHub"), "jira-mcp": conn("Jira") },
    });
    expect(r.statusCode, r.body).toBe(201);
    const jira = await env.db
      .selectFrom("connectors")
      .select("id")
      .where("org_id", "=", env.orgId)
      .where("name", "=", "Jira")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const res = await renderReq(itemId, `?connectorId=${jira.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("connector.not_found");
    // the unguided connector has no guide fields and nothing to confirm
    expect((await page(jira.id)).setupGuide).toBeNull();
    const none = await ack(jira.id, adminHash(doc()));
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("catalog.guide_not_found");
  });

  it("ack route refuses another org's connector (404 connector.not_found)", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    await installWithConnector(itemId);
    const foreign = await installWithConnector(itemId, otherOrgId);
    const r = await ack(foreign, adminHash(doc()));
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("connector.not_found");
    const row = await env.db
      .selectFrom("connectors")
      .select("guide_ack")
      .where("id", "=", foreign)
      .executeTakeFirstOrThrow();
    // the other org's ack is untouched and no audit names the foreign connector
    expect(row.guide_ack?.version).toBe("1.0.0");
    const audits = await env.db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "=", foreign)
      .where("action", "=", "connector.guide_confirmed")
      .execute();
    expect(audits).toEqual([]);
  });

  it("create from template records the ack", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    const connectorId = await installWithConnector(itemId);
    const row = await env.db
      .selectFrom("connectors")
      .select("guide_ack")
      .where("id", "=", connectorId)
      .executeTakeFirstOrThrow();
    expect(row.guide_ack).toEqual({
      guideId: "gh",
      version: "1.0.0",
      hash: adminHash(doc()),
      mode: null,
    });
    const view = await page(connectorId);
    expect(view.setupGuide).toEqual({ itemId, guideId: "gh", version: "1.0.0" });
    expect(view.guideDrift).toBeNull();
    // members see where the guide is too (the member text of /account/connections)
    expect((await page(connectorId, env.mem)).setupGuide).toEqual(view.setupGuide);
    const listed = await env.boss({ method: "GET", url: connectorsUrl() });
    expect(
      (listed.json() as { connectors: ConnectorPage[] }).connectors.find(
        (c) => c.id === connectorId,
      )?.setupGuide,
    ).toEqual(view.setupGuide);

    // the template pages find the guide: catalog detail templates and the components list
    const detail = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().templates).toEqual([
      expect.objectContaining({ id: TEMPLATE, guide: { itemId, guideId: "gh" } }),
    ]);
    const comps = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/components?kind=connector_template`,
    });
    expect(comps.statusCode, comps.body).toBe(200);
    expect(
      (comps.json().components as { name: string; guide?: unknown }[]).find(
        (c) => c.name === TEMPLATE,
      )?.guide,
    ).toEqual({ itemId, guideId: "gh" });
  });

  it("drift appears when the template guide's code changes and not when only prose changes", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    const connectorId = await installWithConnector(itemId);
    // 1.1.0 edits only prose: no notice
    await importPlugin(
      env,
      await ghPlugin({ version: "1.1.0", prose: "For the {{orgName}} team." }),
    );
    expect((await page(connectorId)).guideDrift).toBeNull();
    // 1.2.0 changes the manifest code block: a notice with the versions
    await importPlugin(env, await ghPlugin({ version: "1.2.0", manifest: "scopes: [repo, org]" }));
    const view = await page(connectorId);
    expect(view.setupGuide?.version).toBe("1.2.0");
    expect(view.guideDrift).toEqual({ from: "1.0.0", to: "1.2.0" });
    // a connector without an ack (made before setup guides v2) never shows one
    await env.db
      .updateTable("connectors")
      .set({ guide_ack: null })
      .where("id", "=", connectorId)
      .execute();
    expect((await page(connectorId)).guideDrift).toBeNull();
  });

  it("ack route 409 on stale hash, audits on success", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    const connectorId = await installWithConnector(itemId);
    await importPlugin(env, await ghPlugin({ version: "1.2.0", manifest: "scopes: [repo, org]" }));
    const stale = await ack(connectorId, adminHash(doc()));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("connector.guide_changed");
    const current = adminHash(doc({ manifest: "scopes: [repo, org]" }));
    // the hash the page shows is the one the guide route returns
    expect((await render(itemId, `?connectorId=${connectorId}`)).hash).toBe(current);
    const denied = await ack(connectorId, current, env.mem);
    expect(denied.statusCode).toBe(403);
    const foreign = await env.boss({
      method: "POST",
      url: `${connectorsUrl()}/${randomUUID()}/guide-ack`,
      payload: { hash: current },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("connector.not_found");
    const bad = await ack(connectorId, "nope");
    expect(bad.statusCode).toBe(400);

    const ok = await ack(connectorId, current);
    expect(ok.statusCode, ok.body).toBe(200);
    const view = (ok.json() as { connector: ConnectorPage }).connector;
    expect(view.guideDrift).toBeNull();
    expect(view.setupGuide).toEqual({ itemId, guideId: "gh", version: "1.2.0" });
    const row = await env.db
      .selectFrom("connectors")
      .select("guide_ack")
      .where("id", "=", connectorId)
      .executeTakeFirstOrThrow();
    expect(row.guide_ack).toEqual({ guideId: "gh", version: "1.2.0", hash: current, mode: null });
    const audits = await env.db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("target", "=", connectorId)
      .where("action", "=", "connector.guide_confirmed")
      .execute();
    expect(audits).toEqual([
      { action: "connector.guide_confirmed", detail: { guideId: "gh", version: "1.2.0" } },
    ]);

    // a custom connector has no guide: 404 catalog.guide_not_found
    const custom = await env.boss({
      method: "POST",
      url: connectorsUrl(),
      payload: {
        name: "Custom",
        connector: "fake",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(custom.statusCode, custom.body).toBe(201);
    const none = await ack(custom.json().connector.id, current);
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("catalog.guide_not_found");
  });

  it("ack route applies the guide read's visibility: an item the org cannot see is 404", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    const connectorId = await installWithConnector(itemId);
    const current = adminHash(doc());
    // a named item this org is not listed for (and not requestable): neither the guide nor its ack
    await setScope(env, itemId, "named");
    await env.db
      .updateTable("catalog_items")
      .set({ shown_to_others: false })
      .where("id", "=", itemId)
      .execute();
    expect((await renderReq(itemId, `?connectorId=${connectorId}`)).statusCode).toBe(404);
    const hidden = await ack(connectorId, current);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("catalog.guide_not_found");
    // listed again: the ack goes through
    await setScope(env, itemId, "named", [env.orgId]);
    const ok = await ack(connectorId, current);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("upgrade preview reports a changed template guide with counts, never org names", async () => {
    const itemId = await importPlugin(env, await ghPlugin());
    await installWithConnector(itemId);
    await installWithConnector(itemId, otherOrgId);
    await importPlugin(env, await ghPlugin({ version: "1.1.0", prose: "Prose only." }));
    await importPlugin(env, await ghPlugin({ version: "1.2.0", manifest: "scopes: [repo, org]" }));
    const preview = async (version: string) => {
      const r = await env.root({
        method: "POST",
        url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
        payload: { version },
      });
      expect(r.statusCode, r.body).toBe(200);
      return r;
    };
    // a prose edit changes no hash: nothing to report
    expect((await preview("1.1.0")).json().guideChanges).toEqual([]);
    const r = await preview("1.2.0");
    expect(r.json().guideChanges).toEqual([
      { templateId: TEMPLATE, guideId: "gh", from: "1.0.0", to: "1.2.0", orgs: 2 },
    ]);
    const names = await env.db.selectFrom("orgs").select("name").execute();
    for (const { name } of names) expect(r.body).not.toContain(name);
  });
});
