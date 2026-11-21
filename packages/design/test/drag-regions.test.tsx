// Window drag regions (desktop client spec §7.3 "The top row"): in Electron a drag region swallows
// every mouse event over it whatever is stacked above it (a menu, a tooltip, a toast), and a
// control inside one cannot be used. So only dedicated, empty filler elements drag: the flex
// spacers the templates draw in the top row (`.cb-drag-fill`) and the shell's controls area
// (`.cb-shell-band`), never a container that holds controls; and every filler stops dragging
// while an overlay is open.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
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
