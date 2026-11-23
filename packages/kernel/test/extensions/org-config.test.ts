import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import type { ExtensionHost } from "../../src/extensions/host.js";
import type { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import type { Org, OrgsService } from "../../src/orgs/orgs.service.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";
import { truncateTables } from "../helpers/db.js";
import { orgConfigsFor, testHost } from "../helpers/extensions.js";
import { accountsFor, handlesFor, orgsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let host: ExtensionHost;
let svc: OrgExtensionConfigs;
let deps: KernelDeps;
let accounts: AccountsService;
let orgs: OrgsService;
let members: MembersService;
let A: Account;
let B: Account;
let org: Org;
let org2: Org;

const PW = "correct horse battery";
const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const silent = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  const keyring = createKeyring(Buffer.alloc(32, 3), []);
  deps = {
    db: raw,
    dbUrl: pg.url,
    redis,
    locks: new LockService(redis, createLogger("error")),
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring,
    embedTokens: new EmbedTokens(keyring),
    hooks: undefined,
    shares: undefined,
    runWorkers: false,
    log: silent,
  };
  host = testHost(deps, {}, { registry: new ExtensionRegistry(), autoApprove: true });
  await host.load([fx("fixture"), fx("orgcfg"), fx("dep-provider")]);
  svc = orgConfigsFor(raw, host);
  accounts = accountsFor(db);
  orgs = orgsFor(db);
  members = testMembers(db);
});
afterAll(async () => {
  await host?.close();
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pg?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  A = await accounts.createLocal({ login: "usera", password: PW, displayName: "A" });
  B = await accounts.createLocal({ login: "userb", password: PW, displayName: "B" });
  org = await orgs.create({ name: "Acme", slug: "acme" }, A);
  org2 = await orgs.create({ name: "Beta", slug: "beta" }, B);
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
};

/**
 * Org enablement only: an org's config of an extension is its copy of the overridable deployment
 * fields (org-overrides tests); the retired `config` column and `plugin-config:` secrets are
 * neither read nor written.
 */
describe("OrgExtensionConfigs", () => {
  it("each org has its own switch; the view says whether the extension has overridable fields", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true }, A.id);
    expect(await svc.get(org.id, "orgcfg")).toEqual({ enabled: true });
    expect(await svc.get(org2.id, "orgcfg")).toBeUndefined();
    const list = await svc.list(org2.id);
    expect(list.find((v) => v.plugin === "orgcfg")).toMatchObject({
      enabled: false,
      configurable: true,
      overrideState: "following",
    });
    // no deployment schema: nothing an org can override
    expect(list.find((v) => v.plugin === "dep-provider")).toMatchObject({
      configurable: false,
      overrideState: "none",
    });
    for (const v of list) {
      for (const f of ["config", "secrets", "orgConfigSchema"]) expect(v).not.toHaveProperty(f);
    }
  });

  it("an unloaded extension -> extension.not_found; enabling never checks a config", async () => {
    expect((await codeOf(svc.put(org.id, "nope", { enabled: true }, A.id))).code).toBe(
      "extension.not_found",
    );
    const v = await svc.put(org.id, "dep-provider", { enabled: true }, A.id);
    expect(v).toMatchObject({ plugin: "dep-provider", enabled: true, configurable: false });
    // orgcfg's required overridable fields are empty on the platform: it is enabled all the same
    expect(await svc.put(org.id, "orgcfg", { enabled: true }, A.id)).toMatchObject({
      enabled: true,
      configurable: true,
    });
    await svc.put(org.id, "orgcfg", { enabled: false }, A.id);
    expect(await svc.get(org.id, "orgcfg")).toEqual({ enabled: false });
  });

  it("get inside a caller's transaction reads in it: its own writes seen", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true }, A.id);
    const { db: kdb, txHost } = handlesFor(raw);
    const seen = await txHost.run(async () => {
      // uncommitted in this transaction: only a read on the same connection sees it
      await kdb.db
        .updateTable("extension_org_configs")
        .set({ enabled: false })
        .where("org_id", "=", org.id)
        .where("plugin", "=", "orgcfg")
        .execute();
      return svc.get(org.id, "orgcfg");
    });
    expect(seen).toEqual({ enabled: false });
    expect(await svc.get(org.id, "orgcfg")).toEqual({ enabled: false });
  });

  it("a write leaves the retired config column and writes no plugin-config secret", async () => {
    await svc.put(org.id, "orgcfg", { enabled: false }, A.id);
    await svc.put(org.id, "orgcfg", { enabled: true }, A.id);
    const row = await db
      .selectFrom("extension_org_configs")
      .select(["enabled", "config"])
      .where("org_id", "=", org.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ enabled: true, config: null });
    const secrets = await db
      .selectFrom("secrets")
      .select("key")
      .where("org_id", "=", org.id)
      .where("key", "like", "plugin-config:%")
      .execute();
    expect(secrets).toEqual([]);
  });

  it("a failing audit write rolls the switch back", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true }, A.id);
    await sql`CREATE OR REPLACE FUNCTION capybara.test_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`.execute(
      raw,
    );
    await sql`CREATE TRIGGER test_fail_audit BEFORE INSERT ON capybara.audit_events FOR EACH ROW EXECUTE FUNCTION capybara.test_fail_audit()`.execute(
      raw,
    );
    try {
      await expect(svc.put(org.id, "orgcfg", { enabled: false }, A.id)).rejects.toThrow(
        /audit down/,
      );
    } finally {
      await sql`DROP TRIGGER test_fail_audit ON capybara.audit_events`.execute(raw);
      await sql`DROP FUNCTION capybara.test_fail_audit()`.execute(raw);
    }
    expect(await svc.get(org.id, "orgcfg")).toEqual({ enabled: true });
  });

  it("the actor's role is re-read in the transaction: member or non-member -> forbidden; no org -> org.not_found", async () => {
    const m = await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
    await members.add(org.id, m.id, "member", A.id);
    expect((await codeOf(svc.put(org.id, "orgcfg", { enabled: true }, m.id))).code).toBe(
      "forbidden",
    );
    expect((await codeOf(svc.put(org.id, "orgcfg", { enabled: true }, B.id))).code).toBe(
      "forbidden",
    );
    expect(
      (await codeOf(svc.put("00000000-0000-0000-0000-000000000000", "orgcfg", {}, A.id))).code,
    ).toBe("org.not_found");
  });

  it("audits org.plugin_config.updated with enabled only", async () => {
    await svc.put(org.id, "orgcfg", { enabled: true }, A.id);
    const rows = await db
      .selectFrom("audit_events")
      .select(["action", "target", "actor_account_id", "detail"])
      .where("action", "=", "org.plugin_config.updated")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "orgcfg", actor_account_id: A.id });
    expect(rows[0]?.detail).toEqual({ enabled: true });
  });
});
