import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { Person } from "../src/components/Person";
import { keys } from "../src/lib/query/keys";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
// the browser's canvas crop and the presigned upload are not in jsdom
vi.mock("../src/lib/avatar-crop", () => ({
  cropAvatar: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
}));
vi.mock("../src/lib/uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/uploads")>()),
  uploadToStorage: vi.fn(async () => {}),
}));

const P = en.profile;
const PATH = "/account/profile";

const meWith = (account: Partial<Me["account"]>): Me => ({
  ...ME,
  account: { ...ME.account, ...account },
});

/** Serves `/me` (counting its reads) and the members list next to the given routes. */
function api(me: Me, routes: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    "GET /api/v1/me": () => json(200, me),
    "GET /api/v1/orgs/o1/members": () => json(200, { members: [] }),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    ...routes,
  });
}

const nameInput = () => screen.getByRole("textbox", { name: new RegExp(P.nameLabel) });
const reads = (calls: ReturnType<typeof stubApi>, path: string) =>
  calls.filter((c) => c.method === "GET" && c.url === path).length;

describe("/account/profile", () => {
  beforeEach(() => resetNavigation(PATH));
  afterEach(() => cleanup());

  it("renders the current name and the initial while there is no avatar", async () => {
    api(ME);
    await renderRouteWithCache(PATH, lastStubRoutes());
    expect((nameInput() as HTMLInputElement).value).toBe("Grant");
    const avatar = document.querySelector('[data-part="avatar"][data-shape="circle"]');
    expect(avatar?.getAttribute("data-kind")).toBe("initial");
  });

  it("shows the avatar route as an image and says where an SSO avatar comes from", async () => {
    const me = meWith({
      avatarUrl: "/api/v1/accounts/a1/avatar?v=abc",
      avatarSource: { kind: "identity", source: "lark:t1" },
    });
    api(me, {
      "GET /api/v1/auth/sources": () =>
        json(200, { sources: [{ plugin: "lark", label: { zh: "飞书", en: "Lark" } }] }),
    });
    await renderRouteWithCache(PATH, lastStubRoutes(), { me });
    expect(document.querySelector('[data-part="avatar"][data-kind="image"]')).not.toBeNull();
    // the sign-in source's label, never the identity key
    expect(
      await screen.findByText("Your Lark picture is in use. Upload an image to replace it."),
    ).toBeTruthy();
    expect(screen.queryByText(/lark:t1/)).toBeNull();
    // an SSO avatar is not the person's own: nothing to remove
    expect(screen.queryByRole("button", { name: P.remove })).toBeNull();
  });

  it("names an SSO source the deployment no longer offers by its plugin, not its tenant", async () => {
    const me = meWith({
      avatarUrl: "/api/v1/accounts/a1/avatar?v=abc",
      avatarSource: { kind: "identity", source: "wecom:corp9" },
    });
    api(me, { "GET /api/v1/auth/sources": () => json(200, { sources: [] }) });
    await renderRouteWithCache(PATH, lastStubRoutes(), { me });
    expect(
      await screen.findByText("Your wecom picture is in use. Upload an image to replace it."),
    ).toBeTruthy();
  });

  it("ties the avatar controls to their label", async () => {
    api(ME);
    await renderRouteWithCache(PATH, lastStubRoutes());
    const group = screen.getByRole("group", { name: P.avatarLabel });
    expect(group.querySelector('[data-part="avatar"]')).not.toBeNull();
    expect(group.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("saves a new name with PATCH { displayName } and reads me and the members again", async () => {
    const calls = api(ME, {
      "PATCH /api/v1/me/profile": () =>
        json(200, { account: { ...ME.account, displayName: "Grace" } }),
    });
    const { client } = await renderRouteWithCache(PATH, lastStubRoutes());
    // a members list another page read earlier
    client.setQueryData(keys.org("o1").members(), { members: [] });
    // the admin accounts list another page read earlier
    client.setQueryData(keys.deployment().adminAccounts(), { accounts: [] });
    const user = userEvent.setup();
    await user.clear(nameInput());
    await user.type(nameInput(), "  Grace ");
    await user.click(screen.getByRole("button", { name: P.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ displayName: "Grace" });
    await vi.waitFor(() => expect(reads(calls, "/api/v1/me")).toBe(1));
    await vi.waitFor(() =>
      expect(client.getQueryState(keys.org("o1").members())?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(keys.deployment().adminAccounts())?.isInvalidated).toBe(true);
  });

  it("refuses a 65-character name before sending", async () => {
    const calls = api(ME);
    await renderRouteWithCache(PATH, lastStubRoutes());
    fireEvent.change(nameInput(), { target: { value: "x".repeat(65) } });
    expect(await screen.findByText(P.nameTooLong.replace("{max}", "64"))).toBeTruthy();
    const save = screen.getByRole("button", { name: P.save });
    expect(save).toHaveProperty("disabled", true);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("uploads a chosen file, then saves it as the avatar", async () => {
    const calls = api(ME, {
      "POST /api/v1/me/avatar/uploads": () =>
        json(200, {
          uploadId: "up1",
          upload: { method: "PUT", url: "https://store.example/up1", headers: {} },
          expiresAt: "2026-11-21T08:00:00.000Z",
        }),
      "PATCH /api/v1/me/profile": () => json(200, { account: ME.account }),
    });
    const { container } = await renderRouteWithCache(PATH, lastStubRoutes());
    const user = userEvent.setup();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["x"], "me.jpg", { type: "image/jpeg" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    // the cropped png is what is registered
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      contentType: "image/png",
    });
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      avatar: { kind: "upload", uploadId: "up1" },
    });
  });

  it("removes the own avatar with avatar: null", async () => {
    const me = meWith({
      avatarUrl: "/api/v1/accounts/a1/avatar?v=abc",
      avatarSource: { kind: "upload" },
    });
    const calls = api(me, {
      "PATCH /api/v1/me/profile": () => json(200, { account: ME.account }),
    });
    await renderRouteWithCache(PATH, lastStubRoutes(), { me });
    await userEvent.setup().click(screen.getByRole("button", { name: P.remove }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ avatar: null });
  });

  it("turns uploading off with a note when storage is unavailable", async () => {
    api(ME, {
      "POST /api/v1/me/avatar/uploads": () =>
        json(503, { error: { code: "storage.unavailable", message: "no store" } }),
    });
    const { container } = await renderRouteWithCache(PATH, lastStubRoutes());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.setup().upload(input, new File(["x"], "me.png", { type: "image/png" }));
    expect(await screen.findByText(P.uploadOff)).toBeTruthy();
    expect(screen.getByRole("button", { name: P.upload })).toHaveProperty("disabled", true);
  });

  it("lists Profile first in the account navigation", async () => {
    api(ME);
    await renderRouteWithCache(PATH, lastStubRoutes(), { locale: "zh" });
    const links = screen
      .getAllByRole("link")
      // the path line's `account` link is not part of the navigation
      .filter(
        (a) =>
          a.getAttribute("href")?.startsWith("/account/") &&
          a.closest(".cb-pageheader-path") === null,
      );
    expect(links[0]?.textContent).toBe(zh.connections.nav.profile);
    expect(links[0]?.getAttribute("href")).toBe("/account/profile");
  });

  it("a personal settings page is first-level: no path row (spec §4.2 path rule)", async () => {
    api(ME);
    await renderRouteWithCache(PATH, lastStubRoutes());
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("navigation", { name: "Path" })).toBeNull();
  });
});

describe("Person", () => {
  afterEach(() => cleanup());

  it("a person who left reads the former-member name with the initial", () => {
    renderPage(<Person person={null} size={16} />, { locale: "zh" });
    expect(screen.getByText("已离开的成员")).toBeTruthy();
    expect(document.querySelector('[data-part="avatar"]')?.getAttribute("data-kind")).toBe(
      "initial",
    );
  });

  it("the viewer reads the you label and keeps their avatar", () => {
    const person = { id: "a1", name: "Grant", avatarUrl: "/api/v1/accounts/a1/avatar?v=abc" };
    renderPage(<Person person={person} size={24} viewerId="a1" />, { locale: "zh" });
    expect(screen.getByText("你")).toBeTruthy();
    expect(document.querySelector('[data-part="avatar"][data-kind="image"]')).not.toBeNull();
  });

  it("another person keeps their name", () => {
    const person = { id: "a2", name: "Mia", avatarUrl: null };
    renderPage(<Person person={person} size={16} viewerId="a1" secondary="admin" />);
    expect(screen.getByText("Mia")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
  });
});
