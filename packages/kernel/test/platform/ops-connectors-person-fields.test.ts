import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createLogger } from "../../src/log.js";
import { PLATFORM_EXCLUSIONS } from "../../src/platform/exclusions.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { Credentials } from "../../src/tools/credentials.js";
import {
  importPlugin,
  MCP_TOKEN,
  type OrgEnv,
  startOrgEnv,
  TEMPLATE_ID,
} from "../catalog/org-env.js";
import { mcpTemplate, templateFiles } from "../catalog/packages.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import {
  createConv,
  enableConnectorExtensions,
  eventsOf,
  postMessage,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Connector and catalog operations on person fields (platform web parity spec §7.2, Task 10): a
 * connector's credential comes from its auth method (ruling R3) and is typed by the person on the
 * card; creating a connector and installing a plugin with a template connector run end to end
 * through the `Platform` tool, the approval decision and the sealed values. The credential is found
 * in no event, approval, audit row or log line.
 */

/** A templates-only plugin whose template `github-mcp` has the setup guide `gh`. */
const guidePlugin = () =>
  pluginTgz({
    manifest: {
      name: "gh-guide",
      setupGuides: [{ id: "gh", place: "connector-template", template: TEMPLATE_ID }],
    },
    files: {
      ...templateFiles(TEMPLATE_ID, mcpTemplate(), {
        displayName: { zh: "GitHub 连接器", en: "GitHub MCP" },
      }),
      "guides/gh.md": [
        "# Set up {{templateName}}",
        "",
        "::: audience admin",
        '```yaml title="App manifest"',
        "scopes: [repo]",
        "```",
        ":::",
        "",
      ].join("\n"),
    },
  });

let env: OrgEnv;
let ops: PlatformOperations;
const lines: string[] = [];

beforeAll(async () => {
  env = await startOrgEnv({
    logger: createLogger("debug", { write: (line) => lines.push(line) }),
  });
  ops = env.k.app.get(PlatformOperations);
  await enableConnectorExtensions(env.k, env.orgId);
});
afterAll(async () => {
  await env?.stop();
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const ctxOf = (over: Partial<OperationContext> = {}): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: env.rootId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  errorRole: "superAdmin",
  ...over,
});

const personFieldsOf = async (id: string, input: unknown) => {
  const o = op(id);
  if (o.personFields === undefined) throw new Error(`${id} has no person fields`);
  return o.personFields(o.input.parse(input), ctxOf());
};

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

