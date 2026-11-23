// The Shell environment on the web side (mobile layout spec §9.2–§9.4): the one adapter that
// reads `window.capybaraShell` (`lib/shell.ts`), capability by `name@major` and absent = the
// browser; the event-handler accessor that refuses a call during a render (plan Review Focus 4);
// and the root layout: the viewport and the no-flash script carrying the request's nonce.

import type { NativeHandlers } from "@capybara-hq/design";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  shellCapability,
  useHapticsCapability,
  useMenuCapability,
  useNativeHandlers,
  useNativeNavHandle,
  useNotifyCapability,
  useProfilesCapability,
  useShareCapability,
  useShellCapability,
  useSignInCapability,
  useSwitchProfile,
} from "../src/lib/shell";

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
  const device = useShellCapability<{ status(): string }>("example@1");
  return <p data-testid="device">{device === undefined ? "browser" : device.status()}</p>;
}

describe("useShellCapability", () => {
  const device = { status: () => "not_connected" };

  it("is undefined in the server render, even inside a shell", () => {
    install(fakeShell({ capabilities: { "example@1": device } }).shell);
    expect(renderToString(<Probe />)).toContain("browser");
  });

  it("is undefined before the shell adds it, the object after change, and unsubscribes", () => {
    const f = fakeShell();
    install(f.shell);
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
    act(() => f.change({ "example@1": device }));
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
        return offered ? { "example@1": { status: () => `copy ${copies}` } } : {};
      },
      on: (_e: "change", l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    install(shell);
    const seen: unknown[] = [];
    function Keep() {
      const d = useShellCapability<{ status(): string }>("example@1");
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
    install(fakeShell({ version: 2, capabilities: { "example@1": device } }).shell);
    render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
    cleanup();
    install(fakeShell({ capabilities: { "example@1": device } }).shell);
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    render(<Probe />);
    expect(screen.getByTestId("device").textContent).toBe("browser");
  });

  it("ignores what is not an object and keys inherited from the prototype", () => {
    install(
      fakeShell({
        capabilities: Object.assign(Object.create({ "example@1": device }), { "notify@1": 42 }),
      }).shell,
    );
    function Two() {
      const a = useShellCapability("example@1");
      const b = useShellCapability("notify@1");
      return <p data-testid="two">{`${a === undefined} ${b === undefined}`}</p>;
    }
    render(<Two />);
    expect(screen.getByTestId("two").textContent).toBe("true true");
  });

  it("refuses a key that is not name@major (never a user agent or kind check)", () => {
    expect(() => renderToString(<KeyProbe k="example" />)).toThrow(/name@major/);
    expect(() => renderToString(<KeyProbe k="example@0" />)).toThrow(/name@major/);
  });
});

function KeyProbe({ k }: { k: string }) {
  useShellCapability(k);
  return null;
}

describe("shellCapability (event handlers only)", () => {
  const connect = vi.fn();
  const withDevice = () => install(fakeShell({ capabilities: { "example@1": { connect } } }).shell);

  it("throws when called during a render", () => {
    withDevice();
    function Bad() {
      shellCapability("example@1");
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
      if (on) shellCapability("example@1");
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
    expect(() => shellCapability("example@1")).toThrow(
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
      expect(shellCapability("example@1")).toEqual({ connect });
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
                shellCapability("example@1");
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
        shellCapability("example@1");
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
            got.push(shellCapability("example@1"), shellCapability("notify@1"));
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
  it("declares the viewport: device width, cover, resizes-content and the scheme's page colour", async () => {
    // the root layout's generateViewport builds it (theme brand coverage spec §6: one colour)
    const { rootViewport } = await import("../src/lib/web-manifest");
    const viewport = rootViewport("dark", null);
    expect(viewport).toMatchObject({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
      interactiveWidget: "resizes-content",
      themeColor: "#0A0A0A",
    });
    expect(rootViewport("light", null).themeColor).toBe("#FAF9F6");
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

describe("typed capability accessors", () => {
  function Typed() {
    const n = useNotifyCapability();
    const s = useSignInCapability();
    return <p data-testid="typed">{[n, s].map((c) => (c === undefined ? "-" : "+")).join("")}</p>;
  }

  it("read their own key and follow change; absent in the browser", () => {
    const f = fakeShell();
    install(f.shell);
    render(<Typed />);
    expect(screen.getByTestId("typed").textContent).toBe("--");
    act(() => f.change({ "notify@1": {}, "signIn@1": {} }));
    expect(screen.getByTestId("typed").textContent).toBe("++");
    // another major of a known name is not that capability
    act(() => f.change({ "notify@2": {}, "signIn@1": {} }));
    expect(screen.getByTestId("typed").textContent).toBe("-+");
  });
});

describe("the mobile capability accessors", () => {
  const caps = {
    "haptics@1": { impact: vi.fn(async () => {}) },
    "share@1": { share: vi.fn(async () => {}) },
    "menu@1": { show: vi.fn(async () => null) },
  };

  function Accessors() {
    const a = [useHapticsCapability(), useShareCapability(), useMenuCapability()];
    return <p data-testid="a">{a.map((x) => (x === undefined ? "-" : "+")).join("")}</p>;
  }

  it("each is undefined without its key and the object after a change adds it", () => {
    const f = fakeShell();
    install(f.shell);
    render(<Accessors />);
    expect(screen.getByTestId("a").textContent).toBe("---");
    act(() => f.change({ "haptics@1": caps["haptics@1"] }));
    expect(screen.getByTestId("a").textContent).toBe("+--");
    act(() => f.change(caps));
    expect(screen.getByTestId("a").textContent).toBe("+++");
  });

  it("useNativeHandlers holds menu only when menu@1 is present", () => {
    const seen: NativeHandlers[] = [];
    function H() {
      seen.push(useNativeHandlers());
      return null;
    }
    const f = fakeShell({ capabilities: { "haptics@1": caps["haptics@1"] } });
    install(f.shell);
    render(<H />);
    const last = () => seen[seen.length - 1] as NativeHandlers;
    expect(last().menu).toBeUndefined();
    expect(last().share).toBeUndefined();
    expect(last().haptics).toBeDefined();
    act(() => f.change({ "haptics@1": caps["haptics@1"], "menu@1": caps["menu@1"] }));
    expect(last().menu).toBeDefined();
  });

  it("the haptics handler swallows a rejected impact", async () => {
    const impact = vi.fn(() => Promise.reject(new Error("no")));
    const seen: NativeHandlers[] = [];
    function H() {
      seen.push(useNativeHandlers());
      return null;
    }
    install(fakeShell({ capabilities: { "haptics@1": { impact } } }).shell);
    render(<H />);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    (seen[seen.length - 1] as NativeHandlers).haptics?.("selection");
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", unhandled);
    expect(impact).toHaveBeenCalledWith("selection");
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("the nav@1 and profiles@1 accessors", () => {
  const unhandledDuring = async (fn: () => void) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fn();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", unhandled);
    return unhandled;
  };

  it("useNativeNavHandle is undefined without nav@1 and swallows a rejected or throwing set", async () => {
    const seen: (ReturnType<typeof useNativeNavHandle> | null)[] = [];
    function H() {
      seen.push(useNativeNavHandle() ?? null);
      return null;
    }
    const f = fakeShell();
    install(f.shell);
    const view = render(<H />);
    expect(seen.at(-1)).toBeNull();
    const set = vi.fn(() => Promise.reject(new Error("no strip")));
    const off = vi.fn();
    const nav = {
      set,
      onSelect: vi.fn(() => off),
      onAction: vi.fn(() => off),
      onAccount: vi.fn(() => off),
    };
    act(() => f.change({ "nav@1": nav }));
    const handle = seen.at(-1);
    expect(handle).toBeTruthy();
    const state = {
      items: [{ id: "chats" as const, label: "对话" }],
      current: null,
      action: { id: "new-conversation", label: "新会话", icon: "square-pen" as const },
    };
    const unhandled = await unhandledDuring(() => handle?.set(state));
    expect(set).toHaveBeenCalledWith(state);
    expect(unhandled).not.toHaveBeenCalled();
    set.mockImplementation(() => {
      throw new Error("gone");
    });
    expect(() => handle?.set(state)).not.toThrow();
    // the listeners pass through
    const l = () => {};
    expect(handle?.onSelect(l)).toBe(off);
    expect(handle?.onAction(l)).toBe(off);
    expect(handle?.onAccount(l)).toBe(off);
    expect(nav.onSelect).toHaveBeenCalledWith(l);
    expect(nav.onAction).toHaveBeenCalledWith(l);
    expect(nav.onAccount).toHaveBeenCalledWith(l);
    // a rerender keeps the handle while the capability object stays
    const before = seen.at(-1);
    view.rerender(<H />);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toBe(before);
  });

  it("useSwitchProfile is undefined without profiles@1; it calls show() and swallows a rejection", async () => {
    const seen: (ReturnType<typeof useSwitchProfile> | null)[] = [];
    const caps: unknown[] = [];
    function H() {
      caps.push(useProfilesCapability());
      seen.push(useSwitchProfile() ?? null);
      return null;
    }
    const f = fakeShell();
    install(f.shell);
    render(<H />);
    expect(seen.at(-1)).toBeNull();
    expect(caps.at(-1)).toBeUndefined();
    const show = vi.fn(() => Promise.reject(new Error("busy")));
    act(() => f.change({ "profiles@1": { show } }));
    expect(caps.at(-1)).toEqual({ show });
    const unhandled = await unhandledDuring(() => seen.at(-1)?.());
    expect(show).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
