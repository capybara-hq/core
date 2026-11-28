import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { CONNECTOR_TOOLS_QUEUE } from "../../src/tools/connector-tools-jobs.js";
import {
  ConnectorsService,
  type CreateConnectorInput,
} from "../../src/tools/connectors.service.js";
import { Credentials } from "../../src/tools/credentials.js";
import type { MentionableConnector } from "../../src/tools/mentionable-connectors.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  enableConnectorExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * `GET /orgs/:orgId/agents/:agentId/mentionable-connectors` (composer inline tokens spec §4): the
 * connectors the `@` menu offers for an agent, read from the agent's tools without opening a
 * connector session.
 */

const FAKE_CONNECTOR = fakeExtensionEntry("fake-connector");
const TOKEN = "tok_mentionable_value_0123456789";
const MODEL = { provider: "model-fake", model: "fake-1" };

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let mcp: FakeMcpServer;
let req: Req;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  mcp = await startFakeMcpServer({
    verifyBearer: (t) => t === TOKEN,
    tools: [
      { name: "search", description: "Search documents", inputSchema: { type: "object" } },
      { name: "write", description: "Write a document", inputSchema: { type: "object" } },
    ],
    resources: [{ uri: "doc://a", name: "A", text: "hello" }],
  });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, FAKE_CONNECTOR],
        extensionConfig: { "fake-connector": {} },
      },
    ),
    {
      // tool listings run only when a test lists them (`listToolsForJob`), never in the background
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => queue === CONNECTOR_TOOLS_QUEUE,
        },
      ],
    },
  );
});

