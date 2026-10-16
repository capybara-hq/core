import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres } from "@capybara-hq/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring, createSecrets, rewrapDataKeys } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";

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
    const rows = await db
      .withSchema("capybara")
      .selectFrom("org_data_keys")
      .select(["org_id", "wrapped_key"])
      .where("org_id", "in", ["orgX", "orgY"])
      .execute();
    expect(rows).toHaveLength(2);
    const [r0, r1] = rows;
    if (!r0 || !r1) throw new Error("expected 2 rows");
    expect(Buffer.from(r0.wrapped_key).equals(Buffer.from(r1.wrapped_key))).toBe(false);
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
      await Promise.all([s1.set("raceorg", "a", "from-1"), s2.set("raceorg", "b", "from-2")]);
      expect(await s2.get("raceorg", "a")).toBe("from-1");
      expect(await s1.get("raceorg", "b")).toBe("from-2");
      const n = await db
        .withSchema("capybara")
        .selectFrom("org_data_keys")
        .select("org_id")
        .where("org_id", "=", "raceorg")
        .execute();
      expect(n).toHaveLength(1);
    } finally {
      await db2.destroy();
    }
  });

  it("主密钥轮换：旧值仍可读；rewrap 后仅新钥也可读", async () => {
    const old = createSecrets(db, createKeyring(k1, []), "ns-rot");
    await old.set("rotorg", "k", "persist-me");
    const ring2 = createKeyring(k2, [k1]);
    expect(await createSecrets(db, ring2, "ns-rot").get("rotorg", "k")).toBe("persist-me");
    expect(await rewrapDataKeys(db, ring2)).toBeGreaterThan(0);
    expect(await rewrapDataKeys(db, ring2)).toBe(0);
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
    await expect(rewrapDataKeys(db, createKeyring(k3, []))).rejects.toThrow(/rwunknown/);
  });
});

describe("createSecrets namespace", () => {
  it("非法 namespace 抛 TypeError", () => {
    expect(() => createSecrets(db, createKeyring(k1, []), "a.b")).toThrow(TypeError);
    expect(() => createSecrets(db, createKeyring(k1, []), "UPPER")).toThrow(TypeError);
  });
});
