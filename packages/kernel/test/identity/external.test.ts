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
import { ExternalIdentities, IdentityNotVerified } from "../../src/identity/external.js";
import { truncateTables } from "../helpers/db.js";

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
  await truncateTables(raw, "capybara.accounts, capybara.audit_events");
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

const MERGE = { allowMerge: true, linkedVia: "sso" } as const;
const SSO = { linkedVia: "sso" } as const;

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
    const first = await svc.resolve(ident(), undefined, SSO);
    expect(first.created).toBe(true);
    const second = await svc.resolve(ident({ displayName: "Alice L." }), undefined, SSO);
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
      svc.resolve(ident(), undefined, SSO),
      svc.resolve(ident(), undefined, SSO),
      svc.resolve(ident(), undefined, SSO),
    ]);
    expect(new Set(rs.map((r) => r.accountId)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });

  it("身份源受信任 + 两侧邮箱都已验证 → 合并到同邮箱账号并审计 identity.linked", async () => {
    const a = await local("alice", "Alice@Example.com", true);
    trusted = ["lark:t1"];
    const r = await svc.resolve(ident(), undefined, MERGE);
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
    trusted = ["slack:t1"];
    const r = await svc.resolve(ident(), undefined, MERGE);
    expect(r.created).toBe(true);
    expect(r.accountId).not.toBe(a.id);
  });

  it("受信任但身份邮箱未验证 / 本地账号邮箱未验证 → 新建", async () => {
    trusted = ["lark:t1"];
    const a = await local("alice", "alice@example.com", true);
    const r1 = await svc.resolve(ident({ emailVerified: false }), undefined, MERGE);
    expect(r1.created).toBe(true);
    expect(r1.accountId).not.toBe(a.id);
    const b = await local("bob", "bob@example.com", false);
    const r2 = await svc.resolve(
      ident({ externalId: "ou_2", email: "bob@example.com" }),
      undefined,
      MERGE,
    );
    expect(r2.created).toBe(true);
    expect(r2.accountId).not.toBe(b.id);
  });

  it("source 不合规（无租户、local）→ 拒绝", async () => {
    expect(await codeOf(svc.resolve(ident({ source: "lark" }), undefined, SSO))).toBe(
      "validation_failed",
    );
    expect(await codeOf(svc.resolve(ident({ source: "local:x" }), undefined, SSO))).toBe(
      "validation_failed",
    );
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

describe("修复轮 1：合并只在登录路径、不受信任来源不标记邮箱已验证、resolve / link 竞态", () => {
  it("不受信任来源声称已验证的邮箱：新账号不算邮箱已验证；之后受信任来源同邮箱登录 → 另建账号", async () => {
    trusted = ["lark:t1"];
    const evil = await svc.resolve(
      ident({
        source: "slack:t9",
        tenantId: "t9",
        externalId: "U_evil",
        email: "victim@corp.example",
      }),
      undefined,
      MERGE,
    );
    expect(evil.created).toBe(true);
    const row = await db
      .selectFrom("accounts")
      .select("email_verified")
      .where("id", "=", evil.accountId)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(false);
    const victim = await svc.resolve(
      ident({ externalId: "ou_victim", email: "victim@corp.example" }),
      undefined,
      MERGE,
    );
    expect(victim.created).toBe(true);
    expect(victim.accountId).not.toBe(evil.accountId);
  });

  it("受信任来源新建的账号邮箱算已验证", async () => {
    trusted = ["lark:t1"];
    const r = await svc.resolve(ident(), undefined, MERGE);
    const row = await db
      .selectFrom("accounts")
      .select("email_verified")
      .where("id", "=", r.accountId)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(true);
  });

  it("不传 allowMerge（如渠道入站）→ 即使受信任且两侧已验证也不合并", async () => {
    const a = await local("alice", "alice@example.com", true);
    trusted = ["lark:t1"];
    const r = await svc.resolve(ident(), undefined, SSO);
    expect(r.created).toBe(true);
    expect(r.accountId).not.toBe(a.id);
  });

  it("resolve 与 link 并发：不抛 500，结果一致", async () => {
    for (let i = 0; i < 20; i++) {
      const b = await local(`bob${i}`, `bob${i}@example.com`, false);
      const id = ident({ externalId: `race-${i}` });
      const [r, l] = await Promise.allSettled([
        svc.resolve(id, undefined, SSO),
        svc.link(b.id, id),
      ]);
      expect(r.status).toBe("fulfilled");
      const owner = await svc.findAccount("lark:t1", `race-${i}`);
      if (l.status === "fulfilled") {
        expect(owner).toBe(b.id);
        expect(r.status === "fulfilled" && r.value.accountId).toBe(b.id);
      } else {
        expect((l.reason as ApiError).code).toBe("identity.taken");
        expect(r.status === "fulfilled" && r.value.accountId).toBe(owner);
      }
    }
  });
});

const linkedVia = async (source: string, externalId: string) =>
  (
    await db
      .selectFrom("identities")
      .select("linked_via")
      .where("source", "=", source)
      .where("external_id", "=", externalId)
      .executeTakeFirst()
  )?.linked_via;

describe("修复波 W1：身份来源（linked_via）与租户级信任", () => {
  it("每条写入路径都记下 linked_via：bind / sso / directory / local", async () => {
    const a = await local("alice", "a@example.com", false);
    expect(await linkedVia("local", "alice")).toBe("local");
    await svc.link(a.id, ident({ externalId: "ou_bind" }));
    expect(await linkedVia("lark:t1", "ou_bind")).toBe("bind");
    await svc.resolve(ident({ externalId: "ou_sso" }), undefined, SSO);
    expect(await linkedVia("lark:t1", "ou_sso")).toBe("sso");
    await svc.resolve(ident({ externalId: "ou_dir" }), undefined, { linkedVia: "directory" });
    expect(await linkedVia("lark:t1", "ou_dir")).toBe("directory");
    // 已有的身份行再经别的路径解析：不改 linked_via
    await svc.resolve(ident({ externalId: "ou_bind" }), undefined, { linkedVia: "directory" });
    expect(await linkedVia("lark:t1", "ou_bind")).toBe("bind");
  });

  it("登录路径：bind 绑定的身份 → IdentityNotVerified；同一账号已登录时升级为 sso 并通过", async () => {
    const a = await local("alice", "a@example.com", false);
    const b = await local("bob", "b@example.com", false);
    await svc.link(a.id, ident());
    const login = (sessionAccountId?: string) =>
      svc.resolve(ident(), undefined, {
        ...MERGE,
        login: sessionAccountId === undefined ? {} : { sessionAccountId },
      });
    await expect(login()).rejects.toBeInstanceOf(IdentityNotVerified);
    // 已登录的是别的账号：同样拒绝，不改行
    await expect(login(b.id)).rejects.toBeInstanceOf(IdentityNotVerified);
    expect(await linkedVia("lark:t1", "ou_1")).toBe("bind");
    expect(await login(a.id)).toEqual({ accountId: a.id, created: false });
    expect(await linkedVia("lark:t1", "ou_1")).toBe("sso");
    const verified = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "identity.verified")
      .execute();
    expect(verified).toEqual([
      { target: a.id, detail: expect.objectContaining({ source: "lark:t1", externalId: "ou_1" }) },
    ]);
    // 升级之后未登录也能登录
    expect(await login()).toEqual({ accountId: a.id, created: false });
  });

  it("登录路径：通讯录建的身份只有在该租户受信任时才能直接登录", async () => {
    const r = await svc.resolve(ident(), undefined, { linkedVia: "directory" });
    const login = () => svc.resolve(ident(), undefined, { ...MERGE, login: {} });
    await expect(login()).rejects.toBeInstanceOf(IdentityNotVerified);
    trusted = ["lark:t2"];
    await expect(login()).rejects.toBeInstanceOf(IdentityNotVerified);
    trusted = ["lark:t1"];
    expect(await login()).toEqual({ accountId: r.accountId, created: false });
    // 通讯录身份直接登录不改其来源
    expect(await linkedVia("lark:t1", "ou_1")).toBe("directory");
  });

  it("旧行（linked_via 为 null）按 sso 处理", async () => {
    const r = await svc.resolve(ident(), undefined, SSO);
    await sql`UPDATE capybara.identities SET linked_via = NULL WHERE external_id = 'ou_1'`.execute(
      raw,
    );
    expect(await svc.resolve(ident(), undefined, { ...MERGE, login: {} })).toEqual({
      accountId: r.accountId,
      created: false,
    });
  });

  it("信任按租户：受信任的 lark:t1 不让 lark:t2 的身份算已验证或可合并", async () => {
    const a = await local("alice", "alice@example.com", true);
    trusted = ["lark:t1"];
    const other = await svc.resolve(
      ident({ source: "lark:t2", tenantId: "t2", externalId: "ou_t2" }),
      undefined,
      MERGE,
    );
    expect(other.created).toBe(true);
    expect(other.accountId).not.toBe(a.id);
    const row = await db
      .selectFrom("accounts")
      .select("email_verified")
      .where("id", "=", other.accountId)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(false);
    // 同一租户照常合并
    expect(await svc.resolve(ident(), undefined, MERGE)).toEqual({
      accountId: a.id,
      created: false,
    });
  });

  it("身份源键必须与租户一致（source = <插件>:<tenantId>）", async () => {
    expect(
      await codeOf(svc.resolve(ident({ source: "lark:t2", tenantId: "t1" }), undefined, SSO)),
    ).toBe("validation_failed");
  });
});
