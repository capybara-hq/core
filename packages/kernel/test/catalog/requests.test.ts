import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOrg } from "../helpers/runs.js";
import {
  auditActions,
  importSkill,
  install,
  type OrgEnv,
  requestItem,
  resetOrgCatalog,
  startOrgEnv,
} from "./org-env.js";

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

type Inbox = { items: { type: string; id: string; request?: { item: { id: string } } }[] };

async function inbox(req: OrgEnv["root"]): Promise<Inbox["items"]> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/inbox` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as Inbox).items.filter((i) => i.type === "catalog_request");
}

const decideOrg = (req: OrgEnv["root"], id: string, decision: "approve" | "reject") =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/catalog-requests/${id}/decide`,
    payload: { decision },
  });

const decideAdmin = (req: OrgEnv["root"], id: string, decision: "approve" | "reject") =>
  req({
    method: "POST",
    url: `/api/v1/admin/catalog/requests/${id}/decide`,
    payload: { decision },
  });

async function overviewPending(): Promise<number> {
  const r = await env.root({ method: "GET", url: "/api/v1/admin/overview" });
  return (r.json() as { catalogRequestsPending: number }).catalogRequestsPending;
}

describe("成员申请与审批", { timeout: 60_000 }, () => {
  it("成员申请进组织管理员收件箱；组织管理员批准后安装", async () => {
    const itemId = await importSkill(env);
    const r = await requestItem(env.mem, env, itemId, "need PDFs");
    expect(r.statusCode, r.body).toBe(201);
    const req = r.json().request as { id: string; stage: string; status: string; note: string };
    expect(req).toMatchObject({ stage: "org", status: "pending", note: "need PDFs" });
    expect((await inbox(env.boss)).map((i) => i.id)).toEqual([req.id]);
    expect((await inbox(env.root)).map((i) => i.id)).toEqual([req.id]);
    expect(await inbox(env.mem)).toEqual([]);
    expect(await auditActions(env)).toContain("catalog.requested");
    // 成员不能决定
    expect((await decideOrg(env.mem, req.id, "approve")).statusCode).toBe(403);
    const ok = await decideOrg(env.boss, req.id, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request).toMatchObject({ status: "approved", stage: "org" });
    expect(await inbox(env.boss)).toEqual([]);
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    expect(await auditActions(env)).toContain("catalog.request_decided");
  });

  it("needs_approval：组织批准升级到企业管理员，企业管理员批准后安装（request → approve → install）", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const r = await requestItem(env.mem, env, itemId);
    const id = r.json().request.id as string;
    const up = await decideOrg(env.boss, id, "approve");
    expect(up.json().request).toMatchObject({
      stage: "deployment",
      status: "pending",
      orgDecidedBy: env.bossId,
      decidedBy: null,
    });
    expect(up.json().request.orgDecidedAt).toEqual(expect.any(String));
    expect(await inbox(env.boss)).toEqual([]);
    expect(await overviewPending()).toBe(1);
    // 组织管理员不能替企业管理员决定；非企业管理员调不了后台接口
    expect((await decideOrg(env.boss, id, "approve")).json().error.code).toBe(
      "catalog.request_decided",
    );
    expect((await decideAdmin(env.boss, id, "approve")).statusCode).toBe(403);
    const list = await env.root({ method: "GET", url: "/api/v1/admin/catalog/requests" });
    expect((list.json() as { requests: { id: string }[] }).requests.map((x) => x.id)).toEqual([id]);
    // 没批准前安装：202，复用同一条申请
    const pend = await install(env.boss, env, itemId);
    expect(pend.statusCode).toBe(202);
    expect(pend.json().request.id).toBe(id);
    const ok = await decideAdmin(env.root, id, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request.status).toBe("approved");
    expect(await overviewPending()).toBe(0);
    const grants = await env.db.selectFrom("catalog_org_grants").selectAll().execute();
    expect(grants).toHaveLength(1);
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
  });

  it("拒绝：组织拒绝与企业管理员拒绝；disabled 不能申请；别的组织的申请 404", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const a = (await requestItem(env.mem, env, itemId)).json().request.id as string;
    expect((await decideOrg(env.boss, a, "reject")).json().request.status).toBe("rejected");
    const b = (await install(env.boss, env, itemId)).json().request.id as string;
    expect(b).not.toBe(a);
    expect((await decideAdmin(env.root, b, "reject")).json().request.status).toBe("rejected");
    expect((await install(env.boss, env, itemId)).statusCode).toBe(202);

    const off = await importSkill(env, { name: "off", skillName: "off-skill", policy: "disabled" });
    // 成员看不到 disabled 的条目：not found（不暴露条目存在）；组织管理员得到 item_disabled
    const d = await requestItem(env.mem, env, off);
    expect(d.statusCode).toBe(404);
    expect(d.json().error.code).toBe("catalog.item_not_found");
    const da = await requestItem(env.boss, env, off);
    expect(da.statusCode).toBe(403);
    expect(da.json().error.code).toBe("catalog.item_disabled");
    expect(
      (await decideOrg(env.boss, "00000000-0000-4000-8000-000000000000", "approve")).statusCode,
    ).toBe(404);
  });

  it("安装会把待处理的成员申请标为已批准", async () => {
    const itemId = await importSkill(env);
    const id = (await requestItem(env.mem, env, itemId)).json().request.id as string;
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "decided_by"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "approved", decided_by: env.bossId });
    expect(await inbox(env.boss)).toEqual([]);
  });
});

