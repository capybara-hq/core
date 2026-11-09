import {
  UI_ARRANGEABLE_SLOTS,
  UI_CONTRIBUTION_KEY_RE,
  type UiSlotId,
  uiSlot,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { UiContributionItem } from "./views.js";

/**
 * Arrangement of UI slots (UI slots spec §5): per slot, which contributions are hidden and in
 * which order. "Hidden" means not listed: the access gate never reads an arrangement, so a hidden
 * contribution's view, action and embed routes keep working for an allowed role.
 */

const Key = z.string().regex(UI_CONTRIBUTION_KEY_RE);
const LIST_MAX = 200;

export const UiArrangementEntrySchema = z
  .object({ hidden: z.array(Key).max(LIST_MAX), order: z.array(Key).max(LIST_MAX) })
  .strict();
export type UiArrangementEntry = z.infer<typeof UiArrangementEntrySchema>;

export const UiArrangementSchema = z.partialRecord(
  z.enum(UI_ARRANGEABLE_SLOTS),
  UiArrangementEntrySchema,
);
export type UiArrangement = z.infer<typeof UiArrangementSchema>;

/** The slots an org arranges: every arrangeable slot but the platform's own. */
export const ORG_ARRANGEABLE: readonly UiSlotId[] = UI_ARRANGEABLE_SLOTS.filter(
  (s) => s !== "platform.page",
);

/** An org's patch: a slot's entry replaces the stored one, null removes it. */
export const OrgUiArrangementPatchSchema = z.partialRecord(
  z.enum(ORG_ARRANGEABLE),
  UiArrangementEntrySchema.nullable(),
);

/** A deployment patch: like {@link OrgUiArrangementPatchSchema} over every arrangeable slot. */
export const UiArrangementPatchSchema = z.partialRecord(
  z.enum(UI_ARRANGEABLE_SLOTS),
  UiArrangementEntrySchema.nullable(),
);

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

const NONE: UiArrangementEntry = { hidden: [], order: [] };

/** The entry that applies to a slot: the org's if it arranged the slot, else the platform's. */
export function effectiveEntry(
  org: UiArrangement | undefined,
  platform: UiArrangement,
  slot: UiSlotId,
): { entry: UiArrangementEntry; source: "org" | "platform" | "none" } {
  const o = org?.[slot];
  if (o !== undefined) return { entry: o, source: "org" };
  const p = platform[slot];
  if (p !== undefined) return { entry: p, source: "platform" };
  return { entry: NONE, source: "none" };
}

const keyOf = (i: UiContributionItem) => `${i.plugin}/${i.id}`;

/**
 * Orders the items of one slot (hidden ones stay in place): grouped by anchor in the slot's anchor
 * order, also without an entry (the lists match what the page renders per anchor); within a group
 * the keys of `entry.order` come first in that order, the rest in base order. Unknown keys are
 * ignored, so an order never moves an item across anchors.
 */
export function orderItems(
  items: UiContributionItem[],
  entry: UiArrangementEntry,
): UiContributionItem[] {
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
export function arrange(
  items: UiContributionItem[],
  entry: UiArrangementEntry,
): UiContributionItem[] {
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
  entryOf: (slot: UiSlotId) => UiArrangementEntry,
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
