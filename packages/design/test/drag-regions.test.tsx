// Window drag regions (desktop client spec §7.3 "The top row"): in Electron a drag region swallows
// every mouse event over it whatever is stacked above it (a menu, a tooltip, a toast), and a
// control inside one cannot be used. So only dedicated, empty filler elements drag: the flex
// spacers the templates draw in the top row (`.cb-drag-fill`) and the shell's controls area
// (`.cb-shell-band`), never a container that holds controls; and every filler stops dragging
// while a modal overlay is open (a toast or a tooltip is none: the window keeps dragging).
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  ConversationPage,
  DesignProvider,
  type DrawerNavData,
  NewTitleBar,
  PageHeader,
  RightPanel,
  SharedFilePage,
  TitleBar,
} from "../src/index";
import { css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The selectors a drag region may have as its subject. */
const FILLER = /\.(cb-drag-fill|cb-shell-band)(\[[^\]]*\])*$/;
/** Splits a selector list at its top-level commas (not those inside `:is(...)`). */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    if (list[i] === ")") depth--;
    if (list[i] === "," && depth === 0) {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out;
}
/** The selector's subject (its last compound), with an `:is(a, b)` subject expanded. */
function subjects(selector: string): string[] {
  const last =
    selector
      .split(/\s+(?![^(]*\))|>(?![^(]*\))/)
      .pop()
      ?.trim() ?? "";
  const is = /^:is\((.*)\)$/.exec(last);
  return is ? selectors(is[1] ?? "") : [last];
}

const STYLES = readdirSync(resolve(import.meta.dirname, "../src/styles")).filter((f) =>
  f.endsWith(".css"),
);
const dragRules = () =>
  STYLES.flatMap((f) =>
    parseCss(css(f))
      .filter((r) =>
        Object.entries(r.decls).some(([k, v]) => /(^|-)app-region$/.test(k) && v === "drag"),
      )
      .map((r) => ({ file: f, selector: r.selector })),
  );

describe("drag regions in the design CSS", () => {
  it("are only the dedicated fillers", () => {
    const rules = dragRules();
    expect(rules.length).toBeGreaterThan(0);
    const bad = rules.flatMap((r) =>
      selectors(r.selector)
        .flatMap(subjects)
        .filter((s) => !FILLER.test(s))
        .map((s) => `${r.file}: ${s}`),
    );
    expect(bad).toEqual([]);
  });

  /** The rules that switch the fillers off while something is open (`:root:has(...)`). */
  const overlayOff = () =>
    parseCss(css("shell-environment.css")).filter(
      (r) =>
        r.selector.includes(":has(") &&
        r.decls["-webkit-app-region"] === "no-drag" &&
        r.decls["app-region"] === "no-drag",
    );

  it("every filler stops dragging while a modal overlay is open", () => {
    const selector = overlayOff()
      .map((r) => r.selector)
      .join(" ");
    for (const cls of [
      "cb-drag-fill",
      "cb-shell-band",
      "cb-menu",
      "cb-popover",
      "cb-cmenu",
      "cb-dialog",
      "cb-sheet",
      "cb-palette",
      "cb-drawer",
    ]) {
      expect(selector, cls).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
    }
  });

  it("a toast or a tooltip leaves the fillers dragging, and the toast area itself never drags", () => {
    // a toast is no modal: while one shows the window still drags by its top row (#642)
    const has = overlayOff().map((r) => /:has\(([\s\S]*)\)\s+:is\(/.exec(r.selector)?.[1] ?? "");
    expect(has.length).toBeGreaterThan(0);
    for (const inner of has) {
      expect(inner).not.toMatch(/\.cb-toast(?![\w-])/);
      expect(inner).not.toMatch(/\.cb-toast-region(?![\w-])/);
      expect(inner).not.toMatch(/\.cb-tooltip(?![\w-])/);
    }
    // the region is a no-drag root (a later no-drag region cuts it out of any filler under it)
    const roots = parseCss(css("shell-environment.css")).filter(
      (r) =>
        !r.selector.includes(":has(") &&
        r.decls["-webkit-app-region"] === "no-drag" &&
        r.decls["app-region"] === "no-drag",
    );
    expect(roots.flatMap((r) => selectors(r.selector).flatMap(subjects))).toContain(
      ".cb-toast-region",
    );
  });
});

const sidebar = {
  context: {
    kind: "work" as const,
    org: { name: "Acme", initial: "A", slug: "acme", role: "所有者", menu: [] },
    primary: [{ id: "agents", label: "Agents", href: "/agents", icon: "agent" as const }],
    more: [],
  },
  newConversation: { href: "/" },
  activeNav: "agents",
  account: { name: "grant", menu: [] },
};
const status = { context: "grant@acme:/", version: "0.1.0" };
const noop = () => {};
const drawer: DrawerNavData = {
  sections: [{ id: "agents", label: "智能体", href: "/agents", icon: "agent" }],
  more: [],
  moreLabel: "更多",
  recent: { state: "ready", items: [], onRetry() {} },
  allConversations: { label: "全部会话", href: "/conversations" },
  newConversation: { label: "新会话", href: "/" },
  account: {
    name: "grant",
    orgName: "Acme",
    personalSettingsHref: "/account",
    theme: null,
    status: null,
    onSignOut: noop,
  },
};

function tree() {
  return (
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar}>
        <TitleBar
          title="T"
          untitled="U"
          menu={[{ id: "rename", label: "重命名", icon: "square-pen", onSelect: noop }]}
          properties={{ pressed: false, onToggle: noop }}
          panels={[{ id: "files", label: "文件", icon: "file-text", pressed: false, onOpen: noop }]}
        />
        <NewTitleBar />
        <PageHeader
          path={[
            { label: "acme", href: "/" },
            { label: "agents", href: "/agents" },
            { label: "研究助手" },
          ]}
          title="研究助手"
          actions={[{ label: "新建", variant: "primary", onSelect: noop }]}
        />
        <PageHeader
          path={[
            { label: "acme", href: "/" },
            { label: "devices", href: "/devices" },
            { label: "mac" },
          ]}
          title="Device"
          titleHidden
          actions={[{ label: "重启", variant: "default", onSelect: noop }]}
        />
        <PageHeader
          path={[{ label: "acme", href: "/" }, { label: "skills" }]}
          title="Skills"
          actions={[{ label: "新建", variant: "primary", onSelect: noop }]}
        />
        <PageHeader
          path={[{ label: "acme", href: "/" }, { label: "device" }]}
          title="Device"
          titleHidden
          actions={[{ label: "重启", variant: "default", onSelect: noop }]}
        />
      </AppShell>
      <SharedFilePage name="a.html" badge="HTML" meta="1 KB" onDownload={noop} state="ready">
        <p>doc</p>
      </SharedFilePage>
    </DesignProvider>
  );
}

