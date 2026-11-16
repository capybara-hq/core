import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createKeyring,
  createSecrets,
  initialPasswordAad,
  rewrapToCurrentMasterKey,
} from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { databaseHandles } from "../helpers/database.js";

let box: Awaited<ReturnType<typeof startTestPostgres>>;
// biome-ignore lint/suspicious/noExplicitAny: 测试库无表结构类型
let db: Kysely<any>;
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const k3 = randomBytes(32);

beforeAll(async () => {
  box = await startTestPostgres();
  await migrate(box.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  db = createDb(box.url, 5);
});
afterAll(async () => {
  await db.destroy();
  await box.stop();
});

const rowOf = (ns: string, org: string, key: string) =>
  db
    .withSchema("capybara")
    .selectFrom("secrets")
    .selectAll()
    .where("namespace", "=", ns)
    .where("org_id", "=", org)
    .where("key", "=", key)
    .executeTakeFirstOrThrow();

// biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
const handlesOf = (pool: Kysely<any>) => databaseHandles(pool, createLogger("error"));

describe("createKeyring", () => {
  it("非 32 字节密钥抛 TypeError；id 为 sha256 前 8 字节 hex；不泄露原始密钥", () => {
    expect(() => createKeyring(Buffer.alloc(16), [])).toThrow(TypeError);
    expect(() => createKeyring(k1, [Buffer.alloc(31)])).toThrow(TypeError);
    const ring = createKeyring(k1, [k2]);
    expect(ring.currentId).toMatch(/^[0-9a-f]{16}$/);
    const dump = JSON.stringify(ring) + Object.keys(ring).join(",");
    expect(dump).not.toContain(k1.toString("hex"));
    expect(dump).not.toContain(k1.toString("base64"));
    expect(JSON.parse(JSON.stringify(ring)).currentId).toBe(ring.currentId);
  });
});

describe("Keyring.deriveKey", () => {
  it("同 info 稳定、不同 info 不同；轮换后 byId(旧id) 等于旧环的 current", () => {
    const ring = createKeyring(k1, []);
    const a = ring.deriveKey("access-token/v1");
    const b = ring.deriveKey("access-token/v1");
    expect(a.current).toHaveLength(32);
    expect(a.current.equals(b.current)).toBe(true);
    expect(a.currentId).toBe(ring.currentId);
    expect(a.current.equals(ring.deriveKey("other/v1").current)).toBe(false);
    expect(a.current.equals(k1)).toBe(false);
    const oldRing = createKeyring(k2, []);
    const rotated = createKeyring(k1, [k2]).deriveKey("access-token/v1");
    const old = oldRing.deriveKey("access-token/v1");
    expect(rotated.byId(oldRing.currentId)?.equals(old.current)).toBe(true);
    expect(rotated.byId(ring.currentId)?.equals(a.current)).toBe(true);
    expect(rotated.byId("0000000000000000")).toBeUndefined();
  });
});

describe("ctx.secrets", () => {
  it("set 后 get 取回原文，库里密文不含原文；缺失键返回 null", async () => {
    const s = createSecrets(db, createKeyring(k1, []), "ns-a");
    const plain = "super-secret-token-value";
    await s.set("org1", "tok", plain);
    expect(await s.get("org1", "tok")).toBe(plain);
    const row = await rowOf("ns-a", "org1", "tok");
    expect(Buffer.from(row.ciphertext).includes(Buffer.from(plain))).toBe(false);
    expect(await s.get("org1", "nope")).toBeNull();
  });

  it("set 为 upsert", async () => {
    const s = createSecrets(db, createKeyring(k1, []), "ns-up");
    await s.set("o", "k", "v1");
    await s.set("o", "k", "v2");
    expect(await s.get("o", "k")).toBe("v2");
  });

  it("不同 org 的数据密钥不同", async () => {
    const s = createSecrets(db, createKeyring(k1, []), "ns-b");
    await s.set("orgX", "k", "v");
    await s.set("orgY", "k", "v");
    const ring = createKeyring(k1, []);
    const rows = await db
      .withSchema("capybara")
      .selectFrom("org_data_keys")
      .select(["org_id", "wrapped_key", "master_key_id"])
      .where("org_id", "in", ["orgX", "orgY"])
      .execute();
    expect(rows).toHaveLength(2);
    // 比较解包后的明文数据密钥（包装后的字节因随机 IV 总是不同，比它没有意义）
    const [d0, d1] = rows.map((r) =>
      ring.unwrap(r.master_key_id, Buffer.from(r.wrapped_key), `org_data_key\0${r.org_id}`),
    );
    if (!d0 || !d1) throw new Error("expected 2 rows");
    expect(d0).toHaveLength(32);
    expect(d0.equals(d1)).toBe(false);
  });

  it("密文被篡改一个字节 → get 抛错", async () => {
    const s = createSecrets(db, createKeyring(k1, []), "ns-c");
    await s.set("o", "k", "hello");
    const row = await rowOf("ns-c", "o", "k");
    const ct = Buffer.from(row.ciphertext);
    ct[ct.length - 1] = (ct.at(-1) ?? 0) ^ 0xff;
    await db
      .withSchema("capybara")
      .updateTable("secrets")
      .set({ ciphertext: ct })
      .where("namespace", "=", "ns-c")
      .execute();
    await expect(s.get("o", "k")).rejects.toThrow();
  });

  it("把一行密文复制到另一个 key / org 的行 → get 抛错（AAD 绑定位置）", async () => {
    const s = createSecrets(db, createKeyring(k1, []), "ns-d");
    await s.set("o", "a", "alpha");
    await s.set("o", "b", "beta");
    await s.set("o2", "a", "gamma");
    const a = await rowOf("ns-d", "o", "a");
    await db
      .withSchema("capybara")
      .updateTable("secrets")
      .set({ ciphertext: a.ciphertext })
      .where("namespace", "=", "ns-d")
      .where("org_id", "=", "o")
      .where("key", "=", "b")
      .execute();
    await expect(s.get("o", "b")).rejects.toThrow();
    await db
      .withSchema("capybara")
      .updateTable("secrets")
      .set({ ciphertext: a.ciphertext })
      .where("namespace", "=", "ns-d")
      .where("org_id", "=", "o2")
      .execute();
    await expect(s.get("o2", "a")).rejects.toThrow();
  });

  it("namespace 隔离", async () => {
    const ring = createKeyring(k1, []);
    await createSecrets(db, ring, "ns-e1").set("o", "k", "v");
    expect(await createSecrets(db, ring, "ns-e2").get("o", "k")).toBeNull();
  });

  it("两个独立实例并发为新 org 写入 → 使用同一把数据密钥，可互读", async () => {
    const db2 = createDb(box.url, 5);
    try {
      const ring = createKeyring(k1, []);
      const s1 = createSecrets(db, ring, "ns-race");
      const s2 = createSecrets(db2, ring, "ns-race");
      // 预热 db2 的连接，避免它总因建连慢而落后、竞争实际没发生
      await sql`select 1`.execute(db2);
      const orgs = Array.from({ length: 10 }, (_, i) => `raceorg-${i}`);
      await Promise.all(
        orgs.flatMap((o) => [s1.set(o, "a", `from-1-${o}`), s2.set(o, "b", `from-2-${o}`)]),
      );
      for (const o of orgs) {
        expect(await s2.get(o, "a")).toBe(`from-1-${o}`);
        expect(await s1.get(o, "b")).toBe(`from-2-${o}`);
      }
      const n = await db
        .withSchema("capybara")
        .selectFrom("org_data_keys")
        .select("org_id")
        .where("org_id", "in", orgs)
        .execute();
      expect(n).toHaveLength(orgs.length);
    } finally {
      await db2.destroy();
    }
  });

  it("主密钥轮换：旧值仍可读；rewrap 后仅新钥也可读", async () => {
    const old = createSecrets(db, createKeyring(k1, []), "ns-rot");
    await old.set("rotorg", "k", "persist-me");
    const ring2 = createKeyring(k2, [k1]);
    expect(await createSecrets(db, ring2, "ns-rot").get("rotorg", "k")).toBe("persist-me");
    expect((await rewrapToCurrentMasterKey(handlesOf(db), ring2)).dataKeys).toBeGreaterThan(0);
    expect(await rewrapToCurrentMasterKey(handlesOf(db), ring2)).toEqual({
      dataKeys: 0,
      initialPasswords: 0,
    });
    expect(await createSecrets(db, createKeyring(k2, []), "ns-rot").get("rotorg", "k")).toBe(
      "persist-me",
    );
  });

  it("缺失主密钥：抛错含 master key 与 master_key_id，不含密钥", async () => {
    await createSecrets(db, createKeyring(k1, []), "ns-miss").set("missorg", "k", "v");
    const other = createKeyring(k3, []);
    const row = await db
      .withSchema("capybara")
      .selectFrom("org_data_keys")
      .select("master_key_id")
      .where("org_id", "=", "missorg")
      .executeTakeFirstOrThrow();
    const err = await createSecrets(db, other, "ns-miss")
      .get("missorg", "k")
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err?.message).toContain("master key");
    expect(err?.message).toContain(row.master_key_id);
    expect(err?.message).not.toContain(k1.toString("hex"));
  });

  it("rewrap 遇到 keyring 不认识的 master_key_id → 抛错点名 org_id", async () => {
    await createSecrets(db, createKeyring(k1, []), "ns-rw").set("rwunknown", "k", "v");
    await expect(rewrapToCurrentMasterKey(handlesOf(db), createKeyring(k3, []))).rejects.toThrow(
      /rwunknown/,
    );
  });
});

