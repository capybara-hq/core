// The iPhone Duo's strip and the web's overlays (interaction model §10.2, §10.4–10.7; D11, D13,
// D15, D16): while `nav@1` is present (`<html data-native-nav>`) the web draws no menu button and
// its drawer / rail / sidebar drop what the pill holds; the account sheet gains "Skills,
// connectors, devices…"; a bottom sheet's scrim runs full bleed while its panel stays inside the
// strip side's inset (`data-strip`); the floating back clears a left strip; a live split change
// moves things by CSS alone, so an open sheet and its scroll are kept.
//
// jsdom has no layout: what CSS does is read from the stylesheets with a small cascade (the rules
// whose selector matches the element, under the media conditions of the window's width, the most
// specific and then the last winning).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  BottomSheet,
  DesignProvider,
  type DrawerNavData,
  type NativeNavHandle,
  type NativeSectionId,
  NavDrawer,
} from "../src/index";
import { SHELL_ENVIRONMENT_SCRIPT } from "../src/shell/shell-environment-script";
import { type CssRule, css, parseCss } from "./css-rules";
import { matchMediaFor } from "./width";

const realMatchMedia = window.matchMedia;
const root = () => document.documentElement;

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  Reflect.deleteProperty(window, "capybaraShell");
  for (const a of ["data-native-nav", "data-strip", "data-shell", "data-shell-platform", "style"])
    root().removeAttribute(a);
  document.body.innerHTML = "";
});

// ---- the cascade -------------------------------------------------------------------------------

