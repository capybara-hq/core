// Owners of catalog items and platform components, and the share gate (plugin scope phase 3, spec
// §14, rulings P3-1, P3-16, P3-17). An item or component is owned by the platform
// (`owner_org_id` null) or by one org; an org-owned one reaches other orgs only while its owner
// makes it shareable. Every writer that shows an item to another org or associates one checks the
// gate on the row it writes, read `FOR UPDATE` in its transaction.
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import {
  type ComponentKind,
  componentOn,
  listedIn,
  loadComponents,
  loadScopeState,
  pluginFactsOf,
  switchOf,
} from "./component-state.js";
import { type PluginScope, wantedOn } from "./scope.js";

/** Who owns an item or component: the platform, or one org (by id and name, deleted orgs too). */
export type Owner = { kind: "platform" } | { kind: "org"; orgId: string; name: string };

export const PLATFORM_OWNER: Owner = { kind: "platform" };

/**
 * The share gate (P3-1): a platform item, or an org-owned one its owner made shareable. Closed:
 * the item is never shown, requestable or associable outside its owner (orgs already associated
 * keep it).
 */
export function shareGate(row: { owner_org_id: string | null; shareable: boolean }): boolean {
  return row.owner_org_id === null || row.shareable;
}

/** 409 `catalog.not_shareable` unless the row passes the {@link shareGate} (P3-16). */
export function assertShareable(row: {
  owner_org_id: string | null;
  shareable: boolean;
  name: string;
}): void {
  if (shareGate(row)) return;
  throw new ApiError(
    "catalog.not_shareable",
    `${row.name} is owned by an organization that has not made it shareable`,
  );
}

/**
 * 409 `catalog.owner_required` when a `named` list after a change leaves out the item's owner org
 * (P3-17: the owner stays on its own item's list).
 */
export function assertOwnerListed(
  row: { owner_org_id: string | null; name: string },
  target: { scope: string; orgs: readonly string[] },
): void {
  if (row.owner_org_id === null || target.scope !== "named") return;
  if (target.orgs.includes(row.owner_org_id)) return;
  throw new ApiError(
    "catalog.owner_required",
    `${row.name} is owned by an organization that must stay on its list`,
  );
}

const BREADTH: Record<string, number> = { named: 0, optional: 1, all: 2 };

/**
 * A widening of the scope for a row that does not pass the share gate -> 409
 * `catalog.not_shareable`: a broader scope (`named` < `optional` < `all`), or, `named` to `named`,
 * an org not on the list before the change. Narrowing is always allowed (P3-16).
 */
export function assertShareableTarget(
  row: { owner_org_id: string | null; shareable: boolean; name: string },
  from: { scope: string; orgs: readonly string[] },
  target: { scope: string; orgs: readonly string[] },
): void {
  if (shareGate(row)) return;
  const wider = (BREADTH[target.scope] ?? 2) > (BREADTH[from.scope] ?? 2);
  const known = new Set(from.orgs);
  const added =
    from.scope === "named" && target.scope === "named" && target.orgs.some((o) => !known.has(o));
  if (wider || added) assertShareable(row);
}

/** The facts {@link isUsable} and {@link usableBy} read from a `catalog_items` row. */
export interface UsableFacts {
  scope: PluginScope;
  builtin: boolean;
  disabled: boolean;
  deleted_at: Date | null;
  awaiting_confirmation: boolean;
  owner_org_id: string | null;
  shareable: boolean;
}

/**
 * Whether an item can serve anything at all (ruling P3-9, F12): confirmed (not a first upload
 * still waiting for the super admin), not disabled and not deleted. The one predicate for the
 * dependency check of org uploads (P3-13), the scope sync, org switches and installs.
 */
export function isUsable(
  item: Pick<UsableFacts, "disabled" | "deleted_at" | "awaiting_confirmation">,
): boolean {
  return !item.awaiting_confirmation && !item.disabled && item.deleted_at === null;
}

/**
 * 409 `catalog.item_pending`: the item, or the version asked for, waits for the super admin's
 * confirmation in 待确认 (ruling P3-9): no scope edit, switch, install or generic update.
 */