describe("rewrapToCurrentMasterKey", () => {
  const dataKeyIds = async () =>
    new Map(
      (
        await db
          .withSchema("capybara")
          .selectFrom("org_data_keys")
          .select(["org_id", "master_key_id"])
          .execute()
      ).map((r) => [r.org_id as string, r.master_key_id as string]),
    );

  beforeAll(async () => {
    // Initial-password rows reference accounts and conversations; this file seeds the sealed rows
    // alone, so the test database drops those foreign keys
    await sql`ALTER TABLE capybara.account_initial_passwords
      DROP CONSTRAINT IF EXISTS account_initial_passwords_account_id_fkey,
      DROP CONSTRAINT IF EXISTS account_initial_passwords_recipient_account_id_fkey,
      DROP CONSTRAINT IF EXISTS account_initial_passwords_conversation_id_fkey`.execute(db);
  });
  afterAll(async () => {
    // Restore the foreign keys exactly as migration 0090 creates them (the seeded rows go first)
    await db.withSchema("capybara").deleteFrom("account_initial_passwords").execute();
    await sql`ALTER TABLE capybara.account_initial_passwords
      ADD CONSTRAINT account_initial_passwords_account_id_fkey
        FOREIGN KEY (account_id) REFERENCES capybara.accounts(id) ON DELETE CASCADE,
      ADD CONSTRAINT account_initial_passwords_recipient_account_id_fkey
        FOREIGN KEY (recipient_account_id) REFERENCES capybara.accounts(id) ON DELETE CASCADE,
      ADD CONSTRAINT account_initial_passwords_conversation_id_fkey
        FOREIGN KEY (conversation_id) REFERENCES capybara.conversations(id) ON DELETE CASCADE`.execute(
      db,
    );
  });
  beforeEach(async () => {
    await db.withSchema("capybara").deleteFrom("secrets").execute();
    await db.withSchema("capybara").deleteFrom("org_data_keys").execute();
    await db.withSchema("capybara").deleteFrom("account_initial_passwords").execute();
  });

  const sealPassword = async (
    ring: ReturnType<typeof createKeyring>,
    id: string,
    expired = false,
  ) => {
    const w = ring.wrap(Buffer.from(`pw-${id}`), initialPasswordAad(id));
    await db
      .withSchema("capybara")
      .insertInto("account_initial_passwords")
      .values({
        account_id: id,
        recipient_account_id: "recipient",
        conversation_id: "conv",
        run_id: "run",
        call_id: id,
        master_key_id: w.masterKeyId,
        ciphertext: w.data,
        expires_at: new Date(Date.now() + (expired ? -1 : 1) * 3_600_000),
      })
      .execute();
  };

  it("rewraps in batches until nothing is left; values stay readable with the new key alone", async () => {
    const old = createSecrets(db, createKeyring(k1, []), "ns-batch");
    for (let i = 0; i < 5; i++) await old.set(`batch${i}`, "k", `v${i}`);
    const ring2 = createKeyring(k2, [k1]);
    // one org already on the new key is left alone
    await createSecrets(db, ring2, "ns-batch").set("fresh", "k", "vf");
    expect(await rewrapToCurrentMasterKey(handlesOf(db), ring2, { batchSize: 2 })).toEqual({
      dataKeys: 5,
      initialPasswords: 0,
    });
    expect(new Set((await dataKeyIds()).values())).toEqual(new Set([ring2.currentId]));
    const onlyNew = createSecrets(db, createKeyring(k2, []), "ns-batch");
    for (let i = 0; i < 5; i++) expect(await onlyNew.get(`batch${i}`, "k")).toBe(`v${i}`);
    expect(await onlyNew.get("fresh", "k")).toBe("vf");
  });

  it("rewraps unexpired initial passwords and leaves expired ones to their cleanup", async () => {
    const ring1 = createKeyring(k1, []);
    await sealPassword(ring1, "acc-live");
    await sealPassword(ring1, "acc-expired", true);
    const ring2 = createKeyring(k2, [k1]);
    expect(await rewrapToCurrentMasterKey(handlesOf(db), ring2)).toEqual({
      dataKeys: 0,
      initialPasswords: 1,
    });
    const rows = await db
      .withSchema("capybara")
      .selectFrom("account_initial_passwords")
      .select(["account_id", "master_key_id", "ciphertext"])
      .orderBy("account_id")
      .execute();
    expect(rows.map((r) => [r.account_id, r.master_key_id])).toEqual([
      ["acc-expired", ring1.currentId],
      ["acc-live", ring2.currentId],
    ]);
    const live = rows[1] as { master_key_id: string; ciphertext: Uint8Array };
    expect(
      createKeyring(k2, [])
        .unwrap(live.master_key_id, Buffer.from(live.ciphertext), initialPasswordAad("acc-live"))
        .toString(),
    ).toBe("pw-acc-live");
  });

  it("a master key missing from the keyring fails before anything is written, naming ids only", async () => {
    await createSecrets(db, createKeyring(k1, []), "ns-pre").set("pre-known", "k", "v");
    await createSecrets(db, createKeyring(k3, []), "ns-pre").set("pre-unknown", "k", "v");
    const before = await dataKeyIds();
    const err = await rewrapToCurrentMasterKey(handlesOf(db), createKeyring(k2, [k1]), {
      batchSize: 1,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("pre-unknown");
    expect(err?.message).not.toContain("pre-known");
    for (const k of [k1, k2, k3]) {
      expect(err?.message).not.toContain(k.toString("hex"));
      expect(err?.message).not.toContain(k.toString("base64"));
    }
    expect(await dataKeyIds()).toEqual(before);
  });

  it("a master key that appears after the check fails that batch, naming ids only", async () => {
    await createSecrets(db, createKeyring(k1, []), "ns-late").set("late-known", "k", "v");
    const handles = handlesOf(db);
    let injected = false;
    const txHost = {
      // the first batch transaction: a replica with an unknown key writes a data key meanwhile
      run: async <T>(fn: () => Promise<T>) => {
        if (!injected) {
          injected = true;
          await createSecrets(db, createKeyring(k3, []), "ns-late").set("a-late-unknown", "k", "v");
        }
        return handles.txHost.run(fn);
      },
    };
    const before = createKeyring(k1, []).currentId;
    const err = await rewrapToCurrentMasterKey(
      { db: handles.db, txHost },
      createKeyring(k2, [k1]),
      { batchSize: 10 },
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(injected).toBe(true);
    expect(err?.message).toContain("master key not in keyring");
    expect(err?.message).toContain("a-late-unknown");
    expect(err?.message).toContain(createKeyring(k3, []).currentId);
    for (const k of [k1, k2, k3]) {
      expect(err?.message).not.toContain(k.toString("hex"));
      expect(err?.message).not.toContain(k.toString("base64"));
    }
    // the failed batch rolled back: the known key was not rewrapped either
    expect((await dataKeyIds()).get("late-known")).toBe(before);
  });

  it("rejects a batch size that is not a positive integer", async () => {
    await expect(
      rewrapToCurrentMasterKey(handlesOf(db), createKeyring(k2, []), { batchSize: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("createSecrets namespace", () => {
  it("非法 namespace 抛 TypeError", () => {
    expect(() => createSecrets(db, createKeyring(k1, []), "a.b")).toThrow(TypeError);
    expect(() => createSecrets(db, createKeyring(k1, []), "UPPER")).toThrow(TypeError);
  });
});
