import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
// Playwright loads TS without the @capybara-hq/source condition, so the pure parser is imported by
// path (as fidelity.spec.ts does).
import { parseStateLists, resolveToken } from "../../../packages/design/src/reference/index";
import { openReference, THEMES } from "./reference-page";

/**
 * The head rhythm across the templates (design spec §4.2 "Head rhythm", acceptance item S). Every
 * `head-rhythm-<template>` block draws one template with the same head, so the path, the title
 * row, the tab row and the body's first block must sit at the same y (relative to the block) on
 * every template, and the gaps between them must be the `layout.head-*` tokens. Sizes within
 * ±1px, as fidelity.spec.ts.
 */
const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;
const root = resolve(import.meta.dirname, "../../..");
const spec = readFileSync(resolve(root, "docs/design/spec.md"), "utf8");
const tokens = JSON.parse(
  readFileSync(resolve(root, "docs/design/tokens.json"), "utf8"),
) as unknown;
const COMPONENT = "head-rhythm";
const states = parseStateLists(spec).find((l) => l.component === COMPONENT)?.states ?? [];

/** The blocks whose head has a tab row: the header's tabs (`list-tabs`) or a detail's tabs. */
const TABBED = ["list-tabs", "detail"];
/** The blocks whose title row is led by the 40 px avatar (a taller row, same path and row top). */
const AVATAR = ["settings-avatar"];

const px = (name: string) => Number(resolveToken(tokens, `layout.${name}`, "dark"));

/** The y offsets (relative to the block's top) of the head's rows and of the body's first block. */
type Offsets = {
  path: number;
  pathBottom: number;
  row: number;
  rowBottom: number;
  /** The PageHeader's bottom, or the bottom of the StatCards a head carries. */
  headBottom: number;
  tabs: number | null;
  tabsBottom: number | null;
  /** The body's first block: the first child of the content frame, or the rail when there is one. */
  content: number;
};

test("every template has a head-rhythm block", () => {
  expect([...states].sort()).toEqual(
    ["list", "list-tabs", "detail", "form", "settings", "settings-avatar"]
      .concat(["overview", "inbox", "trace", "wizard"])
      .sort(),
  );
});

for (const theme of THEMES) {
  test(`head rhythm (${theme})`, async ({ page }) => {
    await openReference(page, COMPONENT, theme, ORIGIN);
    const measured: Record<string, Offsets> = {};
    for (const state of states) {
      measured[state] = await page.evaluate((id) => {
        const b = document.querySelector(`[data-ref-block="${id}"]`);
        if (!b) throw new Error(`no block ${id}`);
        const top = b.getBoundingClientRect().top;
        const box = (sel: string) => {
          const el = b.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top - top, bottom: r.bottom - top };
        };
        const need = (sel: string) => {
          const r = box(sel);
          if (!r) throw new Error(`${id}: no ${sel}`);
          return r;
        };
        const path = need('[data-part="path"]');
        const row = need('[data-part="page-header-row"]');
        const header = need('[data-part="page-header"]');
        const stats = box('[data-part="template-head"] [data-part="stat-cards"]');
        const tabs = box('[data-part="page-header-tabs"], [data-part="page-tabs"]');
        const frame = b.querySelector('[data-part="content"]');
        const first = frame?.firstElementChild;
        const firsts = [first, b.querySelector('[data-part="rail"]')]
          .filter((el): el is Element => el != null)
          .map((el) => el.getBoundingClientRect().top - top);
        if (firsts.length === 0) throw new Error(`${id}: no content block`);
        return {
          path: path.top,
          pathBottom: path.bottom,
          row: row.top,
          rowBottom: row.bottom,
          headBottom: stats ? stats.bottom : header.bottom,
          tabs: tabs ? tabs.top : null,
          tabsBottom: tabs ? tabs.bottom : null,
          content: Math.min(...firsts),
        };
      }, `${COMPONENT}-${state}`);
    }

    const failures: string[] = [];
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const same = (what: keyof Offsets, group: string[]) => {
      const [first, ...rest] = group;
      if (first === undefined) return;
      const want = measured[first]?.[what];
      for (const s of rest) {
        const got = measured[s]?.[what];
        if (want == null || got == null || !near(want, got)) {
          failures.push(`${what}: ${first} ${want} but ${s} ${got}`);
        }
      }
    };
    const gap = (state: string, what: string, from: number | null, to: number, token: string) => {
      const want = px(token);
      if (from == null || !near(to - from, want)) {
        failures.push(
          `${state} ${what}: layout.${token} = ${want}px, got ${from == null ? "no row" : to - from}`,
        );
      }
    };

    const plain = states.filter((s) => !TABBED.includes(s) && !AVATAR.includes(s));
    // The path and the title row sit at the same y on every template, the avatar's too.
    same("path", states);
    same("row", states);
    // Same head, same first block: the untabbed templates together, the tabbed ones together.
    same("content", plain);
    same("tabs", TABBED);
    same("content", TABBED);

    for (const s of states) {
      const m = measured[s] as Offsets;
      gap(s, "path → title row", m.pathBottom, m.row, "head-path");
      if (TABBED.includes(s)) {
        gap(s, "head → tabs", m.headBottom, m.tabs ?? Number.NaN, "head-tabs");
        gap(s, "tabs → content", m.tabsBottom, m.content, "head-tabs-content");
      } else {
        if (m.tabs != null) failures.push(`${s}: a tab row the block should not have`);
        gap(s, "head → content", m.headBottom, m.content, "head-content");
      }
    }
    expect(failures).toEqual([]);
  });
}
