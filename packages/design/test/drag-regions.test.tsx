// Window drag regions (desktop client spec §7.3 "The top row"): in Electron a drag region swallows
// every mouse event over it whatever is stacked above it (a menu, a tooltip, a toast), and a
// control inside one cannot be used. So only dedicated, empty filler elements drag: the flex
// spacers the templates draw in the top row (`.cb-drag-fill`) and the shell's controls area
// (`.cb-shell-band`), never a container that holds controls; and every filler stops dragging
// while an overlay is open.
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

  it("every filler stops dragging while an overlay is open", () => {
    const off = parseCss(css("shell-environment.css")).filter(
      (r) =>
        r.selector.includes(":has(") &&
        r.decls["-webkit-app-region"] === "no-drag" &&
        r.decls["app-region"] === "no-drag",
    );
    const selector = off.map((r) => r.selector).join(" ");
    for (const cls of [
      "cb-drag-fill",
      "cb-shell-band",
      "cb-menu",
      "cb-popover",
      "cb-cmenu",
      "cb-dialog",
      "cb-sheet",
      "cb-tooltip",
      "cb-toast",
      "cb-palette",
      "cb-drawer",
    ]) {
      expect(selector, cls).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
    }
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
  recent: {
    state: "ready",
    groups: [],
    moreGroups: false,
    onMoreGroups: noop,
    onRetry: noop,
    filter: { q: "", state: "all", onChange: noop },
    archived: { count: 0, open: false, onOpenChange: noop },
    onRename: async () => {},
    onArchive: async () => {},
    onDelete: async () => {},
  },
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
      <AppShell sidebar={sidebar} status={status}>
        <TitleBar
          title="T"
          untitled="U"
          menu={[{ id: "rename", label: "重命名", icon: "square-pen", onSelect: noop }]}
          properties={{ pressed: false, onToggle: noop }}
          panels={[{ id: "files", label: "文件", icon: "file-text", pressed: false, onOpen: noop }]}
        />
        <NewTitleBar />
        <PageHeader
          path={[{ label: "acme", href: "/" }, { label: "agents" }]}
          title="Agents"
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
      ".cb-shared-bar",
    ]) {
      const el = container.querySelector(row);
      expect(el, row).not.toBeNull();
      expect(el?.querySelector(":scope > .cb-drag-fill"), row).not.toBeNull();
    }
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
        <AppShell sidebar={sidebar} status={status}>
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
      ':root[data-shell="desktop"] .cb-shell[data-surface="chat"]:has(.cb-title-bar:not([data-new])) .cb-floatbar > .cb-drag-fill',
    ]);
  });

  it("the gap is as high as the top row where controls are reported, and 0 on a chat surface without", () => {
    const compact = parseCss(css("shell-environment.css")).filter(
      (r) => r.at === "(max-width: 599px)",
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
        <AppShell sidebar={sidebar} status={status} chatSurface drawer={drawer}>
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
    expect(shell.matches(":has(.cb-title-bar:not([data-new]))")).toBe(false);
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
          status={{ context: "c", version: "v" }}
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
    for (const row of [".cb-sidebar-top", ".cb-title-bar", ".cb-pageheader-path"]) {
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
        <AppShell sidebar={sidebar} status={status} collapsed={collapsed} onCollapsedChange={noop}>
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

  it("a hairline under the band closes it where the rail drops, and nowhere else", () => {
    const line =
      ':root[data-shell="desktop"] .cb-shell:not([data-banner="true"]):has(> .cb-sidebar[data-mode="rail"])::after';
    expect(decl(line, "top", BAND_QUERY)).toBe(
      "calc(var(--cb-shell-band) + var(--cb-shell-rail-drop) - 1px)",
    );
    expect(decl(line, "left", BAND_QUERY)).toBe("0");
    expect(decl(line, "right", BAND_QUERY)).toBe("0");
    expect(decl(line, "height", BAND_QUERY)).toBe("1px");
    // the sidebar's own divider colour, so the rail's divider meets it in a T
    expect(decl(line, "background", BAND_QUERY)).toBe("var(--cb-line-soft)");
    expect(decl(line, "pointer-events", BAND_QUERY)).toBe("none");
    // drawn only inside the style query: no rail drop (browser, full sidebar, banner), no line
    expect(decl(line, "content")).toBeUndefined();
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
          status={status}
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

  it("leaving the medium class closes it", async () => {
    const mm = matchMediaFor(720);
    vi.stubGlobal("matchMedia", mm.matchMedia);
    render(
      <DesignProvider locale="zh">
        <AppShell sidebar={withPage} status={status} collapsed={false} onCollapsedChange={noop}>
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
