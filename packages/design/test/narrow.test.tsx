import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type Column, DataTable, DesignProvider } from "../src/index";
import { parseCss } from "./css-rules";

/**
 * Phone widths (spec §4.3 "Narrow windows"): jsdom cannot lay anything out, so these tests read
 * the stylesheets' rules (inside `@media (max-width: 599px)` where the behaviour is narrow-only)
 * and the DOM the stacked table needs.
 */
afterEach(cleanup);

const STYLES = resolve(import.meta.dirname, "../src/styles");
const css = (file: string) => readFileSync(resolve(STYLES, file), "utf8");

/** ClassForms' compact query (the complement of min-width 600), which the PageHeader rules use. */
const COMPACT = "not all and (min-width: 600px)";

/** The bodies of every `@media <query> {…}` block in `text`, joined. */
function media(text: string, query = "(max-width: 599px)"): string {
  const open = `@media ${query} {`;
  let out = "";
  let at = text.indexOf(open);
  while (at >= 0) {
    let depth = 1;
    let i = at + open.length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out += `${text.slice(at + open.length, i - 1)}\n`;
    at = text.indexOf(open, i);
  }
  return out;
}

/** The declarations of the rules (in `text`, no nested blocks) whose selector list has `sel`. */
function decls(text: string, sel: string): string {
  const out: string[] = [];
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

describe("the conversation page below 640", () => {
  const narrow = media(css("conversation-page.css"));

  it("drops the middle column's minimum, so the composer and bubbles fit the window", () => {
    expect(decls(narrow, ".cb-conv-main")).toContain("min-width: 0;");
  });

  it("uses 16 px side gutters for the thread, the composer and the title bar", () => {
    expect(decls(narrow, ".cb-conv-center")).toMatch(/--cb-conv-thread-pad: var\(--cb-space-4\);/);
    expect(decls(narrow, ".cb-conv-composer")).toMatch(/padding-inline: var\(--cb-space-4\);/);
    expect(decls(narrow, ".cb-title-bar")).toMatch(/padding-inline: var\(--cb-space-4\)/);
  });
});

describe("tabs", () => {
  const display = css("display.css");

  it("stay on one line and scroll sideways instead of wrapping (every width)", () => {
    expect(decls(display, ".cb-tabs")).toContain("overflow-x: auto;");
    const tab = decls(display, ".cb-tab");
    expect(tab).toContain("white-space: nowrap;");
    expect(tab).toContain("flex: none;");
  });

  it("let the page head's tab row shrink them (the search keeps its place)", () => {
    expect(decls(css("shell.css"), ".cb-pageheader-tabs .cb-tabs")).toContain("min-width: 0;");
  });

  it("below 600 the search takes its own line above the tabs", () => {
    const narrow = media(css("shell.css"), COMPACT);
    const row = decls(narrow, ".cb-pageheader-tabs");
    expect(row).toContain("flex-wrap: wrap;");
    expect(row).toContain("height: auto;");
    const search = decls(narrow, ".cb-pageheader-search");
    expect(search).toContain("order: -1;");
    expect(search).toContain("width: 100%;");
  });
});

describe("ObjectRow below 600", () => {
  const narrow = media(css("templates.css"), "not all and (min-width: 600px)");
  const row = '.cb-object-row:not([data-skeleton="true"])';

  it("lays the row out as a grid of the mark, the text column and the trailing parts", () => {
    expect(decls(narrow, '.cb-object-list > .cb-object-row:not([data-skeleton="true"])')).toContain(
      "display: grid;",
    );
    expect(decls(narrow, `${row} > .cb-object-text`)).toContain("grid-column: 2;");
    expect(decls(narrow, `${row} > .cb-object-mark`)).toContain("grid-column: 1;");
  });

  it("draws the state at the end of the meta line in its tone and hides the state label", () => {
    expect(decls(narrow, ".cb-object-meta[data-state]::after")).toContain(
      "content: attr(data-state);",
    );
    for (const tone of ["ok", "warn", "fail"]) {
      expect(decls(narrow, `.cb-object-meta[data-state-tone="${tone}"]::after`)).toContain(
        `color: var(--cb-${tone});`,
      );
    }
    expect(decls(narrow, `${row} > .cb-object-state`)).toContain("display: none;");
  });

  it("stretches the name's link over a row that opens, and draws its chevron", () => {
    expect(decls(narrow, '.cb-object-row[data-open="true"] .cb-object-name::after')).toContain(
      "inset: 0;",
    );
    expect(decls(narrow, ".cb-object-chevron")).toContain("display: block;");
  });

  it("changes nothing above 600: the action group dissolves, a state-only meta line and the chevron are hidden", () => {
    const wide = css("templates.css").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(decls(wide, ".cb-object-actions")).toContain("display: contents;");
    expect(decls(wide, '.cb-object-meta[data-empty="true"]')).toContain("display: none;");
    expect(decls(wide, ".cb-object-chevron")).toContain("display: none;");
  });
});

describe("PageHeader below 600", () => {
  const narrow = media(css("shell.css"), COMPACT);

  it("gives the title and description the full width, the description wrapping", () => {
    expect(decls(narrow, ".cb-pageheader-row")).toContain("flex-wrap: wrap;");
    expect(decls(narrow, ".cb-pageheader-description")).toContain("white-space: normal;");
  });

  it("puts the actions on their own line under them", () => {
    expect(decls(narrow, ".cb-pageheader-actions")).toContain("flex: 1 1 100%;");
  });
});

describe("SettingsPage sub-nav below 640", () => {
  it("is a sticky row on the page ground with its hairline, over the scrolling content", () => {
    const nav = decls(media(css("templates.css")), ".cb-settings-nav");
    expect(nav).toContain("position: sticky;");
    expect(nav).toContain("top: 0;");
    expect(nav).toMatch(/z-index: \d+;/);
    expect(nav).toContain("background: var(--cb-bg);");
    expect(nav).toContain("border-bottom: 1px solid var(--cb-line-soft);");
    expect(nav).toContain("overflow-x: auto;");
  });

  it("is sticky only on phones (the 200 px rail from 600 is not)", () => {
    const wide = css("templates.css").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(decls(wide, ".cb-settings-nav")).not.toContain("position: sticky;");
  });
});

describe("size-class widths in the stylesheets", () => {
  it("a label column that does not fit stacks by a container query on the body, and below 841", () => {
    const templates = css("templates.css");
    const shell = css("shell.css");
    expect(decls(shell, ".cb-body-content")).toContain("container: cb-body / inline-size;");
    for (const [sel, width] of [
      [".cb-form-section", "791px"],
      [".cb-settings-grid", "751px"],
    ] as const) {
      expect(media(templates, "(max-width: 840px)")).toContain(sel);
      expect(media(templates, `(max-width: 840px)`)).not.toContain("959");
      expect(templates).toContain(`@container cb-body (max-width: ${width}) {`);
    }
  });

  it("the compact chrome (the floating row) is shown below 600 only", () => {
    const shell = css("shell.css");
    expect(decls(shell, ".cb-shell-float")).toContain("display: none;");
    const compact = media(shell, "(max-width: 599px)");
    expect(decls(compact, ".cb-shell-float")).toContain("display: block;");
  });

  it("a short window hides the status bar on every class", () => {
    const hidden = media(css("shell.css"), "(max-height: 479px)");
    expect(decls(hidden, ".cb-statusbar")).toContain("display: none;");
  });

  it("compact draws no path row at any height; medium and expanded keep it (decision 2026-11-22)", () => {
    // the floating row's back and the h1 are enough on compact; medium and expanded (844 × 390 is
    // expanded) have no floating row: the path row is their way up
    const shell = css("shell.css");
    expect(decls(media(shell, "(max-height: 479px)"), ".cb-pageheader-path")).not.toContain(
      "display: none;",
    );
    expect(shell).not.toContain("(max-width: 599px) and (max-height: 479px)");
    const hiding = parseCss(shell).filter(
      (r) => r.selector === ".cb-pageheader-path" && r.decls.display === "none",
    );
    expect(hiding.map((r) => r.at)).toEqual([COMPACT]);
    // no rule hides it from 600 (a desktop shell's top row included)
    const all = ["shell.css", "templates.css", "shell-environment.css"].flatMap((f) =>
      parseCss(css(f)),
    );
    expect(
      all.filter(
        (r) =>
          /cb-pageheader-path(?![\w-])/.test(r.selector) &&
          r.decls.display === "none" &&
          r.at !== COMPACT,
      ),
    ).toEqual([]);
  });
});

describe("StatCards below 640", () => {
  it("are two columns (2 × 2 for four metrics)", () => {
    const cards = decls(media(css("shell.css")), ".cb-stat-cards");
    expect(cards).toContain("display: grid;");
    expect(cards).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
  });
});

describe("DataTable below 640: stacked rows", () => {
  const narrow = media(css("table.css"));
  /** The rules outside any media block. */
  const table = css("table.css").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

  it("hides the header row from sight only and lays each row out as a card of label: value lines", () => {
    const head = decls(narrow, ".cb-table .cb-table-el thead");
    // visually hidden, never display: none (screen readers keep the column headers)
    expect(head).not.toContain("display: none;");
    expect(head).toContain("clip-path: inset(50%);");
    expect(decls(table, ".cb-table-narrow-bar")).toContain("display: none;");
    expect(decls(narrow, ".cb-table-narrow-bar")).toContain("display: flex;");
    const row = decls(narrow, ".cb-table .cb-table-el tbody .cb-table-row");
    expect(row).toContain("display: grid;");
    const cell = decls(narrow, ".cb-table .cb-table-el tbody .cb-table-row > td");
    expect(cell).toContain("height: auto;");
    expect(cell).toContain("position: static;");
    expect(cell).toContain("max-width: none;");
    expect(
      decls(narrow, ".cb-table .cb-table-el tbody .cb-table-row > td[data-label]::before"),
    ).toContain("content: attr(data-label);");
  });

  it("keeps the row menu and the checkbox in the card's first line", () => {
    expect(decls(narrow, ".cb-table .cb-table-el tbody .cb-table-row > td.cb-table-menu")).toMatch(
      /grid-column: 3;[\s\S]*grid-row: 1;/,
    );
    expect(decls(narrow, ".cb-table .cb-table-el tbody .cb-table-row > td.cb-table-check")).toMatch(
      /grid-column: 1;[\s\S]*grid-row: 1;/,
    );
  });

  it("lets the toolbar's search take the full width", () => {
    expect(decls(narrow, ".cb-table-toolbar")).toContain("flex-wrap: wrap;");
    expect(decls(narrow, ".cb-table-toolbar .cb-input")).toContain("width: 100%;");
  });

  type Row = { id: string; name: string; role: string; at: string };
  const columns: Column<Row>[] = [
    { key: "name", header: "成员", cell: (r) => r.name },
    { key: "role", header: "角色", cell: (r) => r.role },
    { key: "at", header: "", cell: (r) => r.at },
  ];

  it("labels every cell but the first with its column header", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <DataTable<Row>
          label="成员"
          columns={columns}
          rows={[{ id: "a", name: "Grant", role: "所有者", at: "11-03" }]}
          rowKey={(r) => r.id}
          rowMenu={() => [{ label: "移除", onSelect: () => {} }]}
        />
      </DesignProvider>,
    );
    const cells = [...container.querySelectorAll('tbody td[data-part="cell"]')];
    expect(cells.map((c) => c.getAttribute("data-label"))).toEqual([null, "角色", null]);
    expect(cells.map((c) => c.getAttribute("data-lead"))).toEqual(["true", null, null]);
  });
});

