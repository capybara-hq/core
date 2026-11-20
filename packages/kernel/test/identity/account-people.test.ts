import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  accountAvatarUrl,
  avatarColumns,
  loadPeople,
  personAvatarUrl,
} from "../../src/identity/account-avatar.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import type { ExternalIdentities } from "../../src/identity/external.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor, externalFor } from "../helpers/identity.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * The person shape of an account (account profile spec §5.3): `loadPeople` and the `avatarUrl` /
 * `avatarSource` of `/me` and the admin account list, read from the own upload or the most
 * recently refreshed non-local identity with an https avatar.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let accounts: AccountsService;
let tokens: ApiTokenService;
let external: ExternalIdentities;

const PW = "correct horse battery";
const AVATAR_URL = /^\/api\/v1\/accounts\/[^/]+\/avatar\?v=[A-Za-z0-9_-]{10}$/;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  accounts = accountsFor(db);
  tokens = apiTokensFor(db);
  external = externalFor(db, () => ({ auth: { trustedIdentitySources: [] } }));
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.audit_events");
});

const ident = (externalId: string, avatarUrl?: string): ExternalIdentity => ({
  source: "lark:t1",
  externalId,
  tenantId: "t1",
  emailVerified: false,
  displayName: externalId,
  ...(avatarUrl !== undefined && { avatarUrl }),
});

const local = (login: string, superAdmin = false) =>
  accounts.createLocal({ login, password: PW, displayName: login, superAdmin });

/** The person's avatar URL as `loadPeople` builds it. */
const avatarOf = async (id: string) => (await loadPeople(db, [id])).get(id)?.avatarUrl ?? null;

/** The URL a lone https SSO avatar gives the account (which identity won). */
const ssoAvatar = (id: string, url: string) =>
  accountAvatarUrl({ id, avatar: null, ssoAvatarUrl: url });

describe("loadPeople", () => {
  it("returns name and avatarUrl for each account and omits an unknown id", async () => {
    const alice = await local("alice");
    const bob = await local("bob");
    await external.link(bob.id, ident("ou_bob", "https://idp/bob.png"));
    const people = await loadPeople(db, [alice.id, bob.id, "nobody"]);
    expect([...people.keys()].sort()).toEqual([alice.id, bob.id].sort());
    expect(people.get(alice.id)).toEqual({ id: alice.id, name: "alice", avatarUrl: null });
    expect(people.get(bob.id)?.name).toBe("bob");
    expect(people.get(bob.id)?.avatarUrl).toMatch(AVATAR_URL);
    expect(await loadPeople(db, [])).toEqual(new Map());
  });

  it("of two lark identities, the one refreshed later wins", async () => {
    const a = await local("alice");
    await external.link(a.id, ident("ou_1", "https://idp/first.png"));
    await external.link(a.id, ident("ou_2", "https://idp/second.png"));
    expect(await avatarOf(a.id)).toBe(ssoAvatar(a.id, "https://idp/second.png"));
    // a login refresh of the first identity makes it the most recent
    await external.link(a.id, ident("ou_1", "https://idp/first.png"));
    expect(await avatarOf(a.id)).toBe(ssoAvatar(a.id, "https://idp/first.png"));
  });

  it("a newer identity without an avatar does not hide an older one with an https avatar", async () => {
    const a = await local("alice");
    await external.link(a.id, ident("ou_1", "https://idp/older.png"));
    await external.link(a.id, ident("ou_2"));
    await external.link(a.id, ident("ou_3", "http://idp/plain.png"));
    expect(await avatarOf(a.id)).toBe(ssoAvatar(a.id, "https://idp/older.png"));
  });

  it("ignores a local identity", async () => {
    const a = await local("alice");
    await sql`update capybara.identities set profile = ${JSON.stringify({
      avatarUrl: "https://idp/local.png",
    })}::jsonb, updated_at = now() where account_id = ${a.id} and source = 'local'`.execute(raw);
    expect(await avatarOf(a.id)).toBe(null);
  });
});

describe("avatarColumns", () => {
  it("keeps two people in one row apart by their prefixes", async () => {
    const alice = await local("alice");
    const bob = await local("bob");
    await external.link(bob.id, ident("ou_bob", "https://idp/bob.png"));
    await sql`update capybara.accounts set avatar = '{"kind":"upload","uploadId":"up1"}'
      where id = ${alice.id}`.execute(raw);
    const row = await db
      .selectFrom("accounts as owner")
      .innerJoin("accounts as creator", (j) => j.on("creator.id", "=", bob.id))
      .where("owner.id", "=", alice.id)
      .select((eb) => [
        "owner.id as owner_id",
        "creator.id as creator_id",
        ...avatarColumns(eb, "owner", "owner"),
        ...avatarColumns(eb, "creator", "creator"),
      ])
      .executeTakeFirstOrThrow();
    expect(row.owner_avatar).toEqual({ kind: "upload", uploadId: "up1" });
    expect(row.creator_avatar).toBe(null);
    expect(row.creator_sso_avatar_url).toBe("https://idp/bob.png");
    expect(personAvatarUrl(row, "owner", row.owner_id)).toBe(
      accountAvatarUrl({ id: alice.id, avatar: row.owner_avatar, ssoAvatarUrl: null }),
    );
    expect(personAvatarUrl(row, "creator", row.creator_id)).toBe(
      ssoAvatar(bob.id, "https://idp/bob.png"),
    );
  });
});

describe("account views carry avatarUrl and avatarSource", () => {
  const get = async (account: Account, url: string) => {
    const pat = await tokens.createPersonal(account.id, { name: "t" });
    const res = await k.http.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${pat.token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("null for a fresh local account", async () => {
    const admin = await local("admin", true);
    const me = await get(admin, "/api/v1/me");
    expect(me.account).toMatchObject({ id: admin.id, avatarUrl: null, avatarSource: null });
    const list = await get(admin, "/api/v1/admin/accounts");
    expect(list.accounts).toEqual([
      expect.objectContaining({ id: admin.id, avatarUrl: null, avatarSource: null }),
    ]);
  });

  it("the identity source when only an SSO avatar is there", async () => {
    const admin = await local("admin", true);
    await external.link(admin.id, ident("ou_admin", "https://idp/admin.png"));
    const me = await get(admin, "/api/v1/me");
    expect(me.account.avatarUrl).toMatch(AVATAR_URL);
    expect(me.account.avatarSource).toEqual({ kind: "identity", source: "lark:t1" });
    const list = await get(admin, "/api/v1/admin/accounts");
    expect(list.accounts[0]).toMatchObject({
      avatarUrl: me.account.avatarUrl,
      avatarSource: { kind: "identity", source: "lark:t1" },
    });
  });

  it("the upload when the account has its own avatar", async () => {
    const admin = await local("admin", true);
    await external.link(admin.id, ident("ou_admin", "https://idp/admin.png"));
    await sql`update capybara.accounts set avatar = '{"kind":"upload","uploadId":"up1"}'
      where id = ${admin.id}`.execute(raw);
    const me = await get(admin, "/api/v1/me");
    expect(me.account.avatarUrl).toMatch(AVATAR_URL);
    expect(me.account.avatarSource).toEqual({ kind: "upload" });
  });
});
