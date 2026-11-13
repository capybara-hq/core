import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * Org-layer network requests (network ask-to-allow spec §5.3, plan P2.1): a member asks the org
 * admins to allow hosts in the org's sandbox egress; approving merges them into the org's
 * `sandboxEgress`. The deployment allows `pypi.org` and `*.github.com`.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let tokens: ApiTokenService;
let owner: Account;
let member: Account;
let orgId: string;
let ownerReq: Req;
let memberReq: Req;

const PW = "correct horse battery";

type Req = ReturnType<typeof asUser>;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      sandbox: { limits: { egress: "allowlist", allowHosts: ["pypi.org", "*.github.com"] } },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
  tokens = apiTokensFor(db);
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  member = await accounts.createLocal({ login: "mia", password: PW, displayName: "Mia" });
  ownerReq = await session("owner");
  const res = await ownerReq({
    method: "POST",
    url: "/api/v1/orgs",
    payload: { name: "Acme", slug: "acme" },
  });
  expect(res.statusCode).toBe(201);
  orgId = (res.json() as { org: { id: string } }).org.id;
  await members.add(orgId, member.id, "member", owner.id);
  memberReq = await session("mia");
});

async function session(login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

interface RequestView {
  id: string;
  kind: string;
  status: string;
  note: string;
  item: unknown;
  network: { hosts: string[]; conversationId: string | null; agentId: string | null } | null;
}

const file = (req: Req, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/catalog-requests/network`, payload });

async function fileOk(payload: Record<string, unknown>): Promise<RequestView> {
  const res = await file(memberReq, payload);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: RequestView }).request;
}

const decide = (req: Req, id: string, payload: Record<string, unknown>) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/catalog-requests/${id}/decide`, payload });

async function orgEgress(): Promise<unknown> {
  const res = await ownerReq({ method: "GET", url: `/api/v1/orgs/${orgId}/settings` });
  return (res.json() as { settings: { sandboxEgress?: unknown } }).settings.sandboxEgress;
}

const setOrgEgress = async (sandboxEgress: unknown) => {
  const res = await ownerReq({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { sandboxEgress },
  });
  expect(res.statusCode, res.body).toBe(200);
};

/** Makes the deployment's sandbox egress `none` for the rest of the test. */
function deploymentEgressNone() {
  const cfg = k.app.get(KernelConfigService);
  const real = cfg.get();
  vi.spyOn(cfg, "get").mockReturnValue({
    ...real,
    sandbox: { ...real.sandbox, limits: { ...real.sandbox.limits, egress: "none" } },
  } as KernelConfig);
}

