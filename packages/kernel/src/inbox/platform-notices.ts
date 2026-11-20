// Platform notices (`platform_notices`, plugin scope phase 3, ruling P3-22): what the super admins
// are told, until any one of them dismisses it. Written in the caller's transaction.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OwnedRef } from "../catalog/ownership.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

export type PlatformNoticeKind = "ownership_transferred" | "push_auth_failed";

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
  /**
   * A push provider's credentials were refused on a delivery (mobile app spec §9.2); at most one
   * open notice per plugin ({@link addPushAuthNotice}).
   */
  push_auth_failed: { plugin: string };
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

/**
 * Tells the super admins that `plugin`'s push credentials were refused, unless a notice of that
 * kind naming the plugin is still open. The partial unique index
 * `platform_notices_push_auth_open_idx` (migration 0172) keeps it at one open notice per plugin
 * even when deliveries on several replicas fail at once.
 */
export async function addPushAuthNotice(db: KernelSchemaDb, plugin: string): Promise<void> {
  const detail: PlatformNoticeDetails["push_auth_failed"] = { plugin };
  await db
    .insertInto("platform_notices")
    .values({ id: randomUUID(), kind: "push_auth_failed", detail: JSON.stringify(detail) })
    .onConflict((oc) =>
      oc
        .expression(sql`(detail ->> 'plugin')`)
        // literals, not parameters: PostgreSQL matches the partial index's predicate textually
        .where("kind", "=", sql.lit("push_auth_failed"))
        .where("dismissed_at", "is", null)
        .doNothing(),
    )
    .execute();
}
