// Theme brand coverage spec §6, decision 9: `<meta name="theme-color">` follows the page colour of
// the scheme actually shown, also after a scheme toggle or a theme switch.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useThemeColorMeta } from "../src/index";

const root = () => document.documentElement;
let meta: HTMLMetaElement;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent =
    ':root[data-theme="dark"]{--cb-bg:#101010}:root[data-theme="light"]{--cb-bg:#FAFAFA}';
  document.head.append(sheet);
  meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#000000";
  document.head.append(meta);
  root().dataset.theme = "dark";
});
afterEach(() => {
  cleanup();
  sheet.remove();
  meta.remove();
  delete root().dataset.theme;
  root().style.removeProperty("--cb-bg");
});

/** MutationObserver callbacks run as microtasks. */
const flush = () => act(async () => {});

describe("useThemeColorMeta", () => {
  it("writes the computed page colour after mount", () => {
    renderHook(() => useThemeColorMeta());
    expect(meta.content).toBe("#101010");
  });

  it("useThemeColorMeta updates the meta after a scheme toggle", async () => {
    renderHook(() => useThemeColorMeta());
    root().dataset.theme = "light";
    await flush();
    expect(meta.content).toBe("#FAFAFA");
  });

  it("a theme switch (a new key) reads the colour again", () => {
    const { rerender } = renderHook(({ k }) => useThemeColorMeta(k), {
      initialProps: { k: "a" as string | null },
    });
    sheet.textContent = ':root[data-theme="dark"]{--cb-bg:#223344}';
    rerender({ k: "b" });
    expect(meta.content).toBe("#223344");
  });

  it("a theme stylesheet that finishes loading updates it", () => {
    renderHook(() => useThemeColorMeta());
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.dataset.precedence = "theme";
    document.head.append(link);
    sheet.textContent = ':root[data-theme="dark"]{--cb-bg:#445566}';
    link.dispatchEvent(new Event("load"));
    expect(meta.content).toBe("#445566");
    link.remove();
  });

  it("a value that is no plain colour is not written; no meta, nothing happens", () => {
    root().style.setProperty("--cb-bg", "color-mix(in srgb, red, blue)");
    renderHook(() => useThemeColorMeta());
    expect(meta.content).toBe("#000000");
    meta.remove();
    expect(() => renderHook(() => useThemeColorMeta())).not.toThrow();
  });
});
