import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginClientContextError,
  useCapybaraEvents,
  useClientStorage,
  useLocale,
  useRunState,
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
    void act;
  });
});
