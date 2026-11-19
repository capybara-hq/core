// The Shell environment on the web side (mobile layout spec §9.2–§9.4): the one adapter that
// reads `window.capybaraShell` (`lib/shell.ts`), capability by `name@major` and absent = the
// browser; the event-handler accessor that refuses a call during a render (plan Review Focus 4);
// and the root layout: the viewport and the no-flash script carrying the request's nonce.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellCapability, useShellCapability } from "../src/lib/shell";

/** A fake shell whose capabilities a test changes, announcing them with `change`. */
function fakeShell(over: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>();
  const shell = {
    version: 1,
    kind: "desktop",
    platform: "macos",
    shellVersion: "0.1.0",
    insets: { top: 28, right: 0, bottom: 0, left: 0 },
    capabilities: {} as Record<string, object>,
    on: vi.fn((_e: "change", l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    ...over,
  };
  return {
    shell,
    listeners,
    change(capabilities: Record<string, object>) {
      shell.capabilities = capabilities;
      for (const l of [...listeners]) l();
    },
  };
}
const install = (shell: unknown) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "capybaraShell");
});

function Probe() {
  const device = useShellCapability<{ status(): string }>("device@1");
  return <p data-testid="device">{device === undefined ? "browser" : device.status()}</p>;
}

describe("useShellCapability", () => {
  const device = { status: () => "not_connected" };

  it("is undefined in the server render, even inside a shell", () => {
    install(fakeShell({ capabilities: { "device@1": device } }).shell);
    expect(renderToString(<Probe />)).toContain("browser");
  });

  it("is undefined before the shell adds it, the object after change, and unsubscribes", () => {
    const f = fakeShell();
    install(f.shell);
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
    act(() => f.change({ "device@1": device }));
    expect(screen.getByTestId("device").textContent).toBe("not_connected");
    // removed again: back to the browser
    act(() => f.change({}));
    expect(screen.getByTestId("device").textContent).toBe("browser");
    expect(f.listeners.size).toBe(1);
    unmount();
    expect(f.listeners.size).toBe(0);
  });

  it("is the browser without a shell, for another envelope version and inside a frame", () => {
    render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
    cleanup();
    install(fakeShell({ version: 2, capabilities: { "device@1": device } }).shell);
    render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
    cleanup();
    install(fakeShell({ capabilities: { "device@1": device } }).shell);
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
  });

  it("ignores what is not an object and keys inherited from the prototype", () => {
    install(
      fakeShell({
        capabilities: Object.assign(Object.create({ "device@1": device }), { "notify@1": 42 }),
      }).shell,
    );
    function Two() {
      const a = useShellCapability("device@1");
      const b = useShellCapability("notify@1");
      return <p data-testid="two">{`${a === undefined} ${b === undefined}`}</p>;
    }
    render(<Two />);
    expect(screen.getByTestId("two").textContent).toBe("true true");
  });

  it("refuses a key that is not name@major (never a user agent or kind check)", () => {
    expect(() => renderToString(<KeyProbe k="device" />)).toThrow(/name@major/);
    expect(() => renderToString(<KeyProbe k="device@0" />)).toThrow(/name@major/);
  });
});

function KeyProbe({ k }: { k: string }) {
  useShellCapability(k);
  return null;
}

describe("shellCapability (event handlers only)", () => {
  const connect = vi.fn();
  const withDevice = () => install(fakeShell({ capabilities: { "device@1": { connect } } }).shell);

  it("throws when called during a render", () => {
    withDevice();
    function Bad() {
      shellCapability("device@1");
      return null;
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow("calls a shell capability outside an event handler");
  });

  it("throws in a render that runs inside an event's dispatch too", () => {
    withDevice();
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Flip() {
      const [on, setOn] = useState(false);
      if (on) shellCapability("device@1");
      return (
        <button type="button" onClick={() => flushSync(() => setOn(true))}>
          go
        </button>
      );
    }
    render(<Flip />);
    expect(() => fireEvent.click(screen.getByRole("button"))).toThrow(
      "calls a shell capability outside an event handler",
    );
  });

  it("throws outside any event (a timer, an effect)", () => {
    withDevice();
    expect(() => shellCapability("device@1")).toThrow(
      "calls a shell capability outside an event handler",
    );
  });

  it("returns the capability inside an event handler, undefined when it is absent", () => {
    withDevice();
    const got: unknown[] = [];
    function Button() {
      return (
        <button
          type="button"
          onClick={() => {
            got.push(shellCapability("device@1"), shellCapability("notify@1"));
          }}
        >
          connect
        </button>
      );
    }
    render(<Button />);
    fireEvent.click(screen.getByRole("button"));
    expect(got[0]).toEqual({ connect });
    expect(got[1]).toBeUndefined();
  });
});

describe("the root layout", () => {
  it("declares the viewport: device width, cover, resizes-content and a theme color per scheme", async () => {
    vi.doMock("../src/lib/server/register", () => ({}));
    const { viewport } = await import("../src/app/layout");
    expect(viewport).toMatchObject({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
      interactiveWidget: "resizes-content",
      themeColor: [
        { media: "(prefers-color-scheme: light)", color: "#FAF9F6" },
        { media: "(prefers-color-scheme: dark)", color: "#0A0A0A" },
      ],
    });
    // pinch zoom stays
    expect(viewport).not.toHaveProperty("maximumScale");
    expect(viewport).not.toHaveProperty("userScalable");
  });

  it("renders the shell script first in <head>, with the request's nonce", async () => {
    vi.resetModules();
    vi.doMock("../src/lib/server/register", () => ({}));
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-nonce": "n0nce" }),
      cookies: async () => ({ get: () => undefined }),
    }));
    vi.doMock("next-intl/server", () => ({
      getLocale: async () => "en",
      getTranslations: async () => (k: string) => k,
    }));
    const { default: RootLayout } = await import("../src/app/layout");
    const { ShellEnvironmentScript } = await import("@capybara-hq/design/shell-environment");
    const html = (await RootLayout({ children: null })) as React.ReactElement<{
      children: React.ReactElement[];
    }>;
    const head = (html.props.children as React.ReactElement[])[0] as React.ReactElement<{
      children: React.ReactNode;
    }>;
    expect(head.type).toBe("head");
    const first = ([] as React.ReactNode[]).concat(head.props.children)[0] as React.ReactElement<{
      nonce?: string;
    }>;
    expect(first.type).toBe(ShellEnvironmentScript);
    expect(first.props.nonce).toBe("n0nce");
  });
});
