import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { type Kysely, sql } from "kysely";
import type { KernelDb } from "../infra/database/kernel-db.js";
import type { TransactionHost } from "../infra/database/transaction-host.js";
import { assertNamespace } from "./namespace.js";

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
  /**
   * 为某一用途（`info`）从每把主密钥派生 32 字节子密钥（HKDF-SHA256，info = `capybara:<info>`）。
   * 子密钥 id 与其主密钥 id 相同；原始主密钥不离开闭包。
   */
  deriveKey(info: string): DerivedKeys;
  toJSON(): { currentId: string; previousIds: string[] };
}

/** 某一用途的派生子密钥集合：current 用于签发，byId 用于按 id（= 主密钥 id）校验。 */
export interface DerivedKeys {
  currentId: string;
  current: Buffer;
  byId(id: string): Buffer | undefined;
}

const derive = (key: Buffer, info: string) =>
  Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `capybara:${info}`, KEY_LEN));

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
    deriveKey(info: string): DerivedKeys {
      const derived = new Map<string, Buffer>();
      for (const [id, k] of keys) derived.set(id, derive(k, info));
      const current = derived.get(currentId) as Buffer;
      return {
        currentId,
        current: Buffer.from(current),
        byId: (id: string) => {
          const d = derived.get(id);
          return d && Buffer.from(d);
        },
      };
    },
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

/** 内核视角的 secrets：在 `ctx.secrets` 之上多一个 `delete`（插件契约不暴露）。 */
export type KernelSecrets = ExtensionContext["secrets"] & {
  /** 删除一个值；不存在时无操作。 */
  delete(orgId: string, key: string): Promise<void>;
};

/**
 * 实现 ctx.secrets：每组织一把数据密钥（信封加密），值密文绑定 namespace/org/key 位置。
 * `db` 可以是 Kysely 事务：此时读写（含首次创建组织数据密钥）都在该事务内。
 */
export function createSecrets(db: AnyDb, keyring: Keyring, namespace: string): KernelSecrets {
  assertNamespace(namespace);
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
    async delete(orgId, key) {
      await db
        .withSchema("capybara")
        .deleteFrom("secrets")
        .where("namespace", "=", namespace)
        .where("org_id", "=", orgId)
        .where("key", "=", key)
        .execute();
    },
  };
}

/** What {@link rewrapToCurrentMasterKey} rewrapped. */
export interface RewrapResult {
  /** Org data keys (`org_data_keys`) now wrapped with the current master key. */
  dataKeys: number;
  /** Unexpired one-time initial passwords (`account_initial_passwords`) now sealed with it. */
  initialPasswords: number;
}

/** Rows rewrapped per transaction by default. */
export const REWRAP_BATCH_SIZE = 500;

/** The AAD binding a sealed initial password to its account (a row moved to another one fails). */
export const initialPasswordAad = (accountId: string) => `capybara:initial-password:${accountId}`;

/**
 * The AAD binding a person's sealed card values to their approval and field paths (sorted, joined
 * by ","): a row moved to another approval, or whose paths are altered, fails to unwrap.
 */
export const platformSealedInputAad = (approvalId: string, paths: readonly string[]) =>
  `capybara:platform-sealed-input:${approvalId}:${[...paths].sort().join(",")}`;

type RewrapHandles = { db: Pick<KernelDb, "db">; txHost: Pick<TransactionHost, "run"> };

/** One table whose rows are sealed directly with a master key. */
interface MasterKeyedTable {
  table: "org_data_keys" | "account_initial_passwords";
  /** The row key column; also names the row in errors (an id, never key material). */
  idColumn: "org_id" | "account_id";
  dataColumn: "wrapped_key" | "ciphertext";
  aad(id: string): string;
  /**
   * The table has `expires_at`: expired rows are never read again, so they are left to their
   * cleanup job instead of being rewrapped.
   */
  hasExpiresAt: boolean;
}

const MASTER_KEYED: MasterKeyedTable[] = [
  {
    table: "org_data_keys",
    idColumn: "org_id",
    dataColumn: "wrapped_key",
    aad: dekAad,
    hasExpiresAt: false,
  },
  {
    table: "account_initial_passwords",
    idColumn: "account_id",
    dataColumn: "ciphertext",
    aad: initialPasswordAad,
    hasExpiresAt: true,
  },
];

function staleRows(db: AnyDb, t: MasterKeyedTable, keyring: Keyring) {
  let q = db
    .withSchema("capybara")
    .selectFrom(t.table)
    .where("master_key_id", "!=", keyring.currentId);
  if (t.hasExpiresAt) q = q.where("expires_at", ">", sql<Date>`now()`);
  return q;
}

function assertKnown(t: MasterKeyedTable, keyring: Keyring, rows: { id: string; mk: string }[]) {
  const unknown = rows.filter((r) => !keyring.has(r.mk));
  if (unknown.length === 0) return;
  const shown = unknown.slice(0, 20).map((r) => `${r.id}(master_key_id=${r.mk})`);
  throw new Error(
    `secrets: master key not in keyring for ${t.table}.${t.idColumn}: ${shown.join(", ")}`,
  );
}

/**
 * Rewraps everything sealed with a master key other than the keyring's current one (org data keys
 * and unexpired initial passwords) with the current key, `batchSize` rows per transaction, until
 * none is left. Checks first that the keyring holds every master key in use and throws (naming row
 * ids and key ids, never key material) before writing anything when it does not. Idempotent: a
 * second run finds nothing; concurrent runs lock the same rows and skip the ones already done.
 */
export async function rewrapToCurrentMasterKey(
  handles: RewrapHandles,
  keyring: Keyring,
  opts: { batchSize?: number } = {},
): Promise<RewrapResult> {
  const batchSize = opts.batchSize ?? REWRAP_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("rewrap batch size must be a positive integer");
  }
  const db = (): AnyDb => handles.db.db;
  for (const t of MASTER_KEYED) {
    const rows = await staleRows(db(), t, keyring)
      .select([`${t.idColumn} as id`, "master_key_id as mk"])
      .orderBy(t.idColumn)
      .execute();
    assertKnown(t, keyring, rows);
  }
  const counts = new Map<MasterKeyedTable["table"], number>();
  for (const t of MASTER_KEYED) {
    let total = 0;
    for (;;) {
      const done = await handles.txHost.run(async () => {
        const trx = db();
        const rows: { id: string; mk: string; data: Uint8Array }[] = await staleRows(
          trx,
          t,
          keyring,
        )
          .select([`${t.idColumn} as id`, "master_key_id as mk", `${t.dataColumn} as data`])
          .orderBy(t.idColumn)
          .limit(batchSize)
          .forUpdate()
          .execute();
        // a row written meanwhile by a replica that runs an older config
        assertKnown(t, keyring, rows);
        for (const r of rows) {
          let plain: Buffer;
          try {
            plain = keyring.unwrap(r.mk, Buffer.from(r.data), t.aad(r.id));
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            throw new Error(`secrets: cannot unwrap ${t.table}.${t.idColumn}=${r.id}: ${why}`);
          }
          const w = keyring.wrap(plain, t.aad(r.id));
          plain.fill(0);
          await trx
            .withSchema("capybara")
            .updateTable(t.table)
            .set({ [t.dataColumn]: w.data, master_key_id: w.masterKeyId })
            .where(t.idColumn, "=", r.id)
            .execute();
        }
        return rows.length;
      });
      total += done;
      if (done === 0) break;
    }
    counts.set(t.table, total);
  }
  return {
    dataKeys: counts.get("org_data_keys") ?? 0,
    initialPasswords: counts.get("account_initial_passwords") ?? 0,
  };
}