describe("挂着的申请随条目 / 组织删除取消，安装后一并关闭", { timeout: 60_000 }, () => {
  it("删除条目：pending 申请取消（审计带原因）；企业管理员不能再批准已删除条目的申请", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const orgReq = (await requestItem(env.mem, env, itemId)).json().request.id as string;
    // 另一条已交企业管理员（本组织只能有一条 pending：先让成员申请升级）
    const up = await decideOrg(env.boss, orgReq, "approve");
    expect(up.json().request.stage).toBe("deployment");
    // 先禁用：企业管理员批准 disabled 条目的申请 → item_disabled，不写授予
    await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/policy`,
      payload: { policy: "disabled" },
    });
    const blocked = await decideAdmin(env.root, orgReq, "approve");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("catalog.item_disabled");
    expect(await env.db.selectFrom("catalog_org_grants").select("item_id").execute()).toEqual([]);
    const del = await env.root({
      method: "DELETE",
      url: `/api/v1/admin/catalog/items/${itemId}`,
    });
    expect(del.statusCode, del.body).toBe(204);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "decided_by"])
      .where("id", "=", orgReq)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "cancelled", decided_by: env.rootId });
    expect(await auditActions(env)).toContain("catalog.request_cancelled");
    expect(await overviewPending()).toBe(0);
  });

  it("needs_approval 时建的部署级申请：条目改成 allow 后安装，申请一并标为已批准", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const pend = await install(env.boss, env, itemId);
    expect(pend.statusCode).toBe(202);
    const id = pend.json().request.id as string;
    await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/policy`,
      payload: { policy: "allow" },
    });
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select(["status", "decided_by"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "approved", decided_by: env.bossId });
    expect(await overviewPending()).toBe(0);
  });

  it("删除组织：它挂着的申请取消，不再出现在企业管理员列表与概览计数", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const other = await createOrg(env.root, "Doomed");
    const r = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${other}/catalog/${itemId}/install`,
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(await overviewPending()).toBe(1);
    const del = await env.root({ method: "DELETE", url: `/api/v1/orgs/${other}` });
    expect(del.statusCode, del.body).toBe(204);
    expect(await overviewPending()).toBe(0);
    const list = await env.root({ method: "GET", url: "/api/v1/admin/catalog/requests" });
    expect((list.json() as { requests: unknown[] }).requests).toEqual([]);
    const row = await env.db
      .selectFrom("catalog_requests")
      .select("status")
      .where("org_id", "=", other)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled");
  });
});

describe("并发", { timeout: 60_000 }, () => {
  it("同时两次申请：只有一条 pending，两次都返回它", async () => {
    const itemId = await importSkill(env);
    const [a, b] = await Promise.all([
      requestItem(env.mem, env, itemId),
      requestItem(env.boss, env, itemId),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().request.id).toBe(b.json().request.id);
    expect([a.json().created, b.json().created].sort()).toEqual([false, true]);
    const rows = await env.db.selectFrom("catalog_requests").select("id").execute();
    expect(rows).toHaveLength(1);
  });

  it("同时两次决定：一次成功，一次 409（组织与企业管理员各一组）", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const id = (await requestItem(env.mem, env, itemId)).json().request.id as string;
    const [x, y] = await Promise.all([
      decideOrg(env.boss, id, "approve"),
      decideOrg(env.root, id, "approve"),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const after = await env.db
      .selectFrom("catalog_requests")
      .select(["stage", "status"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ stage: "deployment", status: "pending" });
    const [p, q] = await Promise.all([
      decideAdmin(env.root, id, "approve"),
      decideAdmin(env.root, id, "approve"),
    ]);
    expect([p.statusCode, q.statusCode].sort()).toEqual([200, 409]);
    expect(
      (
        await env.db
          .selectFrom("audit_events")
          .select("action")
          .where("action", "=", "catalog.request_decided")
          .execute()
      ).length,
    ).toBe(2);
  });
});
