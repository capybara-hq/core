// The compact shell in the app frame (design spec §4.6): the chat-first shell draws no bottom
// navigation and no top bar; the floating row is the compact chrome. (The drawer's wiring and the
// chat surfaces come with mobile touch plan Task 28.)
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => resetNavigation("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the compact chrome in the frame", () => {
  it.each(["/agents", "/inbox", "/agents/new", "/chat/c1", "/", "/me"])(
    "on %s: no bottom navigation, no top bar, the floating row",
    (path) => {
      resetNavigation(path);
      renderFrame(shellOf(ME, { pending: { count: 3, more: false } }));
      expect(document.querySelector('[data-part="bottom-nav"]')).toBeNull();
      expect(document.querySelector('[data-part="top-bar"]')).toBeNull();
      expect(document.querySelector('[data-part="floating-bar"]')).not.toBeNull();
    },
  );

  it("the setup frame has no bottom navigation", () => {
    renderFrame(
      shellOf(ME, { readiness: { modelProvider: "none", orgFixableProviders: [], agents: 0 } }),
    );
    expect(document.querySelector('[data-part="bottom-nav"]')).toBeNull();
  });
});
