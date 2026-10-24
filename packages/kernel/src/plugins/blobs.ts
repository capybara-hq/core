import { createHash } from "node:crypto";
import type { KernelDb } from "../db/kernel-schema.js";
import type { StorageService } from "../storage/storage.service.js";
import type { PluginPackage } from "./package.js";

/**
 * 内容寻址的插件包存储（C13）：按整个 tgz 的 sha256 存一份。
 * - 有对象存储时放 `deployment/plugins/blobs/<sha256>.tgz`（`blob_store = object`）；
 * - 没有对象存储、或调用方要求（CLI 进程里没有加载 object-store 插件，F-Q）时放 PG `plugin_blobs`
 *   （`blob_store = pg`，同受 `packages.maxBytes` 限制）。
 * 每个包的存放位置记在 `plugin_packages.blob_store`，读取按记录取，并校验 sha256。
 */

/** 取到的包与 sha256 不符（存储里的字节被篡改或损坏）。 */
export class PluginBlobIntegrityError extends Error {
  constructor(sha256: string) {
    super(`plugin package ${sha256}: stored bytes do not match the sha256`);
    this.name = "PluginBlobIntegrityError";
  }
}

/** 对象存储里的键（相对 `deployment/`）。 */
export const blobKey = (sha256: string) => `plugins/blobs/${sha256}.tgz`;

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface PluginBlobSource {
  source: "npm" | "file" | "directory";
  ref: string;
  /** 上传者账号；CLI 为 null。 */
  actor: string | null;
  /** 强制存放位置；缺省有对象存储就用它。 */
  store?: "object" | "pg";
}

export class PluginBlobs {
  constructor(
    private readonly d: {
      db: KernelDb;
      /** 没有时一律存 PG（如 CLI）。 */
      storage?: StorageService;
      /** `packages.maxBytes`（每次调用时读）。 */
      maxBytes: () => number;
    },
  ) {}

  /**
   * 存一个已校验的包（{@link readPluginPackage} 的结果）及其字节，并写 `plugin_packages` 行。
   * 已有同 sha256 的包时什么都不做（内容寻址，幂等；多副本并发写同一个包也无害）。
   */
  async put(p: PluginPackage, bytes: Uint8Array, src: PluginBlobSource): Promise<void> {
    if (bytes.byteLength > this.d.maxBytes()) {
      throw new Error(`the package is larger than ${this.d.maxBytes()} bytes`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== p.sha256) {
      throw new PluginBlobIntegrityError(p.sha256);
    }
    const existing = await this.d.db
      .selectFrom("plugin_packages")
      .select("blob_store")
      .where("sha256", "=", p.sha256)
      .executeTakeFirst();
    if (existing) {
      // 记录已在：字节若丢了（对象被删、库被清）就按原存放位置补上
      await this.repair(p.sha256, existing.blob_store, bytes);
      return;
    }
    const store = src.store ?? (this.d.storage?.available ? "object" : "pg");
    if (store === "object") {
      if (!this.d.storage) throw new Error("object storage is not available");
      await this.d.storage.deployment().put(blobKey(p.sha256), bytes, {
        contentType: "application/gzip",
        size: bytes.byteLength,
      });
    }
    const m = p.section.manifest;
    await this.d.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("plugin_packages")
        .values({
          sha256: p.sha256,
          name: m.name,
          package_name: String(p.packageJson.name),
          version: m.version,
          size: p.size,
          section: JSON.stringify(p.section),
          blob_store: store,
          source: src.source,
          source_ref: src.ref,
          uploaded_by: src.actor,
        })
        .onConflict((oc) => oc.column("sha256").doNothing())
        .returning("sha256")
        .executeTakeFirst();
      if (inserted && store === "pg") {
        await trx
          .insertInto("plugin_blobs")
          .values({ sha256: p.sha256, bytes: Buffer.from(bytes) })
          .onConflict((oc) => oc.column("sha256").doNothing())
          .execute();
      }
    });
  }

  /** 已有记录的包：按记录的存放位置检查字节在不在，不在就写回（调用方已校验 sha256）。 */
  private async repair(sha256: string, store: "object" | "pg", bytes: Uint8Array): Promise<void> {
    if (store === "pg") {
      await this.d.db
        .insertInto("plugin_blobs")
        .values({ sha256, bytes: Buffer.from(bytes) })
        .onConflict((oc) => oc.column("sha256").doNothing())
        .execute();
      return;
    }
    if (!this.d.storage?.available) return;
    const d = this.d.storage.deployment();
    if ((await d.head(blobKey(sha256))) === null) {
      await d.put(blobKey(sha256), bytes, {
        contentType: "application/gzip",
        size: bytes.byteLength,
      });
    }
  }

  /** 按记录的存放位置取包并校验 sha256；不符抛 {@link PluginBlobIntegrityError}。 */
  async get(sha256: string): Promise<Uint8Array> {
    if (!SHA256_RE.test(sha256)) throw new Error(`invalid package sha256 "${sha256}"`);
    const row = await this.d.db
      .selectFrom("plugin_packages")
      .select("blob_store")
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (!row) throw new Error(`plugin package ${sha256} is not in the package store`);
    let bytes: Uint8Array;
    if (row.blob_store === "pg") {
      const b = await this.d.db
        .selectFrom("plugin_blobs")
        .select("bytes")
        .where("sha256", "=", sha256)
        .executeTakeFirst();
      if (!b) throw new Error(`plugin package ${sha256}: bytes are missing from plugin_blobs`);
      bytes = b.bytes;
    } else {
      if (!this.d.storage) throw new Error("object storage is not available");
      const got = await this.d.storage.deployment().get(blobKey(sha256));
      if (!got) {
        // 常见原因：对象存储换了桶 / 地址，旧桶里的包没有带过来
        throw new Error(
          `plugin package ${sha256} is recorded in object storage, but deployment/${blobKey(sha256)} is missing there; if the object store's bucket or endpoint was changed, copy the deployment/ prefix from the old bucket, or upload the same package again to restore it`,
        );
      }
      bytes = await readCapped(got.body, this.d.maxBytes());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new PluginBlobIntegrityError(sha256);
    }
    return bytes;
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`stored plugin package is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return chunks.length === 1 ? (chunks[0] as Uint8Array) : Buffer.concat(chunks);
}
