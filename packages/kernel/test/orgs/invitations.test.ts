import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import pgLib from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import { InvitationsService } from "../../src/orgs/invitations.service.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { type Org, OrgsService } from "../../src/orgs/orgs.service.js";
import type { OrgRole } from "../../src/orgs/roles.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";

/** 可让 hashPassword 人为变慢（毫秒），使「scrypt 是否在事务内执行」在任何机器上都能被观察到。 */
const hashDelay = vi.hoisted(() => ({ ms: 0 }));
vi.mock("../../src/identity/passwords.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/identity/passwords.js")>();
  return {
    ...m,
    hashPassword: async (plain: string) => {
      if (hashDelay.ms > 0) await new Promise((r) => setTimeout(r, hashDelay.ms));
      return m.hashPassword(plain);
    },
  };
});

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let raw2: ReturnType<typeof createDb>;
let db: KernelDb;
let db2: KernelDb;
let accounts: AccountsService;
let orgs: OrgsService;
let members: MembersService;
let inv: InvitationsService;
/** 用另一个连接池构造的 InvitationsService，模拟另一个副本。 */
let inv2: InvitationsService;
let A: Account;
let B: Account;
let C: Account;
let org: Org;

const PW = "correct horse battery";

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  raw2 = createDb(pg.url, 5);
  db = kernelDb(raw);
  db2 = kernelDb(raw2);
  accounts = new AccountsService(db);
  orgs = new OrgsService(db, new SettingsService(db), new ApiTokenService(db));
  members = testMembers(db);
  inv = new InvitationsService(db, accounts, members);
  inv2 = new InvitationsService(db2, new AccountsService(db2), testMembers(db2));
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await raw2.destroy();
  await pg.stop();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  A = await accounts.createLocal({ login: "usera", password: PW, displayName: "A" });
  B = await accounts.createLocal({ login: "userb", password: PW, displayName: "B" });
  C = await accounts.createLocal({ login: "userc", password: PW, displayName: "C" });
  org = await orgs.create({ name: "Acme", slug: "acme" }, A);
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code;
  }
  return undefined;
};

async function roleOf(accountId: string): Promise<OrgRole | undefined> {
  const r = await db
    .selectFrom("memberships")
    .select("role")
    .where("org_id", "=", org.id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return r?.role;
}

async function count(table: "accounts" | "memberships"): Promise<number> {
  const r = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await inv.list(org.id)).find((i) => i.id === id)?.status;
}

describe("InvitationsService.create / preview / list", () => {
  it("创建后 preview 返回组织名与角色；库里只存令牌的 SHA-256；审计 org.invitation.created", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "member" }, A.id);
    expect(token).toMatch(/^cap_inv_[A-Za-z0-9_-]{43}$/);
    expect(invitation).toMatchObject({
      orgId: org.id,
      role: "member",
      createdBy: A.id,
      acceptedAt: null,
      revokedAt: null,
    });
    const hours = (invitation.expiresAt.getTime() - invitation.createdAt.getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(168);
    const row = await db
      .selectFrom("invitations")
      .select("token_hash")
      .where("id", "=", invitation.id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    const p = await inv.preview(token);
    expect(p).toEqual({
      org: { id: org.id, name: "Acme" },
      role: "member",
      expiresAt: invitation.expiresAt,
    });
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.invitation.created")
      .executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ org_id: org.id, actor_account_id: A.id, target: invitation.id });
    expect(JSON.stringify(ev.detail)).not.toContain(token);
  });

  it("expiresInHours 生效；超出 1–720 → validation_failed", async () => {
    const { invitation } = await inv.create(org.id, { role: "guest", expiresInHours: 2 }, A.id);
    const hours = (invitation.expiresAt.getTime() - invitation.createdAt.getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(2);
    expect(await codeOf(inv.create(org.id, { role: "guest", expiresInHours: 0 }, A.id))).toBe(
      "validation_failed",
    );
    expect(await codeOf(inv.create(org.id, { role: "guest", expiresInHours: 721 }, A.id))).toBe(
      "validation_failed",
    );
  });

  it("admin 邀 admin 成功；role=owner 被拒（validation_failed）", async () => {
    await members.add(org.id, B.id, "admin", A.id);
    const { invitation } = await inv.create(org.id, { role: "admin" }, B.id);
    expect(invitation.role).toBe("admin");
    expect(await codeOf(inv.create(org.id, { role: "owner" as "admin" }, B.id))).toBe(
      "validation_failed",
    );
  });

  it("发起人角色在事务内实时重读：member / 非成员 / 已被降级的 admin → forbidden", async () => {
    await members.add(org.id, B.id, "member", A.id);
    expect(await codeOf(inv.create(org.id, { role: "guest" }, B.id))).toBe("forbidden");
    expect(await codeOf(inv.create(org.id, { role: "guest" }, C.id))).toBe("forbidden");
    await members.add(org.id, C.id, "admin", A.id);
    await members.changeRole(org.id, C.id, "member", A.id);
    expect(await codeOf(inv.create(org.id, { role: "guest" }, C.id))).toBe("forbidden");
  });

  it("组织已软删除 → org.not_found", async () => {
    await orgs.softDelete(org.id, A);
    expect(await codeOf(inv.create(org.id, { role: "guest" }, A.id))).toBe("org.not_found");
  });

  it("list 给出各状态：pending / accepted / expired / revoked", async () => {
    const p = await inv.create(org.id, { role: "guest" }, A.id);
    const a = await inv.create(org.id, { role: "guest" }, A.id);
    const e = await inv.create(org.id, { role: "guest" }, A.id);
    const r = await inv.create(org.id, { role: "guest" }, A.id);
    await inv.accept(a.token, { accountId: B.id });
    await db
      .updateTable("invitations")
      .set({ expires_at: sql<Date>`now() - interval '1 hour'` })
      .where("id", "=", e.invitation.id)
      .execute();
    await inv.revoke(org.id, r.invitation.id, A.id);
    const list = await inv.list(org.id);
    const byId = Object.fromEntries(list.map((i) => [i.id, i.status]));
    expect(byId).toEqual({
      [p.invitation.id]: "pending",
      [a.invitation.id]: "accepted",
      [e.invitation.id]: "expired",
      [r.invitation.id]: "revoked",
    });
    expect(list[0]).not.toHaveProperty("tokenHash");
  });
});

