import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ConversationEvent, ToolViewSchema } from "../../src/conversations/events.js";
import { PLATFORM_EXCLUSIONS } from "../../src/platform/exclusions.js";
import {
  defineOperation,
  type OperationContext,
  type PlatformOperation,
} from "../../src/platform/operation.js";
import { CONNECT_SHOWN_TEXT } from "../../src/platform/ops/connectors.ops.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { MCP_TOKEN, type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
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
 * Handoff link cards (platform web parity spec §4.4, §6; Task 13): an operation whose decision
 * stays with a person on the web returns a `handoff` view on its `tool_result`, display only. A
 * `link` card's path is in the result text as `reviewUrl`; `connectors.connect` starts nothing and
 * tells the model the person was shown a Connect button.
 */

const LINK_OP = "platform.probe-handoff";
const STAGING = "/admin/plugins/import?staging=s-1";

/** Test only: a read whose result hands the person off to a review page. */
const linkProbe = defineOperation({
  id: LINK_OP,
  description: "Test only: hands off to a review page.",
  input: z.object({ bad: z.boolean().default(false) }).strict(),
  example: { bad: false },
  authz: { orgAction: "agents.use" },
  mirrors: [],
  confirm: "read",
  run: async () => ({ staged: true }),
  handoff: (input) => ({
    kind: "handoff",
    title: { zh: "审阅插件 probe", en: "Review plugin probe" },
    // an absolute URL is not a relative web path: the card is left out
    target: { type: "link", url: input.bad ? "https://evil.example/x" : STAGING },
  }),
}) as PlatformOperation;

let env: OrgEnv;
let ops: PlatformOperations;

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
  ops.register([linkProbe]);
  await enableConnectorExtensions(env.k, env.orgId);
});
afterAll(async () => {
  await env?.stop();
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

const ctxOf = (): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: env.rootId,
  agentId: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  errorRole: "superAdmin",
});

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

/** Calls one operation through the tool (approving its card when it asks) and returns the result. */
async function callOp(agentId: string, operation: string, params: Record<string, unknown>) {
  const convId = await createConv(env.root, env.orgId, agentId);
  const call = { action: "call", operation, params };
  await postMessage(env.root, env.orgId, convId, `tool:Platform:${JSON.stringify(call)}`);
  await waitFor(
    async () => {
      const evs = await eventsOf(env.db, convId);
      const asked = ofType(evs, "approval_requested")[0];
      if (asked !== undefined && ofType(evs, "approval_decided").length === 0) {
        const ok = await env.root({
          method: "POST",
          url: `/api/v1/orgs/${env.orgId}/approvals/${asked.payload.approvalId}/decision`,
          payload: { decision: "approve", scope: "once" },
        });
        expect(ok.statusCode, ok.body).toBe(200);
      }
      return ofType(evs, "tool_result")[0];
    },
    30_000,
    "tool_result",
  );
  await waitForTerminal(env.db, convId, 1, 30_000);
  const result = ofType(await eventsOf(env.db, convId), "tool_result").at(-1)?.payload;
  if (result === undefined) throw new Error("no tool_result");
  return result;
}

async function oauthConnector(name: string): Promise<string> {
  const created = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/connectors`,
    payload: {
      name,
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
      credential: { clientId: "cid", clientSecret: "client-secret-0123456789" },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return (created.json() as { connector: { id: string } }).connector.id;
}

describe("registration", () => {
  it("the connect route is connectors.connect's mirror; the OAuth callback stays secret", () => {
    const excluded = new Map(PLATFORM_EXCLUSIONS.map((e) => [e.route, e]));
    expect(excluded.has("POST /api/v1/orgs/:orgId/connectors/:connectorId/connect")).toBe(false);
    expect(op("connectors.connect").mirrors).toEqual([
      "POST /api/v1/orgs/:orgId/connectors/:connectorId/connect",
    ]);
    expect(excluded.get("GET /api/v1/oauth/callback")?.category).toBe("secret");
  });

  it("the view schema takes only a relative web path for a link", () => {
    const view = (url: string) => ({
      kind: "handoff",
      title: { zh: "审阅", en: "Review" },
      target: { type: "link", url },
    });
    expect(ToolViewSchema.safeParse(view("/admin/plugins/import?staging=x")).success).toBe(true);
    for (const bad of ["https://x.example/a", "//x.example/a", "/\\x.example", "a/b", ""]) {
      expect(ToolViewSchema.safeParse(view(bad)).success, bad).toBe(false);
    }
  });
});

describe("handoff views", () => {
  it("connectors.connect: the Connect card on the result, the sentence in the text, nothing started", async () => {
    const id = await oauthConnector("Docs");
    const agentId = await platformAgent("Connector helper");
    const result = await callOp(agentId, "connectors.connect", { connectorId: id });
    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(CONNECT_SHOWN_TEXT);
    expect(CONNECT_SHOWN_TEXT).toBe(
      "The person was shown a Connect button; check connectors.get for the connection state.",
    );
    expect(result.view).toEqual({
      kind: "handoff",
      title: { zh: "连接「Docs」", en: "Connect Docs" },
      target: { type: "connect", connectorId: id },
    });
    // the card is display only: the model's text carries none of it
    expect(result.content).not.toContain("handoff");
    expect(JSON.parse(result.content)).toMatchObject({
      connector: { id, credential: { ownership: "personal", status: "missing" } },
    });
  });

  it("connectors.connect refuses a connector that is not OAuth authorization-code", async () => {
    const created = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors`,
      payload: {
        name: "Token app",
        connector: "fake",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { connector: { id: string } }).connector.id;
    const o = op("connectors.connect");
    expect(await o.precheck?.(o.input.parse({ connectorId: id }), ctxOf())).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
  });

  it("a link card: the view on the result and its path in the text as reviewUrl", async () => {
    const agentId = await platformAgent("Link helper");
    const result = await callOp(agentId, LINK_OP, {});
    expect(result.isError, result.content).toBe(false);
    expect(result.view).toEqual({
      kind: "handoff",
      title: { zh: "审阅插件 probe", en: "Review plugin probe" },
      target: { type: "link", url: STAGING },
    });
    expect(JSON.parse(result.content)).toEqual({ staged: true, reviewUrl: STAGING });
  });

  it("an invalid card is left out and the result stands", async () => {
    const agentId = await platformAgent("Bad link helper");
    const result = await callOp(agentId, LINK_OP, { bad: true });
    expect(result.isError, result.content).toBe(false);
    expect(result.view).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ staged: true });
  });
});
