import {
  UI_ARRANGEABLE_SLOTS,
  UI_CONTRIBUTION_KEY_RE,
  UI_SINGLE_SLOTS,
  type UiSlotId,
  uiSlot,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { UiContributionItem } from "./views.js";

/**
 * Arrangement of UI slots (UI slots spec §5, client extensions spec §6.3): per list slot, which
 * contributions are hidden and in which order; per single slot, which contribution replaces the
 * built-in (`use`, null = the built-in). "Hidden" means not listed and `use` only picks what is
 * listed: the access gate never reads an arrangement, so a contribution's view, action and embed
 * routes keep working for an allowed role whatever the arrangement says.
 */

const Key = z.string().regex(UI_CONTRIBUTION_KEY_RE);
const LIST_MAX = 200;

/** A list slot's entry: the keys hidden and the keys ordered first. */
export const UiListEntrySchema = z
  .object({ hidden: z.array(Key).max(LIST_MAX), order: z.array(Key).max(LIST_MAX) })
  .strict();
export type UiListEntry = z.infer<typeof UiListEntrySchema>;

/** A single slot's entry: the contribution that replaces the built-in, or null for the built-in. */
export const UiUseEntrySchema = z.object({ use: Key.nullable() }).strict();
export type UiUseEntry = z.infer<typeof UiUseEntrySchema>;

/** One slot's entry: `{ hidden, order }` on a list slot, `{ use }` on a single slot. */
export type UiArrangementEntry = UiListEntry | UiUseEntry;

export type UiArrangement = Partial<Record<UiSlotId, UiArrangementEntry>>;

const isSingle = (slot: UiSlotId): boolean => UI_SINGLE_SLOTS.includes(slot);

/**
 * An object over `slots`, each optional and of its kind's entry (nullable in a patch); unknown
 * slots are refused, and so are `use` on a list slot and `hidden` / `order` on a single slot (400
 * `validation_failed` on the settings routes).
 */
function arrangementShape(
  slots: readonly UiSlotId[],
  nullable: boolean,
): z.ZodType<Partial<Record<UiSlotId, UiArrangementEntry | null>>> {
  const shape: Record<string, z.ZodType> = {};
  for (const slot of slots) {
    const entry = isSingle(slot) ? UiUseEntrySchema : UiListEntrySchema;
    shape[slot] = (nullable ? entry.nullable() : entry).optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<
    Partial<Record<UiSlotId, UiArrangementEntry | null>>
  >;
}

export const UiArrangementSchema = arrangementShape(
  UI_ARRANGEABLE_SLOTS,
  false,
) as z.ZodType<UiArrangement>;

/** The slots an org arranges: every arrangeable slot but the platform's own. */
export const ORG_ARRANGEABLE: readonly UiSlotId[] = UI_ARRANGEABLE_SLOTS.filter(
  (s) => s !== "platform.page",
);

/** An org's patch: a slot's entry replaces the stored one, null removes it. */
export const OrgUiArrangementPatchSchema = arrangementShape(ORG_ARRANGEABLE, true);

/** A deployment patch: like {@link OrgUiArrangementPatchSchema} over every arrangeable slot. */
export const UiArrangementPatchSchema = arrangementShape(UI_ARRANGEABLE_SLOTS, true);

/** Merges a per-slot patch into the stored arrangement (null removes the slot's entry). */
export function mergeArrangement(
  current: UiArrangement | undefined,
  patch: Partial<Record<UiSlotId, UiArrangementEntry | null>>,
): UiArrangement {
  const merged: UiArrangement = { ...current };
  for (const [slot, entry] of Object.entries(patch) as [UiSlotId, UiArrangementEntry | null][]) {
    if (entry === null) delete merged[slot];
    else if (entry !== undefined) merged[slot] = entry;
  }
  return merged;
}

const NONE: UiListEntry = { hidden: [], order: [] };

const asList = (e: UiArrangementEntry): UiListEntry => ("hidden" in e ? e : NONE);

/**
 * The list entry that applies to a slot: the org's if it arranged the slot, else the platform's
 * (a `use` entry, which only a single slot stores, reads as none).
 */
export function effectiveEntry(
  org: UiArrangement | undefined,
  platform: UiArrangement,
  slot: UiSlotId,
): { entry: UiListEntry; source: "org" | "platform" | "none" } {
  const o = org?.[slot];
  if (o !== undefined) return { entry: asList(o), source: "org" };
  const p = platform[slot];
  if (p !== undefined) return { entry: asList(p), source: "platform" };
  return { entry: NONE, source: "none" };
}

/**
 * The winner of a single slot (client extensions spec §6.3): the org's entry if it has one, else
 * the platform's, else none. No entry or `use: null` is the built-in (null); a `use` naming a key
 * not in `available` (extension off in the org, contribution dropped, the viewer's role below the
 * slot's) is the built-in too, never the other level's pick. A list slot, or an entry that is not
 * a `use` entry, has no winner.
 */
export function resolveSingleSlot(
  slot: UiSlotId,
  orgEntry: UiArrangementEntry | undefined,
  platformEntry: UiArrangementEntry | undefined,
  available: ReadonlySet<string>,
): string | null {
  if (!isSingle(slot)) return null;
  const entry = orgEntry ?? platformEntry;
  if (entry === undefined || !("use" in entry) || entry.use === null) return null;
  return available.has(entry.use) ? entry.use : null;
}

/** The `use` stored for a single slot: the org's entry if it has one, else the platform's. */
export function storedUse(
  org: UiArrangement | undefined,
  platform: UiArrangement,
  slot: UiSlotId,
): { use: string | null; followsPlatform: boolean } {
  const o = org?.[slot];
  const e = o ?? platform[slot];
  return {
    use: e !== undefined && "use" in e ? e.use : null,
    followsPlatform: o === undefined,
  };
}

const keyOf = (i: UiContributionItem) => `${i.plugin}/${i.id}`;

/**
 * Orders the items of one slot (hidden ones stay in place): grouped by anchor in the slot's anchor
 * order, also without an entry (the lists match what the page renders per anchor); within a group
 * the keys of `entry.order` come first in that order, the rest in base order. Unknown keys are
 * ignored, so an order never moves an item across anchors.
 */
export function orderItems(items: UiContributionItem[], entry: UiListEntry): UiContributionItem[] {
  const anchors = items[0] === undefined ? undefined : uiSlot(items[0].slot)?.anchors;
  const groupOf = (i: UiContributionItem) =>
    anchors === undefined ? 0 : Math.max(0, anchors.indexOf(i.after ?? anchors[0] ?? ""));
  const rank = new Map(entry.order.map((k, n) => [k, n]));
  return items
    .map((item, base) => ({ item, base }))
    .sort((a, b) => {
      const g = groupOf(a.item) - groupOf(b.item);
      if (g !== 0) return g;
      const ra = rank.get(keyOf(a.item));
      const rb = rank.get(keyOf(b.item));
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.base - b.base;
    })
    .map((x) => x.item);
}

/** {@link orderItems} without the hidden keys. */
export function arrange(items: UiContributionItem[], entry: UiListEntry): UiContributionItem[] {
  const hidden = new Set(entry.hidden);
  return orderItems(items, entry).filter((i) => !hidden.has(keyOf(i)));
}

/**
 * Applies the per-slot entries to a mixed list: each slot's items are arranged and written back
 * into the positions that slot occupied (a slot without an entry: its base order, grouped by
 * anchor).
 */
export function arrangeBySlot(
  items: UiContributionItem[],
  entryOf: (slot: UiSlotId) => UiListEntry,
): UiContributionItem[] {
  const bySlot = new Map<UiSlotId, number[]>();
  items.forEach((i, n) => {
    const at = bySlot.get(i.slot);
    if (at) at.push(n);
    else bySlot.set(i.slot, [n]);
  });
  const out: (UiContributionItem | undefined)[] = [...items];
  for (const [slot, at] of bySlot) {
    const arranged = arrange(
      at.map((n) => items[n] as UiContributionItem),
      entryOf(slot),
    );
    at.forEach((n, j) => {
      out[n] = arranged[j];
    });
  }
  return out.filter((i): i is UiContributionItem => i !== undefined);
}
