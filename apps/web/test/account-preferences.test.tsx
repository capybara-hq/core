import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { timeZoneOptions } from "../src/lib/account-preferences";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { openSelect, optionOf, pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BASE = "/api/v1/orgs/o1";
const PREFS = "/api/v1/me/preferences";
const msgs = { zh, en } as const;

/** The page's other server reads answer empty. */
const api = (routes: Parameters<typeof stubApi>[0]) =>
  stubApi({
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    [`GET ${BASE}/themes`]: () =>
      json(200, { themes: [], resolved: null, org: { id: null, personal: "allowed" } }),
    "GET /api/v1/platform/theme": () => json(200, null),
    ...routes,
  });

/**
 * The time-zone section, once rendered. The cases query inside it (and find the save button by its
 * text): page-wide role queries walk the 外观 cards and the field's ~420 option labels, and their
 * cost made these cases slow under load.
 */
async function timeZoneSection(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title, { selector: "h1, h2, h3, h4" });
  const section = heading.closest("section");
  if (section === null) throw new Error("the time zone heading is outside a section");
  return section;
}

/** The page's save button (the action row), by its text. */
function saveButton(label: string): HTMLElement {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`no button ${label}`);
  return button;
}

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
      const section = await timeZoneSection(m.timeZone.title);
      const select = within(section).getByRole("combobox", { name: m.timeZone.label });
      expect(select.textContent).toContain(m.timeZone.follow);
      const user = userEvent.setup();
      // one opening of the ~420 options: read the labels, then pick from the same list
      const listbox = await openSelect(select, user);
      const labels = [...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(labels[0]).toBe(m.timeZone.follow);
      expect(labels).toContain("UTC");
      await user.click(optionOf(listbox, "UTC"));
      await user.click(saveButton(m.save));
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
    const section = await timeZoneSection(zh.preferences.timeZone.title);
    const select = within(section).getByRole("combobox", { name: zh.preferences.timeZone.label });
    expect(select.textContent).toContain("Asia/Shanghai");
    const user = userEvent.setup();
    await pickOption(select, zh.preferences.timeZone.follow, user);
    await user.click(saveButton(zh.preferences.save));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ timeZone: null });
  });

  it("keeps a saved zone the browser does not list as an option", () => {
    const options = timeZoneOptions("Etc/Unlisted");
    expect(options[0]).toEqual({ value: "UTC", label: "UTC" });
    expect(options.at(-1)).toEqual({ value: "Etc/Unlisted", label: "Etc/Unlisted" });
  });
});
