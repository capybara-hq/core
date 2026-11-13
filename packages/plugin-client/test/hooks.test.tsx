import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_NAMES } from "../src/design.js";
import * as exports from "../src/index.js";
import {
  PluginClientContextError,
  useAccess,
  useCapybaraEvents,
  useClientStorage,
  useLocale,
  useRunState,
  useSignIn,
} from "../src/index.js";
import { renderWithFakeHost } from "../src/testing/index.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const event = (type: "run.started" | "tool.finished") =>
  type === "run.started"
    ? ({ type, conversationId: "c1", seq: 1, at: "2026-11-09T00:00:00Z" } as const)
    : ({
        type,
        conversationId: "c1",
        seq: 2,
        at: "2026-11-09T00:00:01Z",
        callId: "k",
        tool: "Bash",
        isError: false,
      } as const);

describe("hooks", () => {
  it("hooks throw PluginClientContextError outside the host", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Probe() {
      useRunState();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(PluginClientContextError);
    spy.mockRestore();
  });

  it("useRunState follows the fake host", () => {
    function Probe() {
      return <p>{useRunState().state}</p>;
    }
    const host = renderWithFakeHost(<Probe />, { slot: "shell.overlay" });
    expect(screen.getByText("idle")).toBeTruthy();
    host.setRunState("running");
    expect(screen.getByText("running")).toBeTruthy();
    host.unmount();
  });

  it("useCapybaraEvents filters by type", () => {
    const seen = vi.fn();
    function Probe() {
      useCapybaraEvents(seen, ["run.started"]);
      return null;
    }
    const host = renderWithFakeHost(<Probe />, { slot: "shell.overlay" });
    host.emit(event("run.started"));
    host.emit(event("tool.finished"));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0].type).toBe("run.started");
    host.unmount();
  });

  it("useClientStorage prefixes keys with cap-ext:<plugin>:", () => {
    function Probe() {
      useClientStorage().set("k", "v");
      return null;
    }
    const host = renderWithFakeHost(<Probe />, { slot: "org.page", plugin: "demo" });
    expect(localStorage.getItem("cap-ext:demo:k")).toBe("v");
    host.unmount();
  });

  it("useLocale.t picks the locale", () => {
    function Probe() {
      return <p>{useLocale().t({ zh: "你好", en: "hello" })}</p>;
    }
    const zh = renderWithFakeHost(<Probe />, { slot: "org.page", locale: "zh" });
    expect(screen.getByText("你好")).toBeTruthy();
    zh.unmount();
    const en = renderWithFakeHost(<Probe />, { slot: "org.page", locale: "en" });
    expect(screen.getByText("hello")).toBeTruthy();
    en.unmount();
  });
});

describe("hooks, more", () => {
  it("storage never throws when the browser store is blocked", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    let read: string | null | undefined;
    function Probe() {
      const s = useClientStorage();
      s.set("k", "v");
      read = s.get("k");
      return null;
    }
    const host = renderWithFakeHost(<Probe />, { slot: "org.page" });
    expect(read).toBeNull();
    host.unmount();
    get.mockRestore();
    set.mockRestore();
  });

  it("useSignIn throws PluginClientContextError outside the host", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Probe() {
      useSignIn();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(PluginClientContextError);
    spy.mockRestore();
  });

  it("useSignIn and the listeners' api carry the fake host's signInId", () => {
    function Probe() {
      return <p>{useSignIn().id}</p>;
    }
    const ids: string[] = [];
    const host = renderWithFakeHost(<Probe />, {
      slot: "shell.overlay",
      signInId: "s-1",
      events: { "run.started": (_e, api) => ids.push(api.signIn.id) },
    });
    expect(screen.getByText("s-1")).toBeTruthy();
    host.emit(event("run.started"));
    expect(ids).toEqual(["s-1"]);
    host.unmount();
    const plain = renderWithFakeHost(<Probe />, { slot: "shell.overlay" });
    expect(screen.getByText("test-sign-in")).toBeTruthy();
    plain.unmount();
  });

  it("useAccess().atLeast ranks roles", () => {
    const seen: Record<string, boolean> = {};
    function Probe() {
      const a = useAccess();
      seen.memberIsAdmin = a.atLeast("admin");
      seen.memberIsMember = a.atLeast("member");
      seen.memberIsGuest = a.atLeast("guest");
      seen.memberIsSuper = a.atLeast("superAdmin");
      return null;
    }
    const host = renderWithFakeHost(<Probe />, { slot: "org.page", role: "member" });
    expect(seen).toEqual({
      memberIsAdmin: false,
      memberIsMember: true,
      memberIsGuest: true,
      memberIsSuper: false,
    });
    host.unmount();
    function Owner() {
      seen.ownerIsAdmin = useAccess().atLeast("admin");
      return null;
    }
    renderWithFakeHost(<Owner />, { slot: "org.page", role: "owner" }).unmount();
    expect(seen.ownerIsAdmin).toBe(true);
  });

  it("every design name is a package export", () => {
    expect(DESIGN_NAMES.length).toBe(13);
    expect(DESIGN_NAMES.filter((n) => !(n in exports))).toEqual([]);
  });
});
