// The browser handoff pages (shell external authorization spec §2, §3): `/handoff/<ticket>` redeems
// its ticket once in the signed-in browser and goes on to the provider; `/handoff/done` shows the
// result and links back to the app only through a listed scheme and a safe site path.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCatalog from "../messages/en.json";
import { withProductName } from "../src/i18n/product";
import { json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderAuthRouteWithCache } from "./support/query";
import { ME, pageElement, renderPage, testQueryClient } from "./support/render";
import { serverRoutes } from "./support/server";

const en = withProductName(enCatalog, null);

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const { default: HandoffLayout } = await import("../src/app/(auth)/handoff/[ticket]/layout");
const { default: HandoffView } = await import("../src/app/(auth)/handoff/[ticket]/view");
const { metadata } = await import("../src/app/(auth)/handoff/[ticket]/page");
const { appDeepLink, parseHandoffDone } = await import("../src/lib/handoff");

const TICKET = "cap_ho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REDEEM = "POST /api/v1/auth/handoffs/redeem";
const AUTHORIZE = "https://slack.example/oauth/authorize?state=s1";
const META = { name: null, icons: { app: null, maskable: null, favicon: null } };
const CONNECTOR = { id: "c1", name: "Slack" };
const SOURCES = [{ plugin: "slack-login", label: { zh: "Slack 登录", en: "Slack sign-in" } }];