/** A private agent with the Platform tool, as the org owner (also the super admin). */
async function platformAgent(name: string): Promise<string> {
  const res = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: builtinsOff("Platform"),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/**
 * Calls one operation through the tool, approves its card with `inputs` and waits for the run:
 * returns the approval's person field paths and the tool result.
 */
async function callWithCard(
  agentId: string,
  operation: string,
  params: Record<string, unknown>,
  inputs: Record<string, string>,
) {
  const convId = await createConv(env.root, env.orgId, agentId);
  const call = { action: "call", operation, params };
  await postMessage(env.root, env.orgId, convId, `tool:Platform:${JSON.stringify(call)}`);
  const asked = await waitFor(
    async () => ofType(await eventsOf(env.db, convId), "approval_requested")[0],
    20_000,
    "approval_requested",
  );
  const row = await env.db
    .selectFrom("approvals")
    .selectAll()
    .where("id", "=", asked.payload.approvalId)
    .executeTakeFirstOrThrow();
  const paths =
    (row.detail as { personFields?: { path: string }[] } | null)?.personFields?.map(
      (f) => f.path,
    ) ?? [];
  const ok = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/approvals/${row.id}/decision`,
    payload: {
      decision: "approve",
      scope: "once",
      ...(Object.keys(inputs).length > 0 && { inputs }),
    },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  await waitForTerminal(env.db, convId, 1, 30_000);
  const result = ofType(await eventsOf(env.db, convId), "tool_result").at(-1)?.payload;
  return { convId, paths, result };
}

/** The value appears in no event, approval, audit row or log line. */
async function foundNowhere(value: string) {
  const events = await sql<{
    payload: unknown;
  }>`SELECT payload FROM capybara.conversation_events`.execute(env.db);
  expect(JSON.stringify(events.rows)).not.toContain(value);
  expect(
    JSON.stringify(await env.db.selectFrom("audit_events").selectAll().execute()),
  ).not.toContain(value);
  expect(JSON.stringify(await env.db.selectFrom("approvals").selectAll().execute())).not.toContain(
    value,
  );
  expect(lines.join("\n")).not.toContain(value);
}

describe("registration", () => {
  const MOVED = [
    "GET /api/v1/orgs/:orgId/connectors/kinds",
    "POST /api/v1/orgs/:orgId/connectors",
    "POST /api/v1/orgs/:orgId/connectors/preview",
    "PATCH /api/v1/orgs/:orgId/connectors/:connectorId",
    "POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack",
    "PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/org",
    "PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me",
    "DELETE /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me",
    "POST /api/v1/orgs/:orgId/catalog/:itemId/install",
    "POST /api/v1/orgs/:orgId/catalog/:itemId/connectors",
    "POST /api/v1/orgs/:orgId/connector-templates/:templateId/connectors",
  ];

  it("every moved route is an operation's mirror and no longer an exclusion", () => {
    const excluded = new Set(PLATFORM_EXCLUSIONS.map((e) => e.route));
    const mirrored = new Set(ops.all().flatMap((o) => o.mirrors));
    for (const route of MOVED) {
      expect(excluded.has(route), route).toBe(false);
      expect(mirrored.has(route), route).toBe(true);
    }
  });

  it("credential writes have person fields; setting your own credential is never remembered", () => {
    for (const id of [
      "connectors.create",
      "connectors.set-org-credential",
      "connectors.set-my-credential",
      "connectors.add-from-template",
      "plugins.install",
      "plugins.configure-connectors",
    ]) {
      expect(op(id).personFields, id).toBeTypeOf("function");
    }
    expect(op("connectors.set-my-credential")).toMatchObject({
      confirm: "personal",
      rememberable: false,
    });
    // a person's attestation and a destructive personal write: confirmed each time
    for (const id of ["connectors.guide-ack", "connectors.clear-my-credential"]) {
      expect(op(id), id).toMatchObject({ confirm: "personal", rememberable: false });
    }
    expect(op("connectors.kinds").confirm).toBe("read");
    expect(op("connectors.preview")).toMatchObject({ confirm: "read", omits: ["credential"] });
  });

  it("connectors.update refuses tools (ruling R4: per-tool policy is the agent's own permission)", () => {
    const o = op("connectors.update");
    expect(o.omits).toContain("tools");
    const id = randomUUID();
    expect(o.input.safeParse({ connectorId: id, name: "Docs" }).success).toBe(true);
    expect(
      o.input.safeParse({ connectorId: id, tools: { search: { defaultPolicy: "allow" } } }).success,
    ).toBe(false);
    expect(o.input.safeParse({ connectorId: id, allowUnannotated: true }).success).toBe(false);
  });
});

describe("connectors.create", () => {
  const params = (over: Record<string, unknown> = {}) => ({
    name: "Docs",
    connector: "fake",
    endpoint: { url: env.mcp.url },
    auth: { type: "bearer", ownership: "org" },
    askPerson: ["credential.token"],
    ...over,
  });

  it("asks the credential fields of the auth method, never one the model passes", async () => {
    const t = await personFieldsOf("connectors.create", params());
    expect(t.target.en).toBe("Connector Docs (org)");
    expect(t.fields.map((f) => [f.path, f.label, f.required])).toEqual([
      ["credential.token", { zh: "令牌", en: "Token" }, true],
    ]);
    // the credential is no param
    expect(op("connectors.create").input.safeParse({ ...params(), credential: {} }).success).toBe(
      false,
    );
    const basic = await personFieldsOf(
      "connectors.create",
      params({ auth: { type: "basic", ownership: "org" }, askPerson: [] }),
    );
    expect(basic.fields.map((f) => f.path)).toEqual(["credential.username", "credential.password"]);
  });

  it("refuses custom header credentials before the card: the person enters them on the web", async () => {
    const o = op("connectors.create");
    const pre = await o.precheck?.(
      o.input.parse(params({ auth: { type: "headers", ownership: "org", names: ["X-Key"] } })),
      ctxOf(),
    );
    expect(pre).toMatchObject({ ok: false, code: "platform.secret_record_web_only" });
  });

  it("refuses an OAuth client without its id, and a client for an auth method that takes none", async () => {
    const o = op("connectors.create");
    const oauth = {
      type: "oauth_client",
      ownership: "org",
      tokenUrl: "https://auth.example.com/token",
    };
    expect(
      await o.precheck?.(o.input.parse(params({ auth: oauth, askPerson: [] })), ctxOf()),
    ).toMatchObject({ ok: false, code: "validation_failed" });
    expect(
      await o.precheck?.(
        o.input.parse(params({ auth: oauth, client: { clientId: "cid" }, askPerson: [] })),
        ctxOf(),
      ),
    ).toEqual({ ok: true });
    const bearer = await o.precheck?.(
      o.input.parse(params({ client: { clientId: "cid" } })),
      ctxOf(),
    );
    expect(bearer).toMatchObject({ ok: false, code: "validation_failed" });
    expect((bearer as { message: string }).message).toContain("leave client out");
  });

  it("creates the connector with the token the person typed on the card, and leaks it nowhere", async () => {
    const agentId = await platformAgent("Connector maker");
    const { convId, paths, result } = await callWithCard(agentId, "connectors.create", params(), {
      "credential.token": MCP_TOKEN,
    });
    expect(paths).toEqual(["credential.token"]);
    expect(result?.isError, result?.content).toBe(false);
    expect(result?.content).toContain("`credential.token`: entered by the person");

    const c = await env.db
      .selectFrom("connectors")
      .select("id")
      .where("org_id", "=", env.orgId)
      .where("slug", "=", "docs")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const read = (await op("connectors.get").run({ connectorId: c.id }, ctxOf())) as {
      connector: { credential: unknown; tools: { name: string }[] };
    };
    expect(read.connector.credential).toMatchObject({ ownership: "org", status: "connected" });
    // the connector listed its tools with the typed token (the fake server requires it)
    expect(read.connector.tools.map((t) => t.name)).toContain("search");

    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "connector.created")
      .where("target", "=", c.id)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      via: "agent",
      operation: "connectors.create",
      agentConversationId: convId,
      inputsProvided: ["credential.token"],
    });
    await foundNowhere(MCP_TOKEN);
  });
});

const injectionOf = async (connectorId: string, auth: unknown) =>
  env.k.app.get(Credentials).injection(env.orgId, connectorId, auth as never, env.rootId);

describe("credentials", () => {
  const NEW_ORG_TOKEN = "tok-org-rotated-Pq83Zx51";
  const MY_TOKEN = "tok-personal-Wm27Lk90";
  const NEW_SECRET = "client-secret-rotated-Hb64Tr";

  const connectorId = async (slug: string) =>
    (
      await env.db
        .selectFrom("connectors")
        .select("id")
        .where("org_id", "=", env.orgId)
        .where("slug", "=", slug)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow()
    ).id;

  it("connectors.set-org-credential replaces the org token with the one typed on the card", async () => {
    const id = await connectorId("docs");
    const agentId = await platformAgent("Org credential setter");
    const { paths, result } = await callWithCard(
      agentId,
      "connectors.set-org-credential",
      { connectorId: id },
      { "credential.token": NEW_ORG_TOKEN },
    );
    expect(paths).toEqual(["credential.token"]);
    expect(result?.isError, result?.content).toBe(false);
    const inj = await injectionOf(id, { type: "bearer", ownership: "org" });
    expect(inj.headers?.Authorization).toBe(`Bearer ${NEW_ORG_TOKEN}`);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "connector.credential.set")
      .where("target", "=", id)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      operation: "connectors.set-org-credential",
      inputsProvided: ["credential.token"],
    });
    await foundNowhere(NEW_ORG_TOKEN);
  });

  it("connectors.set-org-credential rotates an OAuth client: the id as a param, the secret on the card", async () => {
    const created = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors`,
      payload: {
        name: "Auth app",
        connector: "fake",
        endpoint: { url: env.mcp.url },
        auth: {
          type: "oauth_code",
          ownership: "personal",
          discovery: "manual",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          client: "manual",
        },
        credential: { clientId: "cid-old", clientSecret: "client-secret-old" },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { connector: { id: string } }).connector.id;
    const o = op("connectors.set-org-credential");
    // the client id is required for an OAuth connector
    expect(await o.precheck?.(o.input.parse({ connectorId: id }), ctxOf())).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
    const agentId = await platformAgent("Client rotator");
    const { paths, result } = await callWithCard(
      agentId,
      "connectors.set-org-credential",
      { connectorId: id, client: { clientId: "cid-new" }, askPerson: ["client.clientSecret"] },
      { "client.clientSecret": NEW_SECRET },
    );
    expect(paths).toEqual(["client.clientSecret"]);
    expect(result?.isError, result?.content).toBe(false);
    const client = await env.k.app.get(Credentials).oauthClient(env.orgId, id);
    expect(client).toMatchObject({ clientId: "cid-new", clientSecret: NEW_SECRET });
    await foundNowhere(NEW_SECRET);
  });

  it("connectors.set-my-credential stores your own token typed on the card", async () => {
    const created = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors`,
      payload: {
        name: "Mine",
        connector: "fake",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "personal" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { connector: { id: string } }).connector.id;
    // cleared first, so the stored token can only come from the card
    await op("connectors.clear-my-credential").run({ connectorId: id }, ctxOf());
    const cleared = (await op("connectors.get").run({ connectorId: id }, ctxOf())) as {
      connector: { credential: { status: string } };
    };
    expect(cleared.connector.credential.status).toBe("missing");
    const agentId = await platformAgent("Own credential setter");
    const { paths, result } = await callWithCard(
      agentId,
      "connectors.set-my-credential",
      { connectorId: id },
      { "credential.token": MY_TOKEN },
    );
    expect(paths).toEqual(["credential.token"]);
    expect(result?.isError, result?.content).toBe(false);
    const inj = await injectionOf(id, { type: "bearer", ownership: "personal" });
    expect(inj.headers?.Authorization).toBe(`Bearer ${MY_TOKEN}`);
    await foundNowhere(MY_TOKEN);
  });
});

describe("a plugin with a template connector", () => {
  let itemId = "";

  it("plugins.install asks the template's credential under connectors.<templateId>. and installs with it", async () => {
    itemId = await importPlugin(env, await guidePlugin());
    const t = await personFieldsOf("plugins.install", {
      itemId,
      templates: { [TEMPLATE_ID]: { endpoint: { url: env.mcp.url } } },
    });
    expect(t.fields.map((f) => [f.path, f.required])).toEqual([
      [`connectors.${TEMPLATE_ID}.credential.token`, true],
    ]);
    expect(t.fields[0]?.label).toEqual({ zh: "GitHub 连接器：令牌", en: "GitHub MCP: Token" });

    const agentId = await platformAgent("Installer");
    const { paths, result } = await callWithCard(
      agentId,
      "plugins.install",
      { itemId, templates: { [TEMPLATE_ID]: { endpoint: { url: env.mcp.url } } } },
      { [`connectors.${TEMPLATE_ID}.credential.token`]: MCP_TOKEN },
    );
    // a required credential is asked though the call named none
    expect(paths).toEqual([`connectors.${TEMPLATE_ID}.credential.token`]);
    expect(result?.isError, result?.content).toBe(false);
    expect(result?.content).toContain(
      `\`connectors.${TEMPLATE_ID}.credential.token\`: entered by the person`,
    );
    const install = await env.db
      .selectFrom("plugin_installs")
      .select(["id", "status"])
      .where("org_id", "=", env.orgId)
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(install.status).toBe("installed");
    const connector = await env.db
      .selectFrom("connectors")
      .select(["id", "catalog_item_id"])
      .where("org_id", "=", env.orgId)
      .where("catalog_item_id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const read = (await op("connectors.get").run({ connectorId: connector.id }, ctxOf())) as {
      connector: { credential: unknown };
    };
    expect(read.connector.credential).toMatchObject({ ownership: "org", status: "connected" });
    await foundNowhere(MCP_TOKEN);

    // installed now: a second install is refused before the card
    const o = op("plugins.install");
    expect(await o.precheck?.(o.input.parse({ itemId }), ctxOf())).toMatchObject({
      ok: false,
      code: "plugin.already_installed",
    });
  });

  /** The live connectors of the plugin's template in the org. */
  const templateConnectors = () =>
    env.db
      .selectFrom("connectors")
      .select(["id", "guide_ack"])
      .where("org_id", "=", env.orgId)
      .where("catalog_item_id", "=", itemId)
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .execute();

  it("connectors.guide-ack records the guide the person confirmed on the card", async () => {
    const [c] = await templateConnectors();
    if (c === undefined) throw new Error("no template connector");
    await env.db
      .updateTable("connectors")
      .set({ guide_ack: null })
      .where("id", "=", c.id)
      .execute();
    const read = (await op("connectors.get").run({ connectorId: c.id }, ctxOf())) as {
      connector: { setupGuide: { guideId: string; hash: string } | null };
    };
    expect(read.connector.setupGuide).toMatchObject({ guideId: "gh" });
    const hash = read.connector.setupGuide?.hash as string;
    // a hash that is not the current guide's is refused before the card
    const o = op("connectors.guide-ack");
    expect(
      await o.precheck?.(o.input.parse({ connectorId: c.id, hash: "0".repeat(64) }), ctxOf()),
    ).toMatchObject({ ok: false, code: "connector.guide_changed" });
    const agentId = await platformAgent("Guide acker");
    const { paths, result } = await callWithCard(
      agentId,
      "connectors.guide-ack",
      { connectorId: c.id, hash },
      {},
    );
    expect(paths).toEqual([]);
    expect(result?.isError, result?.content).toBe(false);
    const [after] = await templateConnectors();
    expect(after?.guide_ack).toMatchObject({ guideId: "gh", hash });
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "connector.guide_confirmed")
      .where("target", "=", c.id)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ via: "agent", operation: "connectors.guide-ack" });
  });

  it("connectors.add-from-template creates one more connector with the token typed on the card", async () => {
    const tpl = await env.db
      .selectFrom("platform_connector_templates")
      .select("id")
      .where("catalog_item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    const t = await personFieldsOf("connectors.add-from-template", {
      templateId: tpl.id,
      name: "Ops GitHub",
    });
    // the card names the template, not the model's name
    expect(t.target.en).toBe("Connector GitHub MCP (org)");
    const agentId = await platformAgent("Template user");
    const { paths, result } = await callWithCard(
      agentId,
      "connectors.add-from-template",
      { templateId: tpl.id, name: "Ops GitHub", endpoint: { url: env.mcp.url } },
      { "credential.token": MCP_TOKEN },
    );
    expect(paths).toEqual(["credential.token"]);
    expect(result?.isError, result?.content).toBe(false);
    const all = await templateConnectors();
    expect(all).toHaveLength(2);
    const read = (await op("connectors.get").run({ connectorId: all[1]?.id }, ctxOf())) as {
      connector: { name: string; credential: unknown };
    };
    expect(read.connector).toMatchObject({
      name: "Ops GitHub",
      credential: { ownership: "org", status: "connected" },
    });
  });

  it("plugins.configure-connectors creates the missing connector with the token typed on the card", async () => {
    for (const c of await templateConnectors()) {
      await op("connectors.delete").run({ connectorId: c.id }, ctxOf());
    }
    const agentId = await platformAgent("Configurer");
    const { paths, result } = await callWithCard(
      agentId,
      "plugins.configure-connectors",
      { itemId, templates: { [TEMPLATE_ID]: { endpoint: { url: env.mcp.url } } } },
      { [`connectors.${TEMPLATE_ID}.credential.token`]: MCP_TOKEN },
    );
    expect(paths).toEqual([`connectors.${TEMPLATE_ID}.credential.token`]);
    expect(result?.isError, result?.content).toBe(false);
    const [c] = await templateConnectors();
    if (c === undefined) throw new Error("no connector created");
    const read = (await op("connectors.get").run({ connectorId: c.id }, ctxOf())) as {
      connector: { credential: unknown };
    };
    expect(read.connector.credential).toMatchObject({ ownership: "org", status: "connected" });
    await foundNowhere(MCP_TOKEN);
  });
});
