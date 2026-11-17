import { resolveUiSlots, type UiContribution } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

/**
 * Slot problems of a manifest's `ui` (UI slots spec §3.2): a slot or version this SDK does not know
 * (`ui-slot-unknown`, error: the host drops the contribution), an `after` that is no anchor of the
 * slot (`ui-slot-anchor`, error).
 */
export function uiSlotFindings(file: string, ui: unknown): Finding[] {
  if (!Array.isArray(ui)) return [];
  const r = resolveUiSlots(ui as UiContribution[]);
  const out: Finding[] = [];
  const at = (rule: string, message: string): void => {
    out.push({ file, line: 1, rule, message });
  };
  for (const d of r.dropped) {
    at(
      "ui-slot-unknown",
      `ui "${d.id}" names slot ${d.ref}, which this SDK does not know (${d.reason}); the host would drop it`,
    );
  }
  for (const a of r.unknownAnchors) {
    const c = (ui as UiContribution[]).find((x) => x.id === a.id);
    const ref = r.resolved.find((x) => x.contribution.id === a.id);
    const anchors = ref?.slot.anchors ?? [];
    at(
      "ui-slot-anchor",
      `ui "${a.id}" has after "${a.after}", which is not an anchor of slot ${ref?.slot.id ?? c?.slot}; the anchors are ${anchors.join(", ")}`,
    );
  }
  return out;
}
