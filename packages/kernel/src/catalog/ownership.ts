// Owners of catalog items and platform components, and the share gate (plugin scope phase 3, spec
// §14, rulings P3-1, P3-16, P3-17). An item or component is owned by the platform
// (`owner_org_id` null) or by one org; an org-owned one reaches other orgs only while its owner
// makes it shareable. Every writer that shows an item to another org or associates one checks the
// gate on the row it writes, read `FOR UPDATE` in its transaction.
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
 * The owner of the extension name an npm package holds (package -> its live catalog item -> that
 * item's owner; ruling P3-14): the platform when no live item carries the package.
 */
export async function packageOwner(db: KernelSchemaDb, packageName: string | null): Promise<Owner> {
  if (packageName === null) return PLATFORM_OWNER;
  const item = await db
    .selectFrom("catalog_items")
    .select("owner_org_id")
    .where("package_name", "=", packageName)
    .where("deleted_at", "is", null)
    .orderBy("owner_org_id")
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
