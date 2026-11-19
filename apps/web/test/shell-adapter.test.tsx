// The Shell environment on the web side (mobile layout spec §9.2–§9.4): the one adapter that
// reads `window.capybaraShell` (`lib/shell.ts`), capability by `name@major` and absent = the
// browser; the event-handler accessor that refuses a call during a render (plan Review Focus 4);
// and the root layout: the viewport and the no-flash script carrying the request's nonce.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("keeps one reference while unchanged when the shell copies capabilities on every read", () => {
    let copies = 0;
    let offered = true;
    const listeners = new Set<() => void>();
    const shell = {
      version: 1,
      kind: "desktop",
      get capabilities() {
        copies++;
        // a bridge that hands out a fresh copy per access
        return offered ? { "device@1": { status: () => `copy ${copies}` } } : {};
      },
      on: (_e: "change", l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    install(shell);
    const seen: unknown[] = [];
    function Keep() {
      const d = useShellCapability<{ status(): string }>("device@1");
      seen.push(d);
      return <p data-testid="keep">{d === undefined ? "browser" : d.status()}</p>;
    }
    const { rerender } = render(<Keep />);
    const first = screen.getByTestId("keep").textContent;
    rerender(<Keep />);
    rerender(<Keep />);
    // no render loop, and the same object on every render until the shell says it changed
    expect(screen.getByTestId("keep").textContent).toBe(first);
    expect(new Set(seen.filter((x) => x !== undefined)).size).toBe(1);
    act(() => {
      for (const l of [...listeners]) l();
    });
    expect(screen.getByTestId("keep").textContent).not.toBe(first);
    offered = false;
    act(() => {
      for (const l of [...listeners]) l();
    });
    expect(screen.getByTestId("keep").textContent).toBe("browser");
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

  it("without navigator.userActivation: throws outside any event (a timer, an effect)", () => {
    withDevice();
    expect(navigator).not.toHaveProperty("userActivation");
    expect(() => shellCapability("device@1")).toThrow(
      "calls a shell capability without a user activation",
    );
  });

  describe("with navigator.userActivation", () => {
    let active = false;
    beforeEach(() => {
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        get: () => ({ isActive: active, hasBeenActive: active }),
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(navigator, "userActivation");
    });

    it("returns the capability while the activation is active, even after a microtask", async () => {
      withDevice();
      active = true;
      await Promise.resolve();
      expect(shellCapability("device@1")).toEqual({ connect });
    });

    it("throws without an active activation, even inside an event's dispatch", () => {
      withDevice();
      active = false;
      let error: unknown;
      function Button() {
        return (
          <button
            type="button"
            onClick={() => {
              try {
                shellCapability("device@1");
              } catch (e) {
                error = e;
              }
            }}
          >
            connect
          </button>
        );
      }
      render(<Button />);
      fireEvent.click(screen.getByRole("button"));
      expect(String(error)).toContain("calls a shell capability without a user activation");
    });

    it("still throws during a render while the activation is active", () => {
      withDevice();
      active = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      function Bad() {
        shellCapability("device@1");
        return null;
      }
      expect(() => render(<Bad />)).toThrow("calls a shell capability outside an event handler");
    });
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