describe("the fillers the templates draw", () => {
  it("each top row has one, and every filler is empty and hidden from assistive tech", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(1280).matchMedia);
    const { container } = render(tree());
    for (const row of [
      ".cb-sidebar[data-mode='full'] .cb-sidebar-top",
      ".cb-title-bar:not([data-new])",
      ".cb-title-bar[data-new]",
      ".cb-pageheader > .cb-pageheader-path",
      ".cb-pageheader-titleless > .cb-pageheader-path",
      ".cb-pageheader-titleless:not(:has(> .cb-pageheader-path))",
      ".cb-shared-bar",
      "[data-part='shell-content']",
    ]) {
      const el = container.querySelector(row);
      expect(el, row).not.toBeNull();
      expect(el?.querySelector(":scope > .cb-drag-fill"), row).not.toBeNull();
    }
    // every title row has exactly one, with or without a path row above it
    const rows = [...container.querySelectorAll(".cb-pageheader-row")];
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.querySelectorAll(":scope > .cb-drag-fill")).toHaveLength(1);
    // the paper's top gutter is the column's first child
    const column = container.querySelector("[data-part='shell-content']");
    expect(column?.firstElementChild?.matches(".cb-drag-fill.cb-shell-gutter")).toBe(true);
    const fillers = [...container.querySelectorAll(".cb-drag-fill, .cb-shell-band")];
    expect(fillers.length).toBeGreaterThan(6);
    for (const f of fillers) {
      expect(f.childNodes.length, f.outerHTML).toBe(0);
      expect(f.getAttribute("aria-hidden"), f.outerHTML).toBe("true");
      expect(f.hasAttribute("tabindex"), f.outerHTML).toBe(false);
    }
  });
});

describe("the narrow window's row and the side panel's strip", () => {
  it("the compact floating row's gap is a filler, which does not drag on a chat surface", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(480).matchMedia);
    const { container } = render(
      <DesignProvider locale="zh">
        <AppShell sidebar={sidebar}>
          <p>page</p>
        </AppShell>
      </DesignProvider>,
    );
    const gap = container.querySelector(".cb-floatbar > .cb-drag-fill");
    expect(gap).not.toBeNull();
    expect(gap?.childNodes.length).toBe(0);
    expect(gap?.getAttribute("aria-hidden")).toBe("true");
    const rules = parseCss(css("shell-environment.css"));
    // only while a conversation's title pill lies over the gap
    const off = rules.filter(
      (r) =>
        /\.cb-floatbar > \.cb-drag-fill$/.test(r.selector) && r.decls["app-region"] === "no-drag",
    );
    expect(off.map((r) => r.selector)).toEqual([
      ':root[data-shell="desktop"] .cb-shell:has(.cb-shell-main .cb-title-bar:not([data-new])) .cb-floatbar > .cb-drag-fill',
    ]);
  });

  it("the gap is as high as the top row where controls are reported, and 0 on a chat surface without", () => {
    const compact = parseCss(css("shell-environment.css")).filter(
      (r) => r.at === "not all and (min-width: 600px)",
    );
    const height = (selector: string) =>
      compact.find((r) => r.selector === selector)?.decls["--cb-float-gap-height"];
    // with controls the row is their height (48), so the filler spans the row; without them
    // `--cb-shell-row` is 0: a chat surface's gap has no height (taps reach the page as in a
    // browser), a pushed page's keeps the floating row's height as before
    expect(height(':root[data-shell="desktop"] .cb-floatbar > .cb-drag-fill')).toBe(
      "max(var(--cb-float-size), var(--cb-shell-row))",
    );
    expect(
      height(
        ':root[data-shell="desktop"] .cb-shell[data-surface="chat"] .cb-floatbar > .cb-drag-fill',
      ),
    ).toBe("var(--cb-shell-row)");
    // it starts at the window's top edge only with controls, and its margins keep the row's height
    const gap = compact.find(
      (r) => r.selector === ':root[data-shell="desktop"] .cb-floatbar > .cb-drag-fill',
    );
    expect(gap?.decls["--cb-float-gap-top"]).toBe(
      "min(var(--cb-float-top), calc(var(--cb-shell-row) * 100000))",
    );
    expect(gap?.decls.height).toBe("var(--cb-float-gap-height)");
  });

  it("the home (a chat surface with no title pill) draws the gap filler in the floating row", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(480).matchMedia);
    const { container } = render(
      <DesignProvider locale="zh">
        <AppShell sidebar={sidebar} chatSurface drawer={drawer}>
          <NewTitleBar />
        </AppShell>
      </DesignProvider>,
    );
    const shell = container.querySelector(".cb-shell") as HTMLElement;
    expect(shell.dataset.surface).toBe("chat");
    // the menu button, then the filler
    const row = container.querySelector(".cb-floatbar") as HTMLElement;
    expect(row.firstElementChild?.tagName).toBe("BUTTON");
    expect(row.querySelector(":scope > .cb-drag-fill")).not.toBeNull();
    // no conversation title pill: the no-drag rule's `:has(...)` does not match
    expect(shell.matches(":has(.cb-shell-main .cb-title-bar:not([data-new]))")).toBe(false);
  });

  it("an open side panel draws a filler for the strip above it", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(1440).matchMedia);
    const { container } = render(
      <DesignProvider locale="zh">
        <ConversationPage
          titleBar={{
            title: "T",
            untitled: "U",
            menu: [],
            properties: { pressed: false, onToggle: noop },
            panels: [],
          }}
          thread={<p>t</p>}
          composer={<div />}
          right="panel"
          panel={<div>panel</div>}
          onCloseRight={noop}
          layout="inline"
        />
      </DesignProvider>,
    );
    const fill = container.querySelector(".cb-conv-panel > .cb-drag-fill");
    expect(fill).not.toBeNull();
    expect(fill?.childNodes.length).toBe(0);
  });
});