export function itemPendingError(name: string, version?: string): ApiError {
  return new ApiError(
    "catalog.item_pending",
    version === undefined
      ? `${name} waits for a super admin to confirm its extension; confirm or reject it in 待确认 first`
      : `Version ${version} of ${name} waits for a super admin to confirm its extension; confirm it in 待确认`,
  );
}

/**
 * 409 `catalog.item_removed`: the item was removed while a super admin confirmation of its upload
 * was running (ruling P3-21).
 */
export function itemRemovedError(name: string): ApiError {
  return new ApiError(
    "catalog.item_removed",
    `${name} was removed while its confirmation was running; nothing of it stays installed`,
  );
}

/** 409 `catalog.item_pending` while the item's first version waits for the super admin (P3-9). */
export function assertNotAwaiting(item: { awaiting_confirmation: boolean; name: string }): void {
  if (item.awaiting_confirmation) throw itemPendingError(item.name);
}

/**
 * The digest a super admin confirms an org upload's pending version with (rulings P3-10, P3-11):
 * the extension's permission review digest bound to the exact package, so a pending version
 * replaced by another upload is stale even when both ask for the same permissions.
 */
export function pendingDigest(sha256: string, reviewHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ sha256, reviewHash }))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Releases the extension name an org upload claimed (pre-flight F10), in the caller's
 * transaction, when nothing is installed under it: a rejected or withdrawn upload, a pending first
 * version replaced by one without an extension, a deleted org's pending upload. An installed
 * extension keeps its claim (its removal is the cleanup job's).
 */
export async function releaseExtensionClaim(
  db: KernelSchemaDb,
  name: string,
  packageName: string | null,
): Promise<void> {
  if (packageName === null) return;
  const installed = await db
    .selectFrom("extension_installs")
    .select("name")
    .where("name", "=", name)
    .executeTakeFirst();
  if (installed !== undefined) return;
  await db
    .deleteFrom("extension_name_owners")
    .where("name", "=", name)
    .where("package_name", "=", packageName)
    .execute();
}

/**
 * Whether `orgId` can use the item (P3-13): {@link isUsable}, and its owner, or listed by a `named`
 * scope (an org already associated keeps it), or offered to every org (`all` / `optional`, builtin)
 * through the {@link shareGate} (another org's item only while it is shared).
 */
export function usableBy(item: UsableFacts, orgId: string, listed: boolean): boolean {
  if (!isUsable(item)) return false;
  if (item.owner_org_id === orgId) return true;
  if (!item.builtin && item.scope === "named") return listed;
  return listed || shareGate(item);
}

/**
 * The owner of the live catalog item called `name` when it is not `owner` (null = the platform),
 * else undefined: a plugin name is live for one owner only (ruling P3-14).
 */
export async function otherNameOwner(
  db: KernelSchemaDb,
  name: string,
  owner: string | null,
): Promise<Owner | undefined> {
  const live = await db
    .selectFrom("catalog_items")
    .select("owner_org_id")
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (live === undefined || live.owner_org_id === owner) return undefined;
  const ids = live.owner_org_id === null ? [] : [live.owner_org_id];
  return ownerOf(live.owner_org_id, await ownersOf(db, ids));
}

/**
 * 409 `plugin.name_taken` (details `[{ owner }]`) when the plugin name is live for another owner
 * than `owner` (null = the platform): an org cannot upload a platform's or another org's name, and
 * the super admin cannot import an org's (ruling P3-14). The same owner adds a version.
 */
export async function assertNameFree(
  db: KernelSchemaDb,
  name: string,
  owner: string | null,
): Promise<void> {
  const other = await otherNameOwner(db, name, owner);
  if (other === undefined) return;
  throw new ApiError(
    "plugin.name_taken",
    other.kind === "platform"
      ? `Plugin name ${name} is taken by the platform`
      : `Plugin name ${name} is taken by organization ${other.name}`,
    [{ owner: other }],
  );
}

/**
 * The owner other than `owner` (an org id) that already holds npm package `packageName`, else
 * undefined (ruling P3-51: a package name is an identity only within one owner). Held = a catalog
 * item of the package of another owner that is live, or removed while its extension is still
 * installed or its name claimed (a cleanup not run yet); an install of the package whose catalog
 * item is not one of `owner`'s (none = the platform: bootstrap or a direct install); a name claim
 * of the package for which `owner` has no item of that name (an uninstalled platform extension
 * keeps its claim).
 */
export async function otherPackageOwner(
  db: KernelSchemaDb,
  packageName: string | null,
  owner: string,
): Promise<Owner | undefined> {
  if (packageName === null) return undefined;
  const found = async (ownerOrgId: string | null) =>
    ownerOf(ownerOrgId, await ownersOf(db, ownerOrgId === null ? [] : [ownerOrgId]));
  const item = await db
    .selectFrom("catalog_items as ci")
    .select("ci.owner_org_id")
    .where("ci.package_name", "=", packageName)
    .where(sql<boolean>`ci.owner_org_id IS DISTINCT FROM ${owner}`)
    .where(({ or, eb, exists, selectFrom }) =>
      or([
        eb("ci.deleted_at", "is", null),
        exists(
          selectFrom("extension_installs as x")
            .innerJoin("extension_packages as p", "p.sha256", "x.sha256")
            .select("x.name")
            .whereRef("x.name", "=", "ci.name")
            .whereRef("p.package_name", "=", "ci.package_name"),
        ),
        exists(
          selectFrom("extension_name_owners as o")
            .select("o.name")
            .whereRef("o.name", "=", "ci.name")
            .whereRef("o.package_name", "=", "ci.package_name"),
        ),
      ]),
    )
    .orderBy("ci.deleted_at", (o) => o.desc().nullsFirst())
    .orderBy("ci.created_at")
    .executeTakeFirst();
  if (item !== undefined) return found(item.owner_org_id);
  const install = await db
    .selectFrom("extension_installs as x")
    .innerJoin("extension_packages as p", "p.sha256", "x.sha256")
    .leftJoin("catalog_items as ci", "ci.id", "x.catalog_item_id")
    .select(["ci.id", "ci.owner_org_id"])
    .where("p.package_name", "=", packageName)
    .where((eb) =>
      eb.or([eb("ci.id", "is", null), eb("ci.owner_org_id", "is distinct from", owner)]),
    )
    .executeTakeFirst();
  if (install !== undefined) return found(install.id === null ? null : install.owner_org_id);
  const claim = await db
    .selectFrom("extension_name_owners as o")
    .select("o.name")
    .where("o.package_name", "=", packageName)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("catalog_items as ci")
            .select("ci.id")
            .whereRef("ci.name", "=", "o.name")
            .whereRef("ci.package_name", "=", "o.package_name")
            .where("ci.owner_org_id", "=", owner),
        ),
      ),
    )
    .executeTakeFirst();
  if (claim !== undefined) return packageOwner(db, packageName, claim.name);
  return undefined;
}

