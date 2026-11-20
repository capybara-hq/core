import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createLogger } from "../../src/log.js";
import { PLATFORM_EXCLUSIONS } from "../../src/platform/exclusions.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import {
  importTemplate,
  MCP_TOKEN,
  type OrgEnv,
  startOrgEnv,
  TEMPLATE_ID,
} from "../catalog/org-env.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
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
  const paths = (row.detail as { personFields: { path: string }[] }).personFields.map(
    (f) => f.path,
  );
  const ok = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/approvals/${row.id}/decision`,
    payload: { decision: "approve", scope: "once", inputs },
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
    expect(op("connectors.guide-ack").confirm).toBe("personal");
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
      ["credential.token", "Token", true],
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

describe("plugins.install with a template connector", () => {
  it("asks the template's credential under connectors.<templateId>. and installs with it", async () => {
    const itemId = await importTemplate(env);
    const t = await personFieldsOf("plugins.install", {
      itemId,
      templates: { [TEMPLATE_ID]: { endpoint: { url: env.mcp.url } } },
    });
    expect(t.fields.map((f) => [f.path, f.required])).toEqual([
      [`connectors.${TEMPLATE_ID}.credential.token`, true],
    ]);
    expect(t.fields[0]?.label).toBe("GitHub: Token");

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
});
