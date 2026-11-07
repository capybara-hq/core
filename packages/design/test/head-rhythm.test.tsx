// biome-ignore-all lint/correctness/useJsxKeyInIterable: the cases are [name, element, tabbed] tuples, not a rendered list
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesignProvider,
  DetailPage,
  FormPage,
  InboxPage,
  ListPage,
  OnboardingPage,
  OverviewPage,
  SettingsPage,
  StatusPage,
  TracePage,
  WizardPage,
} from "../src/index";

// The head rhythm (spec §4.2 "Head rhythm", acceptance item S) without a browser: every page
// template draws its head through the one TemplateHead (so one rule spaces it), and no stylesheet
// sets a vertical gap on the head's rows except the head rules, which use the layout.head-* tokens.
// apps/web/visual/head-rhythm.spec.ts measures the result in Chromium.

afterEach(cleanup);

const zh = (ui: ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);
const header = { path: [{ label: "capybara" }, { label: "页面" }], title: "页面标题" };
const withTabs = {
  ...header,
  tabs: [{ id: "all", label: "全部" }],
  activeTab: "all",
};
const row = { primary: { label: "保存", onSelect: () => {} } };
const tabs = { items: [{ id: "a", label: "概要" }], value: "a", label: "标签" };

const TEMPLATES: [string, ReactElement, boolean][] = [
  ["ListPage", <ListPage header={header}>x</ListPage>, false],
  ["ListPage tabs", <ListPage header={withTabs}>x</ListPage>, true],
  ["ListPage cards", <ListPage header={withTabs} variant="cards" />, true],
  [
    "DetailPage",
    <DetailPage header={header} tabs={tabs}>
      x
    </DetailPage>,
    true,
  ],
  [
    "FormPage",
    <FormPage header={header} actionRow={row}>
      x
    </FormPage>,
    false,
  ],
  [
    "SettingsPage",
    <SettingsPage header={header} nav={[]} activeNav="">
      x
    </SettingsPage>,
    false,
  ],
  ["OverviewPage", <OverviewPage header={header}>x</OverviewPage>, false],
  [
    "InboxPage",
    <InboxPage header={header} list={<div>l</div>}>
      x
    </InboxPage>,
    false,
  ],
  [
    "TracePage",
    <TracePage header={header} waterfall={<div>w</div>} detail={<div>d</div>} />,
    false,
  ],
  [
    "WizardPage",
    <WizardPage header={header} steps={["一"]} current={0} actionRow={row}>
      x
    </WizardPage>,
    false,
  ],
  ["StatusPage", <StatusPage header={header} kind="404" title="t" description="d" />, false],
  ["OnboardingPage", <OnboardingPage header={header} steps={[]} />, false],
];

describe("every template draws the one head", () => {
  it.each(TEMPLATES)("%s", (_name, ui, tabbed) => {
    const { container } = zh(ui);
    const heads = container.querySelectorAll('[data-part="template-head"]');
    expect(heads).toHaveLength(1);
    const head = heads[0] as Element;
    // The PageHeader and any tab row live inside it; nothing else draws a page header.
    expect(container.querySelectorAll('[data-part="page-header"]')).toHaveLength(1);
    expect(head.querySelector('[data-part="page-header"]')).not.toBeNull();
    expect(head.querySelector('[data-part="page-header-row"]')).not.toBeNull();
    const tabRows = container.querySelectorAll(
      '[data-part="page-header-tabs"], [data-part="page-tabs"]',
    );
    expect(tabRows).toHaveLength(tabbed ? 1 : 0);
    if (tabbed) expect(head.contains(tabRows[0] as Element)).toBe(true);
    expect(head.getAttribute("data-tabs")).toBe(tabbed ? "true" : null);
    // The head carries no gap variant of its own (the old `data-gap="loose"` form head).
    expect(head.hasAttribute("data-gap")).toBe(false);
  });
});

// ── Stylesheets ─────────────────────────────────────────────────────────────

