import { createHash } from "node:crypto";
import type { PluginClientSection } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type ClientBuildRow, ClientBuilds } from "../client/client-builds.service.js";
import { CLIENT_DIR } from "../client/client-files.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { unpackPackageTgz } from "../packages/tgz.js";
import { StorageService } from "../storage/storage.service.js";
import type { ExtensionPackage } from "./package.js";

/**
 * Content-addressed extension package store (C13): one copy per sha256 of the whole tgz.
 * - With object storage: `deployment/plugins/blobs/<sha256>.tgz` (`blob_store = object`);
 * - without object storage, or when the caller asks (the CLI process loads no object-store
 *   extension, F-Q): PG `extension_blobs` (`blob_store = pg`, also limited by `packages.maxBytes`).
 * Each package's location is recorded in `extension_packages.blob_store`; reads follow the record and
 * check the sha256.
 *
 * A package with an `extension.client` section also stores its client build (`ClientBuilds`,
 * client extensions spec §9.1): the client files are read again from the bytes being stored,
 * checked against the section and written to object storage before the package row's transaction,
 * and the build row is inserted in that transaction, all under the build's lock. Without object
 * storage (`ClientBuilds`' own, which the CLI points at its store) such a package is refused
 * (`storage.unavailable`), so a stored build always has its files.
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
  source: "npm" | "file" | "catalog" | "bootstrap";
  ref: string;
  /** 上传者账号；CLI 为 null。 */
  actor: string | null;
  /** 强制存放位置；缺省有对象存储就用它。 */
  store?: "object" | "pg";
}

/** How many packages {@link ExtensionBlobs.remember} keeps; the oldest is dropped beyond it. */
const REMEMBERED_MAX = 8;

