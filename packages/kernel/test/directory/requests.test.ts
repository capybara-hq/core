import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditActions,
  importSkill,
  install,
  type OrgEnv,
  requestItem,
  resetOrgDirectory,
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
  await resetOrgDirectory(env);
});

type Inbox = { items: { type: string; id: string; request?: { item: { id: string } } }[] };

async function inbox(req: OrgEnv["root"]): Promise<Inbox["items"]> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/inbox` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as Inbox).items.filter((i) => i.type === "directory_request");
}

const decideOrg = (req: OrgEnv["root"], id: string, decision: "approve" | "reject") =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/directory-requests/${id}/decide`,
    payload: { decision },
  });

const decideAdmin = (req: OrgEnv["root"], id: string, decision: "approve" | "reject") =>
  req({
    method: "POST",
    url: `/api/v1/admin/directory/requests/${id}/decide`,
    payload: { decision },
  });

async function overviewPending(): Promise<number> {
  const r = await env.root({ method: "GET", url: "/api/v1/admin/overview" });
  return (r.json() as { directoryRequestsPending: number }).directoryRequestsPending;
}

describe("成员申请与审批", () => {
  it("成员申请进组织管理员收件箱；组织管理员批准后安装", async () => {
    const itemId = await importSkill(env);
    const r = await requestItem(env.mem, env, itemId, "need PDFs");
    expect(r.statusCode, r.body).toBe(201);
    const req = r.json().request as { id: string; stage: string; status: string; note: string };
    expect(req).toMatchObject({ stage: "org", status: "pending", note: "need PDFs" });
    expect((await inbox(env.boss)).map((i) => i.id)).toEqual([req.id]);
    expect((await inbox(env.root)).map((i) => i.id)).toEqual([req.id]);
    expect(await inbox(env.mem)).toEqual([]);
    expect(await auditActions(env)).toContain("directory.requested");
    // 成员不能决定
    expect((await decideOrg(env.mem, req.id, "approve")).statusCode).toBe(403);
    const ok = await decideOrg(env.boss, req.id, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request).toMatchObject({ status: "approved", stage: "org" });
    expect(await inbox(env.boss)).toEqual([]);
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    expect(await auditActions(env)).toContain("directory.request_decided");
  });

  it("needs_approval：组织批准升级到企业管理员，企业管理员批准后安装（request → approve → install）", async () => {
    const itemId = await importSkill(env, { policy: "needs_approval" });
    const r = await requestItem(env.mem, env, itemId);
    const id = r.json().request.id as string;
    const up = await decideOrg(env.boss, id, "approve");
    expect(up.json().request).toMatchObject({ stage: "deployment", status: "pending" });
    expect(await inbox(env.boss)).toEqual([]);
    expect(await overviewPending()).toBe(1);
    // 组织管理员不能替企业管理员决定；非企业管理员调不了后台接口
    expect((await decideOrg(env.boss, id, "approve")).json().error.code).toBe(
      "directory.request_decided",
    );
    expect((await decideAdmin(env.boss, id, "approve")).statusCode).toBe(403);
    const list = await env.root({ method: "GET", url: "/api/v1/admin/directory/requests" });
    expect((list.json() as { requests: { id: string }[] }).requests.map((x) => x.id)).toEqual([id]);
    // 没批准前安装：202，复用同一条申请
    const pend = await install(env.boss, env, itemId);
    expect(pend.statusCode).toBe(202);
    expect(pend.json().request.id).toBe(id);
    const ok = await decideAdmin(env.root, id, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request.status).toBe("approved");
    expect(await overviewPending()).toBe(0);
    const grants = await env.db.selectFrom("directory_org_grants").selectAll().execute();
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

    const off = await importSkill(env, {
      name: "@acme/skill-off",
      skillName: "off-skill",
      policy: "disabled",
    });
    const d = await requestItem(env.mem, env, off);
    expect(d.statusCode).toBe(403);
    expect(d.json().error.code).toBe("directory.item_disabled");
    expect(
      (await decideOrg(env.boss, "00000000-0000-4000-8000-000000000000", "approve")).statusCode,
    ).toBe(404);
  });

  it("安装会把待处理的成员申请标为已批准", async () => {
    const itemId = await importSkill(env);
    const id = (await requestItem(env.mem, env, itemId)).json().request.id as string;
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const row = await env.db
      .selectFrom("directory_requests")
      .select(["status", "decided_by"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "approved", decided_by: env.bossId });
    expect(await inbox(env.boss)).toEqual([]);
  });
});

describe("并发", () => {
  it("同时两次申请：只有一条 pending，两次都返回它", async () => {
    const itemId = await importSkill(env);
    const [a, b] = await Promise.all([
      requestItem(env.mem, env, itemId),
      requestItem(env.boss, env, itemId),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().request.id).toBe(b.json().request.id);
    expect([a.json().created, b.json().created].sort()).toEqual([false, true]);
    const rows = await env.db.selectFrom("directory_requests").select("id").execute();
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
      .selectFrom("directory_requests")
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
          .where("action", "=", "directory.request_decided")
          .execute()
      ).length,
    ).toBe(2);
  });
});
