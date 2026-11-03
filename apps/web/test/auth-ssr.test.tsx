// The auth pages render on the server (web-SSR spec §6.3, task 11): /login takes its query from the
// server and sends a signed-in visitor on, /setup keeps the layout's status, /invite and /bind read
// their token preview on the server. A sign-in tells the other tabs (§3.2), then navigates the whole
// document (ruling R4: the new session's frame is server-rendered, never a client navigation).
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import BindPage from "../src/app/(auth)/bind/[token]/page";
import SetupPage from "../src/app/(auth)/setup/page";
import { ServerSetupStatusProvider } from "../src/app/(auth)/setup/status";
import { json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache, renderRouteEmptyCache } from "./support/query";
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
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

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

/** Lets the mounted queries settle (a refetch on mount would have started by then). */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** A client navigation to `path` with an empty cache whose `held` read answers on `release()`. */
async function renderHeld(path: string, held: string, routes: Routes = ROUTES) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const answer = routes[held];
  if (answer === undefined) throw new Error(`no route ${held}`);
  const view = await renderRouteEmptyCache(path, {
    ...routes,
    [held]: async (c) => {
      await gate;
      return answer(c);
    },
  });
  return { ...view, release: () => act(async () => release()) };
}
const bind = () => BindPage({ params: Promise.resolve({ token: "cap_bind_tok" }) });
/** The order of two mocks' first calls. */
const before = (a: { mock: { invocationCallOrder: number[] } }, b: typeof a) =>
  (a.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY) <
  (b.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);

beforeEach(() => {
  resetNavigation("/login");
  broadcastSession.mockReset();
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/login", () => {
  it("/login: a first render from the hydrated cache makes no browser read (the form, the query's error and the sign-in sources)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache(
      `/login?error=sso.unavailable&returnTo=${encodeURIComponent("/bind/x")}`,
      ROUTES,
    );
    expect(screen.getByRole("button", { name: en.login.submit })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en.login.ssoError.sso.unavailable);
    expect(
      screen.getByRole("button", { name: en.login.sso.replace("{name}", "Fake IM") }),
    ).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("sources the kernel fails leave the local form, not read again on mount", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache("/login", {
      ...ROUTES,
      "GET /api/v1/auth/sources": () => json(500, { error: { code: "internal", message: "x" } }),
    });
    expect(screen.getByRole("button", { name: en.login.submit })).toBeTruthy();
    expect(screen.queryByText(en.login.or)).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/login: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/login", "GET /api/v1/auth/sources");
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: en.login.submit })).toBeNull();
    await release();
    expect(await screen.findByRole("button", { name: en.login.submit })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.login.sso.replace("{name}", "Fake IM") }),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("signing in tells the other tabs, drops the cache, then loads returnTo as a new document", async () => {
    stubApi({ "POST /api/v1/auth/login": () => json(200, { account: { id: "a1" } }) });
    const { client } = await renderAuthRouteWithCache(
      `/login?returnTo=${encodeURIComponent("/bind/x")}`,
      ROUTES,
    );
    // what the document cached (the sign-in sources, the signed-out session) is there until then
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
    let cachedAtNavigation = -1;
    navigateBrowser.mockImplementation(() => {
      cachedAtNavigation = client.getQueryCache().getAll().length;
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.login.loginLabel }), "alice");
    await user.type(screen.getByLabelText(en.login.passwordLabel), "pw-123456789");
    await user.click(screen.getByRole("button", { name: en.login.submit }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/bind/x"));
    expect(cachedAtNavigation).toBe(0);
    expect(broadcastSession).toHaveBeenCalledWith("signed-in");
    expect(before(broadcastSession, navigateBrowser)).toBe(true);
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
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(broadcastSession).toHaveBeenCalledWith("signed-in");
    expect(before(broadcastSession, navigateBrowser)).toBe(true);
  });
});

