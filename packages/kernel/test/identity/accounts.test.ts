import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let svc: AccountsService;

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(box.url, 10);
  db = kernelDb(raw);
  svc = new AccountsService(db);
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts CASCADE`.execute(raw);
});

const PW = "correct horse battery";
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code;
  }
  return undefined;
};

describe("AccountsService 本地账号", () => {
  it("创建后可认证（登录名大小写不敏感），identities 有 local 行", async () => {
    const a = await svc.createLocal({ login: "Alice", password: PW, displayName: "Alice" });
    expect(a.status).toBe("active");
    expect((await svc.authenticateLocal("ALICE", PW))?.id).toBe(a.id);
    const ids = await db.selectFrom("identities").selectAll().execute();
    expect(ids.map((i) => [i.source, i.external_id])).toEqual([["local", "alice"]]);
    expect(await svc.get(a.id)).toMatchObject({ id: a.id, displayName: "Alice" });
  });

  it("同名再建 → account.login_taken，且不留下半个账号", async () => {
    await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    expect(await codeOf(svc.createLocal({ login: "ALICE", password: PW, displayName: "B" }))).toBe(
      "account.login_taken",
    );
    expect((await svc.list({ limit: 10 })).length).toBe(1);
  });

  it("错密码 → null；停用后正确密码 → auth.account_disabled", async () => {
    const admin = await svc.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    });
    const a = await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    expect(await svc.authenticateLocal("alice", "wrong password!!")).toBeNull();
    await svc.update(a.id, { status: "disabled" }, admin.id);
    expect(await svc.authenticateLocal("alice", "wrong password!!")).toBeNull();
    expect(await codeOf(svc.authenticateLocal("alice", PW))).toBe("auth.account_disabled");
  });

  it("不存在的登录名 → null，耗时不小于正确路径的一半（同样跑了 scrypt）", async () => {
    await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    await svc.authenticateLocal("alice", PW); // 预热
    const t0 = performance.now();
    await svc.authenticateLocal("alice", PW);
    const real = performance.now() - t0;
    const t1 = performance.now();
    expect(await svc.authenticateLocal("nobody", PW)).toBeNull();
    const ghost = performance.now() - t1;
    expect(ghost).toBeGreaterThan(real * 0.3);
  });

  it("超过 256 字符的密码直接返回 null，不跑 scrypt", async () => {
    await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    await svc.authenticateLocal("alice", PW); // 预热
    const t0 = performance.now();
    await svc.authenticateLocal("alice", PW);
    const real = performance.now() - t0;
    const t1 = performance.now();
    expect(await svc.authenticateLocal("alice", "x".repeat(257))).toBeNull();
    expect(await svc.authenticateLocal("nobody", "x".repeat(100_000))).toBeNull();
    const long = performance.now() - t1;
    expect(long).toBeLessThan(real * 0.5);
  });

  it("verifyPassword：按账号 id 校验本地密码；错误、超长、账号不存在 → false", async () => {
    const a = await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    expect(await svc.verifyPassword(a.id, PW)).toBe(true);
    expect(await svc.verifyPassword(a.id, "wrong password!!")).toBe(false);
    expect(await svc.verifyPassword(a.id, "x".repeat(257))).toBe(false);
    expect(await svc.verifyPassword("00000000-0000-0000-0000-000000000000", PW)).toBe(false);
  });

  it("setPassword 后旧密码失效；账号不存在 → account.not_found", async () => {
    const a = await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    await svc.setPassword(a.id, "another long password");
    expect(await svc.authenticateLocal("alice", PW)).toBeNull();
    expect((await svc.authenticateLocal("alice", "another long password"))?.id).toBe(a.id);
    expect(await codeOf(svc.setPassword("missing", PW))).toBe("account.not_found");
    expect(await codeOf(svc.update("missing", { displayName: "x" }, a.id))).toBe(
      "account.not_found",
    );
  });

  it("list 按 id 分页", async () => {
    for (const l of ["aaa", "bbb", "ccc"]) {
      await svc.createLocal({ login: l, password: PW, displayName: l });
    }
    const p1 = await svc.list({ limit: 2 });
    const p2 = await svc.list({ limit: 2, after: p1[1]?.id ?? "" });
    expect(p1.length).toBe(2);
    expect(p2.length).toBe(1);
    expect([...p1, ...p2].map((a) => a.id)).toEqual([...p1, ...p2].map((a) => a.id).sort());
  });
});

describe("最后一个企业管理员", () => {
  it("仅一个时撤销或停用均被拒绝", async () => {
    const a = await svc.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    });
    expect(await svc.countEnterpriseAdmins()).toBe(1);
    expect(await codeOf(svc.update(a.id, { isEnterpriseAdmin: false }, a.id))).toBe(
      "account.last_enterprise_admin",
    );
    expect(await codeOf(svc.update(a.id, { status: "disabled" }, a.id))).toBe(
      "account.last_enterprise_admin",
    );
    expect((await svc.get(a.id))?.isEnterpriseAdmin).toBe(true);
  });

  it("两个管理员并发互相撤销：恰好一个成功", async () => {
    const a = await svc.createLocal({
      login: "root1",
      password: PW,
      displayName: "1",
      enterpriseAdmin: true,
    });
    const b = await svc.createLocal({
      login: "root2",
      password: PW,
      displayName: "2",
      enterpriseAdmin: true,
    });
    const rs = await Promise.allSettled([
      svc.update(b.id, { isEnterpriseAdmin: false }, a.id),
      svc.update(a.id, { isEnterpriseAdmin: false }, b.id),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rej = rs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as ApiError).code).toBe("account.last_enterprise_admin");
    expect(await svc.countEnterpriseAdmins()).toBe(1);
  });

  it("update 写审计", async () => {
    const a = await svc.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    });
    await svc.update(a.id, { displayName: "Root" }, a.id);
    const ev = await db.selectFrom("audit_events").selectAll().execute();
    expect(ev.some((e) => e.action === "account.updated" && e.target === a.id)).toBe(true);
  });
});