describe("InvitationsService.revoke", () => {
  it("撤销后 preview / accept → invitation.invalid；审计 org.invitation.revoked", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "member" }, A.id);
    await inv.revoke(org.id, invitation.id, A.id);
    expect(await codeOf(inv.preview(token))).toBe("invitation.invalid");
    expect(await codeOf(inv.accept(token, { accountId: B.id }))).toBe("invitation.invalid");
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.invitation.revoked")
      .executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ org_id: org.id, actor_account_id: A.id, target: invitation.id });
  });

  it("不属于该组织 → invitation.invalid；发起人不是 admin → forbidden", async () => {
    const other = await orgs.create({ name: "Other", slug: "other" }, B);
    const { invitation } = await inv.create(org.id, { role: "member" }, A.id);
    expect(await codeOf(inv.revoke(other.id, invitation.id, B.id))).toBe("invitation.invalid");
    await members.add(org.id, C.id, "member", A.id);
    expect(await codeOf(inv.revoke(org.id, invitation.id, C.id))).toBe("forbidden");
    expect(await statusOf(invitation.id)).toBe("pending");
  });
});

describe("InvitationsService.accept", () => {
  it("已登录账号接受 → 成为对应角色的成员，状态 accepted；再接受 → invitation.used", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "admin" }, A.id);
    const r = await inv.accept(token, { accountId: B.id });
    expect(r).toMatchObject({ account: { id: B.id }, orgId: org.id, role: "admin" });
    expect(await roleOf(B.id)).toBe("admin");
    expect(await statusOf(invitation.id)).toBe("accepted");
    const row = await db
      .selectFrom("invitations")
      .select("accepted_by")
      .where("id", "=", invitation.id)
      .executeTakeFirstOrThrow();
    expect(row.accepted_by).toBe(B.id);
    expect(await codeOf(inv.accept(token, { accountId: C.id }))).toBe("invitation.used");
    expect(await codeOf(inv.preview(token))).toBe("invitation.used");
    expect(await roleOf(C.id)).toBeUndefined();
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.invitation.accepted")
      .executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ org_id: org.id, actor_account_id: B.id, target: invitation.id });
  });

  it("signup 接受 → 新账号可用新密码登录并成为成员", async () => {
    const { token } = await inv.create(org.id, { role: "member" }, A.id);
    const r = await inv.accept(token, {
      signup: { login: "newbie", password: "a brand new pass", displayName: "Newbie" },
    });
    expect(r.account.displayName).toBe("Newbie");
    expect(r.role).toBe("member");
    const authed = await accounts.authenticateLocal("newbie", "a brand new pass");
    expect(authed?.id).toBe(r.account.id);
    expect(await roleOf(r.account.id)).toBe("member");
  });

  it("signup 期间事务不会因 scrypt 处于 idle in transaction 超过 50ms（哈希在 BEGIN 之前算）", async () => {
    const watcher = createDb(pg.url, 1);
    // 本机 scrypt 可能快于 50ms：人为再加 150ms，哈希若在事务内执行必然被观察到
    hashDelay.ms = 150;
    try {
      for (let i = 0; i < 3; i++) {
        const { token } = await inv.create(org.id, { role: "member" }, A.id);
        let done = false;
        let worst = 0;
        const poll = (async () => {
          while (!done) {
            const r = await sql<{ s: number | null }>`
              SELECT max(extract(epoch FROM clock_timestamp() - state_change))::float8 AS s
              FROM pg_stat_activity
              WHERE state = 'idle in transaction' AND datname = current_database()`.execute(
              watcher,
            );
            worst = Math.max(worst, Number(r.rows[0]?.s ?? 0));
          }
        })();
        try {
          await inv.accept(token, {
            signup: { login: `idle${i}`, password: PW, displayName: "Idle" },
          });
        } finally {
          done = true;
          await poll;
        }
        expect(worst).toBeLessThan(0.05);
      }
    } finally {
      hashDelay.ms = 0;
      await watcher.destroy();
    }
  });

  it("signup 登录名已占用 → account.login_taken 且邀请未消耗；换登录名后仍可接受", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "member" }, A.id);
    const before = await count("accounts");
    expect(
      await codeOf(
        inv.accept(token, { signup: { login: "userb", password: PW, displayName: "X" } }),
      ),
    ).toBe("account.login_taken");
    expect(await count("accounts")).toBe(before);
    expect(await statusOf(invitation.id)).toBe("pending");
    const r = await inv.accept(token, {
      signup: { login: "userx", password: PW, displayName: "X" },
    });
    expect(await roleOf(r.account.id)).toBe("member");
  });

  it("过期 → invitation.expired；随机令牌 → invitation.invalid", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "member" }, A.id);
    await db
      .updateTable("invitations")
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where("id", "=", invitation.id)
      .execute();
    expect(await codeOf(inv.preview(token))).toBe("invitation.expired");
    expect(await codeOf(inv.accept(token, { accountId: B.id }))).toBe("invitation.expired");
    expect(await roleOf(B.id)).toBeUndefined();
    expect(await codeOf(inv.preview("cap_inv_nope"))).toBe("invitation.invalid");
    expect(await codeOf(inv.accept("cap_inv_nope", { accountId: B.id }))).toBe(
      "invitation.invalid",
    );
  });

  it("组织软删除后 → invitation.invalid", async () => {
    const { token } = await inv.create(org.id, { role: "member" }, A.id);
    await orgs.softDelete(org.id, A);
    expect(await codeOf(inv.preview(token))).toBe("invitation.invalid");
    expect(await codeOf(inv.accept(token, { accountId: B.id }))).toBe("invitation.invalid");
  });

  it("已是成员的账号接受 → member.already_exists，邀请仍为 pending", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "admin" }, A.id);
    await members.add(org.id, B.id, "guest", A.id);
    expect(await codeOf(inv.accept(token, { accountId: B.id }))).toBe("member.already_exists");
    expect(await statusOf(invitation.id)).toBe("pending");
    expect(await roleOf(B.id)).toBe("guest");
  });

  it("并发：两个账号同时接受同一邀请（两个独立连接池）→ 恰好一个成功、一个 invitation.used，且失败方确实打到带条件的 UPDATE", async () => {
    const { invitation, token } = await inv.create(org.id, { role: "member" }, A.id);
    const before = await count("memberships");
    // 另一个连接先持有组织行锁：两个接受请求都在分类通过（邀请仍为 pending）后卡在 tryLockOrg，
    // 释放后串行拿锁，后到者分类阶段已过，只能由条件 UPDATE（0 行）判为 invitation.used
    const holder = new pgLib.Client({ connectionString: pg.url });
    // 观察用的独立连接：事务内的 pg_stat_activity 是事务开始时的快照，不能在 holder 上轮询
    const watcher = new pgLib.Client({ connectionString: pg.url });
    await Promise.all([holder.connect(), watcher.connect()]);
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM capybara.orgs WHERE id = $1 FOR UPDATE", [org.id]);
      const results = Promise.all([
        codeOf(inv.accept(token, { accountId: B.id })),
        codeOf(inv2.accept(token, { accountId: C.id })),
      ]);
      const deadline = Date.now() + 4_000;
      for (;;) {
        const { rows } = await watcher.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE '%"orgs"%for no key update%'
             AND datname = current_database()`,
        );
        if (Number(rows[0]?.n) >= 2) break;
        if (Date.now() > deadline) throw new Error("accepts did not both block on the org lock");
        await new Promise((r) => setTimeout(r, 20));
      }
      // 两者都已过分类阶段，此时邀请仍未被占用
      expect(await statusOf(invitation.id)).toBe("pending");
      await holder.query("COMMIT");
      const codes = await results;
      expect(codes.sort()).toEqual([undefined, "invitation.used"].sort());
    } finally {
      await Promise.all([holder.end(), watcher.end()]);
    }
    expect(await count("memberships")).toBe(before + 1);
  });

  it("并发 signup：恰好一个成功；失败方的账号不残留", async () => {
    const { token } = await inv.create(org.id, { role: "member" }, A.id);
    const accBefore = await count("accounts");
    const memBefore = await count("memberships");
    const codes = await Promise.all([
      codeOf(inv.accept(token, { signup: { login: "signup1", password: PW, displayName: "S1" } })),
      codeOf(inv2.accept(token, { signup: { login: "signup2", password: PW, displayName: "S2" } })),
    ]);
    expect(codes.sort()).toEqual([undefined, "invitation.used"].sort());
    expect(await count("accounts")).toBe(accBefore + 1);
    expect(await count("memberships")).toBe(memBefore + 1);
  });
});
