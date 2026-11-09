import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type Column, DataTable, DesignProvider } from "../src/index";

/**
 * Phone widths (spec §4.3 "Narrow windows"): jsdom cannot lay anything out, so these tests read
 * the stylesheets' rules (inside `@media (max-width: 639px)` where the behaviour is narrow-only)
 * and the DOM the stacked table needs.
 */
afterEach(cleanup);

const STYLES = resolve(import.meta.dirname, "../src/styles");
const css = (file: string) => readFileSync(resolve(STYLES, file), "utf8");

/** The bodies of every `@media <query> {…}` block in `text`, joined. */
function media(text: string, query = "(max-width: 639px)"): string {
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
    expect(decls(narrow, ".cb-conv-scroll")).toMatch(/padding-inline: var\(--cb-space-4\);/);
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

  it("below 640 the search takes its own line above the tabs", () => {
    const narrow = media(css("shell.css"));
    const row = decls(narrow, ".cb-pageheader-tabs");
    expect(row).toContain("flex-wrap: wrap;");
    expect(row).toContain("height: auto;");
    const search = decls(narrow, ".cb-pageheader-search");
    expect(search).toContain("order: -1;");
    expect(search).toContain("width: 100%;");
  });
});

describe("ObjectRow below 640", () => {
  const narrow = media(css("templates.css"));
  const row = '.cb-object-row:not([data-skeleton="true"])';

  it("dissolves the text column so its lines and the row's buttons wrap as one row", () => {
    expect(decls(narrow, ".cb-object-row")).toContain("flex-wrap: wrap;");
    expect(decls(narrow, `${row} .cb-object-text`)).toContain("display: contents;");
    // the skeleton rows keep the mark and the text column side by side
    expect(decls(narrow, '.cb-object-row[data-skeleton="true"] .cb-object-text')).toContain(
      "flex-basis:",
    );
  });

  it("puts the ⋯ menu on the name line and breaks the line after it", () => {
    expect(decls(narrow, `${row} .cb-object-menu`)).toContain("order: 1;");
    const brk = decls(narrow, `${row}::after`);
    expect(brk).toContain("order: 1;");
    expect(brk).toContain("flex-basis: 100%;");
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

  it("aligns the action group right on the meta line (it wraps under it as a whole)", () => {
    const actions = decls(narrow, `${row} .cb-object-actions`);
    expect(actions).toContain("order: 2;");
    expect(actions).toContain("margin-left: auto;");
    expect(actions).toContain("display: flex;");
  });

  it("changes nothing above 640: the action group dissolves, a state-only meta line is hidden", () => {
    const wide = css("templates.css").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(decls(wide, ".cb-object-actions")).toContain("display: contents;");
    expect(decls(wide, '.cb-object-meta[data-empty="true"]')).toContain("display: none;");
  });
});

describe("PageHeader below 640", () => {
  const narrow = media(css("shell.css"));

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

  it("is sticky only on phones (the 200 px rail above 640 is not)", () => {
    const wide = css("templates.css").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(decls(wide, ".cb-settings-nav")).not.toContain("position: sticky;");
  });
});

describe("the sidebar drawer", () => {
  const sidebar = css("sidebar.css");

  it("scrolls its middle as one region; the conversations inside it do not scroll on their own", () => {
    const region = decls(sidebar, ".cb-sidebar-scroll");
    expect(region).toContain("overflow-y: auto;");
    expect(region).toContain("min-height: 0;");
    expect(region).toContain("flex: 1;");
    const convs = decls(sidebar, ".cb-sidebar-scroll > .cb-sidebar-convs");
    expect(convs).toContain("flex: none;");
    expect(convs).toContain("overflow: visible;");
  });

  it("indents the 更多 items one level and turns the chevron while open", () => {
    expect(decls(sidebar, '.cb-sidebar-item[data-depth="1"]')).toContain("padding-left:");
    expect(
      decls(
        sidebar,
        '.cb-sidebar-item[data-part="more-toggle"][aria-expanded="true"] .cb-sidebar-chevron',
      ),
    ).toContain("transform: rotate(90deg);");
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

describe("tap targets below 640 are at least 40 px", () => {
  const narrow = ["shell.css", "conversation-page.css", "table.css", "templates.css"]
    .map((f) => media(css(f)))
    .join("\n");

  for (const sel of [
    ".cb-shell-drawerbar .cb-icon-btn",
    ".cb-title-bar .cb-icon-btn",
    ".cb-pageheader-tabs .cb-tab",
    ".cb-table-menu .cb-btn",
  ]) {
    it(sel, () => {
      const d = decls(narrow, sel);
      expect(d).toContain("min-height: 40px;");
      expect(d).toContain("min-width: 40px;");
    });
  }

  // The page head's actions and an object row's buttons keep their compact look and reach 40 px
  // through an invisible ring (spec §4.3).
  for (const sel of [".cb-pageheader-actions .cb-btn", ".cb-object-row .cb-btn"]) {
    it(`${sel} (a 40 px ring around the compact button)`, () => {
      expect(decls(narrow, sel)).toContain("position: relative;");
      const ring = decls(narrow, `${sel}::after`);
      expect(ring).toContain("position: absolute;");
      expect(ring).toContain("min-height: 40px;");
      expect(ring).toContain("min-width: 40px;");
      expect(decls(narrow, sel)).not.toContain("min-height: 40px;");
    });
  }

  it("the conversation title button", () => {
    expect(decls(narrow, ".cb-title-btn")).toContain("height: 40px;");
  });

  it("sidebar rows in the drawer (the drawer is the touch form, below 960)", () => {
    const sidebar = css("sidebar.css");
    for (const sel of [
      ".cb-sidebar-drawer .cb-sidebar .cb-sidebar-item",
      ".cb-sidebar-drawer .cb-sidebar .cb-sidebar-row",
      ".cb-sidebar-drawer .cb-sidebar .cb-sidebar-back",
      ".cb-sidebar-drawer .cb-sidebar .cb-sidebar-group-head",
      ".cb-sidebar-drawer .cb-sidebar .cb-sidebar-archived",
    ]) {
      expect(decls(sidebar, sel), sel).toContain("height: 40px;");
    }
    const menu = decls(sidebar, ".cb-sidebar-drawer .cb-sidebar .cb-sidebar-row-menu");
    expect(menu).toContain("width: 40px;");
    expect(menu).toContain("height: 40px;");
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