afterAll(async () => {
  await k?.close();
  await mcp?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  const db = k.app.get(KernelDb);
  await truncateTables(db.pool, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (
    await accountsFor(db.pool).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  req = await session(k, "owner");
  orgId = await createOrgWithProviders(k, req);
  await enableConnectorExtensions(k, orgId);
});

const service = () => k.app.get(ConnectorsService);

const input = (over: Partial<CreateConnectorInput> = {}): CreateConnectorInput => ({
  name: "Docs",
  slug: "docs",
  connector: "fake",
  endpoint: { url: mcp.url },
  auth: { type: "bearer", ownership: "org" },
  credential: { token: TOKEN },
  ...over,
});

/** Creates a connector and lists its tools now (as `accountId` for a personal one). */
async function connector(
  over: Partial<CreateConnectorInput> = {},
  accountId?: string,
  inOrg = orgId,
): Promise<string> {
  const id = await service().createDeferredIn(inOrg, null, input(over));
  if (accountId !== undefined) {
    await k.app
      .get(Credentials)
      .setOAuthTokens(
        inOrg,
        id,
        { kind: "user", accountId },
        { access_token: TOKEN, expires_at: Date.now() + 3_600_000, token_type: "Bearer" },
      );
  }
  const ready = accountId !== undefined || over.credential !== undefined || !("credential" in over);
  if (ready) {
    const r = await service().listToolsForJob({
      orgId: inOrg,
      connectorId: id,
      ...(accountId !== undefined && { accountId }),
    });
    expect(r).toBe("listed");
  }
  return id;
}

async function agent(definition: Record<string, unknown> = {}, r = req, inOrg = orgId) {
  const res = await r({
    method: "POST",
    url: `/api/v1/orgs/${inOrg}/agents`,
    payload: {
      definition: { name: "Helper", model: MODEL, ...definition },
      visibility: (definition.visibility as string | undefined) ?? "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const url = (agentId: string, inOrg = orgId) =>
  `/api/v1/orgs/${inOrg}/agents/${agentId}/mentionable-connectors`;

async function list(agentId: string, r = req): Promise<MentionableConnector[]> {
  const res = await r({ method: "GET", url: url(agentId) });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { connectors: MentionableConnector[] }).connectors;
}

async function member(login: string, role: "member" | "guest"): Promise<Req> {
  const db = k.app.get(KernelDb);
  const a = await accountsFor(db.pool).createLocal({ login, password: PW, displayName: login });
  await testMembers(db.pool).add(orgId, a.id, role, ownerId);
  return session(k, login);
}

describe("mentionable connectors", () => {
  it("lists connectors the agent can use", async () => {
    const docs = await connector();
    const wiki = await connector({ name: "Wiki", slug: "wiki" });
    const a = await agent({
      disabledTools: [{ kind: "connector", connectorId: wiki, tools: "all" }],
    });
    expect(await list(a)).toEqual([
      {
        id: docs,
        slug: "docs",
        name: "Docs",
        icon: null,
        state: "ready",
        credential: "none",
        toolCount: 4,
        resources: true,
      },
    ]);
    // search, write, list_resources and read_resource; with write and read_resource switched
    // off the rest counts and there are no resources
    const b = await agent({
      disabledTools: [{ kind: "connector", connectorId: docs, tools: ["write", "read_resource"] }],
    });
    const [row] = await list(b);
    expect(row).toMatchObject({ id: docs, toolCount: 2, resources: false });
    expect((await list(b)).map((c) => c.slug)).toEqual(["docs", "wiki"]);
  });

  it("carries the connector's own description", async () => {
    await connector({ description: "Company docs" });
    const [row] = await list(await agent());
    expect(row?.description).toBe("Company docs");
  });

  it("shows needs_config disabled", async () => {
    const id = await connector({ credential: undefined });
    const off = await connector({ name: "Off", slug: "off" });
    await service().update(orgId, off, ownerId, { status: "disabled" });
    expect(await list(await agent())).toEqual([
      {
        id,
        slug: "docs",
        name: "Docs",
        icon: null,
        state: "needs_config",
        credential: "none",
        toolCount: 0,
        resources: false,
      },
    ]);
  });

  it("leaves out a needs_config connector the agent switches off or whose extension is not loaded", async () => {
    const off = await connector({ credential: undefined });
    const gone = await connector({ name: "Gone", slug: "gone", credential: undefined });
    const shown = await connector({ name: "Wiki", slug: "wiki", credential: undefined });
    await k.app
      .get(KernelDb)
      .updateTable("connectors")
      .set({ connector: "not-loaded" })
      .where("id", "=", gone)
      .execute();
    const a = await agent({
      disabledTools: [{ kind: "connector", connectorId: off, tools: "all" }],
    });
    expect((await list(a)).map((c) => c.id)).toEqual([shown]);
  });

  it("credential missing for a personal OAuth connector not connected", async () => {
    const id = await connector(
      {
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
        credential: undefined,
      },
      ownerId,
    );
    const a = await agent();
    expect(await list(a)).toEqual([
      expect.objectContaining({ id, credential: "connected", state: "ready", toolCount: 4 }),
    ]);
    const bob = await member("bob", "member");
    expect(await list(a, bob)).toEqual([
      expect.objectContaining({ id, credential: "missing", state: "ready", toolCount: 4 }),
    ]);
  });

  it("guest may list", async () => {
    const docs = await connector();
    const guest = await member("gina", "guest");
    expect((await list(await agent(), guest)).map((c) => c.id)).toEqual([docs]);
  });

  it("service token refused", async () => {
    await connector();
    const a = await agent();
    const { token } = await apiTokensFor(k.app.get(KernelDb).pool).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    const res = await k.http.inject({
      method: "GET",
      url: url(a),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("never lists another org's connectors, nor an agent under another org's path", async () => {
    const docs = await connector();
    const other = await createOrgWithProviders(k, req, "Other");
    await enableConnectorExtensions(k, other);
    const foreignConnector = await connector(
      { name: "Foreign", slug: "foreign" },
      undefined,
      other,
    );
    const foreignAgent = await agent({}, req, other);
    const a = await agent();
    expect((await list(a)).map((c) => c.id)).toEqual([docs]);
    // the other org's own listing has only its connector
    const theirs = await req({ method: "GET", url: url(foreignAgent, other) });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(
      (theirs.json() as { connectors: MentionableConnector[] }).connectors.map((c) => c.id),
    ).toEqual([foreignConnector]);
    // the first org's agent under the other org's path
    const crossed = await req({ method: "GET", url: url(a, other) });
    expect(crossed.statusCode, crossed.body).toBe(404);
    expect((crossed.json() as { error: { code: string } }).error.code).toBe("agent.not_found");
  });

  it("another org's agent is not found", async () => {
    const other = await createOrgWithProviders(k, req, "Other");
    const foreign = await agent({}, req, other);
    const res = await req({ method: "GET", url: url(foreign) });
    expect(res.statusCode, res.body).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("agent.not_found");
    // another member's private agent is not found either
    const bob = await member("bob", "member");
    const mine = await agent({}, bob);
    const priv = await bob({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: { definition: { name: "Mine", model: MODEL }, visibility: "private" },
    });
    expect(priv.statusCode, priv.body).toBe(201);
    const privId = (priv.json() as { agent: { id: string } }).agent.id;
    expect((await req({ method: "GET", url: url(privId) })).statusCode).toBe(404);
    expect((await bob({ method: "GET", url: url(mine) })).statusCode).toBe(200);
  });

  it("no connector session opened", async () => {
    await connector();
    await connector(
      {
        name: "Mine",
        slug: "mine",
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
        credential: undefined,
      },
      ownerId,
    );
    const a = await agent();
    const before = mcp.requests.length;
    expect(await list(a)).toHaveLength(2);
    expect(mcp.requests.length).toBe(before);
  });
});
