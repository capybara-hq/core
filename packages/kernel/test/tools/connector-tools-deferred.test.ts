import {
  type FakeMcpServer,
  type FakeOAuthServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startFakeOAuthServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import {
  CONNECTOR_TOOLS_JOB,
  CONNECTOR_TOOLS_QUEUE,
  type ConnectorToolsJobData,
} from "../../src/tools/connector-tools-jobs.js";
import {
  ConnectorsService,
  type CreateConnectorInput,
} from "../../src/tools/connectors.service.js";
import { Credentials } from "../../src/tools/credentials.js";
import { ToolDrift } from "../../src/tools/drift.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createOrgWithProviders,
  enableConnectorExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Plugin pages spec §5.2.1 "Tool lists without a network call in a transaction": a connector
 * created through `createDeferredIn` is written with an empty tool list and no outbound call; the
 * list follows through the outbox (`connector-tools-list` on `cap-connector-tools`). A
 * `needs_config` connector gets the job when it turns ready, a personal one on its first member
 * credential, and agents get no tools from a `needs_config` connector.
 */

const FAKE_CONNECTOR = fakeExtensionEntry("fake-connector");
const TOKEN = "tok_deferred_value_0123456789";
const CLIENT = { clientId: "client-deferred", clientSecret: "client-deferred-secret" };

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let mcp: FakeMcpServer;
let as: FakeOAuthServer;
/** While true, the outbox adds to the connector tools queue fail (the fast path delivers nothing). */
let failTools = false;
let req: Req;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  as = await startFakeOAuthServer({ clients: [CLIENT] });
  mcp = await startFakeMcpServer({
    // the static org token, or a token the fake authorization server issued
    verifyBearer: (t) => t === TOKEN || as.verify(t),
    // MCP discovery of the authorization server (the dcr connector)
    protectedResource: { authorizationServers: [as.issuer], advertise: "header" },
    tools: [{ name: "search", description: "Search documents", inputSchema: { type: "object" } }],
  });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, FAKE_CONNECTOR],
        extensionConfig: { "fake-connector": {} },
        // the fake authorization server is on loopback http
        tools: { oauthAllowInsecureLoopback: true },
        // the OAuth callback a dcr registration names
        http: { port: 0, publicUrl: "https://capybara.test" },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failTools && queue === CONNECTOR_TOOLS_QUEUE,
        },
      ],
    },
  );
});

