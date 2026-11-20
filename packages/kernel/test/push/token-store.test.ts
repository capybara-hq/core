import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring, rewrapToCurrentMasterKey } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { PushTokenStore } from "../../src/push/token-store.js";
import { databaseHandles } from "../helpers/database.js";

/**
 * Push registrations (mobile app spec §9.3): migration 0171_push.sql and the store that seals a
 * device's push token with the master keyring (AAD bound to the registration id).
 */
const FILE = "0171_push.sql";
const TOKEN = "fcm-token-0123456789-abcdefghijklmnopqrstuvwxyz";

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;
const k1 = randomBytes(32);
const k2 = randomBytes(32);

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  db = createDb(pg.url, 3);
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
});

const insertRegistration = async (
  store: PushTokenStore,
  id: string,
  token: string,
  appId = "com.example.app",
) => {
  const sealed = store.seal(id, token);
  await db
    .withSchema("capybara")
    .insertInto("push_registrations")
    .values({
      id,
      account_id: "a1",
      platform: "android",
      app_id: appId,
      provider: "push-fcm",
      token_hash: sealed.tokenHash,
      master_key_id: sealed.masterKeyId,
      token_ciphertext: sealed.ciphertext,
      locale: "zh",
      device_name: "Pixel",
    })
    .execute();
  return sealed;
};

const rowOf = (id: string) =>
  db
    .withSchema("capybara")
    .selectFrom("push_registrations")
    .select(["id", "master_key_id", "token_ciphertext"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe("PushTokenStore", () => {
  it("seal then open round-trips; the hash is sha256 hex and the ciphertext hides the token", async () => {
    const store = new PushTokenStore(createKeyring(k1, []));
    const sealed = await insertRegistration(store, "r-round", TOKEN);
    expect(sealed.tokenHash).toBe(PushTokenStore.hash(TOKEN));
    expect(sealed.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.ciphertext.includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    expect(store.open(await rowOf("r-round"))).toBe(TOKEN);
  });

  it("a ciphertext copied to another registration id fails to open", async () => {
    const store = new PushTokenStore(createKeyring(k1, []));
    await insertRegistration(store, "r-a", `${TOKEN}-a`);
    const row = await rowOf("r-a");
    let error: unknown;
    try {
      store.open({ ...row, id: "r-b" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/decryption failed/);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("after rotating the master key, rewrap reports the token and it opens with the new key only", async () => {
    await db.withSchema("capybara").deleteFrom("push_registrations").execute();
    await insertRegistration(new PushTokenStore(createKeyring(k1, [])), "r-rot", `${TOKEN}-rot`);
    const ring2 = createKeyring(k2, [k1]);
    const result = await rewrapToCurrentMasterKey(
      databaseHandles(db, createLogger("error")),
      ring2,
    );
    expect(result.pushTokens).toBe(1);
    const row = await rowOf("r-rot");
    expect(row.master_key_id).toBe(ring2.currentId);
    expect(new PushTokenStore(createKeyring(k2, [])).open(row)).toBe(`${TOKEN}-rot`);
  });
});

describe("0171_push.sql", () => {
  it("applies again cleanly", async () => {
    const text = readFileSync(join(KERNEL_MIGRATIONS_DIR, FILE), "utf8");
    // `set local` ends with the transaction, so the pooled connection keeps its search path
    const apply = () =>
      db
        .transaction()
        .execute((trx) => sql.raw(`set local search_path to capybara; ${text}`).execute(trx));
    await apply();
    await apply();
    await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  });

  it("a second row with the same provider, app id and token hash violates the unique key", async () => {
    const store = new PushTokenStore(createKeyring(k1, []));
    await insertRegistration(store, "r-dup-1", `${TOKEN}-dup`);
    await expect(insertRegistration(store, "r-dup-2", `${TOKEN}-dup`)).rejects.toThrow(
      /push_registrations_provider_app_id_token_hash_key/,
    );
    // another app id with the same token is a separate registration
    await insertRegistration(store, "r-dup-3", `${TOKEN}-dup`, "com.example.other");
  });

  it("a preference row names one of the four categories", async () => {
    await sql`insert into capybara.push_preferences (account_id, category, enabled)
      values ('a1', 'waiting', false)`.execute(db);
    await expect(
      sql`insert into capybara.push_preferences (account_id, category, enabled)
        values ('a1', 'other', true)`.execute(db),
    ).rejects.toThrow(/check/i);
  });
});
