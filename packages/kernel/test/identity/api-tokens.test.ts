import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let svc: ApiTokenService;

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  svc = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await raw.destroy();
  await pg.stop();
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs CASCADE`.execute(raw);
});

async function account(): Promise<string> {
  const id = randomUUID();
  await db.insertInto("accounts").values({ id, display_name: "A", email: null }).execute();
  return id;
}

async function org(createdBy: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("orgs")
    .values({ id, slug: `o-${id.slice(0, 8)}`, name: "O", created_by: createdBy })
    .execute();
  return id;
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code ?? String(e);
  }
  return undefined;
};

describe("ApiTokenService personal", () => {
  it("cap_pat_ 前缀；库里只存 hash；authenticate 成功；revoke 后 null", async () => {
    const acc = await account();
    const { token, record } = await svc.createPersonal(acc, { name: "cli" });
    expect(token).toMatch(/^cap_pat_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ kind: "personal", accountId: acc, orgId: null, role: null });
    const row = await db
      .selectFrom("api_tokens")
      .selectAll()
      .where("id", "=", record.id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).not.toContain(token.slice("cap_pat_".length));
    expect(row.created_by).toBe(acc);
    expect((await svc.authenticate(token))?.id).toBe(record.id);
    expect((await svc.list({ accountId: acc })).map((r) => r.id)).toEqual([record.id]);
    await svc.revoke(record.id, { accountId: acc });
    expect(await svc.authenticate(token)).toBeNull();
    expect(await svc.list({ accountId: acc })).toEqual([]);
  });

  it("过期后 null；expiresAt 不在未来 / name 越界 → validation_failed", async () => {
    const acc = await account();
    const { token, record } = await svc.createPersonal(acc, {
      name: "t",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await svc.authenticate(token))?.id).toBe(record.id);
    await db
      .updateTable("api_tokens")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", record.id)
      .execute();
    expect(await svc.authenticate(token)).toBeNull();
    expect(
      await codeOf(svc.createPersonal(acc, { name: "t", expiresAt: new Date(Date.now() - 1) })),
    ).toBe("validation_failed");
    expect(await codeOf(svc.createPersonal(acc, { name: "" }))).toBe("validation_failed");
    expect(await codeOf(svc.createPersonal(acc, { name: "x".repeat(101) }))).toBe(
      "validation_failed",
    );
  });

  it("错误前缀或随机串 → null", async () => {
    const acc = await account();
    const { token } = await svc.createPersonal(acc, { name: "t" });
    const body = token.slice("cap_pat_".length);
    expect(await svc.authenticate(`cap_rt_${body}`)).toBeNull();
    expect(await svc.authenticate(body)).toBeNull();
    expect(await svc.authenticate("random-garbage")).toBeNull();
    expect(await svc.authenticate("")).toBeNull();
  });

  it("revoke 别人的 token → token.not_found", async () => {
    const a = await account();
    const b = await account();
    const { record } = await svc.createPersonal(a, { name: "t" });
    expect(await codeOf(svc.revoke(record.id, { accountId: b }))).toBe("token.not_found");
    expect(await codeOf(svc.revoke("missing", { accountId: a }))).toBe("token.not_found");
  });

  it("last_used_at 连续两次 authenticate 只写一次", async () => {
    const acc = await account();
    const { token, record } = await svc.createPersonal(acc, { name: "t" });
    expect(record.lastUsedAt).toBeNull();
    const first = await svc.authenticate(token);
    const lastUsed = async () =>
      (
        await db
          .selectFrom("api_tokens")
          .select("last_used_at")
          .where("id", "=", record.id)
          .executeTakeFirstOrThrow()
      ).last_used_at;
    const t1 = await lastUsed();
    expect(t1).not.toBeNull();
    expect(first?.lastUsedAt).not.toBeNull();
    await svc.authenticate(token);
    expect((await lastUsed())?.getTime()).toBe(t1?.getTime());
  });

  it("revokeAllPersonal 吊销该账号全部个人令牌", async () => {
    const acc = await account();
    const t1 = await svc.createPersonal(acc, { name: "a" });
    const t2 = await svc.createPersonal(acc, { name: "b" });
    await svc.revokeAllPersonal(acc);
    expect(await svc.authenticate(t1.token)).toBeNull();
    expect(await svc.authenticate(t2.token)).toBeNull();
  });
});

describe("ApiTokenService service", () => {
  it("cap_svc_ 前缀；按 org scope 列出与吊销；revokeAllForOrg（含事务内）", async () => {
    const acc = await account();
    const o = await org(acc);
    const o2 = await org(acc);
    const { token, record } = await svc.createService(o, {
      name: "bot",
      role: "member",
      createdBy: acc,
    });
    expect(token).toMatch(/^cap_svc_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ kind: "service", accountId: null, orgId: o, role: "member" });
    expect((await svc.authenticate(token))?.orgId).toBe(o);
    expect((await svc.list({ orgId: o })).map((r) => r.id)).toEqual([record.id]);
    expect(await svc.list({ orgId: o2 })).toEqual([]);
    expect(await codeOf(svc.revoke(record.id, { orgId: o2 }))).toBe("token.not_found");
    expect(await codeOf(svc.revoke(record.id, { accountId: acc }))).toBe("token.not_found");

    const other = await svc.createService(o, { name: "bot2", role: "guest", createdBy: acc });
    await db.transaction().execute((trx) => svc.revokeAllForOrg(o, trx));
    expect(await svc.authenticate(token)).toBeNull();
    expect(await svc.authenticate(other.token)).toBeNull();
  });

  it("revokeServiceAs：组织行锁内实时复核发起人角色；组织已删除 → org.not_found", async () => {
    const owner = await account();
    const admin = await account();
    const o = await org(owner);
    await db
      .insertInto("memberships")
      .values([
        { org_id: o, account_id: owner, role: "owner" },
        { org_id: o, account_id: admin, role: "admin" },
      ])
      .execute();
    const a = await svc.createServiceAs(o, admin, { name: "a", role: "member" });
    const b = await svc.createServiceAs(o, admin, { name: "b", role: "member" });
    await svc.revokeServiceAs(o, a.record.id, admin);
    expect(await svc.authenticate(a.token)).toBeNull();
    // admin 被降为 member 后，已过 guard 的吊销请求在锁内被拒
    await db
      .updateTable("memberships")
      .set({ role: "member" })
      .where("account_id", "=", admin)
      .execute();
    expect(await codeOf(svc.revokeServiceAs(o, b.record.id, admin))).toBe("forbidden");
    expect(await codeOf(svc.revokeServiceAs(o, b.record.id, await account()))).toBe("forbidden");
    expect(await svc.authenticate(b.token)).not.toBeNull();
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", o).execute();
    expect(await codeOf(svc.revokeServiceAs(o, b.record.id, owner))).toBe("org.not_found");
  });
});
