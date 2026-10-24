import { createHash } from "node:crypto";
import type { KernelDb } from "../db/kernel-schema.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ExtensionPackage } from "./package.js";

/**
 * Content-addressed extension package store (C13): one copy per sha256 of the whole tgz.
 * - With object storage: `deployment/plugins/blobs/<sha256>.tgz` (`blob_store = object`);
 * - without object storage, or when the caller asks (the CLI process loads no object-store
 *   extension, F-Q): PG `extension_blobs` (`blob_store = pg`, also limited by `packages.maxBytes`).
 * Each package's location is recorded in `extension_packages.blob_store`; reads follow the record and
 * check the sha256.
 */

/** 取到的包与 sha256 不符（存储里的字节被篡改或损坏）。 */
export class ExtensionBlobIntegrityError extends Error {
  constructor(sha256: string) {
    super(`plugin package ${sha256}: stored bytes do not match the sha256`);
    this.name = "ExtensionBlobIntegrityError";
  }
}

/** 对象存储里的键（相对 `deployment/`）。 */
export const blobKey = (sha256: string) => `plugins/blobs/${sha256}.tgz`;

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface ExtensionBlobSource {
  source: "npm" | "file" | "catalog";
  ref: string;
  /** 上传者账号；CLI 为 null。 */
  actor: string | null;
  /** 强制存放位置；缺省有对象存储就用它。 */
  store?: "object" | "pg";
}

export class ExtensionBlobs {
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
   * Stores a validated package (the result of {@link readExtensionPackage}) and its bytes, and writes
   * the `extension_packages` row. Does nothing when a package with the same sha256 exists
   * (content-addressed, idempotent; replicas writing the same package concurrently is harmless).
   */
  async put(p: ExtensionPackage, bytes: Uint8Array, src: ExtensionBlobSource): Promise<void> {
    if (bytes.byteLength > this.d.maxBytes()) {
      throw new Error(`the package is larger than ${this.d.maxBytes()} bytes`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== p.sha256) {
      throw new ExtensionBlobIntegrityError(p.sha256);
    }
    const existing = await this.d.db
      .selectFrom("extension_packages")
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
    // the row stores the plugin's extension section as reviewed (without the name / version copy)
    const { name: _name, version: _version, ...section } = p.section;
    await this.d.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("extension_packages")
        .values({
          sha256: p.sha256,
          name: m.name,
          package_name: String(p.packageJson.name),
          version: m.version,
          size: p.size,
          section: JSON.stringify(section),
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
          .insertInto("extension_blobs")
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
        .insertInto("extension_blobs")
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

  /** Reads the package from its recorded location and checks its sha256; a mismatch throws {@link ExtensionBlobIntegrityError}. */
  async get(sha256: string): Promise<Uint8Array> {
    if (!SHA256_RE.test(sha256)) throw new Error(`invalid package sha256 "${sha256}"`);
    const row = await this.d.db
      .selectFrom("extension_packages")
      .select("blob_store")
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (!row) throw new Error(`plugin package ${sha256} is not in the package store`);
    let bytes: Uint8Array;
    if (row.blob_store === "pg") {
      const b = await this.d.db
        .selectFrom("extension_blobs")
        .select("bytes")
        .where("sha256", "=", sha256)
        .executeTakeFirst();
      if (!b) throw new Error(`plugin package ${sha256}: bytes are missing from extension_blobs`);
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
      throw new ExtensionBlobIntegrityError(sha256);
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