const STYLES = resolve(__dirname, "../src/styles");

type Rule = { file: string; selector: string; body: string };

/** Splits at the commas outside parentheses (`:is(.a, .b)` / `:has(> .a, > .b)` stay whole). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The innermost `selector { body }` rules of every design stylesheet (comments stripped). */
function rulesOf(files: Record<string, string>): Rule[] {
  const out: Rule[] = [];
  for (const [file, text] of Object.entries(files)) {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of splitSelectors(m[1] ?? "")) {
        out.push({ file, selector, body: m[2] ?? "" });
      }
    }
  }
  return out;
}
function stylesheets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
    out[file] = readFileSync(resolve(STYLES, file), "utf8");
  }
  return out;
}
const rules = () => rulesOf(stylesheets());

/**
 * The selector's subject: its last compound, read outside parentheses (a combinator or comma
 * inside `:has(> .x, > .y)` does not end it), with the parenthesised arguments dropped, and
 * whether a sibling combinator (`+`, `~`) leads to it.
 */
function subjectOf(selector: string): { compound: string; sibling: boolean } {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] as string;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  // Only the combinator right before the subject says whether it follows a sibling.
  const before = selector.slice(0, start).trimEnd();
  const sibling = before.endsWith("+") || before.endsWith("~");
  const compound = selector.slice(start).replace(/\([^()]*(\([^()]*\))*[^()]*\)/g, "()");
  return { compound, sibling };
}
const hasClass = (compound: string, cls: string) =>
  new RegExp(`\\.${cls}(?![-\\w])`).test(compound);

/** The head's rows: a vertical gap, height or offset on one of them is a head rhythm gap. */
const HEAD_CLASSES = [
  "cb-template-head",
  "cb-template-head-frame",
  "cb-pageheader",
  "cb-pageheader-path",
  "cb-pageheader-row",
  "cb-pageheader-notice",
  "cb-pageheader-description",
  "cb-pageheader-tabs",
];
const subjectIsHead = (selector: string) =>
  HEAD_CLASSES.some((c) => hasClass(subjectOf(selector).compound, c));

/**
 * Declarations that move or size a head row vertically: margins, paddings, gaps (the head is a
 * column; the row-wise gaps of the path, the title row and the tab row are allow-listed), heights
 * and offsets.
 */
const VERTICAL =
  /^(margin|margin-top|margin-bottom|margin-block(-start|-end)?|padding|padding-top|padding-bottom|padding-block(-start|-end)?|gap|row-gap|height|min-height|max-height|block-size|min-block-size|top|bottom|inset|inset-block(-start|-end)?|translate|transform)$/;

/**
 * Every allowed vertical declaration on a head row, `selector → property → values`. The tab row's
 * height is its one box (spec §4.2; `auto` on phones, where the search stacks above the tabs with
 * `row-gap`); the path, the title row and the tab row lay their items out in a row (`gap` is
 * horizontal there); `margin: 0 auto` centres the head's frame.
 */
const ALLOWED: Record<string, Record<string, string[]>> = {
  ".cb-template-head": {
    padding: ["var(--cb-space-5) var(--cb-content-pad) var(--cb-layout-head-content)"],
  },
  '.cb-template-head[data-tabs="true"]': {
    "padding-bottom": ["var(--cb-layout-head-tabs-content)"],
  },
  '.cb-template-head-frame[data-width="content"]': { margin: ["0 auto"] },
  ".cb-pageheader-path": { gap: ["var(--cb-space-2)"] },
  ".cb-pageheader-row": { gap: ["var(--cb-space-3)"] },
  ".cb-pageheader-path + .cb-pageheader-row": { "margin-top": ["var(--cb-layout-head-path)"] },
  ".cb-pageheader-notice": { "margin-top": ["var(--cb-layout-head-tabs)"] },
  ".cb-pageheader-description": { margin: ["var(--cb-layout-head-description) 0 0"] },
  ".cb-pageheader-tabs": {
    gap: ["var(--cb-space-3)"],
    height: ["calc(var(--cb-control-default) + 2 * var(--cb-space-1))", "auto"],
    "margin-top": ["var(--cb-layout-head-tabs)"],
    "row-gap": ["var(--cb-space-2)"],
  },
};

