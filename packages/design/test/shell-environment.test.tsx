// The Shell environment on the design side (mobile layout spec §9.3, §7.5): the inline script that
// marks `<html>` before the first paint, the AppShell's live updates after hydration, the
// `shell=` state token and `chrome@1.setAppearance`; and the inset tokens of base.css.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  DesignProvider,
  PageHeader,
  readShellEnvironment,
  ShellReady,
} from "../src/index";
import {
  SHELL_ENVIRONMENT_SCRIPT,
  ShellEnvironmentScript,
} from "../src/shell/shell-environment-script";
import { parseCss } from "./css-rules";
import { insideFrame } from "./support/page";

const root = () => document.documentElement;
const PROPS = [
  "--cb-shell-inset-top",
  "--cb-shell-inset-right",
  "--cb-shell-inset-bottom",
  "--cb-shell-inset-left",
  "--cb-shell-controls-x",
  "--cb-shell-controls-y",
  "--cb-shell-controls-width",
  "--cb-shell-controls-height",
];

/** A fake shell whose fields a test changes, announcing them with `change`. */
function fakeShell(over: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>();
  const shell = {
    version: 1,
    kind: "desktop",
    platform: "macos",
    shellVersion: "0.1.0",
    insets: { top: 28, right: 0, bottom: 0, left: 0 },
    controls: { x: 8, y: 6, width: 64, height: 16 } as Record<string, number> | null,
    capabilities: {} as Record<string, object>,
    on: vi.fn((_event: "change", listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ...over,
  };
  return {
    shell,
    listeners,
    change(next: Partial<typeof shell>) {
      Object.assign(shell, next);
      for (const l of [...listeners]) l();
    },
  };
}

const install = (shell: unknown) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
};
/** Runs the inline script as the browser would (a classic script in the top frame). */
const runScript = () => new Function(SHELL_ENVIRONMENT_SCRIPT)();

const untouched = () => {
  expect(root().hasAttribute("data-shell")).toBe(false);
  expect(root().hasAttribute("data-shell-platform")).toBe(false);
  for (const p of PROPS) expect(root().style.getPropertyValue(p)).toBe("");
};

function clearRoot() {
  root().removeAttribute("data-shell");
  root().removeAttribute("data-shell-platform");
  root().removeAttribute("data-native-nav");
  for (const p of PROPS) root().style.removeProperty(p);
  root().removeAttribute("data-theme");
}

beforeEach(clearRoot);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "capybaraShell");
  clearRoot();
});

