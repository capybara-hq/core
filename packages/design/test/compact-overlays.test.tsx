// The compact shell's overlays (design spec §2.5 focus, §6.7 bottom sheet, §6.52 drawer, §6.54
// NavDrawer, §6.55 AccountSheet, §6.16.2 options sheet): no sideways overflow, one text column, and
// the focus an overlay moves on open draws a ring only after a key. jsdom lays nothing out, so the
// geometry is pinned through the stylesheets' rules (measured in headless Chromium at 480 wide
// when this was fixed: the drawer was 8 px too wide from the conversation section, the account
// sheet 8 px from its own section).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as RD from "@radix-ui/react-dialog";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BottomSheetContent, DesignProvider, Drawer, NavRow } from "../src/index";

afterEach(cleanup);

const STYLES = resolve(import.meta.dirname, "../src/styles");
const read = (f: string) =>
  readFileSync(resolve(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rules in `css` outside any `@media` block whose selector list has `sel`. */
function topLevel(css: string, sel: string): string {
  let depth = 0;
  let flat = "";
  // drop every @media block's body, keep the top level
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith("@media", i)) {
      const open = css.indexOf("{", i);
      depth = 1;
      let j = open + 1;
      for (; j < css.length && depth > 0; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
      }
      i = j - 1;
      continue;
    }
    flat += css[i];
  }
  const out: string[] = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

describe("no sideways overflow", () => {
  const touch = read("touch.css");
  const sidebar = read("sidebar.css");
  const conv = read("conversation-page.css");

  it("the drawer's conversation section keeps to the panel: the sidebar's negative margin is undone", () => {
    // the sidebar's section runs out over the sidebar's space.2 padding; the drawer has none
    expect(topLevel(sidebar, ".cb-sidebar-convs")).toContain(
      "margin: 0 calc(-1 * var(--cb-space-2));",
    );
    expect(topLevel(touch, ".cb-navdrawer-recent > .cb-sidebar-convs")).toContain(
      "margin-inline: 0;",
    );
  });

  it("the drawer is a vertical scroller with the thin scrollbar", () => {
    const drawer = topLevel(touch, ".cb-drawer");
    expect(drawer).toContain("overflow: hidden auto;");
    expect(drawer).toContain("scrollbar-width: thin;");
    expect(drawer).toContain("scrollbar-color: var(--cb-scroll-thumb) transparent;");
    const body = topLevel(conv, ".cb-bsheet-body");
    expect(body).toContain("scrollbar-width: thin;");
  });

  it("the account section runs out exactly over the sheet body's side padding", () => {
    expect(topLevel(conv, ".cb-bsheet-body")).toContain(
      "padding: var(--cb-space-2) var(--cb-space-2)",
    );
    expect(topLevel(touch, ".cb-account")).toContain("margin: 0 calc(-1 * var(--cb-space-2));");
  });

  it("the account sheet's labels never wrap; the status line wraps inside its column", () => {
    const label = topLevel(touch, ".cb-account-label");
    expect(label).toContain("flex: none;");
    expect(label).toContain("white-space: nowrap;");
    const status = topLevel(touch, ".cb-account-status");
    expect(status).toContain("min-width: 0;");
    expect(status).toContain("overflow-wrap: anywhere;");
  });
});

describe("one text column", () => {
  const touch = read("touch.css");
  const conv = read("conversation-page.css");

  it("account rows without an icon reserve a NavRow's icon column; the avatar starts at the icons", () => {
    const account = topLevel(touch, ".cb-account");
    expect(account).toContain("--cb-account-icon: 20px;");
    expect(account).toContain(
      "--cb-account-text: calc(var(--cb-space-4) + var(--cb-account-icon) + var(--cb-space-3));",
    );
    // a NavRow: space.4 padding, the icon, space.3 to the label
    expect(topLevel(touch, ".cb-navrow")).toContain("padding: 0 var(--cb-space-4);");
    expect(topLevel(touch, ".cb-navrow")).toContain("gap: var(--cb-space-3);");
    expect(topLevel(touch, ".cb-account-line")).toContain(
      "padding: 0 var(--cb-space-4) 0 var(--cb-account-text);",
    );
    expect(topLevel(touch, ".cb-account-slot")).toContain(
      "padding: var(--cb-space-2) var(--cb-space-4) var(--cb-space-2) var(--cb-account-text);",
    );
    expect(topLevel(touch, ".cb-account-who")).toContain(
      "padding: var(--cb-space-2) var(--cb-space-4) var(--cb-space-3);",
    );
    // the touch icon widens the column with the NavRow's icon
    expect(touch).toMatch(/\.cb-account \{\s*--cb-account-icon: var\(--cb-touch-icon\);/);
  });

  it("the bottom sheet head: the title on the body's text column, the close button on its rows' edge", () => {
    expect(topLevel(conv, ".cb-bsheet-head")).toContain(
      "padding: 0 var(--cb-space-2) 0 var(--cb-space-4);",
    );
    // the rows: the body's space.2 padding, then their own space.2 to the text
    expect(topLevel(conv, ".cb-options-item")).toContain("padding: 0 var(--cb-space-2);");
  });

  it("the options sheet's notice is styled for every pointer, on the rows' text column", () => {
    const note = topLevel(conv, ".cb-options-sheet-note");
    expect(note).toContain("padding: 0 var(--cb-space-2);");
    expect(note).toContain("color: var(--cb-muted);");
    expect(topLevel(conv, ".cb-options-title")).toContain(
      "padding: var(--cb-space-2) var(--cb-space-2) var(--cb-space-1);",
    );
  });
});

describe("the focus an overlay moves on open", () => {
  it("the quiet mark removes every ring, above any component's own focus rule", () => {
    const base = read("base.css");
    expect(base).toMatch(
      /:root \[data-quiet-focus="true"\]:focus-visible \{\s*outline: none;\s*box-shadow: none;/,
    );
  });

  function DrawerHarness() {
    const [open, setOpen] = useState(false);
    return (
      <DesignProvider locale="zh">
        <button type="button" onClick={() => setOpen(true)}>
          菜单
        </button>
        <Drawer open={open} onOpenChange={setOpen} label="菜单">
          <NavRow icon="search" label="搜索" onSelect={() => {}} />
          <NavRow icon="inbox" label="收件箱" href="/inbox" />
        </Drawer>
      </DesignProvider>
    );
  }

  it("a drawer opened by a click focuses its first row quietly; a key press brings the ring back", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    await user.click(screen.getByRole("button", { name: "菜单" }));
    const first = await screen.findByRole("button", { name: "搜索" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first.getAttribute("data-quiet-focus")).toBe("true");
    await user.keyboard("{Shift>}{/Shift}");
    expect(first.getAttribute("data-quiet-focus")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(first.hasAttribute("data-quiet-focus")).toBe(false);
  });

  it("a drawer opened from the keyboard keeps the ring", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    await user.tab();
    await user.keyboard("{Enter}");
    const first = await screen.findByRole("button", { name: "搜索" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first.hasAttribute("data-quiet-focus")).toBe(false);
  });

  function SheetHarness() {
    const [open, setOpen] = useState(false);
    return (
      <DesignProvider locale="zh">
        <RD.Root open={open} onOpenChange={setOpen}>
          <RD.Trigger>会话选项</RD.Trigger>
          <BottomSheetContent title="会话选项" onDismiss={() => setOpen(false)}>
            <p>内容</p>
          </BottomSheetContent>
        </RD.Root>
      </DesignProvider>
    );
  }

  it("a bottom sheet opened by a click focuses its close button quietly, and loses the mark on blur", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    await user.click(screen.getByRole("button", { name: "会话选项" }));
    const close = await screen.findByRole("button", { name: "关闭" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(close.getAttribute("data-quiet-focus")).toBe("true");
    close.blur();
    expect(close.hasAttribute("data-quiet-focus")).toBe(false);
  });

  it("a bottom sheet opened from the keyboard keeps the ring on its close button", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    await user.tab();
    await user.keyboard("{Enter}");
    const close = await screen.findByRole("button", { name: "关闭" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(close.hasAttribute("data-quiet-focus")).toBe(false);
  });
});
