import type { UiContribution } from "./ui.js";
import { PLACE_SLOTS, parseSlotRef, type UiSlotSpec, uiSlot } from "./ui-slots.js";

/** A contribution whose slot the catalog knows at the version it names (UI slots spec §3.2). */
export interface ResolvedUiContribution {
  contribution: UiContribution;
  slot: UiSlotSpec;
  version: number;
  /**
   * For a slot with anchors: the anchor it goes after (the contribution's own `after` when it is one
   * of the slot's anchors, else the slot's first anchor). Absent for a slot without anchors.
   */
  after?: string;
}

/** Why a contribution was dropped: its slot is not in the catalog, or not at that version. */
export type UiDropReason = "unknown-slot" | "unsupported-version";

/** A contribution left out of the loaded extension; `ref` is the slot reference it names. */
export interface DroppedUiContribution {
  id: string;
  ref: string;
  reason: UiDropReason;
}

/** The slot reference a contribution names: its `slot`, or the slot of its deprecated `place`. */
export function slotRefOf(c: UiContribution): string {
  // biome-ignore lint/style/noNonNullAssertion: validateUiContributions requires slot or place
  return c.slot ?? PLACE_SLOTS[c.place!];
}

/**
 * Resolves the slots of a manifest's `ui` against the catalog (UI slots spec §3.2). Assumes
 * `validateUiContributions` passed; never throws. A contribution to an unknown slot or to a version
 * other than the slot's is dropped (an alias whose target is dropped is dropped with the target's
 * reason and its own `ref`); an `after` that is not an anchor of the slot is listed in
 * `unknownAnchors` and the contribution keeps the slot's default position. `deprecatedPlace` lists
 * the ids that still say `place`. Both lists keep manifest order.
 */
export function resolveUiSlots(ui: readonly UiContribution[] | undefined): {
  resolved: ResolvedUiContribution[];
  dropped: DroppedUiContribution[];
  unknownAnchors: { id: string; after: string }[];
  deprecatedPlace: string[];
} {
  const list = ui ?? [];
  type Own = { ok: true; slot: UiSlotSpec; version: number } | { ok: false; reason: UiDropReason };
  const own = new Map<string, Own>();
  for (const c of list) {
    const ref = parseSlotRef(slotRefOf(c));
    const slot = ref === null ? undefined : uiSlot(ref.id);
    own.set(
      c.id,
      ref === null || slot === undefined
        ? { ok: false, reason: "unknown-slot" }
        : ref.version !== slot.version
          ? { ok: false, reason: "unsupported-version" }
          : { ok: true, slot, version: ref.version },
    );
  }
  const resolved: ResolvedUiContribution[] = [];
  const dropped: DroppedUiContribution[] = [];
  const unknownAnchors: { id: string; after: string }[] = [];
  const deprecatedPlace: string[] = [];
  for (const c of list) {
    if (c.slot === undefined && c.place !== undefined) deprecatedPlace.push(c.id);
    const mine = own.get(c.id) as Own;
    const target = c.aliasOf === undefined ? undefined : own.get(c.aliasOf);
    const r = mine.ok && target !== undefined && !target.ok ? target : mine;
    if (!r.ok) {
      dropped.push({ id: c.id, ref: slotRefOf(c), reason: r.reason });
      continue;
    }
    const anchors = r.slot.anchors ?? [];
    if (c.after !== undefined && !anchors.includes(c.after)) {
      unknownAnchors.push({ id: c.id, after: c.after });
    }
    const after =
      c.after !== undefined && anchors.includes(c.after) ? c.after : (anchors[0] as string);
    resolved.push({
      contribution: c,
      slot: r.slot,
      version: r.version,
      ...(anchors.length > 0 && { after }),
    });
  }
  return { resolved, dropped, unknownAnchors, deprecatedPlace };
}
