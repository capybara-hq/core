// The frame's push parts: `?org=` on app routes, the sign-out that forgets this install's
// registration, and the in-context prompt.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { navigateBrowser, replaceBrowser } from "../src/lib/browser";
import { json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn(), replaceBrowser: vi.fn() }));

const twoOrgs = {
  ...ME,
  memberships: [
    { orgId: "o1", slug: "acme", name: "Acme", role: "owner" },
    { orgId: "o2", slug: "b", name: "Beta", role: "member" },
  ],
};

function installPush(
  status: { permission: "granted" | "denied" | "prompt"; registrationId: string | null },
  order: string[] = [],
) {
  const push = {
    status: vi.fn(async () => ({ ...status, tokenChanged: false })),
    register: vi.fn(async () => ({
      platform: "ios",
      appId: "com.example.app",
      provider: "push-apns",
      token: "t1",
    })),
    registered: vi.fn(async () => {}),
    unregister: vi.fn(async () => {
      order.push("unregister");
    }),
  };
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
    version: 1,
    capabilities: { "push@1": push },
    on: () => () => {},
  };
  return push;
}

beforeEach(() => {
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  vi.mocked(navigateBrowser).mockReset();
  vi.mocked(replaceBrowser).mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "capybaraShell");
  window.history.replaceState(null, "", "/");
});

describe("?org= on an app route", () => {
  it("switches to an org the person belongs to and replaces the URL without the parameter", async () => {
    window.history.replaceState(null, "", "/chat/c1?org=o2");
    const calls = stubApi({ "PUT /api/v1/me/current-org": () => noContent() });
    renderFrame(shellOf(twoOrgs));
    await vi.waitFor(() => expect(replaceBrowser).toHaveBeenCalledWith("/chat/c1"));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ orgId: "o2" });
  });

  it("keeps the other query parameters and the hash", async () => {
    window.history.replaceState(null, "", "/chat/c1?subagent=s1&org=o2#panel=x");
    stubApi({ "PUT /api/v1/me/current-org": () => noContent() });
    renderFrame(shellOf(twoOrgs));
    await vi.waitFor(() =>
      expect(replaceBrowser).toHaveBeenCalledWith("/chat/c1?subagent=s1#panel=x"),
    );
  });

  it("for an org the person is not in only drops the parameter", async () => {
    window.history.replaceState(null, "", "/chat/c1?org=o9");
    const calls = stubApi({});
    renderFrame(shellOf(twoOrgs));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c1"));
    expect(calls).toEqual([]);
    expect(replaceBrowser).not.toHaveBeenCalled();
  });

  it("for the current org only drops the parameter", async () => {
    window.history.replaceState(null, "", "/chat/c1?org=o1");
    const calls = stubApi({});
    renderFrame(shellOf(twoOrgs));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c1"));
    expect(calls).toEqual([]);
  });

  it("without the parameter nothing is called", () => {
    const calls = stubApi({});
    renderFrame(shellOf(twoOrgs));
    expect(calls).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("sign-out with a push registration", () => {
  async function signOut() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `账户: ${ME.account.displayName}` }));
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
  }

  it("deletes the registration and unregisters before logging out", async () => {
    const order: string[] = [];
    installPush({ permission: "granted", registrationId: "r1" }, order);
    stubApi({
      "DELETE /api/v1/me/push-registrations/r1": () => {
        order.push("delete");
        return noContent();
      },
      "POST /api/v1/auth/logout": () => {
        order.push("logout");
        return noContent();
      },
    });
    renderFrame(shellOf(ME));
    await signOut();
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/login"));
    expect(order).toEqual(["delete", "unregister", "logout"]);
  });

  it("still logs out when DELETE fails", async () => {
    const order: string[] = [];
    installPush({ permission: "granted", registrationId: "r1" }, order);
    stubApi({
      "DELETE /api/v1/me/push-registrations/r1": () => json(500, { code: "internal" }),
      "POST /api/v1/auth/logout": () => {
        order.push("logout");
        return noContent();
      },
    });
    renderFrame(shellOf(ME));
    await signOut();
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/login"));
    expect(order).toEqual(["unregister", "logout"]);
  });
});

describe("the in-context push prompt", () => {
  const prompt = () => screen.queryByText(en.notifications.prompt.text);

  it("shows once something waits, and 以后再说 hides it for good", async () => {
    installPush({ permission: "prompt", registrationId: null });
    stubApi({});
    const { unmount } = renderFrame(
      shellOf(ME, { pending: { count: 2, more: false } }),
      undefined,
      {
        locale: "en",
      },
    );
    expect(await screen.findByText(en.notifications.prompt.text)).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.notifications.prompt.later }));
    expect(prompt()).toBeNull();
    unmount();
    renderFrame(shellOf(ME, { pending: { count: 2, more: false } }), undefined, { locale: "en" });
    // the shell has answered by now; the stored answer keeps it hidden
    await vi.waitFor(() => expect(screen.getByText("page body")).toBeTruthy());
    expect(prompt()).toBeNull();
  });

  it("is not shown while nothing waits, nor without the prompt state", async () => {
    installPush({ permission: "prompt", registrationId: null });
    stubApi({});
    renderFrame(shellOf(ME, { pending: { count: 0, more: false } }), undefined, { locale: "en" });
    await vi.waitFor(() => expect(screen.getByText("page body")).toBeTruthy());
    expect(prompt()).toBeNull();
    cleanup();
    installPush({ permission: "denied", registrationId: null });
    renderFrame(shellOf(ME, { pending: { count: 2, more: false } }), undefined, { locale: "en" });
    await vi.waitFor(() => expect(screen.getByText("page body")).toBeTruthy());
    expect(prompt()).toBeNull();
  });

  it("开启 registers this device (the click starts the OS prompt)", async () => {
    const push = installPush({ permission: "prompt", registrationId: null });
    stubApi({ "POST /api/v1/me/push-registrations": () => json(201, { id: "r5" }) });
    renderFrame(shellOf(ME, { pending: { count: 1, more: false } }), undefined, { locale: "en" });
    const banner = (await screen.findByText(en.notifications.prompt.text)).closest("section");
    if (banner === null) throw new Error("the prompt is not a callout");
    await userEvent
      .setup()
      .click(within(banner).getByRole("button", { name: en.notifications.prompt.enable }));
    await vi.waitFor(() => expect(push.registered).toHaveBeenCalledWith("r5"));
    await vi.waitFor(() => expect(prompt()).toBeNull());
  });
});
