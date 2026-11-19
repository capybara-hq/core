import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/**
 * Prompt suggestions on both settings pages (prompt suggestions spec §6): the platform switch on
 * /admin/settings, and the organization's switch on /settings/organization, disabled with
 * "Turned off by the platform" while the platform has it off.
 */

const T = en.promptSuggestions;
const COMPACTION = {
  enabled: true,
  threshold: 0.9,
  keepRecentTurns: 4,
  reserveTokens: 12_000,
  maxOutputTokens: 20_000,
};

const deployment = (promptSuggestions: "on" | "off") => ({
  outsideSandbox: { permission: "allowed", source: "default" },
  deviceNetwork: {
    default: "open",
    ceiling: "open",
    sources: { default: "default", ceiling: "default" },
    allowHosts: [] as string[],
    orgHosts: "extend" as const,
    off: false,
  },
  compaction: COMPACTION,
  promptSuggestions,
});

const ADMIN_SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
  compaction: COMPACTION,
  promptSuggestions: "on",
};

const adminRoutes = () =>
  stubApi({
    "GET /api/v1/admin/settings": () => json(200, ADMIN_SETTINGS),
    "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "PUT /api/v1/admin/settings": (c: Call) =>
      json(200, { ...ADMIN_SETTINGS, ...(bodyOf(c) as Record<string, unknown>) }),
  });

const orgRoutes = (settings: Record<string, unknown>, platform: "on" | "off") =>
  stubApi({
    "GET /api/v1/orgs/o1/settings": () =>
      json(200, {
        settings,
        deployment: deployment(platform),
        effectiveNetwork: { mode: "open", hosts: [] },
      }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "GET /api/v1/orgs/o1/network-allowances": () => json(200, { allowances: [] }),
    "PATCH /api/v1/orgs/o1/settings": (c: Call) =>
      json(200, {
        settings: { ...settings, ...(bodyOf(c) as Record<string, unknown>) },
        deployment: deployment(platform),
        effectiveNetwork: { mode: "open", hosts: [] },
      }),
  });

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;
const switchIn = (section: HTMLElement, name: string) =>
  within(section).getByRole("switch", { name }) as HTMLButtonElement;
const isOn = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

beforeEach(() => resetNavigation());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("输入建议 settings", () => {
  it("platform: turning the switch off writes promptSuggestions and refreshes org settings", async () => {
    resetNavigation("/admin/settings");
    const calls = adminRoutes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").orgSettings(), { settings: {} });
    const section = await sectionOf(T.title);
    expect(within(section).getByText(T.description)).toBeTruthy();
    const sw = switchIn(section, T.title);
    expect(isOn(sw)).toBe(true);
    const user = userEvent.setup();
    await user.click(sw);
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ promptSuggestions: "off" });
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").orgSettings())?.isInvalidated).toBe(true),
    );
  });

  it("org: on by default; turning it off sends off, turning it back on clears it", async () => {
    resetNavigation("/settings/organization");
    const calls = orgRoutes({ toolSearch: "on" }, "on");
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const sw = switchIn(section, T.title);
    expect(isOn(sw)).toBe(true);
    expect(sw.disabled).toBe(false);
    const user = userEvent.setup();
    await user.click(sw);
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ promptSuggestions: "off" });
  });

  it("org: a stored off turned back on sends null (follow the platform)", async () => {
    resetNavigation("/settings/organization");
    const calls = orgRoutes({ toolSearch: "on", promptSuggestions: "off" }, "on");
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const sw = switchIn(section, T.title);
    expect(isOn(sw)).toBe(false);
    const user = userEvent.setup();
    await user.click(sw);
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ promptSuggestions: null });
  });

  it("org: the switch is off and disabled with a note while the platform has it off", async () => {
    resetNavigation("/settings/organization");
    orgRoutes({ toolSearch: "on" }, "off");
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const sw = switchIn(section, T.title);
    expect(isOn(sw)).toBe(false);
    expect(sw.disabled).toBe(true);
    expect(within(section).getByText(T.platformOff)).toBeTruthy();
  });

  it("the Chinese copy", () => {
    expect(zh.promptSuggestions.title).toBe("输入建议");
    expect(zh.promptSuggestions.platformOff).toBe("平台已关闭");
  });
});
