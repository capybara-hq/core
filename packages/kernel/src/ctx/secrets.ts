import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PluginContext } from "@capybara-hq/plugin-sdk";
import type { Kysely } from "kysely";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** 主密钥环：current 用于新包装，previous 仅用于解包。原始密钥只存在于闭包内。 */
export interface Keyring {
  readonly currentId: string;
  /** 用当前主密钥包装（返回密文与所用主密钥 id）。 */
  wrap(plain: Buffer, aad: string): { data: Buffer; masterKeyId: string };
  /** 用指定 id 的主密钥解包；keyring 中没有该 id 时抛错（仅含 id，不含密钥）。 */
  unwrap(masterKeyId: string, data: Buffer, aad: string): Buffer;
  has(masterKeyId: string): boolean;
  toJSON(): { currentId: string; previousIds: string[] };
}

const keyId = (key: Buffer) =>
  createHash("sha256").update(key).digest().subarray(0, 8).toString("hex");

function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("secrets: ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_LEN));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
  try {
    return Buffer.concat([decipher.update(blob.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
  } catch {
    throw new Error("secrets: decryption failed (ciphertext corrupted, moved, or wrong key)");
  }
}

/** 创建主密钥环；每把密钥必须恰为 32 字节。 */
export function createKeyring(current: Buffer, previous: Buffer[]): Keyring {
  for (const k of [current, ...previous]) {
    if (!Buffer.isBuffer(k) || k.length !== KEY_LEN) {
      throw new TypeError(`master key must be a ${KEY_LEN}-byte Buffer`);
    }
  }
  const keys = new Map<string, Buffer>();
  for (const k of [...previous, current]) keys.set(keyId(k), Buffer.from(k));
  const currentId = keyId(current);
  const currentKey = Buffer.from(current);
  const ring = {
    wrap: (plain: Buffer, aad: string) => ({
      data: seal(currentKey, plain, aad),
      masterKeyId: currentId,
    }),
    unwrap(masterKeyId: string, data: Buffer, aad: string) {
      const key = keys.get(masterKeyId);
      if (!key) throw new Error(`secrets: master key ${masterKeyId} not found in keyring`);
      return open(key, data, aad);
    },
    has: (id: string) => keys.has(id),
    toJSON: () => ({ currentId, previousIds: [...keys.keys()].filter((id) => id !== currentId) }),
  };
  Object.defineProperty(ring, "currentId", { value: currentId, enumerable: true });
  return ring as Keyring;
}

const dekAad = (orgId: string) => `org_data_key\0${orgId}`;
const valueAad = (ns: string, orgId: string, key: string) => `${ns}\0${orgId}\0${key}`;

// biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
type AnyDb = Kysely<any>;

async function loadDek(db: AnyDb, keyring: Keyring, orgId: string, create: boolean) {
  const select = () =>
    db
      .withSchema("capybara")
      .selectFrom("org_data_keys")
      .select(["wrapped_key", "master_key_id"])
      .where("org_id", "=", orgId)
      .executeTakeFirst();
  let row = await select();
  if (!row && create) {
    const wrapped = keyring.wrap(randomBytes(KEY_LEN), dekAad(orgId));
    // 多副本并发：先到先得，输家丢弃自己生成的密钥，重新读取赢家的
    await db
      .withSchema("capybara")
      .insertInto("org_data_keys")
      .values({ org_id: orgId, wrapped_key: wrapped.data, master_key_id: wrapped.masterKeyId })
      .onConflict((oc) => oc.column("org_id").doNothing())
      .execute();
    row = await select();
  }
  if (!row) return null;
  return keyring.unwrap(row.master_key_id, Buffer.from(row.wrapped_key), dekAad(orgId));
}

/** 实现 ctx.secrets：每组织一把数据密钥（信封加密），值密文绑定 namespace/org/key 位置。 */
export function createSecrets(
  db: AnyDb,
  keyring: Keyring,
  namespace: string,
): PluginContext["secrets"] {
  return {
    async get(orgId, key) {
      const row = await db
        .withSchema("capybara")
        .selectFrom("secrets")
        .select("ciphertext")
        .where("namespace", "=", namespace)
        .where("org_id", "=", orgId)
        .where("key", "=", key)
        .executeTakeFirst();
      if (!row) return null;
      const dek = await loadDek(db, keyring, orgId, false);
      if (!dek) throw new Error(`secrets: data key missing for org ${orgId}`);
      return open(dek, Buffer.from(row.ciphertext), valueAad(namespace, orgId, key)).toString(
        "utf8",
      );
    },
    async set(orgId, key, value) {
      const dek = await loadDek(db, keyring, orgId, true);
      if (!dek) throw new Error(`secrets: data key unavailable for org ${orgId}`);
      const ciphertext = seal(dek, Buffer.from(value, "utf8"), valueAad(namespace, orgId, key));
      await db
        .withSchema("capybara")
        .insertInto("secrets")
        .values({ namespace, org_id: orgId, key, ciphertext })
        .onConflict((oc) =>
          oc.columns(["namespace", "org_id", "key"]).doUpdateSet({
            ciphertext,
            updated_at: new Date(),
          }),
        )
        .execute();
    },
  };
}

/** 把非当前主密钥包装的数据密钥改用当前主密钥重新包装，返回处理条数。 */
export async function rewrapDataKeys(db: AnyDb, keyring: Keyring): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .withSchema("capybara")
      .selectFrom("org_data_keys")
      .select(["org_id", "wrapped_key", "master_key_id"])
      .where("master_key_id", "!=", keyring.currentId)
      .orderBy("org_id")
      .forUpdate()
      .execute();
    const unknown = rows.filter((r) => !keyring.has(r.master_key_id));
    if (unknown.length > 0) {
      const shown = unknown
        .slice(0, 20)
        .map((r) => `${r.org_id}(master_key_id=${r.master_key_id})`);
      throw new Error(`secrets: master key not in keyring for org_id: ${shown.join(", ")}`);
    }
    for (const r of rows) {
      const dek = keyring.unwrap(r.master_key_id, Buffer.from(r.wrapped_key), dekAad(r.org_id));
      const w = keyring.wrap(dek, dekAad(r.org_id));
      await trx
        .withSchema("capybara")
        .updateTable("org_data_keys")
        .set({ wrapped_key: w.data, master_key_id: w.masterKeyId })
        .where("org_id", "=", r.org_id)
        .execute();
    }
    return rows.length;
  });
}
