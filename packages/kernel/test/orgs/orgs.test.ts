import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { SettingsService } from "../../src/identity/settings.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { truncateTables } from "../helpers/db.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let accounts: AccountsService;
let settings: SettingsService;
let tokens: ApiTokenService;
let orgs: OrgsService;
let alice: Account;
let bob: Account;
let admin: Account;

const PW = "correct horse battery";

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  accounts = new AccountsService(db);
  settings = new SettingsService(db);
  tokens = new ApiTokenService(db);
  orgs = new OrgsService(db, settings, tokens);
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await pg.stop();
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.deployment_settings, capybara.audit_events",
  );
  alice = await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" });
  bob = await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" });
  admin = await accounts.createLocal({
    login: "admin",
    password: PW,
    displayName: "Admin",
    enterpriseAdmin: true,
  });
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code;
  }
  return undefined;
};

describe("OrgsService", () => {
  it("创建者成为 owner；写审计 org.created", async () => {
    const org = await orgs.create({ name: "Acme", slug: "acme" }, alice);
    expect(org).toMatchObject({ slug: "acme", name: "Acme" });
    const list = await orgs.listForAccount(alice.id);
    expect(list.map((o) => [o.id, o.role])).toEqual([[org.id, "owner"]]);
    expect(await orgs.listForAccount(bob.id)).toEqual([]);
    const ev = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "org.created")
      .execute();
    expect(ev.map((e) => [e.org_id, e.actor_account_id])).toEqual([[org.id, alice.id]]);
  });

  it("orgCreation = enterprise_admin：普通账号 → org.creation_disabled；企业管理员可建", async () => {
    await settings.update({ orgCreation: "enterprise_admin" }, admin.id);
    expect(await codeOf(orgs.create({ name: "Acme" }, alice))).toBe("org.creation_disabled");
    const org = await orgs.create({ name: "Acme" }, admin);
    expect(org.slug).toBe("acme");
  });

  it("同 slug → org.slug_taken；软删除后同 slug 可再用", async () => {
    const a = await orgs.create({ name: "Acme", slug: "acme" }, alice);
    expect(await codeOf(orgs.create({ name: "Other", slug: "acme" }, bob))).toBe("org.slug_taken");
    await orgs.softDelete(a.id, alice);
    const b = await orgs.create({ name: "Other", slug: "acme" }, bob);
    expect(b.id).not.toBe(a.id);
    expect(await orgs.get(a.id)).toBeUndefined();
    expect(await orgs.listForAccount(alice.id)).toEqual([]);
  });

  it("slug 不合规 → validation_failed", async () => {
    expect(await codeOf(orgs.create({ name: "X", slug: "-bad" }, alice))).toBe("validation_failed");
    expect(await codeOf(orgs.create({ name: "X", slug: "Upper" }, alice))).toBe(
      "validation_failed",
    );
  });

  it("由名字生成 slug；中文名生成 org- 开头的 slug", async () => {
    expect((await orgs.create({ name: "  My Team!! 2 " }, alice)).slug).toBe("my-team-2");
    const zh = await orgs.create({ name: "研发团队" }, alice);
    expect(zh.slug).toMatch(/^org-[a-z0-9]{6}$/);
  });

  it("update 改名与 slug；slug 冲突 → org.slug_taken", async () => {
    const a = await orgs.create({ name: "A", slug: "a" }, alice);
    await orgs.create({ name: "B", slug: "b" }, alice);
    expect(await orgs.update(a.id, { name: "A2", slug: "a2" }, alice)).toMatchObject({
      name: "A2",
      slug: "a2",
    });
    expect(await codeOf(orgs.update(a.id, { slug: "b" }, alice))).toBe("org.slug_taken");
  });

  it("listAll 带成员数，排除软删除", async () => {
    const a = await orgs.create({ name: "A" }, alice);
    const b = await orgs.create({ name: "B" }, bob);
    await orgs.softDelete(b.id, bob);
    const all = await orgs.listAll();
    expect(all.map((o) => [o.id, o.memberCount])).toEqual([[a.id, 1]]);
  });

  it("软删除：服务令牌 authenticate 返回 null，会话的 current_org_id 置空，审计 org.deleted", async () => {
    const org = await orgs.create({ name: "Acme" }, alice);
    const { token } = await tokens.createService(org.id, {
      name: "ci",
      role: "member",
      createdBy: alice.id,
    });
    expect(await tokens.authenticate(token)).not.toBeNull();
    await db
      .insertInto("sessions")
      .values({
        id: "s1",
        account_id: alice.id,
        current_org_id: org.id,
        refresh_hash: "h",
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .execute();
    await orgs.softDelete(org.id, alice);
    expect(await tokens.authenticate(token)).toBeNull();
    const s = await db.selectFrom("sessions").select("current_org_id").executeTakeFirstOrThrow();
    expect(s.current_org_id).toBeNull();
    const ev = await db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "=", "org.deleted")
      .execute();
    expect(ev.length).toBe(1);
    expect(await codeOf(orgs.softDelete(org.id, alice))).toBe("org.not_found");
  });
});