/**
 * 409 `plugin.name_taken` (details `[{ owner }]`) when an org upload's npm package is held by
 * another owner ({@link otherPackageOwner}, ruling P3-51): an org never shares a package identity
 * with another org or the platform, so no name claim, existing install or cleanup can mistake one
 * owner's plugin for another's.
 */
export async function assertPackageFree(
  db: KernelSchemaDb,
  packageName: string | null,
  owner: string,
): Promise<void> {
  const other = await otherPackageOwner(db, packageName, owner);
  if (other === undefined) return;
  throw new ApiError(
    "plugin.name_taken",
    other.kind === "platform"
      ? `Package ${packageName} is used by a plugin of the platform; rename the package (package.json name) and upload it again`
      : `Package ${packageName} is used by a plugin of organization ${other.name}; rename the package (package.json name) and upload it again`,
    [{ owner: other }],
  );
}

/**
 * The owner of extension `extensionName`, held by npm package `packageName` (package -> its live
 * catalog item -> that item's owner; ruling P3-14). The item is the one named like the extension
 * (a plugin and its extension share one name), else the oldest live item of the package; none ->
 * the platform (an extension installed outside the catalog is the super admin's).
 */
export async function packageOwner(
  db: KernelSchemaDb,
  packageName: string | null,
  extensionName: string,
): Promise<Owner> {
  if (packageName === null) return PLATFORM_OWNER;
  const item = await db
    .selectFrom("catalog_items")
    .select("owner_org_id")
    .where("package_name", "=", packageName)
    .where("deleted_at", "is", null)
    .orderBy(sql`name = ${extensionName}`, "desc")
    .orderBy("created_at")
    .orderBy("id")
    .executeTakeFirst();
  const id = item?.owner_org_id ?? null;
  return ownerOf(id, await ownersOf(db, id === null ? [] : [id]));
}