describe("network requests", () => {
  it("a member files a request; the admins' inbox lists it with its hosts", async () => {
    const r = await fileOk({
      hosts: ["Files.Slack.com", "api.openai.com", "files.slack.com"],
      note: "needed for the report",
    });
    expect(r).toMatchObject({
      kind: "network_allowlist",
      status: "pending",
      note: "needed for the report",
      item: null,
      network: {
        hosts: ["api.openai.com", "files.slack.com"],
        conversationId: null,
        agentId: null,
      },
    });
    const inbox = await ownerReq({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    const items = (inbox.json() as { items: { type: string; request?: RequestView }[] }).items;
    expect(items.filter((i) => i.type === "catalog_request").map((i) => i.request?.id)).toEqual([
      r.id,
    ]);
    // the member's inbox has no admin items
    const mine = await memberReq({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    expect(
      (mine.json() as { items: { type: string }[] }).items.filter(
        (i) => i.type === "catalog_request",
      ),
    ).toEqual([]);
  });

  it("rejects wildcards, invalid hosts, too many hosts, a long note and unknown fields", async () => {
    for (const payload of [
      { hosts: ["*.slack.com"] },
      { hosts: ["10.0.0.5"] },
      { hosts: ["localhost"] },
      { hosts: ["https://slack.com"] },
      { hosts: [] },
      { hosts: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) },
      { hosts: ["a.example.com"], note: "x".repeat(501) },
      { hosts: ["a.example.com"], extra: 1 },
    ]) {
      const res = await file(memberReq, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("refuses hosts the org already allows, and a conversation of another org", async () => {
    const res = await file(memberReq, { hosts: ["pypi.org", "api.github.com"] });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("catalog.request_invalid");
    const conv = await file(memberReq, { hosts: ["a.example.com"], conversationId: "nope" });
    expect(conv.statusCode).toBe(409);
    expect(errCode(conv)).toBe("catalog.request_invalid");
  });

  it("an identical pending request of the member is returned, not filed twice", async () => {
    const a = await fileOk({ hosts: ["b.example.com", "a.example.com"] });
    const b = await fileOk({ hosts: ["a.example.com", "b.example.com", "A.example.com"] });
    expect(b.id).toBe(a.id);
    const c = await fileOk({ hosts: ["a.example.com"] });
    expect(c.id).not.toBe(a.id);
    const n = await db
      .selectFrom("catalog_requests")
      .select(db.fn.countAll<string>().as("n"))
      .where("kind", "=", "network_allowlist")
      .executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(2);
  });

  it("approving an org that follows the deployment copies its list plus the hosts", async () => {
    expect(await orgEgress()).toBeUndefined();
    const r = await fileOk({ hosts: ["files.slack.com"] });
    const res = await decide(ownerReq, r.id, { approve: true });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { request: RequestView }).request.status).toBe("approved");
    expect(await orgEgress()).toEqual({
      mode: "allowlist",
      allowHosts: ["pypi.org", "*.github.com", "files.slack.com"],
    });
    const audit = await db
      .selectFrom("audit_events")
      .select(["detail"])
      .where("action", "=", "org.settings_updated")
      .where("org_id", "=", orgId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ requestId: r.id });
    // the requester's inbox shows the decision
    const mine = await memberReq({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
    const decided = (
      mine.json() as { items: { type: string; request?: RequestView }[] }
    ).items.filter((i) => i.type === "catalog_request_decided");
    expect(
      decided.map((i) => [i.request?.id, i.request?.status, i.request?.network?.hosts]),
    ).toEqual([[r.id, "approved", ["files.slack.com"]]]);
  });

  it("approving merges into the org's own list, adding only what it lacks", async () => {
    await setOrgEgress({ mode: "allowlist", allowHosts: ["*.slack.com"] });
    const r = await fileOk({ hosts: ["api.openai.com"] });
    expect((await decide(ownerReq, r.id, { approve: true })).statusCode).toBe(200);
    expect(await orgEgress()).toEqual({
      mode: "allowlist",
      allowHosts: ["*.slack.com", "api.openai.com"],
    });
  });

  it("the deployment egress none refuses filing and approving", async () => {
    const r = await fileOk({ hosts: ["files.slack.com"] });
    deploymentEgressNone();
    const filed = await file(memberReq, { hosts: ["api.openai.com"] });
    expect(filed.statusCode).toBe(409);
    expect(errCode(filed)).toBe("catalog.request_invalid");
    expect((filed.json() as { error: { message: string } }).error.message).toMatch(/super admin/);
    const res = await decide(ownerReq, r.id, { approve: true });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("catalog.request_invalid");
    expect(await orgEgress()).toBeUndefined();
  });

  it("an org with sandbox network off cannot approve; it can deny", async () => {
    const r = await fileOk({ hosts: ["files.slack.com"] });
    await setOrgEgress({ mode: "none" });
    const res = await decide(ownerReq, r.id, { approve: true });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("catalog.request_invalid");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/turned off/);
    expect(await orgEgress()).toEqual({ mode: "none" });
    const deny = await decide(ownerReq, r.id, { approve: false, reason: "not now" });
    expect(deny.statusCode).toBe(200);
    expect((deny.json() as { request: RequestView & { reason: string } }).request).toMatchObject({
      status: "rejected",
      reason: "not now",
    });
    expect(await orgEgress()).toEqual({ mode: "none" });
    // decided: a second decision is refused
    const again = await decide(ownerReq, r.id, { approve: true });
    expect(errCode(again)).toBe("catalog.request_decided");
  });

  it("an org with sandbox network off refuses filing", async () => {
    await setOrgEgress({ mode: "none" });
    const res = await file(memberReq, { hosts: ["files.slack.com"] });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("catalog.request_invalid");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(
      /ask an admin to turn it on first/,
    );
  });

  it("a member has at most 10 pending network requests", async () => {
    for (let i = 0; i < 10; i++) await fileOk({ hosts: [`h${i}.example.com`] });
    const res = await file(memberReq, { hosts: ["h10.example.com"] });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("catalog.request_invalid");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(
      /too many pending domain requests/,
    );
    // an identical pending request is still returned
    expect((await file(memberReq, { hosts: ["h0.example.com"] })).statusCode).toBe(201);
  });

  it("an admin's API token cannot approve a network request (it widens the org's list); it can reject", async () => {
    const r = await fileOk({ hosts: ["files.slack.com"] });
    const { token: pat } = await tokens.createPersonal(owner.id, { name: "ci" });
    const byPat = (payload: Record<string, unknown>) =>
      k.http.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/catalog-requests/${r.id}/decide`,
        payload,
        headers: { authorization: `Bearer ${pat}` },
      });
    const approved = await byPat({ approve: true });
    expect(approved.statusCode, approved.body).toBe(400);
    expect(errCode(approved)).toBe("org.sandbox_egress_not_allowed");
    expect(await orgEgress()).toBeUndefined();
    const rejected = await byPat({ approve: false, reason: "no" });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((rejected.json() as { request: RequestView }).request.status).toBe("rejected");
  });

  it("a member cannot decide; a PAT and a service token cannot file", async () => {
    const r = await fileOk({ hosts: ["files.slack.com"] });
    const res = await decide(memberReq, r.id, { approve: true });
    expect(res.statusCode).toBe(403);
    expect(await orgEgress()).toBeUndefined();

    const { token: pat } = await tokens.createPersonal(member.id, { name: "ci" });
    const byPat = await k.http.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog-requests/network`,
      payload: { hosts: ["api.openai.com"] },
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(byPat.statusCode).toBe(403);
    expect(errCode(byPat)).toBe("auth.session_required");

    const { token: svc } = await tokens.createService(orgId, {
      name: "ci",
      role: "admin",
      createdBy: owner.id,
    });
    const bySvc = await k.http.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/catalog-requests/network`,
      payload: { hosts: ["api.openai.com"] },
      headers: { authorization: `Bearer ${svc}` },
    });
    expect(bySvc.statusCode).toBe(403);
  });
});
