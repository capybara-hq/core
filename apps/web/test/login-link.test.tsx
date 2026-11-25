import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCatalog from "../messages/en.json";
import zhCatalog from "../messages/zh.json";
import { withProductName } from "../src/i18n/product";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache } from "./support/query";

// The link page (login extensions spec §5): a third-party sign-in without a linked account.

const en = withProductName(enCatalog, null);
const zh = withProductName(zhCatalog, null);

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const msgs = { zh, en } as const;
const TICKET = "cap_link_abc";
const PAGE = `/login/link?ticket=${TICKET}`;
const PEEK = `GET /api/v1/auth/sso/link?ticket=${TICKET}`;
const VIEW = {
  plugin: "fake-im",
  label: { zh: "假 IM", en: "Fake IM" },
  tenantId: "t1",
  displayName: "Alice Wong",
  avatarUrl: "https://im.example/a.png",
  linkedToAnother: false,
};
const signedOut = () => json(401, { error: { code: "auth.required", message: "x" } });

/** A document load of the link page, signed out; the browser reads the pending link. */
function linkAt(routes: Parameters<typeof stubApi>[0], opts: { locale?: "zh" | "en" } = {}) {
  const calls = stubApi({ "GET /api/v1/me": signedOut, ...routes });
  return renderAuthRouteWithCache(PAGE, lastStubRoutes(), opts).then((r) => ({ ...r, calls }));
}

const fill = (s: string, values: Record<string, string>) =>
  Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), s);

beforeEach(() => {
  resetNavigation(PAGE);
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/login/link (AuthPage)", () => {
  it.each(["zh", "en"] as const)(
    "shows the identity and submits credentials (%s)",
    async (locale) => {
      const m = msgs[locale].login.link;
      const { container, calls } = await linkAt(
        {
          [PEEK]: () => json(200, VIEW),
          "POST /api/v1/auth/sso/link": () =>
            json(200, {
              account: { id: "a1", mustChangePassword: false },
              returnTo: "/agents",
            }),
        },
        { locale },
      );
      expect(container.querySelector('[data-template="AuthPage"]')).not.toBeNull();
      expect(await screen.findByText("Alice Wong")).toBeTruthy();
      expect(
        screen.getByText(
          fill(m.intro, { platform: VIEW.label[locale], name: "Alice Wong", tenant: "t1" }),
        ),
      ).toBeTruthy();
      expect(screen.getByText(VIEW.label[locale])).toBeTruthy();
      expect(screen.getByText("t1")).toBeTruthy();
      expect(screen.getByText(m.noAccount)).toBeTruthy();
      expect(screen.queryByText(m.linkedToAnother)).toBeNull();
      // the avatar sends no referrer (the ticket is in the page's address)
      expect(container.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(msgs[locale].login.loginLabel), "alice");
      await user.type(screen.getByLabelText(msgs[locale].login.passwordLabel), "pw");
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/agents"));
      const post = calls.find((c) => c.method === "POST");
      expect(post && bodyOf(post)).toEqual({ ticket: TICKET, login: "alice", password: "pw" });
      expect(post?.headers.get("x-capybara-csrf")).toBe("1");
    },
  );

  it("without a tenant the intro names only the account", async () => {
    await linkAt({ [PEEK]: () => json(200, { ...VIEW, tenantId: "" }) });
    expect(
      await screen.findByText(
        fill(en.login.link.introNoTenant, { platform: "Fake IM", name: "Alice Wong" }),
      ),
    ).toBeTruthy();
  });

  it("an already linked account: says its password upgrades it", async () => {
    await linkAt({ [PEEK]: () => json(200, { ...VIEW, linkedToAnother: true }) }, { locale: "zh" });
    expect(await screen.findByText(zh.login.link.linkedToAnother)).toBeTruthy();
  });

  it("identity.taken shows its message and stays on the page", async () => {
    await linkAt({
      [PEEK]: () => json(200, VIEW),
      "POST /api/v1/auth/sso/link": () =>
        json(409, { error: { code: "identity.taken", message: "x" } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(en.login.loginLabel), "bob");
    await user.type(screen.getByLabelText(en.login.passwordLabel), "pw");
    await user.click(screen.getByRole("button", { name: en.login.link.submit }));
    expect(
      await screen.findByText(fill(en.login.link.taken, { platform: "Fake IM" })),
    ).toBeTruthy();
    expect(navigateBrowser).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: en.login.link.submit })).toBeTruthy();
  });

  it("a wrong password shows the sign-in error", async () => {
    await linkAt({
      [PEEK]: () => json(200, VIEW),
      "POST /api/v1/auth/sso/link": () =>
        json(401, { error: { code: "auth.invalid_credentials", message: "x" } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(en.login.loginLabel), "bob");
    await user.type(screen.getByLabelText(en.login.passwordLabel), "nope");
    await user.click(screen.getByRole("button", { name: en.login.link.submit }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      en.errors.auth.invalid_credentials,
    );
  });

  it("expired ticket sends to /login?error=sso.link_expired", async () => {
    await linkAt({
      [PEEK]: () => json(410, { error: { code: "sso.link_expired", message: "x" } }),
    });
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?error=sso.link_expired"),
    );
  });

  it("a ticket that expires while the password is entered sends to sign-in too", async () => {
    await linkAt({
      [PEEK]: () => json(200, VIEW),
      "POST /api/v1/auth/sso/link": () =>
        json(410, { error: { code: "sso.link_expired", message: "x" } }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(en.login.loginLabel), "bob");
    await user.type(screen.getByLabelText(en.login.passwordLabel), "pw");
    await user.click(screen.getByRole("button", { name: en.login.link.submit }));
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?error=sso.link_expired"),
    );
  });

  it("cancel goes back to sign-in", async () => {
    await linkAt({ [PEEK]: () => json(200, VIEW) });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.login.link.cancel }));
    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  it("no ticket: back to sign-in with sso.link_expired", async () => {
    stubApi({ "GET /api/v1/me": signedOut });
    await expect(renderAuthRouteWithCache("/login/link", lastStubRoutes())).rejects.toThrow(
      "REDIRECT /login?error=sso.link_expired",
    );
  });

  it("the form posts natively without the client JS", async () => {
    const { container } = await linkAt({ [PEEK]: () => json(200, VIEW) });
    await screen.findByText("Alice Wong");
    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(within(form as HTMLElement).getByLabelText(en.login.passwordLabel)).toHaveProperty(
      "name",
      "password",
    );
  });
});