beforeEach(() => {
  resetNavigation(`/handoff/${TICKET}`);
  navigateBrowser.mockReset();
  req.headers = new Headers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the handoff page", () => {
  it("signed out redirects to login with returnTo", async () => {
    serverRoutes({
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await expect(
      HandoffLayout({ children: <p>page</p>, params: Promise.resolve({ ticket: TICKET }) }),
    ).rejects.toThrow(`REDIRECT /login?returnTo=${encodeURIComponent(`/handoff/${TICKET}`)}`);
  });

  it("a signed-in visitor gets the page, which sends no referrer", async () => {
    serverRoutes({ "GET /api/v1/me": () => json(200, ME) });
    await expect(
      HandoffLayout({ children: <p>page</p>, params: Promise.resolve({ ticket: TICKET }) }),
    ).resolves.toBeTruthy();
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("redeems once under a remount", async () => {
    const calls = stubApi({ [REDEEM]: () => json(200, { location: AUTHORIZE }) });
    // StrictMode at the root: React runs the mount effects twice (nested, it does not)
    render(<StrictMode>{pageElement(<HandoffView ticket={TICKET} />)}</StrictMode>);
    expect(screen.getByText(en.handoff.opening)).toBeTruthy();
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTHORIZE));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.body))).toEqual({ ticket: TICKET });
    expect(posts[0]?.headers.get("x-capybara-csrf")).toBe("1");
    expect(navigateBrowser).toHaveBeenCalledTimes(1);
  });

  it("a real remount awaits the same redeem and navigates once", async () => {
    const ticket = `${TICKET.slice(0, -1)}F`;
    let answer!: (r: Response) => void;
    const calls = stubApi({
      [REDEEM]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    // one browser cache, as in the app: the page unmounts and mounts again before the answer
    const client = testQueryClient();
    const first = renderPage(<HandoffView ticket={ticket} />, { client });
    first.unmount();
    renderPage(<HandoffView ticket={ticket} />, { client });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    answer(json(200, { location: AUTHORIZE }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTHORIZE));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(navigateBrowser).toHaveBeenCalledTimes(1);
  });

  it("never navigates to a location that is not http(s) or a site path", async () => {
    const ticket = `${TICKET.slice(0, -1)}B`;
    stubApi({ [REDEEM]: () => json(200, { location: "javascript:alert(1)" }) });
    renderPage(<HandoffView ticket={ticket} />);
    expect(await screen.findByText(en.errors.unknown)).toBeTruthy();
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("invalid ticket shows the invalid message", async () => {
    const ticket = `${TICKET.slice(0, -1)}C`;
    stubApi({
      [REDEEM]: () => json(410, { error: { code: "handoff.invalid", message: "gone" } }),
    });
    renderPage(<HandoffView ticket={ticket} />);
    expect(await screen.findByText(en.errors.handoff.invalid)).toBeTruthy();
    expect(screen.getByText(en.handoff.startAgain)).toBeTruthy();
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("account mismatch names the owner and offers another sign-in", async () => {
    const ticket = `${TICKET.slice(0, -1)}D`;
    const calls = stubApi({
      [REDEEM]: () =>
        json(403, {
          error: {
            code: "handoff.account_mismatch",
            message: "x",
            details: [{ displayName: "Alice Wong", email: "alice@corp.example" }],
          },
        }),
      "POST /api/v1/auth/logout": () => noContent(),
    });
    renderPage(<HandoffView ticket={ticket} />);
    expect(
      await screen.findByText(
        en.errors.handoff.account_mismatch.replace("{login}", "alice@corp.example"),
      ),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: en.handoff.switchAccount }));
    await vi.waitFor(() =>
      expect(navigateBrowser).toHaveBeenCalledWith(
        `/login?returnTo=${encodeURIComponent(`/handoff/${ticket}`)}`,
      ),
    );
    expect(calls.filter((c) => c.url === "/api/v1/auth/logout")).toHaveLength(1);
  });

  it("account mismatch without an email names the display name", async () => {
    const ticket = `${TICKET.slice(0, -1)}E`;
    stubApi({
      [REDEEM]: () =>
        json(403, {
          error: {
            code: "handoff.account_mismatch",
            message: "x",
            details: [{ displayName: "Alice Wong", email: null }],
          },
        }),
    });
    renderPage(<HandoffView ticket={ticket} />);
    expect(
      await screen.findByText(en.errors.handoff.account_mismatch.replace("{login}", "Alice Wong")),
    ).toBeTruthy();
  });
});

const doneRoutes = (appSchemes: string[]) =>
  stubApi({
    "GET /api/v1/me": () => json(200, ME),
    "GET /api/v1/meta": () => json(200, { ...META, appSchemes }),
    "GET /api/v1/orgs/o1/connectors/c1": () => json(200, { connector: CONNECTOR }),
    "GET /api/v1/auth/sources": () => json(200, { sources: SOURCES }),
  });

const connectorDone = (extra: string) =>
  `/handoff/done?kind=connector&org=o1&connector=c1&returnTo=${encodeURIComponent("/settings/connectors")}${extra}`;

describe("the done page", () => {
  it("done page builds the deep link for a listed scheme and tries it once", async () => {
    doneRoutes(["capybara"]);
    await renderAuthRouteWithCache(
      connectorDone("&scheme=capybara&connected=c1"),
      lastStubRoutes(),
    );
    expect(
      await screen.findByText(en.handoff.done.connected.replace("{name}", "Slack")),
    ).toBeTruthy();
    const expected = `capybara://open?url=${encodeURIComponent(`${window.location.origin}/settings/connectors?connected=c1`)}`;
    const back = screen.getByRole("link", { name: en.handoff.done.back });
    expect(back.getAttribute("href")).toBe(expected);
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(expected));
    expect(navigateBrowser).toHaveBeenCalledTimes(1);
    expect(screen.getByText(en.handoff.done.closeTabHint)).toBeTruthy();
  });

  it("done page refuses unlisted schemes and unsafe returnTo", async () => {
    doneRoutes(["capybara"]);
    await renderAuthRouteWithCache(
      "/handoff/done?kind=connector&org=o1&connector=c1&returnTo=%2F%2Fevil.example&scheme=javascript&connected=c1",
      lastStubRoutes(),
    );
    expect(
      await screen.findByText(en.handoff.done.connected.replace("{name}", "Slack")),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.handoff.done.back })).toBeNull();
    expect(screen.getByText(en.handoff.done.backToApp)).toBeTruthy();
    await act(async () => {});
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("a listed scheme with an unsafe returnTo still gets no link", async () => {
    doneRoutes(["capybara"]);
    await renderAuthRouteWithCache(
      "/handoff/done?kind=connector&org=o1&connector=c1&returnTo=%2F%2Fevil.example&scheme=capybara&connected=c1",
      lastStubRoutes(),
    );
    await screen.findByText(en.handoff.done.backToApp);
    expect(screen.queryByRole("link", { name: en.handoff.done.back })).toBeNull();
    await act(async () => {});
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("done page shows the error translation for a connector", async () => {
    doneRoutes(["capybara"]);
    await renderAuthRouteWithCache(
      connectorDone("&scheme=capybara&oauth_error=access_denied"),
      lastStubRoutes(),
    );
    expect(await screen.findByText(en.connect.result.error.access_denied)).toBeTruthy();
    const back = screen.getByRole("link", { name: en.handoff.done.back });
    expect(back.getAttribute("href")).toBe(
      `capybara://open?url=${encodeURIComponent(`${window.location.origin}/settings/connectors?oauth_error=access_denied`)}`,
    );
  });

  it("done page shows the error translation for a login link", async () => {
    doneRoutes([]);
    await renderAuthRouteWithCache(
      `/handoff/done?kind=identity-link&plugin=slack-login&returnTo=${encodeURIComponent("/account/identities")}&error=sso.access_denied`,
      lastStubRoutes(),
    );
    expect(await screen.findByText(en.identities.linkError.sso.access_denied)).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.handoff.done.back })).toBeNull();
  });

  it("a linked login method is named by its source label", async () => {
    doneRoutes(["capybara"]);
    await renderAuthRouteWithCache(
      `/handoff/done?kind=identity-link&plugin=slack-login&returnTo=${encodeURIComponent("/account/identities")}&scheme=capybara`,
      lastStubRoutes(),
    );
    expect(
      await screen.findByText(en.handoff.done.linked.replace("{name}", "Slack sign-in")),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: en.handoff.done.back }).getAttribute("href")).toBe(
      `capybara://open?url=${encodeURIComponent(`${window.location.origin}/account/identities`)}`,
    );
  });
});

