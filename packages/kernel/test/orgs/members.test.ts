import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { type Org, OrgsService } from "../../src/orgs/orgs.service.js";
import type { OrgRole } from "../../src/orgs/roles.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let raw2: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let db2: KernelSchemaDb;
let accounts: AccountsService;
let orgs: OrgsService;
let members: MembersService;
/** 用另一个连接池的 MembersService，模拟另一个副本。 */
let members2: MembersService;
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
  members2 = testMembers(db2);
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await raw2.destroy();
  await pg.stop();
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  A = await accounts.createLocal({
    login: "usera",
    password: PW,
    displayName: "A",
    email: "a@x.io",
  });
  B = await accounts.createLocal({ login: "userb", password: PW, displayName: "B" });
  C = await accounts.createLocal({ login: "userc", password: PW, displayName: "C" });
  org = await orgs.create({ name: "Acme", slug: "acme" }, A);
});

/** 并发互相降级 / 移除时，后到的一方按锁内实时角色被拒绝的可能错误码。 */
const LOSER_CODES = ["org.last_owner", "org.owner_required", "forbidden"];

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

async function ownerCount(): Promise<number> {
  const r = await db
    .selectFrom("memberships")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", org.id)
    .where("role", "=", "owner")
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

describe("MembersService", () => {
  it("add / list；重复 add → member.already_exists；写审计 org.member.added", async () => {
    await members.add(org.id, B.id, "member", A.id);
    expect(await codeOf(members.add(org.id, B.id, "guest", A.id))).toBe("member.already_exists");
    const list = await members.list(org.id);
    expect(list.map((m) => [m.account.id, m.role])).toEqual([
      [A.id, "owner"],
      [B.id, "member"],
    ]);
    expect(list[0]?.account).toEqual({ id: A.id, displayName: "A", email: "a@x.io" });
    expect(list[0]?.joinedAt).toBeInstanceOf(Date);
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.member.added")
      .executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ org_id: org.id, actor_account_id: A.id, target: B.id });
  });

  it("admin 把 member 升为 admin 成功；审计 detail 含前后角色", async () => {
    await members.add(org.id, B.id, "admin", A.id);
    await members.add(org.id, C.id, "member", A.id);
    await members.changeRole(org.id, C.id, "admin", B.id);
    expect(await roleOf(C.id)).toBe("admin");
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.member.role_changed")
      .executeTakeFirstOrThrow();
    expect(ev.detail).toEqual({ from: "member", to: "admin" });
  });

  it("admin 试图升人为 owner → org.owner_required", async () => {
    await members.add(org.id, B.id, "admin", A.id);
    await members.add(org.id, C.id, "member", A.id);
    expect(await codeOf(members.changeRole(org.id, C.id, "owner", B.id))).toBe(
      "org.owner_required",
    );
    expect(await roleOf(C.id)).toBe("member");
  });

  it("admin 试图改 owner 或移除 owner → org.owner_required", async () => {
    await members.add(org.id, B.id, "admin", A.id);
    expect(await codeOf(members.changeRole(org.id, A.id, "member", B.id))).toBe(
      "org.owner_required",
    );
    expect(await codeOf(members.remove(org.id, A.id, B.id))).toBe("org.owner_required");
    expect(await roleOf(A.id)).toBe("owner");
  });

  it("目标不是成员 → member.not_found", async () => {
    expect(await codeOf(members.changeRole(org.id, C.id, "member", A.id))).toBe("member.not_found");
    expect(await codeOf(members.remove(org.id, C.id, A.id))).toBe("member.not_found");
  });

  it("唯一 owner 自降 → org.last_owner；唯一 owner leave → org.last_owner", async () => {
    expect(await codeOf(members.changeRole(org.id, A.id, "admin", A.id))).toBe("org.last_owner");
    expect(await codeOf(members.leave(org.id, A.id))).toBe("org.last_owner");
    expect(await codeOf(members.remove(org.id, A.id, A.id))).toBe("org.last_owner");
    expect(await roleOf(A.id)).toBe("owner");
  });

  it("remove：同一事务置空该账号在此组织的 current_org_id，审计 org.member.removed", async () => {
    await members.add(org.id, B.id, "member", A.id);
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        account_id: B.id,
        current_org_id: org.id,
        refresh_hash: "h",
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .execute();
    await members.remove(org.id, B.id, A.id);
    expect(await roleOf(B.id)).toBeUndefined();
    const s = await db.selectFrom("sessions").select("current_org_id").executeTakeFirstOrThrow();
    expect(s.current_org_id).toBeNull();
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.member.removed")
      .executeTakeFirstOrThrow();
    expect(ev.detail).toEqual({ role: "member" });
  });

  it("leave：非 owner 可离开；审计 org.member.left", async () => {
    await members.add(org.id, B.id, "member", A.id);
    await members.leave(org.id, B.id);
    expect(await roleOf(B.id)).toBeUndefined();
    expect(await codeOf(members.leave(org.id, B.id))).toBe("member.not_found");
  });

  it("转让后原 owner 为 admin、新 owner 为 owner；to 不是成员 → member.not_found", async () => {
    expect(await codeOf(members.transferOwnership(org.id, A.id, C.id))).toBe("member.not_found");
    await members.add(org.id, B.id, "member", A.id);
    expect(await codeOf(members.transferOwnership(org.id, B.id, A.id))).toBe("org.owner_required");
    await members.transferOwnership(org.id, A.id, B.id);
    expect(await roleOf(A.id)).toBe("admin");
    expect(await roleOf(B.id)).toBe("owner");
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.ownership_transferred")
      .executeTakeFirstOrThrow();
    expect(ev.detail).toMatchObject({ from: A.id, to: B.id });
  });

  it("软删除的组织 → org.not_found", async () => {
    await orgs.softDelete(org.id, A);
    expect(await codeOf(members.add(org.id, B.id, "member", A.id))).toBe("org.not_found");
  });

  it("陈旧发起人：被降级的 ex-owner 授予 owner → org.owner_required", async () => {
    await members.add(org.id, B.id, "owner", A.id);
    await members.add(org.id, C.id, "member", A.id);
    await members.changeRole(org.id, B.id, "admin", A.id);
    expect(await codeOf(members.changeRole(org.id, C.id, "owner", B.id))).toBe(
      "org.owner_required",
    );
    expect(await codeOf(members.remove(org.id, A.id, B.id))).toBe("org.owner_required");
    expect(await roleOf(C.id)).toBe("member");
    expect(await roleOf(A.id)).toBe("owner");
  });

  it("陈旧发起人：被移出的 admin 改成员角色或移人 → forbidden", async () => {
    const D = await accounts.createLocal({ login: "userd", password: PW, displayName: "D" });
    await members.add(org.id, C.id, "admin", A.id);
    await members.add(org.id, D.id, "member", A.id);
    await members.remove(org.id, C.id, A.id);
    expect(await codeOf(members.changeRole(org.id, D.id, "admin", C.id))).toBe("forbidden");
    expect(await codeOf(members.remove(org.id, D.id, C.id))).toBe("forbidden");
    expect(await roleOf(D.id)).toBe("member");
  });

  it("陈旧发起人：被降为 member 的 ex-admin → forbidden", async () => {
    await members.add(org.id, C.id, "admin", A.id);
    await members.add(org.id, B.id, "guest", A.id);
    await members.changeRole(org.id, C.id, "member", A.id);
    expect(await codeOf(members.changeRole(org.id, B.id, "member", C.id))).toBe("forbidden");
  });

  it("陈旧发起人：被降级的 ex-owner softDelete / 被移出的 admin update → 拒绝且组织不变", async () => {
    await members.add(org.id, B.id, "owner", A.id);
    await members.changeRole(org.id, B.id, "admin", A.id);
    expect(await codeOf(orgs.softDelete(org.id, B))).toBe("forbidden");
    expect(await orgs.get(org.id)).toBeDefined();
    await members.remove(org.id, B.id, A.id);
    expect(await codeOf(orgs.update(org.id, { name: "Hacked" }, B))).toBe("forbidden");
    expect((await orgs.get(org.id))?.name).toBe("Acme");
  });

  it("concurrent demote keeps an owner", async () => {
    for (let i = 0; i < 5; i++) {
      await members.add(org.id, B.id, "owner", A.id);
      const results = await Promise.allSettled([
        members.changeRole(org.id, B.id, "admin", A.id),
        members2.changeRole(org.id, A.id, "admin", B.id),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(LOSER_CODES).toContain(((failed[0] as PromiseRejectedResult).reason as ApiError).code);
      expect(await ownerCount()).toBe(1);
      // 复原：剩下的 owner 留下，另一个移出，下一轮重来
      const survivor = (await roleOf(A.id)) === "owner" ? A : B;
      const other = survivor === A ? B : A;
      await members.remove(org.id, other.id, survivor.id);
      if (survivor !== A) {
        await members.add(org.id, A.id, "member", B.id);
        await members.transferOwnership(org.id, B.id, A.id);
        await members.remove(org.id, B.id, A.id);
      }
    }
  });

  it("concurrent remove keeps an owner", async () => {
    for (let i = 0; i < 5; i++) {
      await members.add(org.id, B.id, "owner", A.id);
      const results = await Promise.allSettled([
        members.remove(org.id, B.id, A.id),
        members2.remove(org.id, A.id, B.id),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(LOSER_CODES).toContain(((failed[0] as PromiseRejectedResult).reason as ApiError).code);
      expect(await ownerCount()).toBe(1);
      if ((await roleOf(A.id)) !== "owner") {
        await members.add(org.id, A.id, "member", B.id);
        await members.transferOwnership(org.id, B.id, A.id);
        await members.remove(org.id, B.id, A.id);
      }
    }
  });
});
