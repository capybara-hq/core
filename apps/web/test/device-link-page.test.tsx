// The device confirmation page `/devices/link` (environments spec §6.2, §13.3):
// `capybara-device login` opens `/devices/link?code=XXXX-XXXX`; the signed-in person compares the
// code with the terminal, picks the org, the dial-in provider and a new or existing device of it, reads the disclosure
// and confirms or denies.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderAuthRouteWithCache, renderRouteEmptyCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

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

const CODE = "BCDF-GHJK";
const PAGE = `/devices/link?code=${CODE}`;
const PENDING = `/api/v1/device/pending/${CODE}`;
const D = en.deviceLink;
const msgs = { zh, en } as const;

const MACHINE = { name: "grant-mbp", os: "darwin", arch: "arm64", programVersion: "0.1.0" };
const PROVIDERS_URL = (org: string) =>
  `/api/v1/device/providers?orgId=${org}&userCode=${encodeURIComponent(CODE)}`;
/** One dial-in provider on in the org, with one of the person's devices of it. */
const SSH = {
  plugin: "device-ssh",
  displayName: { en: "SSH devices", zh: "SSH 设备" },
  devices: [{ id: "d1", name: "Old laptop" }],
};
const LOCAL = {
  plugin: "@local",
  displayName: { en: "Local device", zh: "本地设备" },
  devices: [{ id: "d7", name: "Desk" }],
};
const providers =
  (...items: unknown[]) =>
  () =>
    json(200, { providers: items });
