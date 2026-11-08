import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { timeZoneOptions } from "../src/lib/account-preferences";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { optionLabels, pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BASE = "/api/v1/orgs/o1";
const PREFS = "/api/v1/me/preferences";
const msgs = { zh, en } as const;

/** The page's other server reads answer empty. */
const api = (routes: Parameters<typeof stubApi>[0]) =>
  stubApi({
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    ...routes,
  });

describe("/account/preferences: the time zone (run context spec §3.4)", () => {
  beforeEach(() => resetNavigation("/account/preferences"));
  afterEach(() => cleanup());

  it.each(["zh", "en"] as const)(
    "defaults to following the browser; a chosen zone is saved with PUT (%s)",
    async (locale) => {
      const m = msgs[locale].preferences;
      let saved: string | null = null;
      const calls = api({
        [`GET ${PREFS}`]: () => json(200, { timeZone: saved }),
        [`PUT ${PREFS}`]: (call) => {
          saved = (JSON.parse(String(call.body)) as { timeZone: string | null }).timeZone;
          return json(200, { timeZone: saved });
        },
      });
      await renderRouteWithCache("/account/preferences", lastStubRoutes(), { locale });
      expect(await screen.findByRole("heading", { name: m.timeZone.title })).toBeTruthy();
      const select = screen.getByRole("combobox", { name: m.timeZone.label });
      expect(select.textContent).toContain(m.timeZone.follow);
      const user = userEvent.setup();
      const labels = await optionLabels(select, user);
      expect(labels[0]).toBe(m.timeZone.follow);
      expect(labels).toContain("UTC");
      await pickOption(select, "UTC", user);
      await user.click(screen.getByRole("button", { name: m.save }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ timeZone: "UTC" });
    },
  );

  it("choosing 跟随浏览器 again clears the setting", async () => {
    const calls = api({
      [`GET ${PREFS}`]: () => json(200, { timeZone: "Asia/Shanghai" }),
      [`PUT ${PREFS}`]: () => json(200, { timeZone: null }),
    });
    await renderRouteWithCache("/account/preferences", lastStubRoutes(), { locale: "zh" });
    const select = await screen.findByRole("combobox", { name: zh.preferences.timeZone.label });
    expect(select.textContent).toContain("Asia/Shanghai");
    const user = userEvent.setup();
    await pickOption(select, zh.preferences.timeZone.follow, user);
    await user.click(screen.getByRole("button", { name: zh.preferences.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ timeZone: null });
  });

  it("keeps a saved zone the browser does not list as an option", () => {
    const options = timeZoneOptions("Etc/Unlisted");
    expect(options[0]).toEqual({ value: "UTC", label: "UTC" });
    expect(options.at(-1)).toEqual({ value: "Etc/Unlisted", label: "Etc/Unlisted" });
  });
});