@Injectable()
export class ExtensionBlobs {
  /**
   * CLI only: packages the CLI process imported itself and reads back before the store, since such
   * a package may be recorded in an object store the CLI cannot read. Each entry's sha256 was
   * checked by {@link remember}; content-addressed and immutable, so it is never stale. Bounded
   * ({@link REMEMBERED_MAX}, oldest dropped); a kernel replica never fills it.
   */
  private readonly local = new Map<string, Uint8Array>();

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** Without an object-store extension (the CLI) packages go to PG. */
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(ClientBuilds) private readonly clientBuilds: ClientBuilds,
  ) {}

  /** `packages.maxBytes` (read at every call). */
  private maxBytes(): number {
    return this.config.get().packages.maxBytes;
  }

  /**
   * CLI only: keeps `bytes` for {@link get} in this process (see {@link local}). Bytes whose sha256
   * is not `sha256` throw {@link ExtensionBlobIntegrityError} and are not kept.
   */
  remember(sha256: string, bytes: Uint8Array): void {
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new ExtensionBlobIntegrityError(sha256);
    }
    this.local.delete(sha256);
    this.local.set(sha256, bytes);
    while (this.local.size > REMEMBERED_MAX) {
      const oldest = this.local.keys().next().value as string;
      this.local.delete(oldest);
    }
  }

  /**
   * Stores a validated package (the result of {@link readExtensionPackage}) and its bytes, and writes
   * the `extension_packages` row. Does nothing when a package with the same sha256 exists
   * (content-addressed, idempotent; replicas writing the same package concurrently is harmless).
   */
  async put(p: ExtensionPackage, bytes: Uint8Array, src: ExtensionBlobSource): Promise<void> {
    if (bytes.byteLength > this.maxBytes()) {
      throw new Error(`the package is larger than ${this.maxBytes()} bytes`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== p.sha256) {
      throw new ExtensionBlobIntegrityError(p.sha256);
    }
    const client = p.section.client;
    if (client === undefined) {
      await this.store(p, bytes, src, undefined);
      return;
    }
    // client code is delivered from object storage: refused before anything is written without it
    this.clientBuilds.assertAvailable();
    const files = await this.clientFiles(bytes);
    // one store or delete of this package's client build at a time (ClientBuilds header)
    await this.clientBuilds.locked(p.sha256, () =>
      this.store(p, bytes, src, { section: client, files }),
    );
  }

  /** {@link put} after its checks; `client` for a package with client code (under its lock). */
  private async store(
    p: ExtensionPackage,
    bytes: Uint8Array,
    src: ExtensionBlobSource,
    client: { section: PluginClientSection; files: Map<string, Uint8Array> } | undefined,
  ): Promise<void> {
    const plugin = p.section.manifest.name;
    const existing = await this.db
      .selectFrom("extension_packages")
      .select("blob_store")
      .where("sha256", "=", p.sha256)
      .executeTakeFirst();
    if (existing) {
      // The row is there: bytes that went missing (an object deleted, a database cleared) are
      // restored where the row says, and so are the client build's files and row
      await this.repair(p.sha256, existing.blob_store, bytes);
      if (client !== undefined) {
        await this.clientBuilds.extract(p.sha256, plugin, client.files, client.section);
      }
      return;
    }
    // checked and written before the transaction (no object storage call inside one)
    const build =
      client !== undefined
        ? await this.clientBuilds.writeFiles(p.sha256, plugin, client.files, client.section)
        : undefined;
    const store = src.store ?? (this.storage.available ? "object" : "pg");
    if (store === "object") {
      if (!this.storage.available) throw new Error("object storage is not available");
      await this.storage.deployment().put(blobKey(p.sha256), bytes, {
        contentType: "application/gzip",
        size: bytes.byteLength,
      });
    }
    // the row stores the plugin's extension section as reviewed (without the name / version copy)
    const { name: _name, version: _version, ...section } = p.section;
    await this.record(p, section, bytes, src, store, build);
  }

  /** The files under `dist/client/` of a package's bytes (sha256 already checked by the caller). */
  private async clientFiles(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    const files = await unpackPackageTgz(bytes, { maxBytes: this.maxBytes() });
    return new Map(files.filter((f) => f.path.startsWith(CLIENT_DIR)).map((f) => [f.path, f.data]));
  }

  @Transactional()
  private async record(
    p: ExtensionPackage,
    section: object,
    bytes: Uint8Array,
    src: ExtensionBlobSource,
    store: "object" | "pg",
    build: ClientBuildRow | undefined,
  ): Promise<void> {
    const m = p.section.manifest;
    const inserted = await this.db
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
        display_name: p.displayName === undefined ? null : JSON.stringify(p.displayName),
      })
      .onConflict((oc) => oc.column("sha256").doNothing())
      .returning("sha256")
      .executeTakeFirst();
    if (inserted && store === "pg") {
      await this.db
        .insertInto("extension_blobs")
        .values({ sha256: p.sha256, bytes: Buffer.from(bytes) })
        .onConflict((oc) => oc.column("sha256").doNothing())
        .execute();
    }
    // the build row commits with the package row it references (or after another replica's)
    if (build !== undefined) await this.clientBuilds.insert(build);
  }

  /** 已有记录的包：按记录的存放位置检查字节在不在，不在就写回（调用方已校验 sha256）。 */
  private async repair(sha256: string, store: "object" | "pg", bytes: Uint8Array): Promise<void> {
    if (store === "pg") {
      await this.db
        .insertInto("extension_blobs")
        .values({ sha256, bytes: Buffer.from(bytes) })
        .onConflict((oc) => oc.column("sha256").doNothing())
        .execute();
      return;
    }
    if (!this.storage.available) return;
    const d = this.storage.deployment();
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
    const local = this.local.get(sha256);
    if (local) return local;
    const row = await this.db
      .selectFrom("extension_packages")
      .select("blob_store")
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    if (!row) throw new Error(`plugin package ${sha256} is not in the package store`);
    let bytes: Uint8Array;
    if (row.blob_store === "pg") {
      const b = await this.db
        .selectFrom("extension_blobs")
        .select("bytes")
        .where("sha256", "=", sha256)
        .executeTakeFirst();
      if (!b) throw new Error(`plugin package ${sha256}: bytes are missing from extension_blobs`);
      bytes = b.bytes;
    } else {
      if (!this.storage.available) throw new Error("object storage is not available");
      const got = await this.storage.deployment().get(blobKey(sha256));
      if (!got) {
        // 常见原因：对象存储换了桶 / 地址，旧桶里的包没有带过来
        throw new Error(
          `plugin package ${sha256} is recorded in object storage, but deployment/${blobKey(sha256)} is missing there; if the object store's bucket or endpoint was changed, copy the deployment/ prefix from the old bucket, or upload the same package again to restore it`,
        );
      }
      bytes = await readCapped(got.body, this.maxBytes());
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