afterAll(async () => {
  await k?.close();
  await mcp?.stop();
  await as?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  failTools = false;
  const db = k.app.get(KernelDb);
  await truncateTables(db.pool, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await sql`DELETE FROM capybara.outbox`.execute(db.pool);
  ownerId = (
    await accountsFor(db.pool).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  req = await session(k, "owner");
  orgId = await createOrgWithProviders(k, req);
  await enableConnectorExtensions(k, orgId);
});

const service = () => k.app.get(ConnectorsService);
const queue = () => k.app.get<Queue>(getQueueToken(CONNECTOR_TOOLS_QUEUE));

const input = (over: Partial<CreateConnectorInput> = {}): CreateConnectorInput => ({
  name: "Docs",
  slug: "docs",
  connector: "fake",
  endpoint: { url: mcp.url },
  auth: { type: "bearer", ownership: "org" },
  credential: { token: TOKEN },
  ...over,
});

const clientInput = () =>
  input({
    auth: { type: "oauth_client", ownership: "org", tokenUrl: `${as.issuer}/token` },
    credential: undefined,
  });

/** The connector's tool names, from its detail route. */
async function toolsOf(connectorId: string): Promise<string[]> {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { connector: { tools: { name: string }[] } }).connector.tools
    .map((t) => t.name)
    .sort();
}

async function setupOf(connectorId: string): Promise<string> {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` });
  return (res.json() as { connector: { setup: string } }).connector.setup;
}

/** The owed connector tools rows of a connector. */
const owed = (connectorId: string) =>
  k.app
    .get(KernelDb)
    .selectFrom("outbox")
    .select(["queue", "job_name", "job_id", "data", "org_id"])
    .where("job_name", "=", CONNECTOR_TOOLS_JOB)
    .where(sql<boolean>`data->>'connectorId' = ${connectorId}`)
    .execute();

/** Makes the owed rows due and delivers them (the fast path was off or failed). */
async function deliver(): Promise<void> {
  failTools = false;
  await k.app
    .get(KernelDb)
    .updateTable("outbox")
    .set({ next_attempt_at: sql`now()` })
    .where("queue", "=", CONNECTOR_TOOLS_QUEUE)
    .execute();
  await drainOutbox(k.app, { queue: CONNECTOR_TOOLS_QUEUE });
}

/** The connector tool keys an agent of the org is offered. */
async function agentKeys(): Promise<string[]> {
  const { tools } = await k.app
    .get(ToolRegistry)
    .forAgent(orgId, { disabledTools: [], source: "web" });
  return tools.map((t) => t.key).filter((key) => key.startsWith("mcp__"));
}

describe("createDeferredIn", () => {
  it("writes the row with no outbound call inside the transaction; the job lists the tools", async () => {
    failTools = true;
    const before = mcp.requests.length;
    const id = await service().createDeferredIn(orgId, ownerId, input());
    // committed, owed, and nothing was asked of the server
    expect(mcp.requests.length).toBe(before);
    expect(await toolsOf(id)).toEqual([]);
    expect(await setupOf(id)).toBe("ready");
    const rows = await owed(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue: CONNECTOR_TOOLS_QUEUE,
      job_name: CONNECTOR_TOOLS_JOB,
      org_id: orgId,
      data: { orgId, connectorId: id } satisfies ConnectorToolsJobData,
    });
    expect(rows[0]?.job_id).toMatch(new RegExp(`^connector-tools-${id}-created-\\d+$`));
    expect(rows[0]?.job_id).not.toContain(":");
    expect(await queue().getJob(rows[0]?.job_id as string)).toBeUndefined();

    await deliver();
    await waitFor(async () => (await toolsOf(id)).length > 0, 20_000, "the tools listed");
    expect(await toolsOf(id)).toEqual(["search"]);
    expect(mcp.requests.length).toBeGreaterThan(before);
    expect(await agentKeys()).toEqual(["mcp__docs__search"]);
  });

  it("works without an acting account (the kernel itself) and audits the creation", async () => {
    const id = await service().createDeferredIn(orgId, null, input());
    await waitFor(async () => (await toolsOf(id)).length > 0, 20_000, "the tools listed");
    const row = await k.app
      .get(KernelDb)
      .selectFrom("connectors")
      .select("created_by")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    // created as no person: no creator (ruling R17); its org token still lists the tools
    expect(row.created_by).toBeNull();
    const audit = await k.app
      .get(KernelDb)
      .selectFrom("audit_events")
      .select(["actor_account_id", "action"])
      .where("target", "=", id)
      .orderBy("at")
      .execute();
    expect(audit).toContainEqual({ actor_account_id: null, action: "connector.created" });
  });

  it("listing twice stores the same tools (the job is idempotent)", async () => {
    failTools = true;
    const id = await service().createDeferredIn(orgId, ownerId, input());
    const data: ConnectorToolsJobData = { orgId, connectorId: id };
    expect(await service().listToolsForJob(data)).toBe("listed");
    const first = await toolsOf(id);
    expect(await service().listToolsForJob(data)).toBe("listed");
    expect(await toolsOf(id)).toEqual(first);
    expect(first).toEqual(["search"]);
  });

  it("a needs_config connector owes no job and gets its tools after the admin saves the client", async () => {
    failTools = true;
    const id = await service().createDeferredIn(orgId, ownerId, clientInput());
    expect(await setupOf(id)).toBe("needs_config");
    expect(await owed(id)).toEqual([]);

    const put = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${id}/credentials/org`,
      payload: CLIENT,
    });
    expect(put.statusCode, put.body).toBe(204);
    expect(await setupOf(id)).toBe("ready");
    const rows = await owed(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toMatch(new RegExp(`^connector-tools-${id}-configured-\\d+$`));

    await deliver();
    await waitFor(async () => (await toolsOf(id)).length > 0, 20_000, "the tools listed");
    expect(await toolsOf(id)).toEqual(["search"]);
  });

  it("an org credential saved on a needs_config static connector owes the configured job", async () => {
    failTools = true;
    const id = await service().createDeferredIn(orgId, ownerId, input({ credential: undefined }));
    expect(await setupOf(id)).toBe("needs_config");
    expect(await owed(id)).toEqual([]);
    const put = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${id}/credentials/org`,
      payload: { token: TOKEN },
    });
    expect(put.statusCode, put.body).toBe(204);
    expect((await owed(id))[0]?.job_id).toMatch(/-configured-\d+$/);
    // saving it again while ready owes nothing more
    const again = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${id}/credentials/org`,
      payload: { token: TOKEN },
    });
    expect(again.statusCode).toBe(204);
    expect(await owed(id)).toHaveLength(1);
    await deliver();
    await waitFor(async () => (await toolsOf(id)).length > 0, 20_000, "the tools listed");
  });

  it("an endpoint that keeps failing leaves the connector ready with no tools, not needs_config", async () => {
    const id = await service().createDeferredIn(
      orgId,
      ownerId,
      input({ endpoint: { url: "http://127.0.0.1:1/mcp" } }),
    );
    // the job ran and failed (the queue retries it); the connector is untouched
    const failed = await waitFor(
      async () => {
        const jobs = await queue().getJobs(["failed", "delayed", "waiting", "completed"]);
        const job = jobs.find((j) => j?.data.connectorId === id);
        return job && job.attemptsMade >= 1 ? job : undefined;
      },
      20_000,
      "the job's first attempt failed",
    );
    expect(failed.failedReason).toMatch(/connect/i);
    expect(await setupOf(id)).toBe("ready");
    expect(await toolsOf(id)).toEqual([]);
  });

  it("a personal connector owes the job on a member's first credential, listed with it", async () => {
    failTools = true;
    const id = await service().createDeferredIn(
      orgId,
      null,
      input({ auth: { type: "bearer", ownership: "personal" }, credential: undefined }),
    );
    expect(await setupOf(id)).toBe("ready");
    expect(await owed(id)).toEqual([]);
    const bob = await accountsFor(k.app.get(KernelDb).pool).createLocal({
      login: "bob",
      password: PW,
      displayName: "Bob",
    });
    await testMembers(k.app.get(KernelDb).pool).add(orgId, bob.id, "member", ownerId);
    const bobReq = await session(k, "bob");
    const put = await bobReq({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${id}/credentials/me`,
      payload: { token: TOKEN },
    });
    expect(put.statusCode, put.body).toBe(204);
    const rows = await owed(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ orgId, connectorId: id, accountId: bob.id });
    expect(rows[0]?.job_id).toMatch(new RegExp(`^connector-tools-${id}-connected-${bob.id}-\\d+$`));
    await deliver();
    await waitFor(async () => (await toolsOf(id)).length > 0, 20_000, "the tools listed");
    expect(await toolsOf(id)).toEqual(["search"]);
  });
});

describe("agents get no tools from a needs_config connector", () => {
  it("a connector whose client is removed offers no tools; saving the client brings them back", async () => {
    const id = await service().createDeferredIn(orgId, ownerId, clientInput());
    const put = () =>
      req({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/connectors/${id}/credentials/org`,
        payload: CLIENT,
      });
    expect((await put()).statusCode).toBe(204);
    await waitFor(async () => (await toolsOf(id)).length > 0, 20_000, "the tools listed");
    expect(await agentKeys()).toEqual(["mcp__docs__search"]);

    await k.app.get(Credentials).clearConnector(orgId, id);
    expect(await setupOf(id)).toBe("needs_config");
    expect(await agentKeys()).toEqual([]);
    const { hidden } = await k.app
      .get(ToolRegistry)
      .forAgent(orgId, { disabledTools: [], source: "web" });
    expect(hidden).toContainEqual({
      ref: "mcp__docs__*",
      reason: expect.stringContaining("organization admin"),
    });

    failTools = true;
    expect((await put()).statusCode).toBe(204);
    expect((await owed(id))[0]?.job_id).toMatch(/-configured-\d+$/);
    await deliver();
    await waitFor(async () => (await owed(id)).length === 0, 20_000, "the job delivered");
    expect(await agentKeys()).toEqual(["mcp__docs__search"]);
  });
});

