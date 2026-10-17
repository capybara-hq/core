import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../../src/identity/passwords.js";
import { SettingsService } from "../../src/identity/settings.js";

// 包一层 spy（行为不变），用来断言是否真的跑了 scrypt 校验，而不是靠计时
vi.mock("../../src/identity/passwords.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/identity/passwords.js")>();
  return { ...m, verifyPassword: vi.fn(m.verifyPassword) };
});
const verifySpy = vi.mocked(verifyPassword);

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

  it("不存在的登录名 → null，同样跑一次 scrypt 校验（防按耗时枚举登录名）", async () => {
    await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    verifySpy.mockClear();
    expect(await svc.authenticateLocal("nobody", PW)).toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(DUMMY_PASSWORD_HASH, PW);
    verifySpy.mockClear();
    expect(await svc.authenticateLocal("!!bad login!!", PW)).toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("超过 256 字符的密码直接返回 null，不调用 verifyPassword（不跑 scrypt）", async () => {
    await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    verifySpy.mockClear();
    expect(await svc.authenticateLocal("alice", "x".repeat(257))).toBeNull();
    expect(await svc.authenticateLocal("nobody", "x".repeat(100_000))).toBeNull();
    expect(await svc.verifyPassword("whatever", "x".repeat(257))).toBe(false);
    expect(verifySpy).not.toHaveBeenCalled();
    // 256 字符仍会校验
    expect(await svc.authenticateLocal("alice", "x".repeat(256))).toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("verifyPassword：按账号 id 校验本地密码；错误、超长、账号不存在 → false", async () => {
    const a = await svc.createLocal({ login: "alice", password: PW, displayName: "A" });
    expect(await svc.verifyPassword(a.id, PW)).toBe(true);
    expect(await svc.verifyPassword(a.id, "wrong password!!")).toBe(false);
    expect(await svc.verifyPassword(a.id, "x".repeat(257))).toBe(false);
    expect(await svc.verifyPassword("00000000-0000-0000-0000-000000000000", PW)).toBe(false);
  });

  it("setPassword 后旧密码失效；账号不存在 → account.not_found", async () => {
    const a = await svc.createLocal({
      login: "alice",
      password: PW,
      displayName: "A",
      enterpriseAdmin: true,
    });
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
    // 后执行的一方在锁内复核时已不是企业管理员
    expect((rej.reason as ApiError).code).toBe("forbidden");
    expect(await svc.countEnterpriseAdmins()).toBe(1);
  });

  it("停用 vs 降级并发（独立连接池）：活跃企业管理员仍至少一个", async () => {
    const raw2 = createDb(box.url, 10);
    const svc2 = new AccountsService(kernelDb(raw2));
    try {
      for (let i = 0; i < 10; i++) {
        await sql`TRUNCATE capybara.accounts CASCADE`.execute(raw);
        const a = await svc.createLocal({
          login: `root-a${i}`,
          password: PW,
          displayName: "A",
          enterpriseAdmin: true,
        });
        const b = await svc.createLocal({
          login: `root-b${i}`,
          password: PW,
          displayName: "B",
          enterpriseAdmin: true,
        });
        const rs = await Promise.allSettled([
          svc.update(b.id, { status: "disabled" }, a.id),
          svc2.update(a.id, { isEnterpriseAdmin: false }, b.id),
        ]);
        expect(rs.filter((r) => r.status === "fulfilled").length).toBe(1);
        for (const r of rs) {
          if (r.status === "rejected") expect((r.reason as ApiError).code).toBe("forbidden");
        }
        expect(await svc.countEnterpriseAdmins()).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await raw2.destroy();
    }
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

describe("企业管理员写操作执行期复核（R5）", () => {
  const admin = (name: string) =>
    svc.createLocal({
      login: `admin-${name}`,
      password: PW,
      displayName: name,
      enterpriseAdmin: true,
    });

  it("A 撤销 B 后，B 已通过鉴权的调用（建管理员 / 改账号 / 改设置）一律 forbidden", async () => {
    const a = await admin("a");
    const b = await admin("b");
    const c = await admin("c");
    await svc.update(b.id, { isEnterpriseAdmin: false }, a.id);
    expect(
      await codeOf(
        svc.createByAdmin(
          { login: "minted", password: PW, displayName: "M", enterpriseAdmin: true },
          b.id,
        ),
      ),
    ).toBe("forbidden");
    expect(await codeOf(svc.update(c.id, { isEnterpriseAdmin: false }, b.id))).toBe("forbidden");
    expect(await codeOf(svc.update(b.id, { isEnterpriseAdmin: true }, b.id))).toBe("forbidden");
    const settings = new SettingsService(db);
    expect(await codeOf(settings.update({ orgCreation: "enterprise_admin" }, b.id))).toBe(
      "forbidden",
    );
    expect((await settings.get()).orgCreation).toBe("anyone");
    expect((await svc.list({ limit: 10 })).map((x) => x.displayName).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    // 停用的管理员同样被拒
    await svc.update(c.id, { status: "disabled" }, a.id);
    expect(await codeOf(settings.update({ orgCreation: "enterprise_admin" }, c.id))).toBe(
      "forbidden",
    );
  });

  it("createByAdmin：活跃企业管理员可建账号（含企业管理员）并写审计", async () => {
    const a = await admin("a");
    const m = await svc.createByAdmin(
      { login: "minted", password: PW, displayName: "M", enterpriseAdmin: true },
      a.id,
    );
    expect(m.isEnterpriseAdmin).toBe(true);
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "account.created")
      .where("target", "=", m.id)
      .execute();
    expect(ev.map((e) => [e.actor_account_id, e.target, e.detail])).toEqual([
      [a.id, m.id, { enterpriseAdmin: true }],
    ]);
  });

  it("撤销进行中（持锁未提交）时被撤销者建管理员：等撤销提交后在锁内复核 → forbidden", async () => {
    const raw2 = createDb(box.url, 10);
    const svc2 = new AccountsService(kernelDb(raw2));
    try {
      await admin("a");
      const b = await admin("b");
      let mint: Promise<unknown> | undefined;
      let settled = false;
      await raw.transaction().execute(async (trx) => {
        // 模拟 AccountsService.update 撤销 B 的事务：已取企业管理员锁、已改行、尚未提交
        await sql`SELECT pg_advisory_xact_lock(hashtext('capybara.enterprise_admins'))`.execute(
          trx,
        );
        await sql`UPDATE capybara.accounts SET is_enterprise_admin = false WHERE id = ${b.id}`.execute(
          trx,
        );
        mint = svc2
          .createByAdmin(
            { login: "minted", password: PW, displayName: "M", enterpriseAdmin: true },
            b.id,
          )
          .finally(() => {
            settled = true;
          });
        mint.catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        expect(settled).toBe(false);
      });
      expect(await codeOf(mint as Promise<unknown>)).toBe("forbidden");
      expect((await svc.list({ limit: 10 })).some((x) => x.displayName === "M")).toBe(false);
    } finally {
      await raw2.destroy();
    }
  });

  it("撤销与新建管理员在独立连接池上并发：被撤销者不会在撤销之后建出管理员", async () => {
    const raw2 = createDb(box.url, 10);
    const svc2 = new AccountsService(kernelDb(raw2));
    try {
      const a = await admin("a");
      for (let i = 0; i < 15; i++) {
        const b = await admin(`b${i}`);
        const [demote, mint] = await Promise.allSettled([
          svc.update(b.id, { isEnterpriseAdmin: false }, a.id),
          svc2.createByAdmin(
            { login: `mint-${i}`, password: PW, displayName: `m${i}`, enterpriseAdmin: true },
            b.id,
          ),
        ]);
        expect(demote.status).toBe("fulfilled");
        if (mint.status === "rejected") {
          expect((mint.reason as ApiError).code).toBe("forbidden");
          continue;
        }
        // 建成的管理员只能发生在撤销之前（两者在同一把锁下串行，审计 id 体现执行顺序）
        const ev = await db
          .selectFrom("audit_events")
          .select(["id", "action"])
          .where("target", "in", [b.id, mint.value.id])
          .where("action", "in", ["account.updated", "account.created"])
          .orderBy("id")
          .execute();
        expect(ev.map((e) => e.action)).toEqual(["account.created", "account.updated"]);
      }
    } finally {
      await raw2.destroy();
    }
  });
});
