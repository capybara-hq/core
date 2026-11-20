// The native wiring (mobile app spec §6): DesignRoot passes the shell's menu / share / haptics and
// tells chrome@1 the page has drawn.
import { useHaptics, useNative } from "@capybara-hq/design";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignRoot } from "../src/components/design-root";

const install = (shell: unknown) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
};

function shellWith(capabilities: Record<string, object>) {
  return { version: 1, kind: "mobile", platform: "ios", capabilities, on: () => () => {} };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "capybaraShell");
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