describe("tap targets below 600", () => {
  const narrow = ["shell.css", "conversation-page.css", "table.css", "templates.css"]
    .map((f) => media(css(f)))
    .join("\n");

  it(".cb-title-bar .cb-icon-btn", () => {
    const d = decls(narrow, ".cb-title-bar .cb-icon-btn");
    expect(d).toContain("min-height: var(--cb-touch-hit);");
    expect(d).toContain("min-width: var(--cb-touch-hit);");
  });

  // The mobile sizes (spec §2.5, maintainer decision 2026-11-22): below 600 the control scale is
  // 44 whatever the pointer, so the page head's tabs and actions, the row menu and an object row's
  // buttons are their own 44 px targets; no invisible ring and no 40 px override is left.
  for (const sel of [
    ".cb-pageheader-tabs .cb-tab",
    ".cb-table-menu .cb-btn",
    ".cb-pageheader-actions .cb-btn",
    ".cb-object-row .cb-btn",
  ]) {
    it(`${sel} takes the mobile control size (no ring, no 40 px override)`, () => {
      expect(decls(narrow, `${sel}::after`)).toBe("");
      expect(decls(narrow, sel)).not.toContain("40px");
    });
  }

  it("the control scale is 44 below 600", () => {
    const tokens = css("tokens.css");
    const block = media(
      tokens,
      "(max-width: 599px), (pointer: coarse), (any-pointer: coarse) and (not (any-pointer: fine))",
    );
    expect(block).toContain("--cb-control-default: 44px;");
    expect(block).toContain("--cb-control-dense: 44px;");
  });

  it("the conversation title button", () => {
    expect(decls(narrow, ".cb-title-btn")).toContain("height: var(--cb-touch-hit);");
  });
});

describe("type is never smaller than micro (11 px)", () => {
  it("every type size token is at least 11 px", () => {
    const sizes = [...css("tokens.css").matchAll(/--cb-type-[a-z-]+-size: (\d+)px;/g)];
    expect(sizes.length).toBeGreaterThan(0);
    for (const [, px] of sizes) expect(Number(px)).toBeGreaterThanOrEqual(11);
  });

  it("no stylesheet sets a smaller literal font size", () => {
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) {
      for (const m of css(f).matchAll(/font-size:\s*([\d.]+)(px|em|rem)/g)) {
        const px = m[2] === "px" ? Number(m[1]) : Number(m[1]) * 13;
        expect(px, `${f}: ${m[0]}`).toBeGreaterThanOrEqual(11);
      }
    }
  });
});
