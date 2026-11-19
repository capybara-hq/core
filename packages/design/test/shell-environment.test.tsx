// The Shell environment on the design side (mobile layout spec §9.3, §7.5): the inline script that
// marks `<html>` before the first paint, the AppShell's live updates after hydration, the
// `shell=` state token and `chrome@1.setAppearance`; and the inset tokens of base.css.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, readShellEnvironment } from "../src/index";
import {
  SHELL_ENVIRONMENT_SCRIPT,
  ShellEnvironmentScript,
} from "../src/shell/shell-environment-script";

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
    const top = vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    runScript();
    untouched();
    top.mockRestore();
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
const status = { context: "grant@acme:/", version: "0.1.0" };
const renderShell = () =>
  render(
    <DesignProvider locale="zh">
      <AppShell sidebar={sidebar} status={status} capState="run=idle">
        <p>page</p>
      </AppShell>
    </DesignProvider>,
  );
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
    expect(setAppearance).toHaveBeenCalledWith({ scheme: "light", background: "#FAF9F6" });
    // an unrelated change (insets) sends nothing new
    act(() => f.change({ insets: { top: 0, right: 0, bottom: 0, left: 0 } }));
    expect(setAppearance).toHaveBeenCalledTimes(1);
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