/**
 * The body's own boxes above its first block, and the template blocks that can come first in a
 * body (settings grid, step bar, trace, list filters, form section, stat cards, facts): none may
 * add space above the first block.
 */
const BODY_CLASSES = ["cb-body", "cb-body-row", "cb-body-main", "cb-body-content", "cb-body-frame"];
const FIRST_BLOCK_CLASSES = [
  "cb-settings-grid",
  "cb-steps",
  "cb-trace",
  "cb-list-filters",
  "cb-form-section",
  "cb-stat-cards",
];
/** Allowed top space on the body side, each with its reason. */
const BODY_ALLOWED: Record<string, { prop: string; value: string; why: string }> = {
  '.cb-body-content[data-padded="true"]': {
    prop: "padding",
    value: "var(--cb-space-4) var(--cb-layout-gutter)",
    why: "a full-width padded body; no template uses it (they are content width)",
  },
  '.cb-template[data-template="InboxPage"] .cb-body-content[data-padded="true"]': {
    prop: "padding",
    value: "var(--cb-space-4)",
    why: "the inbox's middle column inside its split; the split itself (the rail) starts at the gap",
  },
  ".cb-template-head-frame > .cb-stat-cards": {
    prop: "margin-top",
    value: "var(--cb-layout-head-content)",
    why: "in-head stat cards are the head's last block (spec §4.2)",
  },
  ".cb-body-tools": {
    prop: "padding",
    value: "var(--cb-space-2) var(--cb-layout-gutter)",
    why: "the narrow-window filter / details buttons row, a block of its own",
  },
};
const TOP_SPACE =
  /^(margin|margin-top|margin-block(-start)?|padding|padding-top|padding-block(-start)?|top|inset|inset-block(-start)?)$/;
/** The top value of a declaration (`margin: 0 auto` → `0`; `top: 8px` → `8px`). */
const topOf = (prop: string, value: string) =>
  /^(margin|padding|inset)$/.test(prop) ? (value.split(/\s+/)[0] ?? "") : value;
const isZero = (v: string) => v === "0" || v === "0px" || v === "auto";

const decls = (body: string) =>
  body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as const;
    });

/** Vertical declarations on head rows outside the allow-listed head rules. */
function headFindings(all: Rule[]): string[] {
  const found: string[] = [];
  for (const r of all) {
    if (!subjectIsHead(r.selector)) continue;
    for (const [prop, value] of decls(r.body)) {
      if (!VERTICAL.test(prop)) continue;
      if (ALLOWED[r.selector]?.[prop]?.includes(value)) continue;
      found.push(`${r.file}: ${r.selector} { ${prop}: ${value} }`);
    }
  }
  return found;
}

/** Top space the body side adds above its first block, outside `BODY_ALLOWED`. */
function bodyFindings(all: Rule[]): string[] {
  const found: string[] = [];
  for (const r of all) {
    const { compound, sibling } = subjectOf(r.selector);
    const body = BODY_CLASSES.some((c) => hasClass(compound, c));
    const first = !sibling && FIRST_BLOCK_CLASSES.some((c) => hasClass(compound, c));
    // A direct child of the content frame is a first block unless a sibling combinator leads to it.
    const frameChild = !sibling && /\.cb-body-frame[^\s>+~]*\s*>\s*[^\s>+~]+$/.test(r.selector);
    if (!body && !first && !frameChild) continue;
    for (const [prop, value] of decls(r.body)) {
      if (!TOP_SPACE.test(prop) || isZero(topOf(prop, value))) continue;
      const ok = BODY_ALLOWED[r.selector];
      if (ok && ok.prop === prop && ok.value === value) continue;
      found.push(`${r.file}: ${r.selector} { ${prop}: ${value} }`);
    }
  }
  return found;
}