describe("handoff helpers", () => {
  it("parseHandoffDone reads both kinds and refuses unsafe return paths", () => {
    expect(
      parseHandoffDone("kind=connector&org=o1&connector=c1&returnTo=%2Fx%3Fa%3D1&connected=c1"),
    ).toEqual({
      kind: "connector",
      orgId: "o1",
      connectorId: "c1",
      returnTo: "/x?a=1",
      result: { kind: "ok" },
    });
    expect(
      parseHandoffDone("kind=identity-link&plugin=p&returnTo=%2Fy&scheme=s&error=zzz"),
    ).toEqual({
      kind: "identity-link",
      plugin: "p",
      returnTo: "/y",
      scheme: "s",
      result: { kind: "error", code: "unknown" },
    });
    expect(
      parseHandoffDone("kind=connector&org=o1&connector=c1&returnTo=https://evil"),
    ).not.toHaveProperty("returnTo");
    expect(parseHandoffDone("kind=other")).toBeNull();
    expect(parseHandoffDone("kind=connector&org=o1")).toBeNull();
  });

  it("appDeepLink only for a listed scheme, joining the result parameters", () => {
    const p = new URLSearchParams({ connected: "c1" });
    expect(appDeepLink("capybara", ["capybara"], "https://h", "/a?b=1", p)).toBe(
      `capybara://open?url=${encodeURIComponent("https://h/a?b=1&connected=c1")}`,
    );
    expect(appDeepLink("capybara", ["capybara"], "https://h", "/a", new URLSearchParams())).toBe(
      `capybara://open?url=${encodeURIComponent("https://h/a")}`,
    );
    expect(appDeepLink("javascript", ["capybara"], "https://h", "/a", p)).toBeNull();
    expect(appDeepLink(undefined, ["capybara"], "https://h", "/a", p)).toBeNull();
  });
});
