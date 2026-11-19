// The app consent page `/apps/authorize` (desktop client spec §6.5): the Capybara desktop app opens
// it in the system browser; the signed-in person signs the app in or cancels, and the page
// navigates to the redirect the kernel returned (never to the query's own).
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import type { Routes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const CHALLENGE = "a".repeat(43);
const QUERY = new URLSearchParams({
  client: "desktop",
  redirect_uri: "capybara://auth/callback",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "st-1",
  name: "Ada's MacBook",
  app_version: "0.1.0",
});
const PAGE = `/apps/authorize?${QUERY.toString()}`;
const AUTHORIZE = "POST /api/v1/app-auth/authorize";
const BODY = {
  client: "desktop",
  redirectUri: "capybara://auth/callback",
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
  state: "st-1",
  name: "Ada's MacBook",
  appVersion: "0.1.0",
};
const GRANTED = "capybara://auth/callback?code=cap_ac_x&state=st-1&iss=https%3A%2F%2Fa.example";
const msgs = { zh, en } as const;

const ROUTES: Routes = {
  "GET /api/v1/me": () => json(200, ME),
  "GET /api/v1/meta": () => json(200, { name: "Example Corp" }),
  [AUTHORIZE]: () => json(200, { redirect: GRANTED }),
};

beforeEach(() => {
  resetNavigation("/apps/authorize");
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/apps/authorize", () => {
  it("asks once, naming the machine, the platform and the account (zh)", async () => {
    const calls = stubApi(ROUTES);
    const { container } = await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale: "zh" });
    expect(container.querySelector('[data-template="AuthPage"]')).not.toBeNull();
    expect(
      await screen.findByText("在 Ada's MacBook 上的 Capybara 桌面端登录 Example Corp？"),
    ).toBeTruthy();
    expect(screen.getByText(ME.account.email ?? ME.account.displayName)).toBeTruthy();
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("falls back to the product name when the platform has none (en)", async () => {
    stubApi({ ...ROUTES, "GET /api/v1/meta": () => json(200, { name: null }) });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale: "en" });
    expect(
      await screen.findByText("Sign in to Capybara with Capybara Desktop on Ada's MacBook?"),
    ).toBeTruthy();
  });

  it.each(["zh", "en"] as const)("signing in posts the body and navigates (%s)", async (locale) => {
    const m = msgs[locale].appAuth;
    const calls = stubApi(ROUTES);
    await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale });
    await userEvent.setup().click(await screen.findByRole("button", { name: m.confirm }));
    expect(await screen.findByText(m.doneHint)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/v1/app-auth/authorize");
    expect(bodyOf(post)).toEqual(BODY);
    expect(navigateBrowser).toHaveBeenCalledExactlyOnceWith(GRANTED);
  });

  it("after navigating the page says the app can be closed", async () => {
    stubApi(ROUTES);
    await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale: "zh" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "登录" }));
    expect(await screen.findByText("已返回 Capybara，可以关闭此页")).toBeTruthy();
  });

  it("cancelling posts deny and navigates to the returned redirect", async () => {
    const denied = "capybara://auth/callback?error=access_denied&state=st-1&iss=x";
    const calls = stubApi({ ...ROUTES, [AUTHORIZE]: () => json(200, { redirect: denied }) });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: en.appAuth.cancel }));
    expect(await screen.findByText(en.appAuth.doneHint)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ ...BODY, deny: true });
    expect(navigateBrowser).toHaveBeenCalledExactlyOnceWith(denied);
  });

  it.each([
    ["app_auth.redirect_uri_invalid", 400, en.errors.app_auth.redirect_uri_invalid],
    ["app_auth.unavailable", 503, en.errors.app_auth.unavailable],
  ])("%s shows an error and never navigates", async (code, status, copy) => {
    stubApi({ ...ROUTES, [AUTHORIZE]: () => json(status, { error: { code, message: "x" } }) });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.appAuth.confirm }));
    expect(await screen.findByText(copy)).toBeTruthy();
    // cancelling with the same bad address ends the same way
    await user.click(screen.getByRole("button", { name: en.appAuth.cancel }));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(navigateBrowser).not.toHaveBeenCalled();
    expect(screen.queryByText(en.appAuth.doneHint)).toBeNull();
  });

  it("a missing parameter shows an error and calls no API", async () => {
    const bad = new URLSearchParams(QUERY);
    bad.delete("state");
    const calls = stubApi(ROUTES);
    await renderAuthRouteWithCache(`/apps/authorize?${bad.toString()}`, lastStubRoutes());
    expect(await screen.findByText(en.appAuth.invalidHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.appAuth.confirm })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a signed-out browser goes to sign-in and back here", async () => {
    stubApi({
      ...ROUTES,
      "GET /api/v1/me": () => json(401, { error: { code: "auth.required", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(router.replace).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(PAGE)}`);
  });
});
