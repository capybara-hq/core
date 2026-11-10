import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  enableConnectorExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The super admin's routes for every org's agents and connectors (admin agents and connectors
 * spec §4), over HTTP, and their Platform operations.
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ORG_SECRET = "SENTINEL-ADMIN-ORG-SECRET";
const MEMBER_SECRET = "SENTINEL-ADMIN-MEMBER-SECRET";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
/** The super admin S, a member of no org. */
let root: Req;
let rootId: string;
/** O, owner of org A. */
let owner: Req;
let memberId: string;
let orgA: string;
let orgB: string;
/** A private agent of O in A, and an org agent of the owner of B. */
let agentA: string;
let agentB: string;
/** A connector of A with an org credential, one with a personal credential, one of B. */
let docs: string;
let mine: string;
let open: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MEM_CONNECTOR] }),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  rootId = (
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      superAdmin: true,
    })
  ).id;
  await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  await accounts.createLocal({ login: "bowner", password: PW, displayName: "B Owner" });
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "Mem" })).id;
  root = await session(k, "root");
  owner = await session(k, "owner");
  const bOwner = await session(k, "bowner");
  orgA = await createOrg(owner, "Acme");
  orgB = await createOrg(bOwner, "Beta");
  await enableConnectorExtensions(k, orgA);
  await enableConnectorExtensions(k, orgB);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgA}, ${memberId}, 'member')`.execute(raw);

  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgA}/agents`,
    payload: {
      definition: {
        name: "Support bot",
        instructions: "Answer politely.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentA = (res.json() as { agent: { id: string } }).agent.id;
  agentB = await createAgent(bOwner, orgB);

  const st = memState();
  st.servers = {
    docs: {
      tools: [{ name: "search", description: "Search.", inputSchema: { type: "object" } }],
      requireAuth: `Bearer ${ORG_SECRET}`,
    },
    mine: {
      tools: [{ name: "me", description: "Me.", inputSchema: { type: "object" } }],
      requireAuth: `Bearer ${MEMBER_SECRET}`,
    },
    open: { tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object" } }] },
  };
  const connector = async (req: Req, orgId: string, body: Record<string, unknown>) => {
    const r = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { connector: "mem", ...body },
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json() as { connector: { id: string } }).connector.id;
  };
  docs = await connector(owner, orgA, {
    name: "Docs",
    endpoint: { server: "docs" },
    auth: { type: "bearer", ownership: "org" },
    credential: { token: ORG_SECRET },
  });
  mine = await connector(owner, orgA, {
    name: "Mine",
    endpoint: { server: "mine" },
    auth: { type: "bearer", ownership: "personal" },
    credential: { token: MEMBER_SECRET },
  });
  open = await connector(bOwner, orgB, {
    name: "Open",
    endpoint: { server: "open" },
    auth: { type: "none" },
  });
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const noSentinel = (body: string) => {
  expect(body).not.toContain(ORG_SECRET);
  expect(body).not.toContain(MEMBER_SECRET);
};

async function auditOf(action: string, target: string) {
  return db
    .selectFrom("audit_events")
    .select(["actor_account_id", "org_id", "detail"])
    .where("action", "=", action)
    .where("target", "=", target)
    .execute();
}

/** A fresh private agent of O in A (for the writes). */
async function agentOfA(name: string): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgA}/agents`,
    payload: {
      definition: { name, model: { provider: "model-fake", model: "fake-1" } },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

describe("admin agents routes", () => {
  it("super admin lists and reads agents of an org they are not in", async () => {
    const all = await root({ method: "GET", url: "/api/v1/admin/agents" });
    expect(all.statusCode, all.body).toBe(200);
    const body = all.json() as { agents: { id: string; orgName: string }[]; next: unknown };
    expect(body.agents.map((a) => a.id)).toEqual(expect.arrayContaining([agentA, agentB]));
    expect(body.next).toBeNull();

    const onlyA = await root({ method: "GET", url: `/api/v1/admin/agents?orgId=${orgA}` });
    const rows = (onlyA.json() as { agents: { id: string; orgName: string }[] }).agents;
    expect(rows.every((a) => a.orgName === "Acme")).toBe(true);
    expect(rows.map((a) => a.id)).toContain(agentA);

    const paged = await root({ method: "GET", url: "/api/v1/admin/agents?limit=1" });
    const page = paged.json() as { agents: { id: string }[]; next: string | null };
    expect(page.agents).toHaveLength(1);
    expect(page.next).toBe(page.agents[0]?.id);

    const one = await root({ method: "GET", url: `/api/v1/admin/agents/${agentA}` });
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as { agent: unknown }).agent).toMatchObject({
      id: agentA,
      orgId: orgA,
      orgName: "Acme",
      name: "Support bot",
      visibility: "private",
      definition: { instructions: "Answer politely." },
    });
  });

  it("a malformed id or paging value is a validation error or not found, never a 500", async () => {
    const tooLong = "x".repeat(101);
    for (const url of [
      `/api/v1/admin/agents?after=${tooLong}`,
      `/api/v1/admin/agents?orgId=${tooLong}`,
      "/api/v1/admin/agents?limit=0",
      "/api/v1/admin/agents?limit=201",
      "/api/v1/admin/connectors?status=gone",
      `/api/v1/admin/connectors?after=${tooLong}`,
    ]) {
      const res = await root({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(errCode(res), url).toBe("validation_failed");
    }
    // a path id that long is refused by the router before validation (its param length limit)
    for (const url of [
      `/api/v1/admin/agents/${tooLong}`,
      `/api/v1/admin/connectors/${tooLong}`,
      `/api/v1/admin/orgs/${tooLong}/members`,
    ]) {
      expect((await root({ method: "GET", url })).statusCode, url).toBe(414);
    }
    const notAnId = await root({ method: "GET", url: "/api/v1/admin/agents/not-a-uuid" });
    expect(notAnId.statusCode).toBe(404);
    expect(errCode(notAnId)).toBe("agent.not_found");
    const noOrg = await root({ method: "GET", url: "/api/v1/admin/agents?orgId=not-a-uuid" });
    expect(noOrg.statusCode).toBe(200);
    expect(noOrg.json()).toEqual({ agents: [], next: null });
    const noConnector = await root({ method: "GET", url: "/api/v1/admin/connectors/'%3B--" });
    expect(noConnector.statusCode).toBe(404);
    expect(errCode(noConnector)).toBe("connector.not_found");
  });

  it("org owner gets 403 on every admin agents and connectors route", async () => {
    const routes: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: object }[] =
      [
        { method: "GET", url: "/api/v1/admin/agents" },
        { method: "GET", url: `/api/v1/admin/agents/${agentA}` },
        {
          method: "POST",
          url: `/api/v1/admin/agents/${agentA}/owner`,
          payload: { accountId: memberId },
        },
        { method: "DELETE", url: `/api/v1/admin/agents/${agentA}` },
        { method: "GET", url: "/api/v1/admin/connectors" },
        { method: "GET", url: `/api/v1/admin/connectors/${docs}` },
        {
          method: "PATCH",
          url: `/api/v1/admin/connectors/${docs}`,
          payload: { status: "disabled" },
        },
        { method: "DELETE", url: `/api/v1/admin/connectors/${docs}` },
        { method: "GET", url: `/api/v1/admin/orgs/${orgA}/members` },
      ];
    for (const r of routes) {
      const res = await owner(r);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
    // nothing changed
    const still = await root({ method: "GET", url: `/api/v1/admin/connectors/${docs}` });
    expect((still.json() as { connector: { status: string } }).connector.status).toBe("active");
  });

  it("super admin reads the members of any org", async () => {
    const res = await root({ method: "GET", url: `/api/v1/admin/orgs/${orgA}/members` });
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json() as { members: { account: { id: string } }[] }).members.map(
      (m) => m.account.id,
    );
    expect(ids).toContain(memberId);
    expect(ids).not.toContain(rootId);
    const missing = await root({ method: "GET", url: "/api/v1/admin/orgs/no-such-org/members" });
    expect(missing.statusCode).toBe(404);
    expect(errCode(missing)).toBe("org.not_found");
  });

  it("transfer and delete through HTTP", async () => {
    const agent = await agentOfA("Transfer me");
    const bad = await root({
      method: "POST",
      url: `/api/v1/admin/agents/${agent}/owner`,
      payload: { accountId: rootId },
    });
    expect(bad.statusCode).toBe(404);
    expect(errCode(bad)).toBe("member.not_found");

    const moved = await root({
      method: "POST",
      url: `/api/v1/admin/agents/${agent}/owner`,
      payload: { accountId: memberId },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((moved.json() as { agent: unknown }).agent).toMatchObject({
      id: agent,
      ownerAccountId: memberId,
      ownerName: "Mem",
      needsReassignment: false,
      definition: { name: "Transfer me" },
    });
    const [changed] = await auditOf("agent.owner_changed", agent);
    expect(changed).toMatchObject({
      actor_account_id: rootId,
      org_id: orgA,
      detail: { to: memberId, via: "platform" },
    });

    const del = await root({ method: "DELETE", url: `/api/v1/admin/agents/${agent}` });
    expect(del.statusCode, del.body).toBe(204);
    const [deleted] = await auditOf("agent.deleted", agent);
    expect(deleted).toMatchObject({ actor_account_id: rootId, detail: { via: "platform" } });
    const gone = await root({ method: "GET", url: `/api/v1/admin/agents/${agent}` });
    expect(gone.statusCode).toBe(404);
    expect(errCode(gone)).toBe("agent.not_found");
  });
});

describe("admin connectors routes", () => {
  it("connector routes never return a credential", async () => {
    const list = await root({ method: "GET", url: "/api/v1/admin/connectors" });
    expect(list.statusCode, list.body).toBe(200);
    noSentinel(list.body);
    const ids = (list.json() as { connectors: { id: string }[] }).connectors.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([docs, mine, open]));

    const filtered = await root({
      method: "GET",
      url: `/api/v1/admin/connectors?orgId=${orgB}&status=active&q=op`,
    });
    expect(
      (filtered.json() as { connectors: { id: string }[] }).connectors.map((c) => c.id),
    ).toEqual([open]);

    for (const id of [docs, mine]) {
      const one = await root({ method: "GET", url: `/api/v1/admin/connectors/${id}` });
      expect(one.statusCode, one.body).toBe(200);
      noSentinel(one.body);
      expect((one.json() as { connector: { auth: unknown } }).connector.auth).toMatchObject({
        type: "bearer",
      });
    }

    const patched = await root({
      method: "PATCH",
      url: `/api/v1/admin/connectors/${mine}`,
      payload: { status: "disabled" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    noSentinel(patched.body);
    expect((patched.json() as { connector: { status: string } }).connector.status).toBe("disabled");
    const [updated] = await auditOf("connector.updated", mine);
    expect(updated).toMatchObject({
      actor_account_id: rootId,
      org_id: orgA,
      detail: { via: "platform" },
    });
    const back = await root({
      method: "PATCH",
      url: `/api/v1/admin/connectors/${mine}`,
      payload: { status: "active" },
    });
    expect(back.statusCode).toBe(200);
  });

  it("PATCH rejects keys other than status", async () => {
    for (const payload of [{ status: "disabled", name: "x" }, { name: "x" }, { status: "gone" }]) {
      const res = await root({
        method: "PATCH",
        url: `/api/v1/admin/connectors/${docs}`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("delete through HTTP", async () => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/connectors`,
      payload: {
        connector: "mem",
        name: "Doomed",
        endpoint: { server: "open" },
        auth: { type: "none" },
      },
    });
    const doomed = (res.json() as { connector: { id: string } }).connector.id;
    const del = await root({ method: "DELETE", url: `/api/v1/admin/connectors/${doomed}` });
    expect(del.statusCode, del.body).toBe(204);
    const [deleted] = await auditOf("connector.deleted", doomed);
    expect(deleted).toMatchObject({ actor_account_id: rootId, detail: { via: "platform" } });
    const again = await root({ method: "DELETE", url: `/api/v1/admin/connectors/${doomed}` });
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("connector.not_found");
  });
});