describe("the inline script (before the first paint)", () => {
  it("leaves <html> untouched without a shell", () => {
    runScript();
    untouched();
  });

  it("marks <html> with the shell, its platform, insets and controls", () => {
    install(fakeShell().shell);
    runScript();
    expect(root().dataset.shell).toBe("desktop");
    expect(root().dataset.shellPlatform).toBe("macos");
    expect(root().style.getPropertyValue("--cb-shell-inset-top")).toBe("28px");
    expect(root().style.getPropertyValue("--cb-shell-inset-left")).toBe("0px");
    expect(root().style.getPropertyValue("--cb-shell-controls-x")).toBe("8px");
    expect(root().style.getPropertyValue("--cb-shell-controls-y")).toBe("6px");
    expect(root().style.getPropertyValue("--cb-shell-controls-width")).toBe("64px");
    expect(root().style.getPropertyValue("--cb-shell-controls-height")).toBe("16px");
  });

  it("does nothing for another envelope version", () => {
    install(fakeShell({ version: 2 }).shell);
    runScript();
    untouched();
  });

  it("does nothing inside a frame (window.top is another window)", () => {
    install(fakeShell().shell);
    insideFrame(runScript);
    untouched();
  });

  it("does nothing for an unknown kind, and drops an unknown platform", () => {
    install(fakeShell({ kind: "kiosk" }).shell);
    runScript();
    untouched();
    install(fakeShell({ platform: "beos" }).shell);
    runScript();
    expect(root().dataset.shell).toBe("desktop");
    expect(root().hasAttribute("data-shell-platform")).toBe(false);
  });

  it("never writes a value it has not checked: numbers are finite, non-negative and bounded", () => {
    install(
      fakeShell({
        insets: { top: "28px; color: red", right: -4, bottom: Number.NaN, left: 1e9 },
        controls: { x: 8, y: 6, width: Number.POSITIVE_INFINITY, height: 16 },
      }).shell,
    );
    runScript();
    expect(root().style.getPropertyValue("--cb-shell-inset-top")).toBe("0px");
    expect(root().style.getPropertyValue("--cb-shell-inset-right")).toBe("0px");
    expect(root().style.getPropertyValue("--cb-shell-inset-bottom")).toBe("0px");
    expect(root().style.getPropertyValue("--cb-shell-inset-left")).toBe("512px");
    // one bad number: no controls rectangle at all
    for (const p of PROPS.slice(4)) expect(root().style.getPropertyValue(p)).toBe("");
  });

  it("does nothing for a global without an on function", () => {
    install(fakeShell({ on: "nope" }).shell);
    runScript();
    untouched();
  });

  it("leaves the controls unset when they are null or absent", () => {
    install(fakeShell({ controls: null }).shell);
    runScript();
    expect(root().style.getPropertyValue("--cb-shell-inset-top")).toBe("28px");
    for (const p of PROPS.slice(4)) expect(root().style.getPropertyValue(p)).toBe("");
  });

  it("survives a shell whose getters throw", () => {
    install(
      new Proxy(
        {},
        {
          get() {
            throw new Error("boom");
          },
        },
      ),
    );
    expect(runScript).not.toThrow();
    untouched();
  });

  it("is a fixed string: the same for every render, and reads the page nothing", () => {
    expect(SHELL_ENVIRONMENT_SCRIPT).not.toMatch(/\$\{/);
    const a = renderToStaticMarkup(<ShellEnvironmentScript nonce="abc" />);
    const b = renderToStaticMarkup(<ShellEnvironmentScript nonce="xyz" />);
    expect(a.replace('nonce="abc"', "")).toBe(b.replace('nonce="xyz"', ""));
    expect(a).toContain('nonce="abc"');
    expect(a).toContain(SHELL_ENVIRONMENT_SCRIPT.slice(0, 40));
    // no nonce (no proxy, no CSP): no attribute
    expect(renderToStaticMarkup(<ShellEnvironmentScript nonce="" />)).not.toContain("nonce");
  });

  it("marks <html> with data-native-nav when nav@1 is an own object, and not otherwise", () => {
    install(fakeShell({ kind: "mobile", platform: "ios", capabilities: { "nav@1": {} } }).shell);
    runScript();
    expect(root().hasAttribute("data-native-nav")).toBe(true);
    for (const capabilities of [
      {},
      { "nav@1": null },
      { "nav@1": "yes" },
      Object.create({ "nav@1": {} }),
      undefined,
    ]) {
      clearRoot();
      install(fakeShell({ kind: "mobile", platform: "ios", capabilities }).shell);
      runScript();
      expect(root().dataset.shell).toBe("mobile");
      expect(root().hasAttribute("data-native-nav")).toBe(false);
    }
  });

  it("agrees with readShellEnvironment (the AppShell's reader) on every case", () => {
    const cases: unknown[] = [
      undefined,
      fakeShell().shell,
      fakeShell({ version: 2 }).shell,
      fakeShell({ controls: null }).shell,
      fakeShell({
        kind: "mobile",
        platform: "ios",
        insets: { top: 0, right: 0, bottom: 34, left: 0 },
      }).shell,
      fakeShell({ insets: { top: 1e9, right: -1, bottom: "x", left: 3 } }).shell,
      fakeShell({ on: undefined }).shell,
    ];
    for (const c of cases) {
      clearRoot();
      install(c);
      runScript();
      const env = readShellEnvironment(window);
      if (env === null) {
        untouched();
        continue;
      }
      expect(root().dataset.shell).toBe(env.kind);
      for (const side of ["top", "right", "bottom", "left"] as const) {
        expect(root().style.getPropertyValue(`--cb-shell-inset-${side}`)).toBe(
          `${env.insets[side]}px`,
        );
      }
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
const shellTree = (singleScheme?: boolean) => (
  <DesignProvider locale="zh">
    <AppShell
      sidebar={sidebar}
      capState="run=idle"
      {...(singleScheme === undefined ? {} : { singleScheme })}
    >
      <p>page</p>
    </AppShell>
  </DesignProvider>
);
const renderShell = () => render(shellTree());

/** The seven main color tokens chrome@1 carries, as a theme would set them on <html>. */
const TOKENS = {
  "--cb-bg": "#101010",
  "--cb-panel": "#181818",
  "--cb-ink": "rgb(240, 240, 240)",
  "--cb-muted": "#888",
  "--cb-line": "rgba(255, 255, 255, 0.12)",
  "--cb-accent": "#00ff99",
  "--cb-on-accent": "#000000",
};
const setTokens = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...TOKENS, ...over })) root().style.setProperty(k, v);
};
const clearTokens = () => {
  for (const k of Object.keys(TOKENS)) root().style.removeProperty(k);
};
const capState = (c: HTMLElement) =>
  (c.querySelector(".cb-shell") as HTMLElement).dataset.capState ?? "";

describe("the AppShell in a shell (after hydration)", () => {
  it("adds shell=<kind> to the state tokens inside a shell, nothing in a browser", () => {
    const { container, unmount } = renderShell();
    expect(capState(container)).not.toMatch(/shell=/);
    unmount();
    install(fakeShell().shell);
    const view = renderShell();
    expect(capState(view.container).split(" ").at(-1)).toBe("shell=desktop");
  });

  it("follows change: controls set to null remove the controls properties", () => {
    const f = fakeShell();
    install(f.shell);
    runScript();
    const { unmount } = renderShell();
    expect(root().style.getPropertyValue("--cb-shell-controls-width")).toBe("64px");
    act(() => f.change({ controls: null, insets: { top: 0, right: 0, bottom: 0, left: 0 } }));
    for (const p of PROPS.slice(4)) expect(root().style.getPropertyValue(p)).toBe("");
    expect(root().style.getPropertyValue("--cb-shell-inset-top")).toBe("0px");
    act(() => f.change({ controls: { x: 0, y: 0, width: 80, height: 28 } }));
    expect(root().style.getPropertyValue("--cb-shell-controls-width")).toBe("80px");
    // unmounted: it no longer listens
    unmount();
    expect(f.listeners.size).toBe(0);
  });

  it("tells chrome@1 the scheme and background once per theme change", async () => {
    const setAppearance = vi.fn();
    const f = fakeShell({ capabilities: { "chrome@1": { setAppearance } } });
    install(f.shell);
    root().dataset.theme = "dark";
    renderShell();
    expect(setAppearance).toHaveBeenCalledWith({ scheme: "dark", background: "#0A0A0A" });
    setAppearance.mockClear();
    await act(async () => {
      root().dataset.theme = "light";
      // MutationObserver callbacks run as microtasks
      await Promise.resolve();
    });
    expect(setAppearance).toHaveBeenCalledTimes(1);
    expect(setAppearance).toHaveBeenCalledWith({ scheme: "light", background: "#FDFDFC" });
    // an unrelated change (insets) sends nothing new
    act(() => f.change({ insets: { top: 0, right: 0, bottom: 0, left: 0 } }));
    expect(setAppearance).toHaveBeenCalledTimes(1);
  });

  it("follows a theme that changes the background through <html>'s style or class", async () => {
    const setAppearance = vi.fn();
    install(fakeShell({ capabilities: { "chrome@1": { setAppearance } } }).shell);
    root().dataset.theme = "dark";
    renderShell();
    setAppearance.mockClear();
    await act(async () => {
      root().style.setProperty("--cb-bg", "#123456");
      await Promise.resolve();
    });
    expect(setAppearance).toHaveBeenCalledTimes(1);
    expect(setAppearance).toHaveBeenCalledWith({ scheme: "dark", background: "#123456" });
    root().style.removeProperty("--cb-bg");
  });

  it("adds the seven color tokens only when every one is a plain color", async () => {
    const setAppearance = vi.fn();
    install(fakeShell({ capabilities: { "chrome@1": { setAppearance } } }).shell);
    root().dataset.theme = "dark";
    setTokens();
    try {
      renderShell();
      expect(setAppearance).toHaveBeenCalledTimes(1);
      expect(setAppearance).toHaveBeenCalledWith({
        scheme: "dark",
        background: "#101010",
        tokens: {
          bg: "#101010",
          panel: "#181818",
          ink: "rgb(240, 240, 240)",
          muted: "#888",
          line: "rgba(255, 255, 255, 0.12)",
          accent: "#00ff99",
          onAccent: "#000000",
        },
      });
      setAppearance.mockClear();
      // a token the shell cannot check (color-mix) drops all of them, not just that one
      await act(async () => {
        root().style.setProperty("--cb-line", "color-mix(in srgb, #fff 12%, transparent)");
        await Promise.resolve();
      });
      expect(setAppearance).toHaveBeenCalledTimes(1);
      expect(setAppearance).toHaveBeenCalledWith({ scheme: "dark", background: "#101010" });
      setAppearance.mockClear();
      // a changed token is a new report
      await act(async () => {
        setTokens({ "--cb-accent": "#ff0066" });
        await Promise.resolve();
      });
      expect(setAppearance).toHaveBeenCalledTimes(1);
      expect(setAppearance.mock.calls[0]?.[0].tokens.accent).toBe("#ff0066");
    } finally {
      clearTokens();
    }
  });

  it("says singleScheme when the AppShell is told so, and reports a flip once", () => {
    const setAppearance = vi.fn();
    install(fakeShell({ capabilities: { "chrome@1": { setAppearance } } }).shell);
    root().dataset.theme = "dark";
    const view = render(shellTree(true));
    expect(setAppearance).toHaveBeenCalledTimes(1);
    expect(setAppearance).toHaveBeenCalledWith({
      scheme: "dark",
      background: "#0A0A0A",
      singleScheme: true,
    });
    setAppearance.mockClear();
    view.rerender(shellTree(true));
    expect(setAppearance).not.toHaveBeenCalled();
    view.rerender(shellTree(false));
    expect(setAppearance).toHaveBeenCalledTimes(1);
    expect(setAppearance).toHaveBeenCalledWith({ scheme: "dark", background: "#0A0A0A" });
  });

  it("draws the window drag band as a real element, hidden from assistive tech", () => {
    const { container } = renderShell();
    const band = container.querySelector(".cb-shell > .cb-shell-band") as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.getAttribute("aria-hidden")).toBe("true");
  });

  it("calls no appearance without chrome@1, and a capability that throws breaks nothing", async () => {
    install(fakeShell({ capabilities: {} }).shell);
    root().dataset.theme = "dark";
    expect(renderShell).not.toThrow();
    cleanup();
    install(
      fakeShell({
        capabilities: {
          "chrome@1": {
            setAppearance: () => {
              throw new Error("native");
            },
          },
        },
      }).shell,
    );
    expect(renderShell).not.toThrow();
  });
});

describe("ShellReady (chrome@1.ready, once per document)", () => {
  /** Holds animation frames until a test runs them. */
  function frames() {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return queue.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    return () => {
      for (const cb of queue.splice(0)) cb(0);
    };
  }
  const ready = (over: Record<string, unknown> = {}) =>
    fakeShell({ kind: "mobile", platform: "ios", capabilities: { "chrome@1": over } }).shell;

  it("calls ready once after a frame, and not again on a rerender or a remount", () => {
    const run = frames();
    const fn = vi.fn();
    install(ready({ ready: fn }));
    const view = render(<ShellReady />);
    expect(fn).not.toHaveBeenCalled();
    act(run);
    expect(fn).toHaveBeenCalledTimes(1);
    view.rerender(<ShellReady />);
    act(run);
    view.unmount();
    render(<ShellReady />);
    act(run);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("skips silently when ready is absent, throws or rejects", () => {
    const run = frames();
    install(ready({}));
    expect(() => {
      render(<ShellReady />);
      act(run);
    }).not.toThrow();
    cleanup();
    install(
      ready({
        ready: () => {
          throw new Error("native");
        },
      }),
    );
    expect(() => {
      render(<ShellReady />);
      act(run);
    }).not.toThrow();
    cleanup();
    install(ready({ ready: () => Promise.reject(new Error("native")) }));
    expect(() => {
      render(<ShellReady />);
      act(run);
    }).not.toThrow();
  });

  it("does nothing in a frame", () => {
    const run = frames();
    const fn = vi.fn();
    install(ready({ ready: fn }));
    insideFrame(() => {
      render(<ShellReady />);
      act(run);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    expect(renderToStaticMarkup(<ShellReady />)).toBe("");
  });
});

describe("the inset tokens (spec §7.5, design spec §4.7)", () => {
  const css = (f: string) => readFileSync(resolve(import.meta.dirname, "../src/styles", f), "utf8");

  it("base.css combines the OS safe areas with the shell's insets", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(css("base.css")).toContain(
        `--cb-inset-${side}: max(env(safe-area-inset-${side}, 0px), var(--cb-shell-inset-${side}, 0px));`,
      );
    }
  });

  it("the shell environment CSS is imported in the design layer", () => {
    expect(css("index.css")).toContain('@import "./shell-environment.css" layer(design);');
  });

  it("the pinned composer pads by the inset token, not the raw safe area", () => {
    expect(css("conversation-page.css")).not.toMatch(/env\(safe-area-inset-bottom\)\)/);
  });
});

describe("desktop drag regions (desktop client spec §7.3)", () => {
  const css = readFileSync(
    resolve(import.meta.dirname, "../src/styles/shell-environment.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every innermost rule: its selector list (whitespace collapsed) and its body. */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").replace(/\s+/g, " ").trim(),
    body: m[2] ?? "",
  }));
  const desktopRule = (cls: string, decl: RegExp) =>
    rules.some(
      (r) =>
        r.selector.includes(':root[data-shell="desktop"]') &&
        new RegExp(`\\.${cls}(?![\\w-])`).test(r.selector) &&
        decl.test(r.body),
    );
  const OVERLAYS = [
    "cb-scrim",
    "cb-dialog",
    "cb-sheet",
    "cb-bsheet",
    "cb-bsheet-scrim",
    "cb-menu",
    "cb-popover",
    "cb-cmenu",
    "cb-tooltip",
    "cb-palette",
    "cb-toast-region",
    "cb-viewer",
    "cb-conv-sheet",
    "cb-conv-scrim",
    "cb-sidebar-layer",
    "cb-sidebar-scrim",
    "cb-drawer",
    "cb-drawer-scrim",
    "cb-conv-pushed",
  ];

  it("the band is a real element that drags; no pseudo-element carries a drag region", () => {
    expect(desktopRule("cb-shell-band", /(^|[^-])app-region: drag/)).toBe(true);
    expect(rules.filter((r) => r.selector.includes("::") && /app-region/.test(r.body))).toEqual([]);
  });

  it("every portaled overlay root is no-drag, so it stays clickable over the band", () => {
    for (const cls of OVERLAYS) {
      expect(desktopRule(cls, /-webkit-app-region: no-drag/), cls).toBe(true);
      expect(desktopRule(cls, /(^|[^-])app-region: no-drag/), cls).toBe(true);
    }
  });

  it("full-height overlays start below the band and the top row on their controls' side", () => {
    for (const [cls, row] of [
      ["cb-sheet", "row-end"],
      ["cb-conv-sheet", "row-end"],
      ["cb-sidebar-layer", "row-start"],
      ["cb-viewer", "row"],
    ] as const) {
      const decl = new RegExp(`top: max\\(var\\(--cb-shell-band\\), var\\(--cb-shell-${row}\\)\\)`);
      expect(desktopRule(cls, decl), cls).toBe(true);
    }
    expect(
      desktopRule(
        "cb-conv-pushed",
        /padding-top: max\(var\(--cb-shell-band\), var\(--cb-shell-row\)\)/,
      ),
    ).toBe(true);
    expect(
      desktopRule(
        "cb-drawer",
        /padding-top: max\(var\(--cb-inset-top\), var\(--cb-shell-row-start\)\)/,
      ),
    ).toBe(true);
  });

  const body = (selector: string) =>
    rules.filter((r) => r.selector === selector).map((r) => r.body.replace(/\s+/g, " "));

  it("a mobile shell keeps the band down to the controls; the desktop's band is its top inset", () => {
    expect(body(":root[data-shell]").join()).toMatch(
      /--cb-shell-band: max\( var\(--cb-inset-top\), calc\(var\(--cb-shell-controls-y, 0px\) \+ var\(--cb-shell-controls-height, 0px\)\) \)/,
    );
    expect(body(':root[data-shell="desktop"]').join()).toContain(
      "--cb-shell-band: var(--cb-inset-top);",
    );
    expect(body(":root[data-shell] .cb-shell").join()).toContain(
      "padding-top: var(--cb-shell-band);",
    );
  });

  it("the desktop's top row is the controls' height, reserved only where they reach below the band", () => {
    const root = body(':root[data-shell="desktop"]').join();
    expect(root).toMatch(
      /--cb-shell-below: max\( 0px, calc\(\(var\(--cb-shell-controls-bottom\) - var\(--cb-shell-band\)\) \* 100000\) \)/,
    );
    expect(root).toContain(
      "--cb-shell-row: min(var(--cb-shell-controls-bottom), var(--cb-shell-below));",
    );
    for (const side of ["start", "end"]) {
      expect(root).toMatch(new RegExp(`--cb-shell-reserve-${side}: min\\(`));
      expect(root).toContain(`--cb-shell-row-${side}: min(var(--cb-shell-row),`);
    }
  });

  it("the top row's first rows take its height and keep clear of the controls", () => {
    expect(
      desktopRule(
        "cb-sidebar-top",
        /height: max\(var\(--cb-row-default\), var\(--cb-shell-row\)\)/,
      ),
    ).toBe(true);
    expect(desktopRule("cb-sidebar-top", /padding-left: max\([^;]*--cb-shell-reserve-start/)).toBe(
      true,
    );
    for (const cls of ["cb-title-bar", "cb-shared-bar"]) {
      expect(
        desktopRule(cls, /height: max\(var\(--cb-layout-title-bar\), var\(--cb-shell-row\)\)/),
        cls,
      ).toBe(true);
      expect(desktopRule(cls, /padding-right: max\([^;]*--cb-shell-reserve-end/), cls).toBe(true);
    }
    expect(desktopRule("cb-shell-float", /left: var\(--cb-float-start\)/)).toBe(true);
    expect(desktopRule("cb-shell-band", /width: max\(var\(--cb-shell-reserve-start\)/)).toBe(true);
    expect(desktopRule("cb-pageheader-path", /min-height: var\(--cb-shell-row\)/)).toBe(true);
  });
});

describe("the page path in the desktop's top row (desktop client spec §7.3, decision 2026-11-21)", () => {
  const rules = parseCss(
    readFileSync(resolve(import.meta.dirname, "../src/styles/shell-environment.css"), "utf8"),
  );
  const DESKTOP_HEAD = ':root[data-shell="desktop"] .cb-shell-main';
  const find = (selector: string, prop: string) =>
    rules.find((r) => r.at === "(min-width: 600px)" && r.selector === selector && r.decls[prop])
      ?.decls[prop];

  it("leaves the centred frame only with controls: back over the frame's margin to the column's edge", () => {
    // the head is the container whose content box is the frame's room
    expect(find(`${DESKTOP_HEAD} .cb-template-head`, "container")).toBe("cb-head / inline-size");
    // the shift is the frame's centring margin plus the head's side padding, and 0 without a top
    // row (no controls: the browser's layout)
    expect(
      find(
        `${DESKTOP_HEAD} .cb-template-head :is(.cb-pageheader > .cb-pageheader-path, .cb-pageheader-titleless)`,
        "margin-left",
      ),
    ).toBe(
      "calc( -1 * min( calc(max(0px, (100cqw - var(--cb-layout-content)) / 2) + var(--cb-content-pad)), calc(var(--cb-shell-row) * 100000) ) )",
    );
  });

  it("starts where the title bar starts: after the full sidebar, or after the controls and the band's toggle", () => {
    const pad = find(`${DESKTOP_HEAD} .cb-pageheader-path`, "padding-left");
    // with a top row: the title bar's start padding (space.5 beside the full sidebar; past a rail
    // the column reserve, which counts the controls and the band's toggle, plus space.3)
    expect(pad).toContain(
      "min( calc(var(--cb-shell-row) * 100000), max(var(--cb-space-5), calc(var(--cb-shell-column-reserve) + var(--cb-space-3))) )",
    );
    const titleBar = rules.find(
      (r) => r.selector === ':root[data-shell="desktop"] .cb-title-bar' && r.decls["padding-left"],
    )?.decls["padding-left"];
    expect(titleBar).toBe(
      "max( var(--cb-space-5), calc(var(--cb-shell-column-reserve, var(--cb-shell-reserve-start)) + var(--cb-space-3)) )",
    );
    // the band's toggle widens the column reserve on medium as on a collapsed expanded rail
    expect(
      rules.find(
        (r) =>
          r.selector === ':root[data-shell="desktop"] .cb-shell-column' &&
          r.decls["--cb-shell-column-reserve"],
      )?.decls["--cb-shell-column-reserve"],
    ).toContain("var(--cb-shell-toggle, 0px)");
  });

  it("a slug-only or first-level path draws no path row; the head starts below the top row", () => {
    for (const path of [
      [{ label: "capybara", href: "/" }],
      [{ label: "capybara", href: "/" }, { label: "inbox" }],
    ]) {
      const html = renderToStaticMarkup(
        <DesignProvider locale="zh">
          <PageHeader path={path} title="收件箱" />
        </DesignProvider>,
      );
      expect(html).not.toContain("cb-pageheader-path");
    }
    expect(
      find(`${DESKTOP_HEAD} .cb-template-head:not(:has(.cb-pageheader-path))`, "padding-top"),
    ).toBe("max(var(--cb-space-5), calc(var(--cb-shell-row) - var(--cb-space-2)))");
  });

  it("keeps the browser's path row: no rule outside the desktop shell moves or hides it", () => {
    const all = ["shell.css", "templates.css", "shell-environment.css"].flatMap((f) =>
      parseCss(readFileSync(resolve(import.meta.dirname, "../src/styles", f), "utf8")),
    );
    const moved = all.filter(
      (r) =>
        /cb-pageheader-(path|titleless)|cb-template-head/.test(r.selector) &&
        // (the filler cancelling the row's gap is the browser's layout too)
        !r.selector.includes("cb-drag-fill") &&
        !r.selector.includes(':root[data-shell="desktop"]') &&
        (r.decls["margin-left"] !== undefined ||
          r.decls.container !== undefined ||
          (r.decls["max-width"] !== undefined && r.selector.includes("pageheader-path-seg"))),
    );
    expect(moved.map((r) => r.selector)).toEqual([]);
  });
});