describe("a filler adds no gap", () => {
  it("cancels the gap of every row it is drawn in, so a row lays out as before", () => {
    const rules = STYLES.flatMap((f) => parseCss(css(f)));
    const gapOf = (row: string) =>
      rules.find((r) => r.at === null && r.selector === row && r.decls.gap)?.decls.gap;
    for (const row of [
      ".cb-sidebar-top",
      ".cb-title-bar",
      ".cb-pageheader-path",
      ".cb-pageheader-row",
      ".cb-pageheader-titleless",
    ]) {
      const gap = gapOf(row);
      expect(gap, row).toBeDefined();
      const cancel = rules.find((r) => selectors(r.selector).includes(`${row} > .cb-drag-fill`))
        ?.decls["margin-left"];
      expect(cancel, row).toBe(`calc(-1 * ${gap})`);
    }
  });
});

describe("the rail's top row inside the desktop shell (desktop client spec §7.3)", () => {
  const rules = () => parseCss(css("shell-environment.css"));
  const decl = (selector: string, prop: string, at: string | null = null) =>
    rules().find((r) => r.at === at && r.selector === selector && r.decls[prop] !== undefined)
      ?.decls[prop];
  const BAND_QUERY = "not style(--cb-shell-rail-drop: 0px)";
  const COLLAPSED_RAIL =
    ':root[data-shell="desktop"] .cb-shell:not([data-banner="true"]):has( > .cb-sidebar[data-mode="rail"][data-collapsed="true"] )';
  const desktop = (on: boolean) => {
    (window as unknown as { capybaraShell?: unknown }).capybaraShell = on
      ? {
          version: 1,
          kind: "desktop",
          platform: "macos",
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
          controls: { x: 0, y: 0, width: 92, height: 48 },
          capabilities: {},
          on: () => () => {},
        }
      : undefined;
  };
  afterEach(() => desktop(false));
  const shell = (collapsed: boolean, width: number) => {
    vi.stubGlobal("matchMedia", matchMediaFor(width).matchMedia);
    return render(
      <DesignProvider locale="zh">
        <AppShell sidebar={sidebar} collapsed={collapsed} onCollapsedChange={noop}>
          <p>page</p>
        </AppShell>
      </DesignProvider>,
    );
  };

  it("the rail drops below the band only when start controls reach past it", () => {
    const css$ = css("shell-environment.css");
    expect(css$).toMatch(/@property --cb-shell-rail-drop \{[^}]*syntax: "<length>";/);
    // 0 without controls (row-start is 0), with controls at the end (reserve-start is 0) and with
    // controls no wider than the rail (the step is 0)
    expect(decl(':root[data-shell="desktop"]', "--cb-shell-rail-drop")).toBe(
      "min( var(--cb-shell-row-start), max( 0px, calc( (var(--cb-shell-reserve-start) - var(--cb-inset-left) - var(--cb-layout-sidebar-rail)) * 100000 ) ) )",
    );
    // a banner is the first row: nothing below it drops
    expect(
      decl(':root[data-shell="desktop"] .cb-shell[data-banner="true"] > *', "--cb-shell-rail-drop"),
    ).toBe("0px");
  });

  it("the rail's surface and divider start below the band; the full sidebar is unchanged", () => {
    const rail = ':root[data-shell="desktop"] .cb-shell > .cb-sidebar[data-mode="rail"]';
    expect(decl(rail, "margin-top")).toBe("var(--cb-shell-rail-drop)");
    expect(decl(rail, "height")).toBe("auto");
    // below the band the rail pads as in a browser (space.3)
    expect(decl(rail, "padding-top")).toContain(
      "min(var(--cb-space-3), calc(var(--cb-shell-rail-drop) * 100000))",
    );
    const full = rules().filter(
      (r) => r.selector.includes('.cb-sidebar[data-mode="full"]') && r.decls["margin-top"],
    );
    expect(full).toEqual([]);
    expect(
      rules().filter(
        (r) =>
          /rail-drop/.test(Object.values(r.decls).join()) && /data-mode="full"/.test(r.selector),
      ),
    ).toEqual([]);
  });

  it("in the rail's form the paper's first row sits in the band; the paper's colour starts below it", () => {
    const css$ = css("shell-environment.css");
    expect(css$).toMatch(
      /@property --cb-shell-paper-drop \{[^}]*syntax: "<length>";[^}]*initial-value: 0px;/,
    );
    // the drop is the rail's, set only in the rail's form from 600 up and never with a banner
    const drops = rules().filter((r) => r.decls["--cb-shell-paper-drop"] !== undefined);
    expect(drops.map((r) => r.at).sort()).toEqual([
      "(min-width: 600px)",
      "(min-width: 600px) and (max-width: 840px)",
      "(min-width: 841px)",
    ]);
    for (const r of drops) {
      expect(r.decls["--cb-shell-paper-drop"]).toBe("var(--cb-shell-rail-drop)");
      expect(r.selector).toContain('.cb-shell:not([data-banner="true"]):has(');
      expect(r.selector).not.toContain('data-mode="full"');
    }
    expect(drops.find((r) => r.at === "(min-width: 841px)")?.selector).toContain(
      '[data-collapsed="true"]',
    );
    const Q = "not style(--cb-shell-paper-drop: 0px)";
    const PAGE =
      ':root[data-shell="desktop"] .cb-shell-column > .cb-shell-main:not(:has(.cb-conv-page))';
    const CONV = ':root[data-shell="desktop"] .cb-shell-main .cb-conv-main';
    // the paper's box starts at the window's top edge, so its first row is the band's height
    expect(decl(PAGE, "margin-top", Q)).toBe("0");
    expect(decl(':root[data-shell="desktop"] .cb-shell-main .cb-conv-page', "padding-top", Q)).toBe(
      "0",
    );
    expect(decl(`${CONV} > .cb-title-bar`, "height", Q)).toBe(
      "max(var(--cb-layout-title-bar), var(--cb-shell-row))",
    );
    expect(
      decl(':root[data-shell="desktop"] .cb-shell-main .cb-pageheader-path', "min-height", Q),
    ).toBe("var(--cb-shell-row)");
    // the paper's colour is a layer space.2 below the band: the box is transparent over the band
    const paper = rules().find((r) => r.at === Q && r.selector === `${PAGE}, ${CONV}`);
    expect(paper?.decls.background).toBe("transparent");
    const layer = rules().find(
      (r) => r.at === Q && r.selector === `${PAGE}::before, ${CONV}::before`,
    );
    expect(layer?.decls.inset).toBe("calc(var(--cb-shell-row) + var(--cb-space-2)) 0 0");
    expect(layer?.decls.background).toBe("var(--cb-bg)");
    // the next row starts on the paper; a first-level head (no path row) starts inside it
    expect(decl(`${CONV} > .cb-title-bar`, "margin-bottom", Q)).toBe("var(--cb-space-2)");
    expect(
      decl(
        ':root[data-shell="desktop"] .cb-shell-main .cb-template-head:not(:has(.cb-pageheader-path))',
        "padding-top",
        Q,
      ),
    ).toBe("calc(var(--cb-shell-row) + var(--cb-space-2) + var(--cb-space-5))");
    // the conversation's title bar is the band's whole row: it runs to the window's end over the
    // inline panel (its end group at the far end, clear of end controls) ...
    expect(
      decl(':root[data-shell="desktop"] .cb-shell-main .cb-conv-page', "container-type", Q),
    ).toBe("inline-size");
    expect(decl(CONV, "overflow-x", Q)).toBe("visible");
    expect(decl(CONV, "overflow-y", Q)).toBe("clip");
    const BAR =
      ':root[data-shell="desktop"] .cb-shell-column .cb-shell-main .cb-conv-main > .cb-title-bar';
    expect(decl(BAR, "width", Q)).toBe("100cqw");
    expect(decl(BAR, "padding-right", Q)).toBe(
      "max( calc(var(--cb-space-3) + var(--cb-inset-right)), calc(var(--cb-shell-reserve-end) + var(--cb-space-2)) )",
    );
    // ... and the inline panel's box starts below the band, so nothing of it lies over the bar
    const PANEL = ':root[data-shell="desktop"] .cb-shell-main .cb-conv-panel:not([data-full])';
    expect(decl(PANEL, "margin-top", Q)).toBe("calc(var(--cb-shell-row) + var(--cb-space-2))");
    expect(decl(PANEL, "padding-top", Q)).toBe("0");
    expect(
      decl(
        ':root[data-shell="desktop"] .cb-shell-main .cb-conv-panel > .cb-drag-fill',
        "height",
        Q,
      ),
    ).toBe("0");
    // the band's rows keep their reserves: no rule clears the row, the start reserve or the
    // column reserve, so the row starts after the toggle and ends clear of end controls
    expect(
      rules().filter(
        (r) =>
          r.at === Q &&
          [
            "--cb-shell-row",
            "--cb-shell-reserve-start",
            "--cb-shell-reserve-end",
            "--cb-shell-column-reserve",
          ].some((v) => r.decls[v] !== undefined),
      ),
    ).toEqual([]);
    // no rule reads the drop in the full sidebar's form or below 600
    expect(
      rules().filter(
        (r) =>
          /paper-drop/.test(Object.values(r.decls).join() + (r.at ?? "")) &&
          (/data-mode="full"/.test(r.selector) ||
            /not all and \(min-width: 600px\)/.test(r.at ?? "")),
      ),
    ).toEqual([]);
  });

  it("no hairline closes the band where the rail drops: band, rail and gutters are one ground", () => {
    const pseudo = parseCss(css("shell-environment.css")).filter(
      (r) => /::(after|before)/.test(r.selector) && /\.cb-shell\b/.test(r.selector),
    );
    // (the paper's colour layer under the band's rows is a surface, not a line)
    expect(
      pseudo.filter((r) => r.decls.content !== undefined && r.decls.background !== "var(--cb-bg)"),
    ).toEqual([]);
  });

  it("the expand button sits in the band right after the controls, and leaves the rail", () => {
    const toggle =
      ':root[data-shell="desktop"] .cb-shell:not([data-banner="true"]) > .cb-shell-rail-toggle';
    expect(decl(".cb-shell-rail-toggle", "display")).toBe("none");
    expect(decl(toggle, "display", BAND_QUERY)).toBe("flex");
    expect(decl(toggle, "left", BAND_QUERY)).toBe("var(--cb-shell-reserve-start)");
    expect(decl(toggle, "top", BAND_QUERY)).toBe(
      "calc((var(--cb-shell-row) - var(--cb-control-default)) / 2)",
    );
    // clickable over an open drawer's modal page (it closes the drawer it opened)
    expect(decl(toggle, "pointer-events", BAND_QUERY)).toBe("auto");
    // the rail's own expand button and medium sidebar toggle give way to it
    expect(
      decl(
        ':root[data-shell="desktop"] .cb-shell > .cb-sidebar[data-mode="rail"] :is([data-part="expand-toggle"], [data-part="drawer-toggle"])',
        "display",
        BAND_QUERY,
      ),
    ).toBe("none");
    // the content column's title starts after it: the collapsed rail, and any hydrated rail (the
    // medium class's, collapsed or not, whose toggle opens the drawer)
    expect(decl(COLLAPSED_RAIL, "--cb-shell-toggle", BAND_QUERY)).toBe(
      "calc(var(--cb-control-default) + var(--cb-space-1))",
    );
    expect(
      decl(
        ':root[data-shell="desktop"] .cb-shell:not([data-banner="true"]):has( > .cb-sidebar[data-mode="rail"]:not([data-responsive="true"]) )',
        "--cb-shell-toggle",
        BAND_QUERY,
      ),
    ).toBe("calc(var(--cb-control-default) + var(--cb-space-1))");
    expect(
      decl(':root[data-shell="desktop"] .cb-shell-column', "--cb-shell-column-reserve"),
    ).toContain("var(--cb-shell-toggle, 0px)");
    // no rule takes the room away on medium any more
    expect(rules().filter((r) => r.decls["--cb-shell-toggle"] === "0px" && r.at !== null)).toEqual(
      [],
    );
  });

  it("the AppShell draws the top-row toggle for the collapsed sidebar on expanded, the drawer toggle on medium", () => {
    // a browser: none
    const browser = shell(true, 1280);
    expect(browser.container.querySelector(".cb-shell-rail-toggle")).toBeNull();
    browser.unmount();

    desktop(true);
    const collapsed = shell(true, 1280);
    const band = collapsed.container.querySelector(".cb-shell > .cb-shell-rail-toggle");
    expect(band).not.toBeNull();
    const button = band?.querySelector("button[data-part='top-row-expand-toggle']");
    expect(button?.getAttribute("aria-label")).toBeTruthy();
    // after the controls area, before the sidebar and the content column
    const children = [...(collapsed.container.querySelector(".cb-shell")?.children ?? [])];
    const at = (cls: string) => children.findIndex((c) => c.classList.contains(cls));
    expect(at("cb-shell-band")).toBeLessThan(at("cb-shell-rail-toggle"));
    expect(at("cb-shell-rail-toggle")).toBeLessThan(at("cb-sidebar"));
    // the rail keeps its own button for a browser and windows whose controls fit; CSS hides it
    expect(
      collapsed.container.querySelector(
        ".cb-sidebar[data-mode='rail'] [data-part='expand-toggle']",
      ),
    ).not.toBeNull();
    // it is no drag region, and a band toggle is no filler
    expect(band?.classList.contains("cb-drag-fill")).toBe(false);
    collapsed.unmount();

    // medium: the forced rail cannot expand; the band holds the sidebar toggle (the drawer)
    // whatever the collapsed choice
    for (const choice of [true, false]) {
      const medium = shell(choice, 720);
      const mediumBand = medium.container.querySelector(".cb-shell > .cb-shell-rail-toggle");
      expect(mediumBand?.querySelector("[data-part='top-row-expand-toggle']")).toBeNull();
      const drawerToggle = mediumBand?.querySelector("[data-part='top-row-drawer-toggle']");
      expect(drawerToggle?.getAttribute("aria-label")).toBe("显示侧栏");
      expect(drawerToggle?.getAttribute("aria-expanded")).toBe("false");
      expect(medium.container.querySelector("[data-part='expand-toggle']")).toBeNull();
      // the rail keeps its own sidebar toggle for windows whose controls fit; CSS hides it
      expect(
        medium.container.querySelector(".cb-sidebar[data-mode='rail'] [data-part='drawer-toggle']"),
      ).not.toBeNull();
      medium.unmount();
    }

    // the full sidebar: nothing in the band
    const full = shell(false, 1280);
    expect(full.container.querySelector(".cb-shell-rail-toggle")).toBeNull();
    expect(full.container.querySelector(".cb-sidebar[data-mode='full']")).not.toBeNull();
  });
});