describe("the head gaps are the head tokens, set once", () => {
  it("no stylesheet sets a vertical gap, height or offset on a head row outside the head rules", () => {
    expect(headFindings(rules())).toEqual([]);
  });

  it("no body or first block adds space above the body's first block", () => {
    expect(bodyFindings(rules())).toEqual([]);
  });

  it("every head rule is in place", () => {
    const all = rules();
    for (const [selector, want] of Object.entries(ALLOWED)) {
      for (const [prop, values] of Object.entries(want)) {
        const hit = all.some(
          (r) =>
            r.selector === selector &&
            decls(r.body).some(([p, v]) => p === prop && v === values[0]),
        );
        expect(hit, `${selector} { ${prop}: ${values[0]} }`).toBe(true);
      }
    }
  });

  it("every allowed body-side rule is in place (in-head stat cards: layout.head-content)", () => {
    const all = rules();
    for (const [selector, { prop, value }] of Object.entries(BODY_ALLOWED)) {
      const hit = all.some(
        (r) => r.selector === selector && decls(r.body).some(([p, v]) => p === prop && v === value),
      );
      expect(hit, `${selector} { ${prop}: ${value} }`).toBe(true);
    }
  });

  it("no rule keeps the old loose head", () => {
    expect(rules().filter((r) => r.selector.includes(".cb-template-head[data-gap"))).toEqual([]);
  });

  // Each case is a rule the guard must reject (proven red before the guard was extended).
  const red = (css: string) => {
    const all = rulesOf({ "probe.css": css });
    return [...headFindings(all), ...bodyFindings(all)];
  };
  it.each([
    [
      "a template's body frame padding",
      '.cb-template[data-template="DetailPage"] .cb-body-frame { padding-top: 8px; }',
    ],
    ["a loose body's top padding", '.cb-body-frame[data-gap="loose"] { padding: 8px 0 0; }'],
    ["a first block's margin", ".cb-settings-grid { margin-top: 8px; }"],
    [
      "a frame child's margin",
      '.cb-body-frame[data-width="content"] > .cb-card { margin-top: 4px; }',
    ],
    ["a bare head frame gap", ".cb-template-head-frame { gap: 4px; }"],
    ["a title row min-height", ".cb-pageheader-row { min-height: 40px; }"],
    ["a tab row offset", ".cb-pageheader-tabs { position: relative; top: 2px; }"],
    ["a head height", '.cb-template-head[data-tabs="true"] { height: 120px; }'],
    ["commas inside :has()", ".cb-pageheader-row:has(> .a, > .b) { margin-top: 20px; }"],
    [
      "commas inside :is()",
      ":is(.cb-x, .cb-y) .cb-template-head:not(.a > .b) { padding-bottom: 2px; }",
    ],
  ])("rejects %s", (_name, css) => {
    expect(red(css)).not.toEqual([]);
  });

  it("keeps an allowed sibling margin (a form section after another) out of the first blocks", () => {
    expect(
      red(
        '.cb-body-frame[data-gap="loose"] > .cb-form-section + .cb-form-section { margin-top: 24px; }',
      ),
    ).toEqual([]);
  });

  it("a content-width body adds no space above its first block", () => {
    const body = rules().filter((r) =>
      /^\.cb-body-content.*:has\(> \.cb-body-frame\[data-width="content"\]\)$/.test(r.selector),
    );
    expect(body.length).toBeGreaterThan(0);
    for (const r of body) {
      const pad = decls(r.body).find(([p]) => p === "padding")?.[1] ?? "";
      expect(pad.split(/\s+/)[0], r.selector).toBe("0");
    }
    // No template-scoped rule reaches into the head.
    const scoped = rules().filter(
      (r) => r.selector.startsWith(".cb-template[data-template") && subjectIsHead(r.selector),
    );
    expect(scoped).toEqual([]);
  });
});