describe("Platform operations", () => {
  const ctx = (): OperationContext => ({
    orgId: orgA,
    actorAccountId: rootId,
    agentId: randomUUID(),
    conversationId: randomUUID(),
    runId: randomUUID(),
    signal: new AbortController().signal,
  });
  const run = (id: string, input: unknown) => {
    const o = k.app.get(PlatformOperations).get(id);
    if (o === null) throw new Error(`no operation ${id}`);
    return o.run(o.input.parse(input), ctx());
  };

  it("the Platform operations return the same views", async () => {
    const got = (await run("admin.connector-get", { connectorId: docs })) as {
      connector: { id: string };
    };
    expect(got.connector.id).toBe(docs);
    noSentinel(JSON.stringify(got));
    const http = await root({ method: "GET", url: `/api/v1/admin/connectors/${docs}` });
    expect(JSON.parse(JSON.stringify(got))).toEqual(http.json());

    const list = await run("admin.connectors-list", {});
    noSentinel(JSON.stringify(list));

    const agent = (await run("admin.agent-get", { agentId: agentA })) as { agent: { id: string } };
    const httpAgent = await root({ method: "GET", url: `/api/v1/admin/agents/${agentA}` });
    expect(JSON.parse(JSON.stringify(agent))).toEqual(httpAgent.json());
  });

  it("tool writes are audited with via platform and the tool's run", async () => {
    const c = ctx();
    const runIn = (id: string, input: unknown) => {
      const o = k.app.get(PlatformOperations).get(id);
      if (o === null) throw new Error(`no operation ${id}`);
      return o.run(o.input.parse(input), c);
    };
    const toolAudit = (operation: string) => ({
      actor_account_id: rootId,
      org_id: orgA,
      detail: {
        via: "platform",
        operation,
        agentConversationId: c.conversationId,
        agentRunId: c.runId,
      },
    });

    const agent = await agentOfA("Tool delete");
    expect(await runIn("admin.agent-delete", { agentId: agent })).toEqual({
      id: agent,
      deleted: true,
    });
    expect((await auditOf("agent.deleted", agent))[0]).toMatchObject(
      toolAudit("admin.agent-delete"),
    );

    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/connectors`,
      payload: {
        connector: "mem",
        name: "Tooled",
        endpoint: { server: "open" },
        auth: { type: "none" },
      },
    });
    const conn = (res.json() as { connector: { id: string } }).connector.id;
    const set = (await runIn("admin.connector-set-status", {
      connectorId: conn,
      status: "disabled",
    })) as { connector: { status: string } };
    expect(set.connector.status).toBe("disabled");
    expect((await auditOf("connector.updated", conn))[0]).toMatchObject({
      ...toolAudit("admin.connector-set-status"),
      detail: { status: { from: "active", to: "disabled" } },
    });
    expect(await runIn("admin.connector-delete", { connectorId: conn })).toEqual({
      id: conn,
      deleted: true,
    });
    expect((await auditOf("connector.deleted", conn))[0]).toMatchObject(
      toolAudit("admin.connector-delete"),
    );
  });

  it("admin.org-members lists the conversation org's members", async () => {
    const { members } = (await run("admin.org-members", {})) as {
      members: { account: { id: string }; role: string }[];
    };
    expect(members.map((m) => m.account.id)).toContain(memberId);
    expect(members.find((m) => m.account.id === memberId)?.role).toBe("member");
  });

  it("operations stay in the conversation's org: other orgs' items are refused", async () => {
    const agents = (await run("admin.agents-list", {})) as { agents: { orgId: string }[] };
    expect(agents.agents.length).toBeGreaterThan(0);
    expect(agents.agents.every((a) => a.orgId === orgA)).toBe(true);
    const connectors = (await run("admin.connectors-list", {})) as {
      connectors: { orgId: string }[];
    };
    expect(connectors.connectors.every((c) => c.orgId === orgA)).toBe(true);

    for (const [id, input] of [
      ["admin.agent-get", { agentId: agentB }],
      ["admin.agent-delete", { agentId: agentB }],
      ["admin.connector-get", { connectorId: open }],
      ["admin.connector-set-status", { connectorId: open, status: "disabled" }],
      ["admin.connector-delete", { connectorId: open }],
    ] as const) {
      await expect(run(id, input), id).rejects.toBeInstanceOf(ToolError);
    }
    const stillOpen = await root({ method: "GET", url: `/api/v1/admin/connectors/${open}` });
    expect((stillOpen.json() as { connector: { status: string } }).connector.status).toBe("active");
    expect((await root({ method: "GET", url: `/api/v1/admin/agents/${agentB}` })).statusCode).toBe(
      200,
    );
  });
});
