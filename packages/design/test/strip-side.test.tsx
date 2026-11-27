// The strip's side (interaction model §10.7, D16): `nav@1` reports `side`, else the inset that
// carries the strip says it, else it is right. The inline script writes `data-strip` on <html>
// before the first paint while the strip shows; the AppShell follows the envelope's `change`
// (a live split change) without a remount, and clears it when the strip goes.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, DesignProvider, readShellEnvironment } from "../src/index";
import { SHELL_ENVIRONMENT_SCRIPT } from "../src/shell/shell-environment-script";

const root = () => document.documentElement;
const runScript = () => new Function(SHELL_ENVIRONMENT_SCRIPT)();
const install = (shell: unknown) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
};

function fakeShell(over: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>();
  const shell: Record<string, unknown> = {
    version: 1,
    kind: "mobile",
    platform: "ios",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    capabilities: {},
    on: vi.fn((_event: "change", listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ...over,
  };
  return {
    shell,
    listeners,
    change(next: Record<string, unknown>) {
      Object.assign(shell, next);
      for (const l of [...listeners]) l();
    },
  };
}

const nav = (extra: Record<string, unknown> = {}) => ({
  set() {},
  onSelect: () => () => {},
  ...extra,
});
const insets = (left: number, right: number) => ({ top: 0, right, bottom: 0, left });

function clearRoot() {
  for (const a of ["data-shell", "data-shell-platform", "data-native-nav", "data-strip"])
    root().removeAttribute(a);
  root().removeAttribute("style");
}
beforeEach(clearRoot);
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "capybaraShell");
  clearRoot();
});

/** The cases both readers see, with the side each one must give. */
const CASES: [string, Record<string, unknown>, "left" | "right" | null][] = [
  ["nav@1 reports left", { capabilities: { "nav@1": nav({ side: "left" }) } }, "left"],
  ["nav@1 reports right", { capabilities: { "nav@1": nav({ side: "right" }) } }, "right"],
  [
    "the reported side wins over the insets",
    { capabilities: { "nav@1": nav({ side: "right" }) }, insets: insets(30, 0) },
    "right",
  ],
  [
    "no side: the left inset carries the strip",
    { capabilities: { "nav@1": nav() }, insets: insets(30, 0) },
    "left",
  ],
  [
    "an unknown side falls back to the insets",
    { capabilities: { "nav@1": nav({ side: "up" }) }, insets: insets(30, 0) },
    "left",
  ],
  ["nothing reported: right", { capabilities: { "nav@1": nav() } }, "right"],
  [
    "both insets equal (a notch): right",
    { capabilities: { "nav@1": nav() }, insets: insets(30, 30) },
    "right",
  ],
  [
    "a tie after rounding to hundredths: right in both readers",
    { capabilities: { "nav@1": nav() }, insets: insets(30.004, 30) },
    "right",
  ],
  ["no nav@1: no strip", { capabilities: {}, insets: insets(30, 0) }, null],
];

describe("side from nav@1 is written as data-strip", () => {
  for (const [name, over, side] of CASES) {
    it(`before the first paint and in the reader: ${name}`, () => {
      install(fakeShell(over).shell);
      runScript();
      expect(root().getAttribute("data-strip")).toBe(side);
      expect(readShellEnvironment(window)?.strip).toBe(side);
    });
  }

  it("the AppShell follows a live split change and the strip going, without a remount", () => {
    const f = fakeShell({ capabilities: { "nav@1": nav({ side: "left" }) } });
    install(f.shell);
    runScript();
    const view = render(
      <DesignProvider locale="zh">
        <AppShell
          sidebar={{
            context: { kind: "work", org: null, primary: [], more: [] },
            activeNav: "",
            account: { name: "grant", menu: [] },
          }}
        >
          <p data-testid="page">page</p>
        </AppShell>
      </DesignProvider>,
    );
    const page = view.getByTestId("page");
    expect(root().getAttribute("data-strip")).toBe("left");
    // the app moved to the right half of the split
    act(() => f.change({ capabilities: { "nav@1": nav({ side: "right" }) } }));
    expect(root().getAttribute("data-strip")).toBe("right");
    expect(view.getByTestId("page")).toBe(page);
    // the strip went (a scene resize): nav@1 withdrawn
    act(() => f.change({ capabilities: {} }));
    expect(root().hasAttribute("data-strip")).toBe(false);
  });
});
