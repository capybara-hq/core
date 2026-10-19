import { fileURLToPath } from "node:url";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { ExternalIdentities } from "../../src/identity/external.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let accounts: AccountsService;
let trusted: string[] = [];
let svc: ExternalIdentities;

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(box.url, 10);
  db = kernelDb(raw);
  accounts = new AccountsService(db);
  svc = new ExternalIdentities(db, () => ({
    auth: { trustedIdentitySources: trusted },
  }));
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});
beforeEach(async () => {
  trusted = [];
  await sql`TRUNCATE capybara.accounts, capybara.audit_events CASCADE`.execute(raw);
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

const ident = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
  source: "lark:t1",
  externalId: "ou_1",
  tenantId: "t1",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  ...over,
});

/** 本地账号，邮箱已验证与否可选。 */
async function local(login: string, email: string, verified: boolean) {
  const a = await accounts.createLocal({ login, password: PW, displayName: login, email });
  await sql`UPDATE capybara.accounts SET email_verified = ${verified} WHERE id = ${a.id}`.execute(
    raw,
  );
  return a;
}

describe("ExternalIdentities.resolve", () => {
  it("同一外部身份第二次得到同一账号（第一次新建）", async () => {
    const first = await svc.resolve(ident());
    expect(first.created).toBe(true);
    const second = await svc.resolve(ident({ displayName: "Alice L." }));
    expect(second).toEqual({ accountId: first.accountId, created: false });
    const rows = await db
      .selectFrom("identities")
      .selectAll()
      .where("source", "=", "lark:t1")
      .execute();
    expect(rows).toHaveLength(1);
    const acc = await accounts.get(first.accountId);
    expect(acc).toMatchObject({
      displayName: "Alice",
      email: "alice@example.com",
      status: "active",
    });
    // 新建账号不建组织
    const orgs = await db
      .selectFrom("memberships")
      .selectAll()
      .where("account_id", "=", first.accountId)
      .execute();
    expect(orgs).toEqual([]);
  });

  it("并发首次登录也只建一个账号、一行身份", async () => {
    const rs = await Promise.all([
      svc.resolve(ident()),
      svc.resolve(ident()),
      svc.resolve(ident()),
    ]);
    expect(new Set(rs.map((r) => r.accountId)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });

  it("身份源受信任 + 两侧邮箱都已验证 → 合并到同邮箱账号并审计 identity.linked", async () => {
    const a = await local("alice", "Alice@Example.com", true);
    trusted = ["lark"];
    const r = await svc.resolve(ident());
    expect(r).toEqual({ accountId: a.id, created: false });
    const audits = await db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "identity.linked")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target: a.id });
    expect(audits[0]?.detail).toMatchObject({ source: "lark:t1", externalId: "ou_1" });
  });

  it("身份源未受信任 → 新建账号（即使邮箱都已验证）", async () => {
    const a = await local("alice", "alice@example.com", true);
    trusted = ["slack"];
    const r = await svc.resolve(ident());
    expect(r.created).toBe(true);
    expect(r.accountId).not.toBe(a.id);
  });

  it("受信任但身份邮箱未验证 / 本地账号邮箱未验证 → 新建", async () => {
    trusted = ["lark"];
    const a = await local("alice", "alice@example.com", true);
    const r1 = await svc.resolve(ident({ emailVerified: false }));
    expect(r1.created).toBe(true);
    expect(r1.accountId).not.toBe(a.id);
    const b = await local("bob", "bob@example.com", false);
    const r2 = await svc.resolve(ident({ externalId: "ou_2", email: "bob@example.com" }));
    expect(r2.created).toBe(true);
    expect(r2.accountId).not.toBe(b.id);
  });

  it("source 不合规（无租户、local）→ 拒绝", async () => {
    expect(await codeOf(svc.resolve(ident({ source: "lark" })))).toBe("validation_failed");
    expect(await codeOf(svc.resolve(ident({ source: "local:x" })))).toBe("validation_failed");
  });
});

describe("ExternalIdentities.link / unlink / listForAccount", () => {
  it("link 到本人可重复；已被他人占用 → 409 identity.taken", async () => {
    const a = await local("alice", "a@example.com", false);
    const b = await local("bob", "b@example.com", false);
    await svc.link(a.id, ident());
    await svc.link(a.id, ident());
    expect(await codeOf(svc.link(b.id, ident()))).toBe("identity.taken");
    expect(await svc.findAccount("lark:t1", "ou_1")).toBe(a.id);
    const list = await svc.listForAccount(a.id);
    expect(list).toEqual([
      expect.objectContaining({ source: "lark:t1", externalId: "ou_1", displayName: "Alice" }),
    ]);
    // 本地登录名不算外部身份
    expect(list.some((i) => i.source === "local")).toBe(false);
  });

  it("unlink：只能解除本人的；不存在 → identity.not_found", async () => {
    const a = await local("alice", "a@example.com", false);
    const b = await local("bob", "b@example.com", false);
    await svc.link(a.id, ident());
    expect(await codeOf(svc.unlink(b.id, "lark:t1", "ou_1"))).toBe("identity.not_found");
    await svc.unlink(a.id, "lark:t1", "ou_1");
    expect(await svc.findAccount("lark:t1", "ou_1")).toBeUndefined();
    expect(await codeOf(svc.unlink(a.id, "local", "alice"))).toBe("identity.not_found");
  });
});
