import { fileURLToPath } from "node:url";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { seedLoginSources, startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import type { AccountsService } from "../../src/identity/accounts.js";
import type { ExternalIdentities } from "../../src/identity/external.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, externalFor } from "../helpers/identity.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let accounts: AccountsService;
let svc: ExternalIdentities;

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(box.url, 10);
  db = kernelDb(raw);
  accounts = accountsFor(db);
  svc = externalFor(db);
});
afterAll(async () => {
  await raw.destroy();
  await box.stop();
});
beforeEach(async () => {
  // also empties the login sources (deployment_settings references accounts): nothing trusted
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

/** Trusts one tenant of a source (the login sources setting, switched off on the login page). */
const trust = (plugin: string, tenant: string) =>
  seedLoginSources(db, [{ plugin, enabled: false, trustedTenants: [tenant] }]);

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

/**
 * A sign-in with self sign-up on (`decideSignIn`, signUp create): the trusted-email merge applies
 * (Ruling A9), otherwise an account is created.
 */
async function signIn(i: ExternalIdentity): Promise<{ accountId: string; created: boolean }> {
  const r = await svc.decideSignIn(i, { intent: "signin", signUp: "create" });
  if (!("accountId" in r.decision)) throw new Error(`unexpected decision ${r.decision.kind}`);
  return { accountId: r.decision.accountId, created: r.created };
}

/** The hash of PW, computed once: these tests never check passwords, scrypt is not under test. */
let pwHash: Promise<string> | undefined;

/** A local account, its email verified or not. */
async function local(login: string, email: string, verified: boolean) {
  pwHash ??= accounts.hashNewPassword(PW);
  const a = await accounts.createLocal(
    { login, password: PW, displayName: login, email },
    await pwHash,
  );
  await sql`UPDATE capybara.accounts SET email_verified = ${verified} WHERE id = ${a.id}`.execute(
    raw,
  );
  return a;
}

describe("ExternalIdentities.resolve", () => {
  it("同一外部身份第二次得到同一账号（第一次新建）", async () => {
    const first = await svc.resolve(ident(), SSO);
    expect(first.created).toBe(true);
    const second = await svc.resolve(ident({ displayName: "Alice L." }), SSO);
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
      svc.resolve(ident(), SSO),
      svc.resolve(ident(), SSO),
      svc.resolve(ident(), SSO),
    ]);
    expect(new Set(rs.map((r) => r.accountId)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });

  it("sign-in: a trusted source + both emails verified → merged into the account with that email, audited identity.linked", async () => {
    const a = await local("alice", "Alice@Example.com", true);
    await trust("lark", "t1");
    const r = await signIn(ident());
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

  it("sign-in: an untrusted source → a new account (even with both emails verified)", async () => {
    const a = await local("alice", "alice@example.com", true);
    await trust("slack", "t1");
    const r = await signIn(ident());
    expect(r.created).toBe(true);
    expect(r.accountId).not.toBe(a.id);
  });

  it("sign-in: trusted but the identity's or the account's email unverified → a new account", async () => {
    await trust("lark", "t1");
    const a = await local("alice", "alice@example.com", true);
    const r1 = await signIn(ident({ emailVerified: false }));
    expect(r1.created).toBe(true);
    expect(r1.accountId).not.toBe(a.id);
    const b = await local("bob", "bob@example.com", false);
    const r2 = await signIn(ident({ externalId: "ou_2", email: "bob@example.com" }));
    expect(r2.created).toBe(true);
    expect(r2.accountId).not.toBe(b.id);
  });

  it("source 不合规（无租户、local）→ 拒绝", async () => {
    expect(await codeOf(svc.resolve(ident({ source: "lark" }), SSO))).toBe("validation_failed");
    expect(await codeOf(svc.resolve(ident({ source: "local:x" }), SSO))).toBe("validation_failed");
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
  it("an untrusted source's verified-claimed email: the new account is not email-verified; a later trusted sign-in with that email creates another account", async () => {
    await trust("lark", "t1");
    const evil = await signIn(
      ident({
        source: "slack:t9",
        tenantId: "t9",
        externalId: "U_evil",
        email: "victim@corp.example",
      }),
    );
    expect(evil.created).toBe(true);
    const row = await db
      .selectFrom("accounts")
      .select("email_verified")
      .where("id", "=", evil.accountId)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(false);
    const victim = await signIn(ident({ externalId: "ou_victim", email: "victim@corp.example" }));
    expect(victim.created).toBe(true);
    expect(victim.accountId).not.toBe(evil.accountId);
  });

  it("an account created through a trusted source counts as email-verified", async () => {
    await trust("lark", "t1");
    const r = await signIn(ident());
    const row = await db
      .selectFrom("accounts")
      .select("email_verified")
      .where("id", "=", r.accountId)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(true);
  });

  it("resolve (directory sync) never merges, even trusted with both emails verified", async () => {
    const a = await local("alice", "alice@example.com", true);
    await trust("lark", "t1");
    const r = await svc.resolve(ident(), SSO);
    expect(r.created).toBe(true);
    expect(r.accountId).not.toBe(a.id);
  });

  it("resolve 与 link 并发：不抛 500，结果一致", async () => {
    for (let i = 0; i < 20; i++) {
      const b = await local(`bob${i}`, `bob${i}@example.com`, false);
      const id = ident({ externalId: `race-${i}` });
      const [r, l] = await Promise.allSettled([svc.resolve(id, SSO), svc.link(b.id, id)]);
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
    await svc.resolve(ident({ externalId: "ou_sso" }), SSO);
    expect(await linkedVia("lark:t1", "ou_sso")).toBe("sso");
    await svc.resolve(ident({ externalId: "ou_dir" }), { linkedVia: "directory" });
    expect(await linkedVia("lark:t1", "ou_dir")).toBe("directory");
    // an existing row resolved through another path keeps its linked_via
    await svc.resolve(ident({ externalId: "ou_bind" }), { linkedVia: "directory" });
    expect(await linkedVia("lark:t1", "ou_bind")).toBe("bind");
  });

  it("sign-in: a bind row goes to the link page; a link intent of the same account upgrades it", async () => {
    const a = await local("alice", "a@example.com", false);
    const b = await local("bob", "b@example.com", false);
    await svc.link(a.id, ident());
    const signIn = () => svc.decideSignIn(ident(), { intent: "signin", signUp: "create" });
    expect((await signIn()).decision).toEqual({ kind: "link_page", existingAccountId: a.id });
    // a link intent of another account: refused, the row unchanged
    expect(
      (await svc.decideSignIn(ident(), { intent: "link", sessionAccountId: b.id, signUp: "link" }))
        .decision,
    ).toEqual({ kind: "error", code: "identity.taken" });
    expect(await linkedVia("lark:t1", "ou_1")).toBe("bind");
    expect(
      (await svc.decideSignIn(ident(), { intent: "link", sessionAccountId: a.id, signUp: "link" }))
        .decision,
    ).toEqual({ kind: "upgrade", accountId: a.id });
    expect(await linkedVia("lark:t1", "ou_1")).toBe("sso");
    const verified = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "identity.verified")
      .execute();
    expect(verified).toEqual([
      { target: a.id, detail: expect.objectContaining({ source: "lark:t1", externalId: "ou_1" }) },
    ]);
    // once upgraded, a sign-in goes straight in
    expect((await signIn()).decision).toEqual({ kind: "signin", accountId: a.id });
  });

  it("Ruling A23: a directory row signs in whether or not its tenant is trusted", async () => {
    const r = await svc.resolve(ident(), { linkedVia: "directory" });
    const signIn = async () =>
      (await svc.decideSignIn(ident(), { intent: "signin", signUp: "link" })).decision;
    await seedLoginSources(db, []);
    expect(await signIn()).toEqual({ kind: "signin", accountId: r.accountId });
    await trust("lark", "t1");
    expect(await signIn()).toEqual({ kind: "signin", accountId: r.accountId });
    // signing in through a directory row keeps its kind and writes no identity.verified
    expect(await linkedVia("lark:t1", "ou_1")).toBe("directory");
    expect(
      await db
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "identity.verified")
        .execute(),
    ).toEqual([]);
  });

  it("a legacy row (linked_via null) signs in as sso", async () => {
    const r = await svc.resolve(ident(), SSO);
    await sql`UPDATE capybara.identities SET linked_via = NULL WHERE external_id = 'ou_1'`.execute(
      raw,
    );
    expect(
      (await svc.decideSignIn(ident(), { intent: "signin", signUp: "link" })).decision,
    ).toEqual({ kind: "signin", accountId: r.accountId });
  });

  it("sign-in of an unlinked identity: signUp link creates nothing, signUp create creates", async () => {
    const off = await svc.decideSignIn(ident(), { intent: "signin", signUp: "link" });
    expect(off.decision).toEqual({ kind: "link_page" });
    expect(await db.selectFrom("accounts").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("identities").select("source").execute()).toEqual([]);
    const on = await svc.decideSignIn(ident(), { intent: "signin", signUp: "create" });
    expect(on.decision.kind).toBe("signin");
    expect(await linkedVia("lark:t1", "ou_1")).toBe("sso");
  });

  it("trust is per tenant: a trusted lark:t1 makes no lark:t2 identity verified or mergeable", async () => {
    const a = await local("alice", "alice@example.com", true);
    await trust("lark", "t1");
    const other = await signIn(ident({ source: "lark:t2", tenantId: "t2", externalId: "ou_t2" }));
    expect(other.created).toBe(true);
    expect(other.accountId).not.toBe(a.id);
    const row = await db
      .selectFrom("accounts")
      .select("email_verified")
      .where("id", "=", other.accountId)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(false);
    // the same tenant merges as usual
    expect(await signIn(ident())).toEqual({
      accountId: a.id,
      created: false,
    });
  });

  it("身份源键必须与租户一致（source = <插件>:<tenantId>）", async () => {
    expect(await codeOf(svc.resolve(ident({ source: "lark:t2", tenantId: "t1" }), SSO))).toBe(
      "validation_failed",
    );
  });
});
