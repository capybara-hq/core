import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { createOrg, PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * The org network allowance routes and Platform operations (plugin safe fetch spec): the super
 * admin adds, lists and removes; the org's admins read their own org's list; members and other
 * orgs get nothing.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: Req;
let owner: Req;
let member: Req;
let outsider: Req;
let rootId: string;
let ownerId: string;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
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
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  const memberId = (
    await accounts.createLocal({ login: "member", password: PW, displayName: "Member" })
  ).id;
  await accounts.createLocal({ login: "outsider", password: PW, displayName: "Outsider" });
  [root, owner, member, outsider] = await Promise.all([
    session(k, "root"),
    session(k, "owner"),
    session(k, "member"),
    session(k, "outsider"),
  ]);
  orgId = await createOrg(owner, "Acme");
  otherOrgId = await createOrg(outsider, "Beta");
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${memberId}, 'member')`.execute(db);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const adminUrl = (org: string) => `/api/v1/admin/orgs/${org}/network-allowances`;
const orgUrl = (org: string) => `/api/v1/orgs/${org}/network-allowances`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type View = { id: string; entry: string; createdAt: string };

const add = async (org: string, entry: string): Promise<View> => {
  const res = await root({ method: "POST", url: adminUrl(org), payload: { entry } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { allowance: View }).allowance;
};

const auditRows = (org: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "target", "detail"])
    .where("org_id", "=", org)
    .where("action", "like", "org.network_allowance_%")
    .orderBy("id")
    .execute();

describe("super admin routes", () => {
  it("adds, lists and removes an org's allowances, audited in the org", async () => {
    const a = await add(orgId, "http://MCP.internal:8080/");
    expect(a).toEqual({
      id: expect.any(String),
      entry: "http://mcp.internal:8080",
      createdAt: expect.any(String),
    });
    const b = await add(orgId, "*.corp.example");

    const list = await root({ method: "GET", url: adminUrl(orgId) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { allowances: View[] }).allowances.map((x) => x.entry)).toEqual([
      "http://mcp.internal:8080",
      "*.corp.example",
    ]);

    const del = await root({ method: "DELETE", url: `${adminUrl(orgId)}/${b.id}` });
    expect(del.statusCode).toBe(204);
    const after = await root({ method: "GET", url: adminUrl(orgId) });
    expect((after.json() as { allowances: View[] }).allowances.map((x) => x.id)).toEqual([a.id]);

    expect(await auditRows(orgId)).toEqual([
      {
        action: "org.network_allowance_added",
        actor_account_id: rootId,
        target: a.id,
        detail: { entry: "http://mcp.internal:8080" },
      },
      {
        action: "org.network_allowance_added",
        actor_account_id: rootId,
        target: b.id,
        detail: { entry: "*.corp.example" },
      },
      {
        action: "org.network_allowance_removed",
        actor_account_id: rootId,
        target: b.id,
        detail: { entry: "*.corp.example" },
      },
    ]);
    await root({ method: "DELETE", url: `${adminUrl(orgId)}/${a.id}` });
  });

  it("refuses an invalid entry with 400 org.network_allowance_invalid", async () => {
    for (const entry of ["169.254.169.254", "localhost", "http://h/path"]) {
      const res = await root({ method: "POST", url: adminUrl(orgId), payload: { entry } });
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("org.network_allowance_invalid");
    }
    const missing = await root({ method: "POST", url: adminUrl(orgId), payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(errCode(missing)).toBe("validation_failed");
  });

  it("answers 404 for a missing id, another org's id and an unknown org", async () => {
    const other = await add(otherOrgId, "mcp.beta.example");
    for (const id of [randomUUID(), "not-a-uuid", other.id]) {
      const res = await root({ method: "DELETE", url: `${adminUrl(orgId)}/${id}` });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("org.network_allowance_not_found");
    }
    // the other org's entry is untouched
    const beta = await root({ method: "GET", url: adminUrl(otherOrgId) });
    expect((beta.json() as { allowances: View[] }).allowances.map((x) => x.id)).toEqual([other.id]);

    const unknown = randomUUID();
    const list = await root({ method: "GET", url: adminUrl(unknown) });
    expect(list.statusCode).toBe(404);
    expect(errCode(list)).toBe("org.not_found");
    const post = await root({
      method: "POST",
      url: adminUrl(unknown),
      payload: { entry: "a.example" },
    });
    expect(post.statusCode).toBe(404);
    expect(errCode(post)).toBe("org.not_found");
  });

  it("is closed to anyone but a super admin", async () => {
    const anon = await k.http.inject({ method: "GET", url: adminUrl(orgId) });
    expect(anon.statusCode).toBe(401);
    for (const req of [owner, member]) {
      for (const r of [
        { method: "GET" as const, url: adminUrl(orgId) },
        { method: "POST" as const, url: adminUrl(orgId), payload: { entry: "a.example" } },
        { method: "DELETE" as const, url: `${adminUrl(orgId)}/${randomUUID()}` },
      ]) {
        const res = await req(r);
        expect(res.statusCode).toBe(403);
        expect(errCode(res)).toBe("forbidden");
      }
    }
  });
});

describe("org read route", () => {
  it("lets the org's admins read the list, refuses members, other orgs and service tokens", async () => {
    const a = await add(orgId, "10.20.0.0/16");
    const res = await owner({ method: "GET", url: orgUrl(orgId) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { allowances: View[] }).allowances).toEqual([
      { id: a.id, entry: "10.20.0.0/16", createdAt: expect.any(String) },
    ]);

    const asMember = await member({ method: "GET", url: orgUrl(orgId) });
    expect(asMember.statusCode).toBe(403);
    expect(errCode(asMember)).toBe("forbidden");

    const asOutsider = await outsider({ method: "GET", url: orgUrl(orgId) });
    expect(asOutsider.statusCode).toBe(404);
    expect(errCode(asOutsider)).toBe("org.not_found");

    // the org route has no write: an org admin adds nothing
    const write = await owner({
      method: "POST",
      url: orgUrl(orgId),
      payload: { entry: "a.example" },
    });
    expect(write.statusCode).toBe(404);
    const { token } = await apiTokensFor(db).createService(orgId, {
      name: "ci",
      role: "admin",
      createdBy: ownerId,
    });
    const svc = await k.http.inject({
      method: "GET",
      url: orgUrl(orgId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(svc.statusCode).toBe(403);

    await root({ method: "DELETE", url: `${adminUrl(orgId)}/${a.id}` });
  });
});

describe("Platform operations", () => {
  const ctxOf = (accountId: string, org = orgId): OperationContext => ({
    orgId: org,
    actorAccountId: accountId,
    agentId: randomUUID(),
    conversationId: randomUUID(),
    runId: randomUUID(),
    signal: new AbortController().signal,
  });
  const op = (id: string) => {
    const o = k.app.get(PlatformOperations).get(id);
    if (o === null) throw new Error(`no operation ${id}`);
    return o;
  };
  const run = (id: string, input: unknown, ctx: OperationContext = ctxOf(rootId)) => {
    const o = op(id);
    return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
      throw toToolError(e, (code) => nextStepFor(o.errors, code, "superAdmin"));
    });
  };

  it("mirror the routes and return the same rows", async () => {
    const added = (await run("admin.org-network-allowance-add", {
      orgId: otherOrgId,
      entry: "https://git.beta.example:8443",
    })) as { allowance: View };
    expect(added.allowance.entry).toBe("https://git.beta.example:8443");

    const listed = (await run("admin.org-network-allowances", { orgId: otherOrgId })) as {
      allowances: { id: string; entry: string; createdAt: Date }[];
    };
    const http = await root({ method: "GET", url: adminUrl(otherOrgId) });
    expect(JSON.parse(JSON.stringify(listed))).toEqual(http.json());

    const read = (await run("orgs.network-allowances", {}, ctxOf(rootId, otherOrgId))) as unknown;
    expect(JSON.parse(JSON.stringify(read))).toEqual(http.json());

    expect(
      await run("admin.org-network-allowance-remove", {
        orgId: otherOrgId,
        id: added.allowance.id,
      }),
    ).toEqual({ id: added.allowance.id, removed: true });
    const rows = await auditRows(otherOrgId);
    expect(rows.at(-1)).toMatchObject({
      action: "org.network_allowance_removed",
      target: added.allowance.id,
    });
  });

  it("precheck refuses an invalid entry and a missing id before the card", async () => {
    const addOp = op("admin.org-network-allowance-add");
    expect(
      await addOp.precheck?.(addOp.input.parse({ orgId, entry: "169.254.169.254" }), ctxOf(rootId)),
    ).toMatchObject({ ok: false, code: "org.network_allowance_invalid" });
    expect(
      await addOp.precheck?.(addOp.input.parse({ orgId, entry: "mcp.internal" }), ctxOf(rootId)),
    ).toEqual({ ok: true });
    const removeOp = op("admin.org-network-allowance-remove");
    expect(
      await removeOp.precheck?.(removeOp.input.parse({ orgId, id: randomUUID() }), ctxOf(rootId)),
    ).toMatchObject({ ok: false, code: "org.network_allowance_not_found" });
  });

  it("a write by an account that is no super admin is refused", async () => {
    await expect(
      run("admin.org-network-allowance-add", { orgId, entry: "x.example" }, ctxOf(ownerId)),
    ).rejects.toThrow();
    expect(
      (await auditRows(orgId)).some(
        (r) => r.detail && JSON.stringify(r.detail).includes("x.example"),
      ),
    ).toBe(false);
  });

  it("declares the route's authorization", () => {
    expect(op("admin.org-network-allowances").authz).toEqual({ superAdmin: true });
    expect(op("admin.org-network-allowance-add").authz).toEqual({ superAdmin: true });
    expect(op("admin.org-network-allowance-remove").authz).toEqual({ superAdmin: true });
    expect(op("orgs.network-allowances").authz).toEqual({ orgAction: "org.update" });
  });
});
