// Platform notices (`platform_notices`, plugin scope phase 3, ruling P3-22): what the super admins
// are told, until any one of them dismisses it. Written in the caller's transaction.
import { randomUUID } from "node:crypto";
import type { OwnedRef } from "../catalog/ownership.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

export type PlatformNoticeKind = "ownership_transferred";

/** The `detail` of each platform notice kind. */
export interface PlatformNoticeDetails {
  /** A deleted org's (or owner's) shared item now belongs to the platform. */
  ownership_transferred: {
    ref: OwnedRef;
    name: string;
    fromOrg: { id: string; name: string };
    reason: "owner_deleted" | "org_deleted";
    /** How many other orgs use it. */
    usedBy: number;
  };
}

export async function addPlatformNotice<K extends PlatformNoticeKind>(
  db: KernelSchemaDb,
  kind: K,
  detail: PlatformNoticeDetails[K],
): Promise<void> {
  await db
    .insertInto("platform_notices")
    .values({ id: randomUUID(), kind, detail: JSON.stringify(detail) })
    .execute();
}
