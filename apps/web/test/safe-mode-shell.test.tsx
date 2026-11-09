// Safe mode is a state of the App Shell (client extensions spec §10.1, final review B-I1): the
// banner is the shell's first row, inside the 100dvh shell, so the status bar and the bottom of
// the page are never pushed below the window.
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientHost } from "../src/components/client-ext/ClientHost";
import type { ClientExtensionsResponse } from "../src/lib/client-extensions";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { NOT_READY, renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BUILD = "b".repeat(64);
const SET: ClientExtensionsResponse = {
  enabled: true,
  apiVersion: 1,
  items: [
    {
      plugin: "fake-client",
      build: BUILD,
      entry: { url: `/api/v1/client/fake-client/${BUILD}/client.mjs`, integrity: "sha384-e" },
      styles: [],
      components: [],
    },
  ],
};
const safeHost = (frame: ReactNode) => (
  <ClientHost set={SET} safe scope="org" orgId="o1">
    {frame}
  </ClientHost>
);
const shell = () => document.querySelector('[data-cap-part~="shell"]') as HTMLElement;
const banner = () => document.querySelector('[data-part="safe-mode-banner"]') as HTMLElement;

beforeEach(() => resetNavigation("/agents"));
afterEach(cleanup);

describe("safe mode in the App Shell", () => {
  it("the banner is the shell's first row; the status bar stays inside the shell", () => {
    renderFrame(shellOf(ME), <p>page body</p>, { wrap: safeHost });
    expect(banner()).not.toBeNull();
    expect(shell().getAttribute("data-banner")).toBe("true");
    expect(shell().contains(banner())).toBe(true);
    // never a sibling before the shell (that pushed the 100dvh shell below the window)
    expect(shell().previousElementSibling).toBeNull();
    expect(shell().contains(screen.getByRole("contentinfo"))).toBe(true);
    expect(shell().contains(screen.getByText("page body"))).toBe(true);
  });

  it("the setup layout draws it the same way", () => {
    renderFrame(shellOf(ME, { readiness: NOT_READY }), <p>page body</p>, { wrap: safeHost });
    expect(document.querySelector('[data-template="SetupPage"]')).not.toBeNull();
    expect(shell().contains(banner())).toBe(true);
    expect(shell().getAttribute("data-banner")).toBe("true");
  });

  it("outside safe mode the shell has no banner row", () => {
    renderFrame(shellOf(ME), <p>page body</p>, {
      wrap: (frame) => (
        <ClientHost set={SET} safe={false} scope="org" orgId="o1">
          {frame}
        </ClientHost>
      ),
    });
    expect(banner()).toBeNull();
    expect(shell().hasAttribute("data-banner")).toBe(false);
  });
});
