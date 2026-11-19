import { Inject, Injectable, Module } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StorageModule } from "../storage/storage.module.js";
import { StorageService } from "../storage/storage.service.js";
import type { PlatformIconPurpose } from "./platform-icon.schemas.js";

/**
 * Platform icon objects in object storage (mobile layout spec §10.2.1): the icon of a purpose with
 * SHA-256 `h` is `platform-icons/<purpose>-<h>.<png|svg>` under the kernel's `deployment/` prefix,
 * so the same bytes always land on the same key. An upload writes its object before the row that
 * names it; an object no row names is deleted through the outbox ({@link PLATFORM_ICON_DELETE_JOB}):
 * the upload owes a delayed check of its own object first (an upload that never commits leaves no
 * orphan), and a replace or clear owes the deletion of the object the row stops naming.
 *
 * Because keys are content addressed, a later upload of the same bytes may name a key again after
 * its deletion was owed: uploads, clears and the job hold {@link platformIconLockKey} for the
 * purpose, so the job's "no row names it" check and its delete never interleave with an upload
 * between its object write and its commit.
 */

/** The file extension of a purpose's object (its type is fixed by the purpose). */
const extensionOf = (purpose: PlatformIconPurpose): "png" | "svg" =>
  purpose === "favicon" ? "svg" : "png";

/** The object key of an icon, relative to the kernel's `deployment/` prefix. */
export const platformIconKey = (purpose: PlatformIconPurpose, sha256: string): string =>
  `platform-icons/${purpose}-${sha256}.${extensionOf(purpose)}`;

/** True when `key` is one {@link platformIconKey} makes for `purpose`. */
const isIconKeyOf = (purpose: PlatformIconPurpose, key: string): boolean =>
  new RegExp(`^platform-icons/${purpose}-[0-9a-f]{64}\\.${extensionOf(purpose)}$`).test(key);

/** The `LockService` key of a purpose's icon writes and deletions (no `:`). */
export const platformIconLockKey = (purpose: PlatformIconPurpose): string =>
  `platform-icon-${purpose}`;

/** How long a write or the deletion job holds the purpose's lock without renewal, and waits for it. */
export const PLATFORM_ICON_LOCK = { ttlMs: 30_000, waitMs: 10_000 } as const;

/** The maintenance job that deletes one icon object no row names. */
export const PLATFORM_ICON_DELETE_JOB = "platform-icon-delete";

/** Outbox id of the deletion a replace or clear owes for the object the row stopped naming. */
export const platformIconDeleteJobId = (purpose: PlatformIconPurpose, sha256: string): string =>
  `platform-icon-delete-${purpose}-${sha256}`;

/** Outbox id of the delayed check an upload owes for its own object before writing it. */
export const platformIconOrphanJobId = (purpose: PlatformIconPurpose, sha256: string): string =>
  `platform-icon-orphan-${purpose}-${sha256}`;

/** How long after an upload starts its orphan check runs (the upload is long done by then). */
export const PLATFORM_ICON_ORPHAN_DELAY_MS = 10 * 60 * 1000;

/** The data of a {@link PLATFORM_ICON_DELETE_JOB}. */
export interface PlatformIconDeleteData {
  purpose: PlatformIconPurpose;
  objectKey: string;
}

/**
 * Owes the deletion of a purpose's object in the caller's transaction: at once (`runAt` absent,
 * a replace or clear) or later (an upload's orphan check, under its own id).
 */
export async function owePlatformIconDelete(
  outbox: Pick<OutboxService, "add">,
  purpose: PlatformIconPurpose,
  sha256: string,
  opts: { orphanCheck?: boolean } = {},
): Promise<void> {
  const data: PlatformIconDeleteData = { purpose, objectKey: platformIconKey(purpose, sha256) };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: PLATFORM_ICON_DELETE_JOB,
    jobId: opts.orphanCheck
      ? platformIconOrphanJobId(purpose, sha256)
      : platformIconDeleteJobId(purpose, sha256),
    data,
    ...(opts.orphanCheck && { runAt: new Date(Date.now() + PLATFORM_ICON_ORPHAN_DELAY_MS) }),
  });
}

/**
 * Runs a {@link PLATFORM_ICON_DELETE_JOB} (the maintenance processor dispatches it here). Under
 * the purpose's lock it deletes the object unless the purpose's row names it; delivered twice it
 * is harmless (deleting a missing object is a no-op). A lock it cannot take in time throws, and
 * BullMQ retries the job.
 */
@Injectable()
export class PlatformIconObjects {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "deployment">,
  ) {}

  /** Deletes the object unless the row names it; see the class comment. */
  async deleteObject(data: PlatformIconDeleteData): Promise<void> {
    if (!isIconKeyOf(data.purpose, data.objectKey)) {
      // never delete anything outside the purpose's own icon keys, whatever the job data says
      throw new Error(`platform-icon-delete: unexpected object key for ${data.purpose}`);
    }
    await this.locks.run(platformIconLockKey(data.purpose), PLATFORM_ICON_LOCK, async () => {
      const row = await this.db
        .selectFrom("platform_icons")
        .select("object_key")
        .where("purpose", "=", data.purpose)
        .executeTakeFirst();
      if (row?.object_key === data.objectKey) return;
      await this.storage.deployment().delete(data.objectKey);
    });
  }
}

/** {@link PlatformIconObjects} for the maintenance worker (storage, the database and locks only). */
@Module({
  imports: [StorageModule],
  providers: [PlatformIconObjects],
  exports: [PlatformIconObjects],
})
export class PlatformIconObjectsModule {}