describe("/invite/[token]", () => {
  const PAGE = "/invite/cap_inv_tok";

  it("/invite/[token]: a first render from the hydrated cache makes no browser read (signed in: the preview and accept)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache(PAGE, { ...ROUTES, "GET /api/v1/me": () => json(200, ME) });
    expect(screen.getByText(en.invite.subtitle.replace("{org}", "Initech"))).toBeTruthy();
    expect(screen.getByRole("button", { name: en.invite.accept })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("signed out: sign in or sign up", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache(PAGE, ROUTES);
    expect(screen.getByText(en.invite.signInHint)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/invite/[token]: an empty cache shows the template's loading state, then the data", async () => {
    resetNavigation(PAGE);
    const { release } = await renderHeld(PAGE, "GET /api/v1/invitations/cap_inv_tok", {
      ...ROUTES,
      // the browser's apiFetch tries one refresh after a 401
      "POST /api/v1/auth/refresh": unauthenticated,
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(en.invite.signInHint)).toBeNull();
    await release();
    expect(await screen.findByText(en.invite.signInHint)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("a dead link is the page's own problem, not a not-found page, and is not read again", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache(PAGE, {
      ...ROUTES,
      "GET /api/v1/invitations/cap_inv_tok": () =>
        json(410, { error: { code: "invitation.expired", message: "x" } }),
    });
    expect(screen.getByText(en.invite.invalidTitle)).toBeTruthy();
    expect(screen.getByText(en.errors.invitation.expired)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.common.retry })).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an unreachable kernel on the first load is the page's error state; retry reads it again", async () => {
    let up = false;
    const preview = () =>
      up ? json(200, INVITE) : json(502, { error: { code: "upstream_unavailable", message: "x" } });
    const browser = stubApi({ "GET /api/v1/invitations/cap_inv_tok": preview });
    await renderAuthRouteWithCache(PAGE, {
      ...ROUTES,
      "GET /api/v1/invitations/cap_inv_tok": preview,
    });
    expect(screen.getByText(en.invite.title)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.invite.accept })).toBeNull();
    await settle();
    expect(browser).toEqual([]);
    up = true;
    await userEvent.setup().click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByText(en.invite.signInHint)).toBeTruthy();
    expect(browser.map((c) => c.url)).toEqual(["/api/v1/invitations/cap_inv_tok"]);
  });

  it("signing up through the invitation tells the other tabs, drops the cache, then enters", async () => {
    stubApi({
      "POST /api/v1/invitations/cap_inv_tok/accept": () =>
        json(200, { account: { id: "a7" }, orgId: "o9", role: "guest" }),
      "PUT /api/v1/me/current-org": () => noContent(),
    });
    const { client } = await renderAuthRouteWithCache(PAGE, ROUTES);
    let cachedAtNavigation = -1;
    navigateBrowser.mockImplementation(() => {
      cachedAtNavigation = client.getQueryCache().getAll().length;
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.invite.signupToggle }));
    await user.type(screen.getByLabelText(en.invite.loginLabel), "carol");
    await user.type(screen.getByLabelText(en.invite.passwordLabel), "a-very-long-password");
    await user.type(screen.getByLabelText(en.invite.displayNameLabel), "Carol");
    await user.click(screen.getByRole("button", { name: en.invite.signup }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(cachedAtNavigation).toBe(0);
    expect(broadcastSession).toHaveBeenCalledWith("signed-in");
    expect(before(broadcastSession, navigateBrowser)).toBe(true);
  });

  it("accepting while signed in switches the org, tells the other tabs and drops the cache", async () => {
    stubApi({
      "POST /api/v1/invitations/cap_inv_tok/accept": () =>
        json(200, { account: { id: "a1" }, orgId: "o9", role: "guest" }),
      "PUT /api/v1/me/current-org": () => noContent(),
    });
    const { client } = await renderAuthRouteWithCache(PAGE, {
      ...ROUTES,
      "GET /api/v1/me": () => json(200, ME),
    });
    let cachedAtNavigation = -1;
    navigateBrowser.mockImplementation(() => {
      cachedAtNavigation = client.getQueryCache().getAll().length;
    });
    await userEvent.setup().click(screen.getByRole("button", { name: en.invite.accept }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(cachedAtNavigation).toBe(0);
    expect(broadcastSession).toHaveBeenCalledWith("org-switched");
    expect(router.replace).not.toHaveBeenCalled();
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