describe("the drift scan writing the first snapshot", () => {
  it("applies the template's default policies; the tools job afterwards does not apply them again", async () => {
    failTools = true;
    const id = await service().createDeferredIn(orgId, ownerId, input());
    const db = k.app.get(KernelDb);
    await db
      .updateTable("connectors")
      .set({ template_tool_policies: JSON.stringify({ search: "allow" }) })
      .where("id", "=", id)
      .execute();
    const policy = () =>
      db
        .selectFrom("connector_tools")
        .select(["default_policy", "policy_source"])
        .where("connector_id", "=", id)
        .where("name", "=", "search")
        .executeTakeFirstOrThrow();
    // a scan tick between the commit and the job lists first
    expect((await k.app.get(ToolDrift).check(orgId, id, "schedule")).status).toBe("checked");
    expect(await policy()).toEqual({ default_policy: "allow", policy_source: "template" });
    // an admin changes it; the job's listing is not a first snapshot any more
    await db
      .updateTable("connector_tools")
      .set({ default_policy: "deny", policy_source: "admin" })
      .where("connector_id", "=", id)
      .execute();
    expect(await service().listToolsForJob({ orgId, connectorId: id })).toBe("listed");
    expect(await policy()).toEqual({ default_policy: "deny", policy_source: "admin" });
  });
});

describe("a dcr connector created without a client (ruling R16)", () => {
  const dcrInput = () =>
    input({
      slug: "dcr",
      auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
      credential: undefined,
    });
  const connect = (r: Req, id: string) =>
    r({ method: "POST", url: `/api/v1/orgs/${orgId}/connectors/${id}/connect`, payload: {} });

  it("is ready, owes no listing, and registers its client once on concurrent first connects", async () => {
    const id = await service().createDeferredIn(orgId, null, dcrInput());
    expect(await setupOf(id)).toBe("ready");
    expect(await owed(id)).toEqual([]);
    expect(await k.app.get(Credentials).oauthClient(orgId, id)).toBeNull();
    const before = as.registrations.length;
    const [a, b] = await Promise.all([connect(req, id), connect(req, id)]);
    for (const res of [a, b]) {
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { authorizationUrl: string }).authorizationUrl).toContain(as.issuer);
    }
    expect(as.registrations.length - before).toBe(1);
    const client = await k.app.get(Credentials).oauthClient(orgId, id);
    expect(client?.clientId).toBeDefined();
    for (const res of [a, b]) {
      const url = new URL((res.json() as { authorizationUrl: string }).authorizationUrl);
      expect(url.searchParams.get("client_id")).toBe(client?.clientId);
    }
    // a later connect reuses it
    expect((await connect(req, id)).statusCode).toBe(200);
    expect(as.registrations.length - before).toBe(1);
  });
});
