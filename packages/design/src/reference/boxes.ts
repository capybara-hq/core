/**
 * The box-in-box guard (spec §1 "One box is enough", §9.1): finds a boxed design component drawn
 * inside another boxed design component in a rendered DOM tree (jsdom in the design and web
 * tests). A box is anything with its own border, hairline or filled ground around content.
 */

/** One kind of box, by the markup the design package draws for it. */
export type BoxRule = { name: string; selector: string };

/**
 * Every box the design package draws (the inventory of acceptance item AB). A component that has
 * an unboxed form inside a box is listed by its boxed form only, so its unboxed form never counts.
 */
export const BOXES: readonly BoxRule[] = [
  { name: "Card", selector: ".cb-card" },
  { name: "FormSection card", selector: ".cb-form-section-fields" },
  { name: "Dialog", selector: ".cb-dialog" },
  { name: "Sheet", selector: ".cb-sheet" },
  { name: "Popover", selector: ".cb-popover" },
  { name: "properties sheet", selector: ".cb-conv-sheet" },
  { name: "InlineCard", selector: ".cb-icard" },
  { name: "PropertySection", selector: '.cb-property-section:not([data-inset="box"])' },
  { name: "DataTable frame", selector: '.cb-table[data-framed="true"] .cb-table-panel' },
  { name: "ObjectList", selector: ".cb-object-list" },
  { name: "Callout", selector: ".cb-callout" },
  { name: "DangerZone", selector: ".cb-danger-zone" },
  { name: "LinkCard", selector: ".cb-link-card" },
  { name: "StatCard", selector: ".cb-stat-card" },
  { name: "Repeater card", selector: '.cb-repeater[data-variant="cards"] .cb-repeater-item' },
  { name: "CodeBlock", selector: '.cb-code:not([data-framed="false"])' },
  { name: "EmbedFrame", selector: '.cb-embed:not([data-framed="false"])' },
  { name: "FilePicker", selector: ".cb-file-picker" },
  { name: "option card", selector: '.cb-radio[data-variant="card"]' },
];

/*
 * Not boxes: KeyValue, Disclosure (a 1px guide), ContentSection, Subsection, ItemList and
 * SwitchList rows, Repeater rows and divided items, StepList; and IoBlock, whose only mark is a
 * `panel` fill, a card's own ground, so inside a card it draws nothing around its text (the
 * trajectory's IN / OUT blocks share the ground, acceptance item AB "borderline").
 */

/**
 * Full-height panes (spec §1): a pane holds content like a page, so a box inside it is on its
 * ground, not inside a box, even when the narrow layout puts the pane in a Sheet. The agent map's
 * transcript (level 3) is one: its thread renders as in the main chat.
 */
export const PANES: readonly string[] = [".cb-rpanel", ".cb-amap-transcript"];

/** An allowed box inside a box, with the reason the rule makes an exception for it. */
export type BoxException = {
  inner: string;
  /** The enclosing box's name; any box when unset. */
  outer?: string;
  reason: string;
};

/**
 * The exceptions of spec §1. Form controls (inputs, textareas, selects, steppers, the key-value
 * editor's inputs) are not in {@link BOXES} at all: a control's border says "type here", it does
 * not group content.
 */
export const BOX_EXCEPTIONS: readonly BoxException[] = [
  {
    inner: "option card",
    reason:
      "card radios are a choice between options (sandbox 直接执行 / 需要审批), drawn as cards inside a form card on purpose (spec §6.3)",
  },
  {
    inner: "FilePicker",
    outer: "Dialog",
    reason:
      "a dialog's one file drop zone is a control (a dashed target to drop on), not a group (spec §6.25)",
  },
];

export type NestedBox = {
  outer: string;
  inner: string;
  /** The inner box element, for a test's message. */
  element: Element;
};

function boxOf(el: Element): string | undefined {
  for (const b of BOXES) if (el.matches(b.selector)) return b.name;
  return undefined;
}

function allowed(inner: string, outer: string): boolean {
  return BOX_EXCEPTIONS.some(
    (e) => e.inner === inner && (e.outer === undefined || e.outer === outer),
  );
}

/**
 * Every boxed element under `root` whose nearest boxed ancestor (below `root`, and not across a
 * pane) is another box, except the {@link BOX_EXCEPTIONS}. `root` itself may be a box: its own
 * descendants are then checked against it.
 */
export function findNestedBoxes(root: Element): NestedBox[] {
  const out: NestedBox[] = [];
  const selector = BOXES.map((b) => b.selector).join(", ");
  for (const el of Array.from(root.querySelectorAll(selector))) {
    const inner = boxOf(el);
    if (inner === undefined) continue;
    let up = el.parentElement;
    while (up !== null) {
      if (PANES.some((p) => up?.matches(p))) break;
      const outer = boxOf(up);
      if (outer !== undefined) {
        if (!allowed(inner, outer)) out.push({ outer, inner, element: el });
        break;
      }
      if (up === root) break;
      up = up.parentElement;
    }
  }
  return out;
}

/** A finding as one line: `<inner> inside <outer>: <first words of its text>`. */
export function describeNestedBox(f: NestedBox): string {
  const text = (f.element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return `${f.inner} inside ${f.outer}${text ? `: ${text}` : ""}`;
}