describe("the medium rail's drawer (design spec §6.13, maintainer decision 2026-11-21)", () => {
  const desktop = (on: boolean) => {
    (window as unknown as { capybaraShell?: unknown }).capybaraShell = on
      ? {
          version: 1,
          kind: "desktop",
          platform: "macos",
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
          controls: { x: 0, y: 0, width: 92, height: 48 },
          capabilities: {},
          on: () => () => {},
        }
      : undefined;
  };
  afterEach(() => desktop(false));
  const withPage = {
    ...sidebar,
    context: {
      ...sidebar.context,
      primary: [
        { id: "agents", label: "Agents", href: "/agents", icon: "agent" as const },
        { id: "skills", label: "Skills", href: "/skills", icon: "skills" as const },
      ],
    },
  };
  const shell = (width: number, onCollapsedChange = vi.fn(), activeNav = "agents") => {
    vi.stubGlobal("matchMedia", matchMediaFor(width).matchMedia);
    const ui = (nav: string) => (
      <DesignProvider locale="zh">
        <AppShell
          sidebar={{ ...withPage, activeNav: nav }}
          collapsed={false}
          onCollapsedChange={onCollapsedChange}
        >
          <p>page</p>
        </AppShell>
      </DesignProvider>
    );
    const r = render(ui(activeNav));
    return { ...r, navigate: (nav: string) => r.rerender(ui(nav)) };
  };
  const drawerEl = () => document.querySelector("[data-part='sidebar-drawer']");
  const user = () => userEvent.setup({ pointerEventsCheck: 0 });

  it("the browser's medium rail has the sidebar toggle where the expand button sits; expanded has none", async () => {
    const wide = shell(1280);
    expect(wide.container.querySelector("[data-part='drawer-toggle']")).toBeNull();
    wide.unmount();
    const onCollapsed = vi.fn();
    const medium = shell(720, onCollapsed);
    const tools = medium.container.querySelector(
      ".cb-sidebar[data-mode='rail'] .cb-sidebar-rail-tools",
    );
    const toggle = tools?.firstElementChild?.matches("[data-part='drawer-toggle']")
      ? (tools.firstElementChild as HTMLElement)
      : null;
    expect(toggle?.getAttribute("aria-label")).toBe("显示侧栏");
    // no band in a browser
    expect(medium.container.querySelector(".cb-shell-rail-toggle")).toBeNull();
    await user().click(toggle as HTMLElement);
    const drawer = drawerEl();
    expect(drawer?.getAttribute("role")).toBe("dialog");
    // the full sidebar, with its scrim; the content is not pushed (the drawer is portaled)
    expect(
      drawer?.querySelector(".cb-sidebar[data-mode='full'][data-variant='drawer']"),
    ).not.toBeNull();
    expect(
      document.querySelector(".cb-sidebar-layer[data-drawer='true'] > .cb-sidebar-scrim"),
    ).not.toBeNull();
    expect(medium.container.contains(drawer)).toBe(false);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // its own toggle closes it
    await user().click(within(drawer as HTMLElement).getByRole("button", { name: "隐藏侧栏" }));
    expect(drawerEl()).toBeNull();
    // the remembered collapsed choice is untouched
    expect(onCollapsed).not.toHaveBeenCalled();
  });

  it("inside the desktop shell the band's toggle opens it; Esc, the scrim, the toggle and a pick close it", async () => {
    desktop(true);
    const r = shell(720);
    const toggle = () =>
      r.container.querySelector<HTMLElement>("[data-part='top-row-drawer-toggle']") as HTMLElement;
    // Esc
    await user().click(toggle());
    expect(drawerEl()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await user().keyboard("{Escape}");
    expect(drawerEl()).toBeNull();
    // the scrim
    await user().click(toggle());
    const scrim = document.querySelector<HTMLElement>("[data-part='sidebar-drawer-scrim']");
    expect(scrim).not.toBeNull();
    await user().click(scrim as HTMLElement);
    expect(drawerEl()).toBeNull();
    // the band's toggle again
    await user().click(toggle());
    expect(drawerEl()).not.toBeNull();
    await user().click(toggle());
    expect(drawerEl()).toBeNull();
    // choosing a page: the link click closes it, and so does the route change it causes
    await user().click(toggle());
    const link = within(drawerEl() as HTMLElement).getByRole("link", { name: "Skills" });
    link.addEventListener("click", (e) => e.preventDefault());
    await user().click(link);
    expect(drawerEl()).toBeNull();
    await user().click(toggle());
    expect(drawerEl()).not.toBeNull();
    r.navigate("skills");
    expect(drawerEl()).toBeNull();
  });

  it("⌘\\ / Ctrl+\\ opens and closes it on medium, and leaves the collapsed choice alone", async () => {
    const onCollapsed = vi.fn();
    shell(720, onCollapsed);
    const press = (init: KeyboardEventInit) =>
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", bubbles: true, ...init }));
      });
    press({ metaKey: true });
    expect(drawerEl()).not.toBeNull();
    press({ metaKey: true });
    expect(drawerEl()).toBeNull();
    press({ ctrlKey: true });
    expect(drawerEl()).not.toBeNull();
    press({ ctrlKey: true });
    expect(drawerEl()).toBeNull();
    // without the modifier: nothing
    press({});
    expect(drawerEl()).toBeNull();
    expect(onCollapsed).not.toHaveBeenCalled();
  });

  it("the medium toggles' tooltips show the shortcut, like the expand button's", async () => {
    desktop(true);
    const r = shell(720);
    for (const part of ["top-row-drawer-toggle", "drawer-toggle"]) {
      const button = r.container.querySelector<HTMLElement>(`[data-part='${part}']`) as HTMLElement;
      act(() => button.focus());
      const tip = await within(document.body).findByRole("tooltip");
      expect(tip.textContent, part).toContain("显示侧栏 ⌘\\");
      act(() => button.blur());
    }
  });

  it("leaving the medium class closes it", async () => {
    const mm = matchMediaFor(720);
    vi.stubGlobal("matchMedia", mm.matchMedia);
    render(
      <DesignProvider locale="zh">
        <AppShell sidebar={withPage} collapsed={false} onCollapsedChange={noop}>
          <p>page</p>
        </AppShell>
      </DesignProvider>,
    );
    await user().click(
      document.querySelector<HTMLElement>("[data-part='drawer-toggle']") as HTMLElement,
    );
    expect(drawerEl()).not.toBeNull();
    act(() => mm.resize(1280));
    expect(drawerEl()).toBeNull();
  });

  it("every drag region is off while it is open, and its roots never drag", () => {
    const sheetRules = parseCss(css("shell-environment.css"));
    const off = sheetRules
      .filter((r) => r.selector.includes(":has(") && r.decls["app-region"] === "no-drag")
      .map((r) => r.selector)
      .join(" ");
    for (const cls of ["cb-sidebar-layer", "cb-sidebar-scrim"]) {
      expect(off, cls).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
      expect(
        sheetRules.some(
          (r) =>
            r.at === null &&
            !r.selector.includes(":has(") &&
            new RegExp(`\\.${cls}(?![\\w-])`).test(r.selector) &&
            r.decls["app-region"] === "no-drag",
        ),
        cls,
      ).toBe(true);
    }
    // it starts below the band and the controls' row (the sheet layer's rule)
    expect(
      sheetRules.find((r) => r.selector === ':root[data-shell="desktop"] .cb-sidebar-layer')?.decls
        .top,
    ).toBe("max(var(--cb-shell-band), var(--cb-shell-row-start))");
  });
});

