// The auth pages render on the server (web-SSR spec §6.3, task 11): /login takes its query from the
// server and sends a signed-in visitor on, /setup keeps the layout's status, /invite and /bind read
// their token preview on the server. A sign-in tells the other tabs (§3.2) before navigating.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import BindPage from "../src/app/(auth)/bind/[token]/page";
import InvitePage from "../src/app/(auth)/invite/[token]/page";
import LoginPage from "../src/app/(auth)/login/page";
import SetupPage from "../src/app/(auth)/setup/page";
import { ServerSetupStatusProvider } from "../src/app/(auth)/setup/status";
import { json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute, renderServer } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
const broadcastSession = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/session-sync", () => ({ broadcastSession, useSessionSync: () => {} }));

const unauthenticated = () => json(401, { error: { code: "auth.required", message: "x" } });
const SOURCES = [{ plugin: "fake-im", label: { zh: "假 IM", en: "Fake IM" } }];
const INVITE = {
  org: { id: "o9", name: "Initech" },
  role: "guest",
  expiresAt: "2026-10-29T00:00:00.000Z",
};
const BINDING = {
  connectionId: "ch1",
  source: "fake-im:t1",
  externalId: "u-alice",
  displayName: "Alice Wong",
};
const ROUTES: Routes = {
  "GET /api/v1/me": unauthenticated,
  "GET /api/v1/auth/sources": () => json(200, { sources: SOURCES }),
  "GET /api/v1/invitations/cap_inv_tok": () => json(200, INVITE),
  "GET /api/v1/bind/cap_bind_tok": () => json(200, { binding: BINDING }),
};

const login =
  (q: Record<string, string> = {}) =>
  () =>
    LoginPage({ searchParams: Promise.resolve(q) });
const invite = () => InvitePage({ params: Promise.resolve({ token: "cap_inv_tok" }) });
const bind = () => BindPage({ params: Promise.resolve({ token: "cap_bind_tok" }) });
/** The order of two mocks' first calls. */
const before = (a: { mock: { invocationCallOrder: number[] } }, b: typeof a) =>
  (a.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY) <
  (b.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);

beforeEach(() => {
  resetNavigation("/login");
  broadcastSession.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/login", () => {
  it("the form, the query's error and the sign-in sources, with no browser fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(login({ error: "sso.unavailable", returnTo: "/bind/x" }), ROUTES);
    expect(screen.getByRole("button", { name: en.login.submit })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en.login.ssoError.sso.unavailable);
    expect(
      screen.getByRole("button", { name: en.login.sso.replace("{name}", "Fake IM") }),
    ).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("sources the kernel fails leave the local form", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(login(), {
      ...ROUTES,
      "GET /api/v1/auth/sources": () => json(500, { error: { code: "internal", message: "x" } }),
    });
    expect(screen.getByRole("button", { name: en.login.submit })).toBeTruthy();
    expect(screen.queryByText(en.login.or)).toBeNull();
    expect(browser).toEqual([]);
  });

  it("a signed-in visitor goes to returnTo before anything renders", async () => {
    expectNoFirstPaintFetch();
    const ok = { ...ROUTES, "GET /api/v1/me": () => json(200, ME) };
    await expect(renderRoute(login({ returnTo: "/agents" }), ok)).rejects.toThrow(
      "REDIRECT /agents",
    );
    await expect(renderRoute(login({ returnTo: "https://evil.example" }), ok)).rejects.toThrow(
      "REDIRECT /",
    );
    // never back to a sign-in page (a loop)
    await expect(renderRoute(login({ returnTo: "/login?x=1" }), ok)).rejects.toThrow(
      /^REDIRECT \/$/,
    );
  });

  it("signing in tells the other tabs, then goes to returnTo", async () => {
    stubApi({ "POST /api/v1/auth/login": () => json(200, { account: { id: "a1" } }) });
    await renderRoute(login({ returnTo: "/bind/x" }), ROUTES);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.login.loginLabel }), "alice");
    await user.type(screen.getByLabelText(en.login.passwordLabel), "pw-123456789");
    await user.click(screen.getByRole("button", { name: en.login.submit }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/bind/x"));
    expect(broadcastSession).toHaveBeenCalledWith("signed-in");
    expect(before(broadcastSession, router.replace)).toBe(true);
  });
});

