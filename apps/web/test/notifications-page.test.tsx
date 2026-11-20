import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const REGS = "/api/v1/me/push-registrations";
const PREFS = "/api/v1/me/push-preferences";
const msgs = { zh, en } as const;

const registration = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  platform: "ios",
  appId: "com.example.app",
  provider: "push-apns",
  deviceName: `Phone ${id}`,
  locale: "en",
  createdAt: "2026-11-01T08:00:00.000Z",
  lastSeenAt: "2026-11-20T08:00:00.000Z",
  current: false,
  ...over,
});

const ALL_ON = { waiting: true, replies: true, tasks: true, schedules: true };

function installPush(permission: "granted" | "denied" | "prompt") {
  const push = {
    status: vi.fn(async () => ({ permission, registrationId: null, tokenChanged: false })),
    register: vi.fn(async () => ({
      platform: "ios",
      appId: "com.example.app",
      provider: "push-apns",
      token: "t1",
    })),
    registered: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
  };
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
    version: 1,
    capabilities: { "push@1": push },
    on: () => () => {},
  };
  return push;
}

describe("/account/notifications", () => {
  beforeEach(() => resetNavigation("/account/notifications"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "capybaraShell");
  });

  it.each(["zh", "en"] as const)(
    "lists the devices, marks this one and removes one with DELETE (%s)",
    async (locale) => {
      const m = msgs[locale].notifications;
      let items = [registration("r1", { current: true }), registration("r2")];
      const calls = stubApi({
        [`GET ${REGS}`]: () => json(200, { items }),
        [`GET ${PREFS}`]: () => json(200, ALL_ON),
        [`DELETE ${REGS}/r2`]: () => {
          items = items.filter((r) => r.id !== "r2");
          return noContent();
        },
      });
      await renderRouteWithCache("/account/notifications", lastStubRoutes(), { locale });
      const table = await screen.findByRole("table", { name: m.devices.title });
      expect(
        within(table).getByText(new RegExp(`Phone r1 · ${m.devices.thisDevice}`)),
      ).toBeTruthy();
      expect(within(table).getByText("Phone r2")).toBeTruthy();
      const user = userEvent.setup();
      await user.click(within(table).getByRole("button", { name: `${m.devices.remove} Phone r2` }));
      await vi.waitFor(() =>
        expect(calls.some((c) => c.method === "DELETE" && c.url === `${REGS}/r2`)).toBe(true),
      );
      // the list is read again: the row is gone
      await vi.waitFor(() => expect(screen.queryByText("Phone r2")).toBeNull());
    },
  );

  it("an empty list shows the empty state", async () => {
    stubApi({
      [`GET ${REGS}`]: () => json(200, { items: [] }),
      [`GET ${PREFS}`]: () => json(200, ALL_ON),
    });
    await renderRouteWithCache("/account/notifications", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText(en.notifications.devices.empty)).toBeTruthy();
  });

  it("the four switches come from GET and a toggle PUTs only its key", async () => {
    let prefs = { ...ALL_ON, replies: false };
    const calls = stubApi({
      [`GET ${REGS}`]: () => json(200, { items: [] }),
      [`GET ${PREFS}`]: () => json(200, prefs),
      [`PUT ${PREFS}`]: (call) => {
        prefs = { ...prefs, ...(bodyOf(call) as object) };
        return json(200, prefs);
      },
    });
    await renderRouteWithCache("/account/notifications", lastStubRoutes(), { locale: "zh" });
    const m = zh.notifications.categories;
    const list = await screen.findByRole("list", { name: m.title });
    const switchOf = (name: string) => within(list).getByRole("switch", { name });
    expect(switchOf(m.waiting).getAttribute("aria-checked")).toBe("true");
    expect(switchOf(m.replies).getAttribute("aria-checked")).toBe("false");
    expect(switchOf(m.tasks).getAttribute("aria-checked")).toBe("true");
    expect(switchOf(m.schedules).getAttribute("aria-checked")).toBe("true");
    await userEvent.setup().click(switchOf(m.replies));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ replies: true });
    await vi.waitFor(() => expect(switchOf(m.replies).getAttribute("aria-checked")).toBe("true"));
  });

  it("without push@1 there is no 在此设备开启通知 button", async () => {
    stubApi({
      [`GET ${REGS}`]: () => json(200, { items: [] }),
      [`GET ${PREFS}`]: () => json(200, ALL_ON),
    });
    await renderRouteWithCache("/account/notifications", lastStubRoutes(), { locale: "zh" });
    await screen.findByText(zh.notifications.devices.empty);
    expect(screen.queryByRole("button", { name: zh.notifications.devices.enable })).toBeNull();
  });

  it("with push@1 the button registers this device", async () => {
    const push = installPush("prompt");
    const calls = stubApi({
      [`GET ${REGS}`]: () => json(200, { items: [] }),
      [`GET ${PREFS}`]: () => json(200, ALL_ON),
      [`POST ${REGS}`]: () => json(201, { id: "r9" }),
    });
    await renderRouteWithCache("/account/notifications", lastStubRoutes(), { locale: "zh" });
    const button = await screen.findByRole("button", { name: zh.notifications.devices.enable });
    await userEvent.setup().click(button);
    await vi.waitFor(() => expect(push.registered).toHaveBeenCalledWith("r9"));
    expect(calls.some((c) => c.method === "POST" && c.url === REGS)).toBe(true);
    expect(push.register).toHaveBeenCalledOnce();
  });

  it("a denied permission shows the note instead of the button", async () => {
    installPush("denied");
    stubApi({
      [`GET ${REGS}`]: () => json(200, { items: [] }),
      [`GET ${PREFS}`]: () => json(200, ALL_ON),
    });
    await renderRouteWithCache("/account/notifications", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText(en.notifications.devices.denied)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.notifications.devices.enable })).toBeNull();
  });
});
