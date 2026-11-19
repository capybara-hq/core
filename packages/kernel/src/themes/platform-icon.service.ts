import { createHash } from "node:crypto";
import { sanitizeThemeSvg } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import type { WriteActor } from "../identity/write-actor.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { isStorageUnavailable, StorageService } from "../storage/storage.service.js";
import {
  PLATFORM_ICON_MAX_BYTES,
  PLATFORM_ICON_PNG_SIZE,
  type PlatformIconPurpose,
  type PlatformIconView,
} from "./platform-icon.schemas.js";
import {
  owePlatformIconDelete,
  PLATFORM_ICON_LOCK,
  platformIconKey,
  platformIconLockKey,
} from "./platform-icon-objects.js";

/** The type each purpose is stored and served as (fixed by the purpose, never by the upload). */
const CONTENT_TYPE: Record<PlatformIconPurpose, "image/png" | "image/svg+xml"> = {
  app: "image/png",
  maskable: "image/png",
  favicon: "image/svg+xml",
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/** A validated icon, ready to store: the bytes to write and their SHA-256. */
export interface PlatformIconFile {
  purpose: PlatformIconPurpose;
  contentType: "image/png" | "image/svg+xml";
  bytes: Uint8Array;
  sha256: string;
}

/** The public URL of an icon: the hash in `v` changes on upload, so it is cached as immutable. */
export const platformIconUrl = (purpose: PlatformIconPurpose, sha256: string): string =>
  `/api/v1/platform/icon/${purpose}?v=${sha256}`;

/**
 * Checks an upload (nothing is rendered or resized): at most 1 MiB; `app` and `maskable` a PNG
 * (signature, an `IHDR` first chunk) of exactly 512 × 512; `favicon` an SVG, parsed with the theme
 * logo sanitizer (a strict XML parser, an `<svg>` root in the SVG namespace with a viewBox, no
 * script, style element, event handler or external reference) and stored as its sanitized output.
 * Throws the refusal as `platform_icon.*`.
 */
export function checkPlatformIcon(
  purpose: PlatformIconPurpose,
  declared: "image/png" | "image/svg+xml",
  dataBase64: string,
): PlatformIconFile {
  const data = Buffer.from(dataBase64, "base64");
  if (data.byteLength > PLATFORM_ICON_MAX_BYTES) {
    throw new ApiError(
      "platform_icon.too_large",
      `The icon is ${data.byteLength} bytes; an icon file is at most 1 MiB (${PLATFORM_ICON_MAX_BYTES} bytes)`,
    );
  }
  const expected = CONTENT_TYPE[purpose];
  if (declared !== expected) {
    throw new ApiError(
      "platform_icon.invalid_type",
      purpose === "favicon"
        ? "The favicon must be an SVG (image/svg+xml)"
        : `The ${purpose} icon must be a PNG (image/png) of ${PLATFORM_ICON_PNG_SIZE} × ${PLATFORM_ICON_PNG_SIZE} pixels; an SVG is accepted only as the favicon`,
    );
  }
  let bytes: Uint8Array = data;
  if (expected === "image/png") {
    checkPng(purpose, data);
  } else {
    const r = sanitizeThemeSvg(data);
    if ("error" in r) {
      throw new ApiError(
        "platform_icon.invalid_type",
        `The favicon is not a usable SVG: ${r.error}`,
      );
    }
    bytes = new TextEncoder().encode(r.svg);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { purpose, contentType: expected, bytes, sha256 };
}

/** A PNG of exactly 512 × 512 by its signature and `IHDR` width and height; throws the refusal. */
function checkPng(purpose: PlatformIconPurpose, data: Buffer): void {
  const isPng =
    data.byteLength >= 24 &&
    PNG_SIG.every((b, i) => data[i] === b) &&
    data.readUInt32BE(8) === 13 &&
    IHDR.every((b, i) => data[12 + i] === b);
  if (!isPng) {
    throw new ApiError(
      "platform_icon.invalid_type",
      `The ${purpose} icon is not a PNG file (no PNG signature and IHDR header); upload a ${PLATFORM_ICON_PNG_SIZE} × ${PLATFORM_ICON_PNG_SIZE} PNG`,
    );
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== PLATFORM_ICON_PNG_SIZE || height !== PLATFORM_ICON_PNG_SIZE) {
    throw new ApiError(
      "platform_icon.invalid_size",
      `The ${purpose} icon is ${width} × ${height} pixels; it must be exactly ${PLATFORM_ICON_PNG_SIZE} × ${PLATFORM_ICON_PNG_SIZE}`,
    );
  }
}

const storageUnavailable = () =>
  new ApiError(
    "platform_icon.storage_unavailable",
    "Object storage is not available in this deployment, so the platform icon cannot be stored or served; install and configure an object-store plugin",
  );

/**
 * The platform icon setting (mobile layout spec §10.2.1): the super admin's uploads (the app icon,
 * its maskable variant, the SVG favicon), stored in object storage under the kernel's
 * `deployment/` prefix with a row per purpose in `capybara.platform_icons`; the public read the
 * manifest, favicons and native clients use. Writes are audited (`platform.icon.updated`,
 * `platform.icon.cleared`) and serialized per purpose (see `platform-icon-objects.ts`).
 */
@Injectable()
export class PlatformIconService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Every uploaded icon, in purpose order (`app`, `maskable`, `favicon`). */
  async list(): Promise<{ icons: PlatformIconView[] }> {
    const rows = await this.db
      .selectFrom("platform_icons")
      .select(["purpose", "sha256", "updated_at"])
      .execute();
    const order: PlatformIconPurpose[] = ["app", "maskable", "favicon"];
    rows.sort((a, b) => order.indexOf(a.purpose) - order.indexOf(b.purpose));
    return { icons: rows.map((r) => viewOf(r.purpose, r.sha256, r.updated_at)) };
  }

  /**
   * The icon of a purpose now, `{ purpose, sha256, url }`, or null when the default is in use:
   * what other features (the meta document, the manifest) build the icon URL from.
   */
  async current(
    purpose: PlatformIconPurpose,
  ): Promise<{ purpose: PlatformIconPurpose; sha256: string; url: string } | null> {
    const row = await this.db
      .selectFrom("platform_icons")
      .select("sha256")
      .where("purpose", "=", purpose)
      .executeTakeFirst();
    return row ? { purpose, sha256: row.sha256, url: platformIconUrl(purpose, row.sha256) } : null;
  }

  /** The upload's checks alone (the Platform operation's precheck); throws the write's refusal. */
  async check(
    purpose: PlatformIconPurpose,
    contentType: "image/png" | "image/svg+xml",
    dataBase64: string,
  ): Promise<void> {
    checkPlatformIcon(purpose, contentType, dataBase64);
    if (!this.storage.available) throw storageUnavailable();
  }

  /**
   * Sets the icon of a purpose. Under the purpose's lock: first the orphan check of the new object
   * is owed (a committed intent), then the object is written, then the row in a transaction that
   * also owes the deletion of the object the row named before (none when the bytes are the same).
   */
  async set(
    purpose: PlatformIconPurpose,
    contentType: "image/png" | "image/svg+xml",
    dataBase64: string,
    actor: WriteActor,
    auditDetail: Record<string, unknown> = {},
  ): Promise<PlatformIconView> {
    const file = checkPlatformIcon(purpose, contentType, dataBase64);
    if (!this.storage.available) throw storageUnavailable();
    return this.locks.run(platformIconLockKey(purpose), PLATFORM_ICON_LOCK, async () => {
      await this.oweOrphanCheck(file, actor);
      try {
        await this.storage.deployment().put(platformIconKey(purpose, file.sha256), file.bytes, {
          contentType: file.contentType,
          size: file.bytes.byteLength,
        });
      } catch (e) {
        if (isStorageUnavailable(e)) throw storageUnavailable();
        throw e;
      }
      return this.commit(file, actor, auditDetail);
    });
  }

  /** The intent: the new object's delayed orphan check, owed before the object is written. */
  @Transactional()
  private async oweOrphanCheck(file: PlatformIconFile, actor: WriteActor): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor.accountId);
    await owePlatformIconDelete(this.outbox, file.purpose, file.sha256, { orphanCheck: true });
  }

  /** The row naming the written object, the old object's deletion and the audit event. */
  @Transactional()
  private async commit(
    file: PlatformIconFile,
    actor: WriteActor,
    auditDetail: Record<string, unknown>,
  ): Promise<PlatformIconView> {
    await this.adminLock.lockAndAuthorize(actor.accountId);
    const old = await this.db
      .selectFrom("platform_icons")
      .select("sha256")
      .where("purpose", "=", file.purpose)
      .forUpdate()
      .executeTakeFirst();
    const objectKey = platformIconKey(file.purpose, file.sha256);
    const row = await this.db
      .insertInto("platform_icons")
      .values({
        purpose: file.purpose,
        object_key: objectKey,
        sha256: file.sha256,
        content_type: file.contentType,
      })
      .onConflict((oc) =>
        oc.column("purpose").doUpdateSet({
          object_key: objectKey,
          sha256: file.sha256,
          content_type: file.contentType,
          updated_at: new Date(),
        }),
      )
      .returning(["updated_at"])
      .executeTakeFirstOrThrow();
    if (old && old.sha256 !== file.sha256) {
      await owePlatformIconDelete(this.outbox, file.purpose, old.sha256);
    }
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      action: "platform.icon.updated",
      target: file.purpose,
      detail: { purpose: file.purpose, sha256: file.sha256, ...auditDetail },
    });
    return viewOf(file.purpose, file.sha256, row.updated_at);
  }

  /**
   * Restores the default of a purpose: the row goes and its object's deletion is owed. Clearing a
   * purpose with no upload changes nothing; returns whether a row was removed.
   */
  async clear(
    purpose: PlatformIconPurpose,
    actor: WriteActor,
    auditDetail: Record<string, unknown> = {},
  ): Promise<boolean> {
    return this.locks.run(platformIconLockKey(purpose), PLATFORM_ICON_LOCK, () =>
      this.remove(purpose, actor, auditDetail),
    );
  }

  @Transactional()
  private async remove(
    purpose: PlatformIconPurpose,
    actor: WriteActor,
    auditDetail: Record<string, unknown>,
  ): Promise<boolean> {
    await this.adminLock.lockAndAuthorize(actor.accountId);
    const gone = await this.db
      .deleteFrom("platform_icons")
      .where("purpose", "=", purpose)
      .returning("sha256")
      .executeTakeFirst();
    if (!gone) return false;
    await owePlatformIconDelete(this.outbox, purpose, gone.sha256);
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      action: "platform.icon.cleared",
      target: purpose,
      detail: { purpose, sha256: gone.sha256, ...auditDetail },
    });
    return true;
  }

  /**
   * The stored bytes of a purpose for the public route, or `platform_icon.not_found` when the
   * default is in use, `v` names another upload, or the object is missing. `immutable` is true
   * when `v` is the current hash (the URL then never changes meaning).
   */
  async read(
    purpose: PlatformIconPurpose,
    v: string | undefined,
  ): Promise<{ contentType: string; bytes: Uint8Array; immutable: boolean }> {
    const row = await this.db
      .selectFrom("platform_icons")
      .select(["object_key", "sha256"])
      .where("purpose", "=", purpose)
      .executeTakeFirst();
    const notFound = () =>
      new ApiError(
        "platform_icon.not_found",
        v === undefined || row === undefined
          ? `No ${purpose} icon is uploaded; the built-in Capybara icon applies`
          : `The ${purpose} icon was replaced; read the current URL from the platform icon settings`,
      );
    if (!row || (v !== undefined && v !== row.sha256)) throw notFound();
    let obj: Awaited<ReturnType<ReturnType<StorageService["deployment"]>["get"]>>;
    try {
      obj = await this.storage.deployment().get(row.object_key);
    } catch (e) {
      if (isStorageUnavailable(e)) throw storageUnavailable();
      throw e;
    }
    if (!obj) throw notFound();
    const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
    // the type is the purpose's, never the store's metadata
    return { contentType: CONTENT_TYPE[purpose], bytes, immutable: v !== undefined };
  }
}

const viewOf = (purpose: PlatformIconPurpose, sha256: string, at: Date): PlatformIconView => ({
  purpose,
  url: platformIconUrl(purpose, sha256),
  sha256,
  updatedAt: at.toISOString(),
});