describe("/setup", () => {
  it("the layout's status draws the form with no browser fetch; setting up tells the other tabs", async () => {
    const browser = stubApi({
      "POST /api/v1/setup": () => json(200, { account: { id: "a1" } }),
    });
    renderServer(
      <ServerSetupStatusProvider value={true}>{await SetupPage()}</ServerSetupStatusProvider>,
    );
    expect(browser).toEqual([]);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.setup.loginLabel }), "admin");
    await user.type(
      screen.getByLabelText(en.setup.passwordLabel, { exact: false }),
      "correct-horse-battery",
    );
    await user.type(screen.getByRole("textbox", { name: en.setup.displayNameLabel }), "Admin");
    await user.click(screen.getByRole("button", { name: en.setup.submit }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(broadcastSession).toHaveBeenCalledWith("signed-in");
    expect(before(broadcastSession, router.replace)).toBe(true);
  });
});

describe("/invite/[token]", () => {
  it("signed in: the preview and accept, with no browser fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(invite, { ...ROUTES, "GET /api/v1/me": () => json(200, ME) });
    expect(screen.getByText(en.invite.subtitle.replace("{org}", "Initech"))).toBeTruthy();
    expect(screen.getByRole("button", { name: en.invite.accept })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("signed out: sign in or sign up", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(invite, ROUTES);
    expect(screen.getByText(en.invite.signInHint)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("a dead link is the page's own problem, not a not-found page", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(invite, {
      ...ROUTES,
      "GET /api/v1/invitations/cap_inv_tok": () =>
        json(410, { error: { code: "invitation.expired", message: "x" } }),
    });
    expect(screen.getByText(en.invite.invalidTitle)).toBeTruthy();
    expect(screen.getByText(en.errors.invitation.expired)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("signing up through the invitation tells the other tabs before entering", async () => {
    stubApi({
      "POST /api/v1/invitations/cap_inv_tok/accept": () =>
        json(200, { account: { id: "a7" }, orgId: "o9", role: "guest" }),
      "PUT /api/v1/me/current-org": () => noContent(),
    });
    await renderRoute(invite, ROUTES);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.invite.signupToggle }));
    await user.type(screen.getByLabelText(en.invite.loginLabel), "carol");
    await user.type(screen.getByLabelText(en.invite.passwordLabel), "a-very-long-password");
    await user.type(screen.getByLabelText(en.invite.displayNameLabel), "Carol");
    await user.click(screen.getByRole("button", { name: en.invite.signup }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(broadcastSession).toHaveBeenCalledWith("signed-in");
    expect(before(broadcastSession, router.replace)).toBe(true);
  });

  it("accepting while signed in switches the org and tells the other tabs", async () => {
    stubApi({
      "POST /api/v1/invitations/cap_inv_tok/accept": () =>
        json(200, { account: { id: "a1" }, orgId: "o9", role: "guest" }),
      "PUT /api/v1/me/current-org": () => noContent(),
    });
    await renderRoute(invite, { ...ROUTES, "GET /api/v1/me": () => json(200, ME) });
    await userEvent.setup().click(screen.getByRole("button", { name: en.invite.accept }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(broadcastSession).toHaveBeenCalledWith("org-switched");
  });
});

describe("/bind/[token]", () => {
  it("the pending binding, with no browser fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(bind, ROUTES);
    expect(screen.getByText("Alice Wong")).toBeTruthy();
    expect(screen.getByRole("button", { name: en.bind.confirm })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("signed out: to sign-in and back here, before anything renders", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(bind, { ...ROUTES, "GET /api/v1/bind/cap_bind_tok": unauthenticated }),
    ).rejects.toThrow(`REDIRECT /login?returnTo=${encodeURIComponent("/bind/cap_bind_tok")}`);
  });

  it("an invalid link is the page's own problem", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(bind, {
      ...ROUTES,
      "GET /api/v1/bind/cap_bind_tok": () =>
        json(404, { error: { code: "bind.invalid", message: "x" } }),
    });
    expect(screen.getByText(en.bind.invalidTitle)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.bind.confirm })).toBeNull();
    expect(browser).toEqual([]);
  });
});
