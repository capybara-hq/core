// Platform tool spec §14.5 item 2: an account created with a generated initial password sets its
// own on /change-password before anything else.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { bodyOf, json, stubApi } from "./support/api";
import { ME, renderPage } from "./support/render";
import { serverRoutes } from "./support/server";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  usePathname: () => "/change-password",
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const { default: ChangePasswordLayout } = await import("../src/app/(auth)/change-password/layout");
const { default: ChangePasswordView } = await import("../src/app/(auth)/change-password/view");

const pending = { ...ME, account: { ...ME.account, mustChangePassword: true } };

beforeEach(() => navigateBrowser.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/change-password decides on the server", () => {
  it("signed out goes to sign-in; nothing to change goes home; a pending change renders", async () => {
    serverRoutes({
      "GET /api/v1/me": () =>
        json(401, { error: { code: "auth.required", message: "signed out" } }),
    });
    await expect(ChangePasswordLayout({ children: <p>page body</p> })).rejects.toThrow(
      "REDIRECT /login?returnTo=%2Fchange-password",
    );
    serverRoutes({ "GET /api/v1/me": () => json(200, ME) });
    await expect(ChangePasswordLayout({ children: <p>page body</p> })).rejects.toThrow(
      /^REDIRECT \/$/,
    );
    serverRoutes({ "GET /api/v1/me": () => json(200, pending) });
    await expect(ChangePasswordLayout({ children: <p>page body</p> })).resolves.toBeTruthy();
  });
});

describe("the change-password form", () => {
  it("refuses two different new passwords without asking the kernel", async () => {
    const calls = stubApi({});
    renderPage(<ChangePasswordView />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.changePassword.current), "Gen3ratedPassw0rdXyz");
    await user.type(screen.getByLabelText(en.changePassword.next), "my own passphrase");
    await user.type(screen.getByLabelText(en.changePassword.confirm), "my own passphrasf");
    await user.click(screen.getByRole("button", { name: en.changePassword.submit }));
    expect(await screen.findByText(en.changePassword.mismatch)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("saves the new password, then loads home as a new document", async () => {
    const calls = stubApi({ "PUT /api/v1/me/password": () => new Response(null, { status: 204 }) });
    renderPage(<ChangePasswordView />, { locale: "en" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.changePassword.current), "Gen3ratedPassw0rdXyz");
    await user.type(screen.getByLabelText(en.changePassword.next), "my own passphrase");
    await user.type(screen.getByLabelText(en.changePassword.confirm), "my own passphrase");
    await user.click(screen.getByRole("button", { name: en.changePassword.submit }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      currentPassword: "Gen3ratedPassw0rdXyz",
      newPassword: "my own passphrase",
    });
  });
});