describe("the compact flat title bar inside the desktop shell (maintainer decision 2026-11-22)", () => {
  const FLAT = "not style(--cb-shell-flat: 0px)";
  const rules = () => parseCss(css("shell-environment.css"));
  const flat = (selector: string) =>
    Object.assign(
      {},
      ...rules()
        .filter((r) => r.at === FLAT && selectors(r.selector).includes(selector))
        .map((r) => r.decls),
    ) as Record<string, string>;
  const D = ':root[data-shell="desktop"]';

  it("is on only below 600 inside the desktop shell, without a banner, where controls are reported", () => {
    const source = css("shell-environment.css");
    // a registered length, so the style query compares a computed value (0 without controls)
    expect(source).toMatch(
      /@property --cb-shell-flat \{[^}]*syntax: "<length>";[^}]*initial-value: 0px;/,
    );
    const set = rules().filter((r) => r.decls["--cb-shell-flat"] !== undefined);
    expect(set.map((r) => [r.at, r.selector, r.decls["--cb-shell-flat"]])).toEqual([
      [
        "not all and (min-width: 600px)",
        `${D} .cb-shell:not([data-banner="true"])`,
        "var(--cb-shell-row)",
      ],
    ]);
    // the browser, touch and mobile shells keep the floating row: nothing in the flat block
    // applies outside the desktop shell
    const block = rules().filter((r) => r.at === FLAT);
    expect(block.length).toBeGreaterThan(5);
    for (const r of block) {
      for (const s of selectors(r.selector)) expect(s.startsWith(D), s).toBe(true);
    }
  });

  it("is one row as high as the controls on the page ground with a line-soft hairline under it", () => {
    const column = flat(`${D} .cb-shell-column`);
    expect(column["--cb-float-row"]).toBe("var(--cb-shell-flat)");
    expect(column["--cb-float-size"]).toBe("var(--cb-control-default)");
    expect(column["--cb-float-top"]).toBe(
      "calc((var(--cb-shell-flat) - var(--cb-float-size)) / 2)",
    );
    expect(flat(`${D} .cb-shell-column::before`)["border-bottom"]).toBe(
      "1px solid var(--cb-line-soft)",
    );
    // the strip under the row is the page ground, as high as the row (shell.css)
    const strip = parseCss(css("shell.css")).find(
      (r) => r.at === "not all and (min-width: 600px)" && r.selector === ".cb-shell-column::before",
    );
    expect(strip?.decls.background).toBe("var(--cb-bg)");
    expect(strip?.decls.height).toBe("var(--cb-float-row)");
  });

  it("its buttons are ghost and one desktop size: menu or back, the page's and the conversation's …", () => {
    for (const sel of [
      `${D} .cb-shell-float .cb-float-btn`,
      `${D} .cb-shell-float .cb-floatbar .cb-icon-btn`,
      `${D} .cb-shell .cb-title-bar .cb-title-overflow > .cb-icon-btn`,
    ]) {
      const d = flat(sel);
      expect(d.width, sel).toBe("var(--cb-control-default)");
      expect(d.height, sel).toBe("var(--cb-control-default)");
      expect(d.background, sel).toBe("transparent");
      expect(d.border, sel).toBe("0");
      expect(d["box-shadow"], sel).toBe("none");
    }
  });

  it("shows the plain title and the flat …, hides the pill and the floating …", () => {
    const bar = `${D} .cb-shell .cb-shell-main .cb-title-bar`;
    expect(flat(`${bar} > .cb-title-btn`).display).toBe("none");
    expect(
      flat(`${D} .cb-shell .cb-shell-main .cb-title-overflow[data-form="float"]`).display,
    ).toBe("none");
    expect(flat(`${bar} > .cb-title-plain`).display).toBe("flex");
    expect(flat(`${D} .cb-shell .cb-shell-main .cb-title-overflow[data-form="flat"]`).display).toBe(
      "contents",
    );
    // the bar spans the row from the menu button to the window's end edge, its own filler last
    expect(flat(bar).top).toBe("0");
    expect(flat(bar).height).toBe("var(--cb-shell-flat)");
    expect(flat(bar).right).toBe("0");
    expect(flat(`${bar} > .cb-drag-fill`).display).toBe("block");
    expect(flat(`${bar} > .cb-drag-fill`).width).toBe("var(--cb-float-end)");
    // the filler laid over the title covers it whole (conversation-page.css)
    const over = parseCss(css("conversation-page.css")).find(
      (r) => r.selector === ".cb-title-plain > .cb-drag-fill",
    );
    expect(over?.decls).toMatchObject({ position: "absolute", inset: "0" });
  });

  it("puts the title and … in the band's own row (one row, never a second row under the band)", () => {
    const bar = `${D} .cb-shell .cb-shell-main .cb-title-bar`;
    // the bar is the row: from the window's top edge, the row's height, centring its children
    // (the base rule), so the plain title (stretched) and the … (28, centred) share the band's box
    expect(flat(bar)).toMatchObject({ top: "0", height: "var(--cb-shell-flat)" });
    const base = parseCss(css("conversation-page.css"));
    expect(
      base.find((r) => r.at === null && r.selector === ".cb-title-bar")?.decls["align-items"],
    ).toBe("center");
    expect(
      base.find((r) => r.at === null && r.selector === ".cb-title-plain" && r.decls["align-self"])
        ?.decls["align-self"],
    ).toBe("stretch");
    // the band's buttons are centred in the same row: (row - size) / 2 from the top
    expect(flat(`${D} .cb-shell-column`)["--cb-float-top"]).toBe(
      "calc((var(--cb-shell-flat) - var(--cb-float-size)) / 2)",
    );
    // a pushed surface pads the main column down by the row (shell.css): the bar lifts back by
    // exactly that, so it never lands under the band
    const padded = parseCss(css("shell.css")).find(
      (r) =>
        r.at === "not all and (min-width: 600px)" &&
        r.selector === '.cb-shell[data-surface="pushed"] .cb-shell-main' &&
        r.decls["padding-top"],
    );
    expect(padded?.decls["padding-top"]).toBe("var(--cb-float-row)");
    expect(flat(`${D} .cb-shell[data-surface="pushed"] .cb-shell-main .cb-title-bar`).top).toBe(
      "calc(-1 * var(--cb-float-row))",
    );
    // the floating form does the same with its own offset (browser, touch, mobile)
    const lift = base.find(
      (r) =>
        r.at === "not all and (min-width: 600px)" &&
        r.selector === '.cb-shell[data-surface="pushed"] .cb-shell-main .cb-title-bar',
    );
    expect(lift?.decls.top).toBe("calc(var(--cb-float-top) - var(--cb-float-row))");
    // and the row's own gap filler never drags under the bar, on any surface
    expect(
      rules().some(
        (r) =>
          r.selector ===
            `${D} .cb-shell:has(.cb-shell-main .cb-title-bar:not([data-new])) .cb-floatbar > .cb-drag-fill` &&
          r.decls["app-region"] === "no-drag",
      ),
    ).toBe(true);
  });

  it("the title is plain text inside a filler; only the menu and … take clicks", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(480).matchMedia);
    const { container } = render(
      <DesignProvider locale="zh">
        <AppShell sidebar={sidebar} chatSurface drawer={drawer}>
          <TitleBar
            title="沙箱内 pnpm 安装失败"
            untitled="U"
            menu={[{ id: "rename", label: "重命名", icon: "square-pen", onSelect: noop }]}
            properties={{ pressed: false, onToggle: noop }}
            panels={[]}
          />
        </AppShell>
      </DesignProvider>,
    );
    const plain = container.querySelector(".cb-title-plain") as HTMLElement;
    expect(plain.tagName).toBe("SPAN");
    expect(plain.textContent).toBe("沙箱内 pnpm 安装失败");
    expect(plain.querySelector("button, a, [tabindex]")).toBeNull();
    expect(plain.querySelector(":scope > .cb-drag-fill")).not.toBeNull();
    // what the flat row shows that takes clicks: the floating row's menu button and the flat …
    const row = container.querySelector(".cb-floatbar") as HTMLElement;
    expect(row.querySelectorAll("button, a")).toHaveLength(1);
    expect(row.querySelector("button")?.classList.contains("cb-shell-menu-btn")).toBe(true);
    const flatMore = container.querySelector('[data-form="flat"]') as HTMLElement;
    expect(
      [...flatMore.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["更多操作"]);
    // every filler in the row stops dragging while an overlay is open: the title's filler is a
    // `.cb-drag-fill` like the others, which the overlay rule switches off
    const off = rules().find(
      (r) => r.selector.includes(":has(") && r.decls["app-region"] === "no-drag",
    );
    expect(off?.selector).toContain(".cb-drag-fill");
  });

  it("the … holds the properties toggle, the panels, then the title menu's items", async () => {
    vi.stubGlobal("matchMedia", matchMediaFor(480).matchMedia);
    const onRename = vi.fn();
    const { container } = render(
      <DesignProvider locale="zh">
        <TitleBar
          title="T"
          untitled="U"
          menu={[
            { id: "rename", label: "重命名", icon: "square-pen", onSelect: onRename },
            { id: "copy-link", label: "复制链接", icon: "link", onSelect: noop },
            { id: "compact", label: "压缩上下文", icon: "gauge", disabled: true, onSelect: noop },
          ]}
          properties={{ pressed: false, onToggle: noop }}
          panels={[{ id: "files", label: "文件", icon: "file-text", pressed: false, onOpen: noop }]}
        />
      </DesignProvider>,
    );
    const flatMore = container.querySelector('[data-form="flat"]') as HTMLElement;
    await userEvent.click(within(flatMore).getByRole("button", { name: "更多操作" }));
    const menu = document.querySelector(".cb-cmenu") as HTMLElement;
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["属性面板", "文件", "重命名", "复制链接", "压缩上下文"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    expect(
      within(menu).getByRole("menuitem", { name: "压缩上下文" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    // the touch / browser overflow keeps its items: the title pill still opens the title menu
    const float = container.querySelector('[data-form="float"]') as HTMLElement;
    await userEvent.click(within(float).getByRole("button", { name: "更多操作" }));
    expect(
      within(document.querySelector(".cb-cmenu") as HTMLElement)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["属性面板", "文件"]);
  });
});

describe("the side panel's header", () => {
  it("drags the window by its empty room only; its buttons stay controls", () => {
    const { container } = render(
      <DesignProvider locale="zh">
        <RightPanel title="浏览器" onClose={noop} onFullscreen={noop}>
          <p>body</p>
        </RightPanel>
      </DesignProvider>,
    );
    const head = container.querySelector(".cb-rpanel-head") as HTMLElement;
    const fills = head.querySelectorAll(":scope > .cb-drag-fill");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.childNodes.length).toBe(0);
    expect(fills[0]?.getAttribute("aria-hidden")).toBe("true");
    // the header itself is no drag region, and neither is any control in it
    expect(head.classList.contains("cb-drag-fill")).toBe(false);
    for (const b of head.querySelectorAll("button")) {
      expect(b.closest(".cb-drag-fill"), b.outerHTML).toBeNull();
    }
    expect(head.querySelectorAll("button").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the paper's top gutter in the desktop shell (layered shell spec §5)", () => {
  const rules = parseCss(css("shell-environment.css"));
  const wide = rules.filter((r) => r.at === "(min-width: 600px)");

  it("starts after the start reserve, so the band's sidebar toggle is never under it", () => {
    expect(
      wide.find((r) => r.selector === ':root[data-shell="desktop"] .cb-shell-gutter')?.decls.left,
    ).toBe("var(--cb-shell-column-reserve, 0px)");
    // and the toggle is a no-drag root as well (a later no-drag region cuts it out of a filler)
    const roots = rules.filter(
      (r) =>
        !r.selector.includes(":has(") &&
        r.decls["-webkit-app-region"] === "no-drag" &&
        r.decls["app-region"] === "no-drag",
    );
    expect(roots.flatMap((r) => selectors(r.selector).flatMap(subjects))).toContain(
      ".cb-shell-rail-toggle",
    );
  });

  it("over a head without a path row it is as high as the top row, which the head starts below", () => {
    const tall = wide.find(
      (r) => r.selector.includes("> .cb-shell-gutter") && r.selector.includes(":has("),
    );
    // (space.2 more in the rail-drop band, where the paper starts space.2 below the band)
    expect(tall?.decls.height).toBe(
      "calc( max(var(--cb-space-2), var(--cb-shell-row)) + min(var(--cb-space-2), calc(var(--cb-shell-paper-drop) * 100000)) )",
    );
    expect(
      wide.find(
        (r) =>
          r.selector ===
          ':root[data-shell="desktop"] .cb-shell-main .cb-template-head:not(:has(.cb-pageheader-path))',
      )?.decls["padding-top"],
    ).toBe("max(var(--cb-space-5), calc(var(--cb-shell-row) - var(--cb-space-2)))");
  });
});