/** The stylesheets in `index.css`'s import order (source order across files). */
const FILES = [...css("index.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1] ?? "");
const RULES: (CssRule & { order: number })[] = FILES.flatMap((f) => parseCss(css(f))).map(
  (r, order) => ({ ...r, order }),
);

/** Split at top-level commas or spaces (not inside parentheses). */
function splitTop(text: string, sep: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (sep === "," ? ch === "," : /\s/.test(ch))) {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** An approximate specificity: [ids, classes / attributes / pseudo-classes, types]. */
function specificity(selector: string): number {
  const s = selector.replace(/:(is|not|has|where)\(/g, " (").replace(/::[\w-]+/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const types = (s.match(/(^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/** `prop`'s value in a rule's declarations (a later longhand or `inset` wins), or undefined. */
function declared(decls: Record<string, string>, prop: string): string | undefined {
  const SIDES = ["top", "right", "bottom", "left"];
  let value: string | undefined;
  for (const [k, v] of Object.entries(decls)) {
    if (k === prop) value = v;
    else if (k === "inset" && SIDES.includes(prop)) {
      const parts = splitTop(v, " ");
      const [t, r = t, b = t, l = r] = parts;
      value = [t, r, b, l][SIDES.indexOf(prop)];
    }
  }
  return value;
}

/** The value of `prop` that wins for `el` at a window `width` px wide (fine pointer). */
function cascade(el: Element, prop: string, width: number): string | undefined {
  const mm = matchMediaFor(width).matchMedia;
  let best: { spec: number; order: number; value: string } | undefined;
  for (const r of RULES) {
    if (r.at !== null && !mm(r.at).matches) continue;
    const value = declared(r.decls, prop);
    if (value === undefined) continue;
    for (const sel of splitTop(r.selector, ",")) {
      if (/::/.test(sel)) continue;
      let hit = false;
      try {
        hit = el.matches(sel);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      const spec = specificity(sel);
      if (!best || spec > best.spec || (spec === best.spec && r.order >= best.order))
        best = { spec, order: r.order, value };
    }
  }
  return best?.value;
}

/** Not displayed: the element or an ancestor resolves to `display: none`. */
function hiddenAt(el: Element | null, width: number): boolean {
  if (el === null) throw new Error("no element");
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    if (cascade(e, "display", width) === "none") return true;
  }
  return false;
}

// ---- fixtures ----------------------------------------------------------------------------------

const status = { context: "demo", version: "0.1.0", timeZone: "UTC" };
const MORE_LABEL = "技能、连接器、设备…";

function drawerData(): DrawerNavData {
  return {
    sections: [
      { id: "inbox", label: "收件箱", href: "/inbox", icon: "inbox", badge: { count: 3 } },
      { id: "agents", label: "智能体", href: "/agents", icon: "agent" },
      { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock" },
    ],
    more: [
      { id: "skills", label: "技能", href: "/skills", icon: "skills" },
      { id: "devices", label: "设备", href: "/devices", icon: "cpu" },
    ],
    moreLabel: MORE_LABEL,
    recent: { state: "ready", items: [], onRetry() {} },
    allConversations: { label: "全部会话", href: "/conversations" },
    newConversation: { label: "新会话", href: "/" },
    onSearch: () => {},
    account: {
      name: "Grant",
      orgName: "Meta1",
      personalSettingsHref: "/account/profile",
      theme: null,
      status: "正常",
      onSignOut: () => {},
    },
  };
}

const sidebar = {
  context: {
    kind: "work" as const,
    org: null,
    primary: [
      { id: "agents", label: "智能体", href: "/agents", icon: "agent" as const },
      { id: "skills", label: "技能", href: "/skills", icon: "skills" as const },
      { id: "schedules", label: "定时任务", href: "/schedules", icon: "clock" as const },
    ],
    more: [{ id: "devices", label: "设备", href: "/devices", icon: "cpu" as const }],
    inbox: { href: "/inbox", count: 3 },
  },
  newConversation: { href: "/" },
  activeNav: "",
  conversations: {
    state: "ready" as const,
    groups: [],
    moreGroups: false,
    onMoreGroups: () => {},
    onRetry: () => {},
    filter: { q: "", state: "all" as const, onChange: () => {} },
    archived: { count: 0, open: false, onOpenChange: () => {} },
    onRename: async () => {},
    onArchive: async () => {},
    onDelete: async () => {},
  },
  account: { name: "grant", menu: [{ label: "个人设置", href: "/account/profile" }] },
};

function fakeNav() {
  const account = new Set<() => void>();
  const nav: NativeNavHandle = {
    set: vi.fn(),
    onSelect: (_l: (id: NativeSectionId) => void) => () => {},
    onAction: () => () => {},
    onAccount: (l: () => void) => {
      account.add(l);
      return () => account.delete(l);
    },
  };
  return {
    nav,
    account() {
      for (const l of [...account]) l();
    },
  };
}

function shell(width: number, nav: NativeNavHandle | undefined, pathname = "/") {
  window.matchMedia = matchMediaFor(width).matchMedia;
  if (nav) root().setAttribute("data-native-nav", "");
  return render(
    <DesignProvider locale="zh">
      <AppShell
        sidebar={sidebar}
        status={status}
        pathname={pathname}
        chatSurface={pathname === "/"}
        drawer={drawerData()}
        commands={[{ label: "跳转", items: [{ id: "a", label: "智能体", onSelect() {} }] }]}
        {...(nav ? { nativeNav: nav } : {})}
      >
        <p data-testid="page">内容</p>
      </AppShell>
    </DesignProvider>,
  );
}

const OUTER = 382;
const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);

// ---- the tests ---------------------------------------------------------------------------------

describe("the Duo at 382 with data-native-nav", () => {
  it("no menu button", () => {
    shell(OUTER, fakeNav().nav);
    expect(hiddenAt(q(".cb-shell-menu-btn"), OUTER)).toBe(true);
    cleanup();
    root().removeAttribute("data-native-nav");
    // without nav@1 the drawer's button is back
    shell(OUTER, undefined);
    expect(hiddenAt(q(".cb-shell-menu-btn"), OUTER)).toBe(false);
  });

  it("the drawer drops the pill's entries: sections, search, New conversation and the recents", () => {
    window.matchMedia = matchMediaFor(OUTER).matchMedia;
    const drawer = (native: boolean) => {
      if (native) root().setAttribute("data-native-nav", "");
      else root().removeAttribute("data-native-nav");
      return render(
        <DesignProvider locale="zh">
          <NavDrawer open onOpenChange={() => {}} data={drawerData()} pathname="/" />
        </DesignProvider>,
      );
    };
    const pill = [
      '[data-part="drawer-search"]',
      '[data-part="drawer-new"]',
      '[data-part="drawer-recent"]',
      '[data-nav-section="inbox"]',
      '[data-nav-section="agents"]',
      '[data-nav-section="schedules"]',
    ];
    drawer(true);
    for (const s of pill) expect(hiddenAt(q(s), OUTER), s).toBe(true);
    // what stays: More (the level) and the account row
    expect(hiddenAt(screen.getByText("更多"), OUTER)).toBe(false);
    expect(hiddenAt(q('[data-part="drawer-account"]'), OUTER)).toBe(false);
    cleanup();
    drawer(false);
    for (const s of pill) expect(hiddenAt(q(s), OUTER), s).toBe(false);
  });

  it("account sheet holds 技能、连接器、设备…", () => {
    const fake = fakeNav();
    shell(OUTER, fake.nav);
    act(() => fake.account());
    const sheet = q('[data-part="account-sheet"]');
    expect(sheet).not.toBeNull();
    const row = q<HTMLButtonElement>('[data-part="account-more"]');
    expect(row?.textContent).toContain(MORE_LABEL);
    // it opens in the sheet (no pick: the sheet stays), as the drawer's More opens its level
    fireEvent.click(row as HTMLButtonElement);
    expect(q('[data-part="account-sheet"]')).toBe(sheet);
    expect(sheet?.querySelector(".cb-bsheet-title")?.textContent).toBe(MORE_LABEL);
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>('[data-part="account-more-item"]'),
    ];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["技能", "/skills"],
      ["设备", "/devices"],
    ]);
    const back = q<HTMLButtonElement>('[data-part="account-more-back"]');
    expect(document.activeElement).toBe(back);
    // back returns to the account rows, focus on the row that opened the level
    fireEvent.click(back as HTMLButtonElement);
    expect(q('[data-part="account-sheet"]')).toBe(sheet);
    expect(sheet?.querySelector(".cb-bsheet-title")?.textContent).toBe("账户");
    expect(document.activeElement).toBe(q('[data-part="account-more"]'));
  });

  it("the drawer's own account sheet keeps no such row (its More is in the drawer)", () => {
    window.matchMedia = matchMediaFor(OUTER).matchMedia;
    render(
      <DesignProvider locale="zh">
        <NavDrawer open onOpenChange={() => {}} data={drawerData()} pathname="/" />
      </DesignProvider>,
    );
    fireEvent.click(q('[data-part="drawer-account"]') as HTMLElement);
    expect(q('[data-part="account-sheet"]')).not.toBeNull();
    expect(q('[data-part="account-more"]')).toBeNull();
  });

  it("sheet panel ends at the strip inset", () => {
    window.matchMedia = matchMediaFor(OUTER).matchMedia;
    root().setAttribute("data-native-nav", "");
    root().setAttribute("data-strip", "right");
    render(
      <DesignProvider locale="zh">
        <BottomSheet open onOpenChange={() => {}} title="筛选">
          <p>行</p>
        </BottomSheet>
      </DesignProvider>,
    );
    const panel = q(".cb-bsheet") as HTMLElement;
    const scrim = q(".cb-bsheet-scrim") as HTMLElement;
    expect(cascade(panel, "right", OUTER)).toBe("var(--cb-inset-right)");
    // the scrim runs under the strip, edge to edge (D13)
    for (const side of ["top", "right", "bottom", "left"])
      expect(cascade(scrim, side, OUTER), side).toBe("0");
    // toasts sit inside the insets too (T0b.4)
    const region = document.createElement("div");
    region.className = "cb-toast-region";
    document.body.append(region);
    expect(cascade(region, "right", OUTER)).toContain("var(--cb-inset-right)");
    expect(cascade(region, "left", OUTER)).toContain("var(--cb-inset-left)");
  });

  it("without nav@1.side or a left inset the side is right", () => {
    (window as unknown as { capybaraShell: unknown }).capybaraShell = {
      version: 1,
      kind: "mobile",
      platform: "ios",
      insets: { top: 0, right: 84, bottom: 0, left: 0 },
      capabilities: { "nav@1": { set() {}, onSelect: () => () => {} } },
      on: () => () => {},
    };
    new Function(SHELL_ENVIRONMENT_SCRIPT)();
    expect(root().getAttribute("data-strip")).toBe("right");
    window.matchMedia = matchMediaFor(OUTER).matchMedia;
    render(
      <DesignProvider locale="zh">
        <BottomSheet open onOpenChange={() => {}} title="筛选" />
      </DesignProvider>,
    );
    expect(cascade(q(".cb-bsheet") as HTMLElement, "right", OUTER)).toBe("var(--cb-inset-right)");
  });
});

describe('the Duo at 382 with data-strip="left" (the left app of an inner split)', () => {
  beforeEach(() => {
    root().setAttribute("data-native-nav", "");
    root().setAttribute("data-strip", "left");
  });

  it("sheet panel starts after the left inset", () => {
    window.matchMedia = matchMediaFor(OUTER).matchMedia;
    render(
      <DesignProvider locale="zh">
        <BottomSheet open onOpenChange={() => {}} title="筛选" />
      </DesignProvider>,
    );
    expect(cascade(q(".cb-bsheet") as HTMLElement, "left", OUTER)).toBe("var(--cb-inset-left)");
    const scrim = q(".cb-bsheet-scrim") as HTMLElement;
    expect(cascade(scrim, "left", OUTER)).toBe("0");
  });

  it("back button clears the left inset", () => {
    shell(OUTER, fakeNav().nav, "/agents/a");
    const float = q(".cb-shell-float") as HTMLElement;
    const column = float.closest(".cb-shell-column") as HTMLElement;
    const shellEl = column.closest(".cb-shell") as HTMLElement;
    expect(q(".cb-shell-float .cb-float-btn")).not.toBeNull();
    // the shell pads its start by the left inset, so the column (the float's containing block)
    // starts after the strip; the float adds only the gutter: the inset counted once
    expect(cascade(shellEl, "padding-left", OUTER)).toBe("var(--cb-inset-left)");
    expect(cascade(column, "position", OUTER)).toBe("relative");
    expect(cascade(float, "left", OUTER)).toBe("var(--cb-space-4)");
    expect(hiddenAt(float, OUTER)).toBe(false);
  });

  it("a split side change keeps the open sheet and the scroll position (no remount)", () => {
    const listeners = new Set<() => void>();
    const shellObj: Record<string, unknown> = {
      version: 1,
      kind: "mobile",
      platform: "ios",
      insets: { top: 0, right: 0, bottom: 0, left: 84 },
      capabilities: { "nav@1": { set() {}, onSelect: () => () => {}, side: "left" } },
      on: (_e: string, l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    (window as unknown as { capybaraShell: unknown }).capybaraShell = shellObj;
    new Function(SHELL_ENVIRONMENT_SCRIPT)();
    const fake = fakeNav();
    shell(OUTER, fake.nav, "/agents");
    act(() => fake.account());
    const sheet = q('[data-part="account-sheet"]') as HTMLElement;
    const body = sheet.querySelector(".cb-bsheet-body") as HTMLElement;
    const page = screen.getByTestId("page");
    body.scrollTop = 120;
    const scrolled = body.scrollTop;
    expect(root().getAttribute("data-strip")).toBe("left");
    // the app moved to the right half of the split
    act(() => {
      Object.assign(shellObj, {
        insets: { top: 0, right: 84, bottom: 0, left: 0 },
        capabilities: { "nav@1": { set() {}, onSelect: () => () => {}, side: "right" } },
      });
      for (const l of [...listeners]) l();
    });
    expect(root().getAttribute("data-strip")).toBe("right");
    expect(q('[data-part="account-sheet"]')).toBe(sheet);
    expect(sheet.querySelector(".cb-bsheet-body")).toBe(body);
    expect(body.scrollTop).toBe(scrolled);
    expect(screen.getByTestId("page")).toBe(page);
    // the side is presentation only: no rule keyed on it changes a box (display, position)
    for (const r of RULES.filter((x) => x.selector.includes("[data-strip"))) {
      expect(r.decls.display, r.selector).toBeUndefined();
      expect(r.decls.position, r.selector).toBeUndefined();
    }
  });
});

describe("the rail and the sidebar beside the strip (the inner display)", () => {
  it("drop the pill's entries and keep the account", () => {
    const EXPANDED = 951;
    shell(EXPANDED, fakeNav().nav, "/agents");
    const side = q('.cb-sidebar[data-mode="full"]') as HTMLElement;
    for (const s of [
      '[data-part="search"]',
      '[data-part="inbox"]',
      '[data-part="new-conversation"]',
      ".cb-sidebar-recents",
      '[data-nav-section="agents"]',
      '[data-nav-section="schedules"]',
    ]) {
      expect(hiddenAt(side.querySelector(s), EXPANDED), s).toBe(true);
    }
    expect(hiddenAt(side.querySelector('[data-part="account"]'), EXPANDED)).toBe(false);
    // the filler keeps the account at the foot once the recents are gone
    expect(hiddenAt(side.querySelector(".cb-sidebar-fill[data-native-fill]"), EXPANDED)).toBe(
      false,
    );
  });

  it("the medium rail drops its Conversations button", () => {
    const MEDIUM = 700;
    shell(MEDIUM, fakeNav().nav, "/agents");
    const rail = q('.cb-sidebar[data-mode="rail"]') as HTMLElement;
    const button = rail.querySelector('[data-part="conversations-button"]');
    expect(button).not.toBeNull();
    expect(hiddenAt(button, MEDIUM)).toBe(true);
  });

  it("without nav@1 the sidebar keeps them", () => {
    const EXPANDED = 951;
    shell(EXPANDED, undefined, "/agents");
    const side = q('.cb-sidebar[data-mode="full"]') as HTMLElement;
    for (const s of [
      '[data-part="search"]',
      '[data-part="new-conversation"]',
      ".cb-sidebar-recents",
    ])
      expect(hiddenAt(side.querySelector(s), EXPANDED), s).toBe(false);
    expect(hiddenAt(side.querySelector(".cb-sidebar-fill[data-native-fill]"), EXPANDED)).toBe(true);
  });
});
