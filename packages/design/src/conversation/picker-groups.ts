import type { PickerItem, PickerProps } from "./composer";

// A long picker's list (spec §6.16.2, §6.16.3; the model picker): above LONG_PICKER_THRESHOLD
// items it gets a search field, and the checked item and the pinned ones (the agent's default
// model) move to a small group of their own before the provider groups.

/** A picker with more items than this is long: a search field and the pinned group. */
export const LONG_PICKER_THRESHOLD = 8;

/** An item of an arranged list: `keywords` is what the search matches besides its label. */
export type ArrangedPickerItem = PickerItem & { keywords?: string };

export type ArrangedPickerGroup = {
  /** Stable within one list: `pinned`, or the group's position in the picker's groups. */
  key: string;
  label?: string;
  pinned?: boolean;
  items: ArrangedPickerItem[];
};

/** How many items a picker lists. */
export function pickerItemCount(groups: PickerProps["groups"]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

/**
 * The picker's groups for a list that may be long: each item keeps its group's label as its
 * `keywords` (a model is found by its provider's name too). A long list (more than
 * {@link LONG_PICKER_THRESHOLD} items) starts with a group labelled `pinnedLabel` holding the
 * checked item, then the `pinned` ones, each moved out of its own group (a group left empty
 * goes); a short list keeps the picker's groups as they are.
 */
export function arrangePickerGroups(
  groups: PickerProps["groups"],
  pinnedLabel: string,
): ArrangedPickerGroup[] {
  const all: ArrangedPickerGroup[] = groups.map((g, i) => ({
    key: `g${i}`,
    ...(g.label !== undefined ? { label: g.label } : {}),
    items: g.items.map((it) => (g.label !== undefined ? { ...it, keywords: g.label } : it)),
  }));
  if (pickerItemCount(groups) <= LONG_PICKER_THRESHOLD) return all;
  const items = all.flatMap((g) => g.items);
  const pinned = [
    ...items.filter((it) => it.checked === true),
    ...items.filter((it) => it.checked !== true && it.pinned === true),
  ];
  if (pinned.length === 0) return all;
  const moved = new Set(pinned);
  const rest = all
    .map((g) => ({ ...g, items: g.items.filter((it) => !moved.has(it)) }))
    .filter((g) => g.items.length > 0);
  return [{ key: "pinned", label: pinnedLabel, pinned: true, items: pinned }, ...rest];
}

/**
 * The groups a search keeps: the items whose label or keywords hold the query (trimmed, case
 * insensitive), each in its group; a group with no match goes. An empty query keeps everything.
 */
export function filterPickerGroups(
  groups: ArrangedPickerGroup[],
  query: string,
): ArrangedPickerGroup[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return groups;
  const hit = (it: ArrangedPickerItem) =>
    it.label.toLocaleLowerCase().includes(q) ||
    (it.keywords?.toLocaleLowerCase().includes(q) ?? false);
  return groups
    .map((g) => ({ ...g, items: g.items.filter(hit) }))
    .filter((g) => g.items.length > 0);
}
