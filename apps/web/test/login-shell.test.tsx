// The sign-in page inside the desktop shell (desktop client spec §6): with `signIn@1` the page
// offers only the system-browser sign-in; without it, the page is the browser's.
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderAuthRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const SOURCES = [{ plugin: "fake-im", label: { zh: "假 IM", en: "Fake IM" } }];

function fakeShell(capabilities: Record<string, object>) {
  const listeners = new Set<() => void>();
  const shell = {
    version: 1,
    kind: "desktop",
    platform: "macos",
    shellVersion: "0.1.0",
    insets: { top: 28, right: 0, bottom: 0, left: 0 },
    capabilities,
    on: vi.fn((_e: "change", l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
  };
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = shell;
  return {
    change(next: Record<string, object>) {
      shell.capabilities = next;
      for (const l of [...listeners]) l();
    },
  };
}

function loginPage() {
  stubApi({ "GET /api/v1/auth/sources": () => json(200, { sources: SOURCES }) });
  return renderAuthRouteWithCache("/login", {
    ...lastStubRoutes(),
    "GET /api/v1/me": () => json(401, { error: { code: "auth.required", message: "x" } }),
  });
}

beforeEach(() => {
  resetNavigation("/login");
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "capybaraShell");
});

describe("login inside the desktop shell", () => {
  it("copy: zh says 在浏览器中登录", () => {
    expect(zh.login.browserSignIn).toBe("在浏览器中登录");
    expect(typeof en.login.browserSignIn).toBe("string");
  });

  it("shows only the browser sign-in; a click calls start() and signs in", async () => {
    const start = vi.fn().mockResolvedValue("signedIn");
    fakeShell({ "signIn@1": { start } });
    await loginPage();
    const button = await screen.findByRole("button", { name: en.login.browserSignIn });
    expect(screen.queryByLabelText(en.login.loginLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: en.login.submit })).toBeNull();
    expect(screen.queryByRole("button", { name: /Fake IM/ })).toBeNull();
    await userEvent.setup().click(button);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
  });

  it("cancelled keeps the page and shows no error", async () => {
    const start = vi.fn().mockResolvedValue("cancelled");
    fakeShell({ "signIn@1": { start } });
    await loginPage();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.login.browserSignIn }));
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(navigateBrowser).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: en.login.browserSignIn })).toBeTruthy();
  });

  it("a failure shows the generic sign-in error", async () => {
    const start = vi.fn().mockRejectedValue({ code: "failed" });
    fakeShell({ "signIn@1": { start } });
    await loginPage();
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.login.browserSignIn }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.login.ssoError.unknown);
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("without the capability the page is the browser's", async () => {
    fakeShell({});
    await loginPage();
    expect(await screen.findByRole("button", { name: en.login.submit })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.login.browserSignIn })).toBeNull();
  });

  it("a capability that appears after mount switches the page", async () => {
    const shell = fakeShell({});
    await loginPage();
    await screen.findByRole("button", { name: en.login.submit });
    act(() => shell.change({ "signIn@1": { start: vi.fn() } }));
    expect(await screen.findByRole("button", { name: en.login.browserSignIn })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.login.submit })).toBeNull();
  });
});