/** The owners of `orgIds` by org id (deleted orgs included, by their name). */
export async function ownersOf(
  db: KernelSchemaDb,
  orgIds: readonly string[],
): Promise<Map<string, Owner>> {
  const ids = [...new Set(orgIds)];
  const out = new Map<string, Owner>();
  if (ids.length === 0) return out;
  const rows = await db.selectFrom("orgs").select(["id", "name"]).where("id", "in", ids).execute();
  for (const r of rows) out.set(r.id, { kind: "org", orgId: r.id, name: r.name });
  return out;
}

/** The {@link Owner} of a row from {@link ownersOf}'s map (an org row gone: its id as the name). */
export function ownerOf(ownerOrgId: string | null, owners: ReadonlyMap<string, Owner>): Owner {
  if (ownerOrgId === null) return PLATFORM_OWNER;
  return owners.get(ownerOrgId) ?? { kind: "org", orgId: ownerOrgId, name: ownerOrgId };
}

/** An owned item: a plugin, a skill or an agent template (the platform id once promoted). */
export type OwnedRef = { kind: "plugin" | "skill" | "agent_template"; id: string };

/**
 * The live orgs an item is on in (ruling P3-18: listed and not switched off for `named`, switched
 * on for `optional`, any live org for `all`; a component by {@link componentOn}), minus
 * `except` (usually the owner), by name. One definition for the update notices and the
 * "used by another org" check of deletes. An item that is gone or disabled is on nowhere.
 */
export async function orgsUsing(
  db: KernelSchemaDb,
  ref: OwnedRef,
  opts: { except?: string | null } = {},
): Promise<{ id: string; name: string }[]> {
  const orgs = await db
    .selectFrom("orgs")
    .select(["id", "name"])
    .where("deleted_at", "is", null)
    .orderBy("name")
    .orderBy("id")
    .execute();
  const others = orgs.filter((o) => o.id !== opts.except);
  if (others.length === 0) return [];
  if (ref.kind === "plugin") {
    const item = await db
      .selectFrom("catalog_items")
      .select(["scope", "builtin", "disabled"])
      .where("id", "=", ref.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) return [];
    const listed = new Set(
      (
        await db
          .selectFrom("catalog_item_scope_orgs")
          .select("org_id")
          .where("item_id", "=", ref.id)
          .execute()
      ).map((r) => r.org_id),
    );
    const switches = new Map(
      (
        await db
          .selectFrom("catalog_item_org_switches")
          .select(["org_id", "enabled"])
          .where("item_id", "=", ref.id)
          .execute()
      ).map((r) => [r.org_id, r.enabled] as const),
    );
    return others.filter((o) => wantedOn(item, listed.has(o.id), switches.get(o.id) ?? null));
  }
  const kind: ComponentKind = ref.kind;
  const [c] = await loadComponents(db, kind, { ids: [ref.id] });
  if (!c) return [];
  const st = await loadScopeState(db, kind, [c]);
  return others.filter((o) =>
    componentOn(
      c,
      pluginFactsOf(st, c.itemId, o.id),
      listedIn(st, c.id, o.id),
      switchOf(st, c.id, o.id),
    ),
  );
}

/**
 * Who a scope change newly shows an org-owned item to (the `item_shared` notice, P3-22): the orgs
 * added to a `named` list, or `all_orgs` when the scope gets broader (`named` < `optional` < `all`);
 * nothing for a narrowing or a platform-owned item.
 */
export function newlySharedWith(
  from: { scope: string; orgs: readonly string[] },
  to: { scope: string; orgs: readonly string[] },
): string[] | "all_orgs" {
  if ((BREADTH[to.scope] ?? 2) > (BREADTH[from.scope] ?? 2)) return "all_orgs";
  if (from.scope === "named" && to.scope === "named") {
    const known = new Set(from.orgs);
    return to.orgs.filter((o) => !known.has(o));
  }
  return [];
}
