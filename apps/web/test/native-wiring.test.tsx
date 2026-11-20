// The native wiring (mobile app spec §6): the frame hands the shell's nav@1 to the design as the
// tab bar and navigates on a tap; DesignRoot passes the shell's menu / share / haptics and tells
// chrome@1 the page has drawn.
import { useHaptics, useNative } from "@capybara-hq/design";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignRoot } from "../src/components/design-root";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const install = (shell: unknown) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
};

function shellWith(capabilities: Record<string, object>) {
  return { version: 1, kind: "mobile", platform: "ios", capabilities, on: () => () => {} };
}

beforeEach(() => resetNavigation("/me"));
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "capybaraShell");
  document.documentElement.removeAttribute("data-native-nav");
});

describe("AppFrame with nav@1", () => {
  it("passes nativeNav to the shell: the bar is told the state, a tap navigates", () => {
    let select: ((id: string) => void) | undefined;
    const nav = {
      set: vi.fn(async () => {}),
      onSelect: vi.fn((l: (id: string) => void) => {
        select = l;
        return () => {};
      }),
    };
    install(shellWith({ "nav@1": nav }));
    renderFrame(shellOf(ME));
    expect(document.querySelector('[data-part="app-shell"], [data-native-nav]')).not.toBeNull();
    expect(nav.set).toHaveBeenCalled();
    const state = nav.set.mock.calls[nav.set.mock.calls.length - 1] as unknown as [
      { items: { id: string }[]; current: string | null },
    ];
    expect(state[0].items.map((i) => i.id)).toEqual(["chats", "agents", "inbox", "me"]);
    expect(state[0].current).toBe("me");
    select?.("me");
    expect(router.push).toHaveBeenCalledWith("/me");
  });

  it("has no native bar without nav@1", () => {
    renderFrame(shellOf(ME));
    expect(document.querySelector("[data-native-nav]")).toBeNull();
  });
});

describe("DesignRoot", () => {
  function Probe() {
    const native = useNative();
    const buzz = useHaptics();
    return (
      <button
        type="button"
        data-has={Object.keys(native ?? {}).join(",")}
        onClick={() => buzz("light")}
      >
        x
      </button>
    );
  }

  it("provides only the present capabilities and plays haptics through impact", () => {
    const impact = vi.fn(async () => {});
    install(shellWith({ "haptics@1": { impact } }));
    const { getByRole } = render(
      <DesignRoot locale="en">
        <Probe />
      </DesignRoot>,
    );
    expect(getByRole("button").getAttribute("data-has")).toBe("haptics");
    getByRole("button").click();
    expect(impact).toHaveBeenCalledWith("light");
  });

  it("tells chrome@1 the page has drawn, once", async () => {
    const ready = vi.fn(async () => {});
    install(shellWith({ "chrome@1": { setAppearance: vi.fn(), ready } }));
    render(
      <DesignRoot locale="en">
        <p>page</p>
      </DesignRoot>,
    );
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  });
});