const ROUTES: Routes = {
  "GET /api/v1/me": () => json(200, ME),
  [`GET ${PENDING}`]: () => json(200, { machine: MACHINE, expiresAt: "2026-11-08T08:10:00.000Z" }),
  [`GET ${PROVIDERS_URL("o1")}`]: providers(SSH),
};
const unauthenticated = () => json(401, { error: { code: "auth.required", message: "x" } });
/** The label of the option a select shows now. */
const chosen = (select: HTMLElement) =>
  select.querySelector('[data-current="true"]')?.textContent ?? null;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => {
  resetNavigation("/devices/link");
  navigateBrowser.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/devices/link", () => {
  it.each(["zh", "en"] as const)(
    "device page shows the code and the disclosure and confirms into a new device (%s)",
    async (locale) => {
      const m = msgs[locale].deviceLink;
      const calls = stubApi({
        ...ROUTES,
        "POST /api/v1/device/confirm": () => json(200, { deviceId: "d9" }),
      });
      const { container } = await renderAuthRouteWithCache(PAGE, lastStubRoutes(), { locale });
      expect(container.querySelector('[data-template="AuthPage"]')).not.toBeNull();
      expect(await screen.findByText(CODE)).toBeTruthy();
      expect(screen.getByText("grant-mbp")).toBeTruthy();
      expect(screen.getByText("macOS · arm64")).toBeTruthy();
      expect(screen.getByText("v0.1.0")).toBeTruthy();
      expect(within(screen.getByRole("note")).getByText(m.disclosure)).toBeTruthy();
      // the new device's name defaults to the machine's
      expect(screen.getByRole("textbox", { name: m.name })).toHaveProperty("value", "grant-mbp");
      // one provider: nothing to choose
      expect(screen.queryByRole("combobox", { name: m.provider })).toBeNull();
      // nothing is sent before the person confirms
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
      const confirm = screen.getByRole("button", { name: m.confirm });
      expect(confirm.getAttribute("data-variant")).toBe("primary");
      await userEvent.setup().click(confirm);
      expect(await screen.findByText(m.doneTitle)).toBeTruthy();
      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/api/v1/device/confirm");
      expect(post?.headers.get("x-capybara-csrf")).toBe("1");
      expect(bodyOf(post)).toEqual({
        userCode: CODE,
        orgId: "o1",
        provider: "device-ssh",
        name: "grant-mbp",
      });
    },
  );

  it("confirming grants no Auto: the body carries no ceiling, the page says so", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d9" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("Confirming does not allow Auto");
    // no control on this page widens the machine
    for (const role of ["checkbox", "radio", "switch", "button"] as const) {
      expect(screen.queryByRole(role, { name: /Auto/ })).toBeNull();
    }
    await userEvent.setup().click(screen.getByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    for (const c of calls.filter((x) => x.method === "POST")) {
      expect(String(c.body)).not.toMatch(/fullAccess|ownerCeiling|confirmWidening|mode/);
    }
  });

  it("org= preselects that org with 新建设备 named after the machine; one click confirms", async () => {
    const me = {
      ...ME,
      memberships: [
        ...ME.memberships,
        { orgId: "o2", slug: "beta", name: "Beta", role: "member" as const },
      ],
    };
    const calls = stubApi({
      ...ROUTES,
      "GET /api/v1/me": () => json(200, me),
      [`GET ${PROVIDERS_URL("o2")}`]: providers(SSH),
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d9" }),
    });
    await renderAuthRouteWithCache(`${PAGE}&org=o2`, lastStubRoutes());
    await screen.findByRole("combobox", { name: D.org });
    await vi.waitFor(() => expect(calls.some((c) => c.url === PROVIDERS_URL("o2"))).toBe(true));
    expect(chosen(screen.getByRole("combobox", { name: D.device }))).toBe(D.newDevice);
    expect(screen.getByRole("textbox", { name: D.name })).toHaveProperty("value", "grant-mbp");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      userCode: CODE,
      orgId: "o2",
      provider: "device-ssh",
      name: "grant-mbp",
    });
  });

  it("an org= the person is not in is ignored", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d9" }),
    });
    await renderAuthRouteWithCache(`${PAGE}&org=zz`, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ orgId: "o1" });
  });

  it("confirms into an existing device of the provider", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d1" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const user = userEvent.setup();
    const target = await screen.findByRole("combobox", { name: D.device });
    await user.click(target);
    await user.click(await screen.findByRole("option", { name: "Old laptop" }));
    // an existing device keeps its own name: no name field
    expect(screen.queryByRole("textbox", { name: D.name })).toBeNull();
    await user.click(screen.getByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      userCode: CODE,
      orgId: "o1",
      provider: "device-ssh",
      deviceId: "d1",
    });
    // the device is in the current org: the done state opens its page, a full navigation (the
    // workspace layout's import map runs only in a server-rendered document)
    await user.click(screen.getByRole("button", { name: D.openDevice }));
    expect(navigateBrowser).toHaveBeenCalledWith("/devices/d1");
    expect(router.replace).not.toHaveBeenCalledWith("/devices/d1");
  });

  it("confirming invalidates the org's devices and providers", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d9" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    // the list was read again after the POST (invalidated while the form observed it)
    await vi.waitFor(() => {
      const names = calls.map((c) => `${c.method} ${c.url}`);
      expect(names.slice(names.indexOf("POST /api/v1/device/confirm"))).toContain(
        `GET ${PROVIDERS_URL("o1")}`,
      );
    });
  });

  it("confirm page offers a provider select when two dial-in providers are on", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`GET ${PROVIDERS_URL("o1")}`]: providers(SSH, LOCAL),
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d7" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    const user = userEvent.setup();
    const provider = await screen.findByRole("combobox", { name: D.provider });
    // the first provider's devices
    expect(chosen(provider)).toBe("SSH devices");
    await user.click(screen.getByRole("combobox", { name: D.device }));
    expect(await screen.findByRole("option", { name: "Old laptop" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Desk" })).toBeNull();
    await user.keyboard("{Escape}");
    // another provider: its devices only, and the device choice starts again at a new device
    await user.click(provider);
    await user.click(await screen.findByRole("option", { name: "Local device" }));
    expect(chosen(screen.getByRole("combobox", { name: D.device }))).toBe(D.newDevice);
    await user.click(screen.getByRole("combobox", { name: D.device }));
    expect(await screen.findByRole("option", { name: "Desk" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Old laptop" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Desk" }));
    await user.click(screen.getByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      userCode: CODE,
      orgId: "o1",
      provider: "@local",
      deviceId: "d7",
    });
  });

  it("confirm page hides the provider select with one provider and sends it", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`GET ${PROVIDERS_URL("o1")}`]: providers(LOCAL),
      "POST /api/v1/device/confirm": () => json(200, { deviceId: "d9" }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.doneTitle)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: D.provider })).toBeNull();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ provider: "@local" });
  });

  it("an org with no provider for this machine says so and cannot confirm", async () => {
    stubApi({ ...ROUTES, [`GET ${PROVIDERS_URL("o1")}`]: providers() });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText(D.noProvider)).toBeTruthy();
    expect(screen.getByRole("button", { name: D.confirm })).toHaveProperty("disabled", true);
  });

  it("device page shows the expired state for an unknown code", async () => {
    stubApi({
      ...ROUTES,
      [`GET ${PENDING}`]: () =>
        json(404, { error: { code: "device_sign_in.code_invalid", message: "unknown" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    expect(await screen.findByText(D.invalidTitle)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en.errors.device_sign_in.code_invalid);
    expect(screen.getByText(D.invalidHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: D.confirm })).toBeNull();
  });

  it("a confirm the kernel could not hand over shows the start-over state", async () => {
    stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () =>
        json(503, { error: { code: "device_sign_in.unavailable", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByText(D.invalidTitle)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(en.errors.device_sign_in.unavailable);
  });

  it("a refused confirm (limit reached) stays on the page with the error copy", async () => {
    stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": () =>
        json(409, { error: { code: "device.limit_reached", message: "x" } }),
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      en.errors.device.limit_reached,
    );
    expect(screen.getByRole("button", { name: D.confirm })).toBeTruthy();
  });

  it("deny refuses the code and says so", async () => {
    const calls = stubApi({ ...ROUTES, "POST /api/v1/device/deny": () => noContent() });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.deny }));
    expect(await screen.findByText(D.deniedTitle)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/v1/device/deny");
    expect(bodyOf(post)).toEqual({ userCode: CODE });
  });

  it("a confirm that finds the session gone signs in again, back here", async () => {
    stubApi({
      ...ROUTES,
      "POST /api/v1/device/confirm": unauthenticated,
      "POST /api/v1/auth/refresh": unauthenticated,
    });
    await renderAuthRouteWithCache(PAGE, lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: D.confirm }));
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(PAGE)}`),
    );
  });

  it("without a code the page asks for the one shown in the terminal", async () => {
    stubApi(ROUTES);
    await renderAuthRouteWithCache("/devices/link", lastStubRoutes());
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: D.code });
    const next = screen.getByRole("button", { name: D.continue });
    expect(next).toHaveProperty("disabled", true);
    await user.type(field, " bcdf-ghjk ");
    await user.click(next);
    expect(router.replace).toHaveBeenCalledWith(`/devices/link?code=${CODE}`);
  });

  it("/devices/link: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderAuthRouteWithCache(PAGE, ROUTES);
    expect(screen.getByText(CODE)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/devices/link: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache(PAGE, {
      ...ROUTES,
      [`GET ${PENDING}`]: async (c) => {
        await gate;
        return (ROUTES[`GET ${PENDING}`] as NonNullable<Routes[string]>)(c);
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-template="AuthPage"]')).not.toBeNull(),
    );
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("grant-mbp")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("grant-mbp")).toBeTruthy();
  });
});
