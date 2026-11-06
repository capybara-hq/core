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
    // A detail page's tabs are the head's tab row (the PageHeader's row box), not PageTabs.
    expect(container.querySelector(".cb-pagetabs")).toBeNull();
  });
});

// ── Stylesheets ─────────────────────────────────────────────────────────────

const STYLES = resolve(__dirname, "../src/styles");

type Rule = { file: string; selector: string; body: string };

/** The innermost `selector { body }` rules of every design stylesheet (comments stripped). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(resolve(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of (m[1] ?? "").split(",")) {
        out.push({ file, selector: selector.trim(), body: m[2] ?? "" });
      }
    }
  }
  return out;
}

/** The head's rows: a vertical gap on one of them is a head rhythm gap. */
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
/** The selector's subject (last compound) is one of the head's rows. */
function subjectIsHead(selector: string): boolean {
  const last = selector.split(/\s*[>+~\s]\s*/).pop() ?? "";
  return HEAD_CLASSES.some((c) => new RegExp(`\\.${c}(?![-\\w])`).test(last));
}
/** Declarations that set vertical space (a row-wise gap counts: the head is a column). */
const VERTICAL =
  /^(margin|margin-top|margin-bottom|margin-block(-start|-end)?|padding|padding-top|padding-bottom|padding-block(-start|-end)?|row-gap)$/;

/**
 * Every allowed vertical declaration on a head row, `selector → property: value`. The phone rule
 * stacks the search above the tabs (`row-gap`, spec §4.2) inside the tab row; `margin: 0 auto`
 * centres the head's frame.
 */
const ALLOWED: Record<string, Record<string, string>> = {
  ".cb-template-head": {
    padding: "var(--cb-space-5) var(--cb-content-pad) var(--cb-layout-head-content)",
  },
  '.cb-template-head[data-tabs="true"]': {
    "padding-bottom": "var(--cb-layout-head-tabs-content)",
  },
  '.cb-template-head-frame[data-width="content"]': { margin: "0 auto" },
  ".cb-pageheader-path + .cb-pageheader-row": { "margin-top": "var(--cb-layout-head-path)" },
  ".cb-pageheader-notice": { "margin-top": "var(--cb-layout-head-tabs)" },
  ".cb-pageheader-description": { margin: "var(--cb-layout-head-description) 0 0" },
  ".cb-pageheader-tabs": {
    "margin-top": "var(--cb-layout-head-tabs)",
    "row-gap": "var(--cb-space-2)",
  },
};

const decls = (body: string) =>
  body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as const;
    });

describe("the head gaps are the head tokens, set once", () => {
  it("no stylesheet sets a vertical gap on a head row outside the head rules", () => {
    const found: string[] = [];
    for (const r of rules()) {
      if (!subjectIsHead(r.selector)) continue;
      for (const [prop, value] of decls(r.body)) {
        if (!VERTICAL.test(prop)) continue;
        if (ALLOWED[r.selector]?.[prop] === value) continue;
        found.push(`${r.file}: ${r.selector} { ${prop}: ${value} }`);
      }
    }
    expect(found).toEqual([]);
  });

  it("every head rule is in place", () => {
    const all = rules();
    for (const [selector, want] of Object.entries(ALLOWED)) {
      for (const [prop, value] of Object.entries(want)) {
        const hit = all.some(
          (r) =>
            r.selector === selector && decls(r.body).some(([p, v]) => p === prop && v === value),
        );
        expect(hit, `${selector} { ${prop}: ${value} }`).toBe(true);
      }
    }
  });

  it("the head's flex column has no gap of its own (each pair of rows has its token)", () => {
    const head = rules().filter(
      (r) => r.selector === ".cb-pageheader" || r.selector.startsWith(".cb-template-head-frame["),
    );
    for (const r of head) {
      expect(decls(r.body).filter(([p]) => p === "gap" || p === "row-gap")).toEqual([]);
    }
  });

  it("in-head stat cards sit layout.head-content below the PageHeader", () => {
    const hit = rules().some(
      (r) =>
        r.selector === ".cb-template-head-frame > .cb-stat-cards" &&
        r.body.includes("margin-top: var(--cb-layout-head-content)"),
    );
    expect(hit).toBe(true);
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
