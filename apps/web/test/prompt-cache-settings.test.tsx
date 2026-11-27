import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/**
 * Prompt cache on both settings pages (idle compaction spec §6.4): the platform's long-cache switch
 * on /admin/settings, and the organization's override with the "follow the platform" state on
 * /settings/organization.
 */

const T = en.promptCache;
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const COMPACTION = {
  enabled: true,
  threshold: 0.9,
  keepRecentTurns: 4,
  reserveTokens: 12_000,
  maxOutputTokens: 20_000,
};

const deployment = (longTtl: boolean) => ({
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
  promptCache: { longTtl },
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
  promptCache: { longTtl: false },
};

const adminRoutes = () =>
  stubApi({
    "GET /api/v1/admin/platform/icons": () => json(200, { icons: [] }),
    "GET /api/v1/platform/theme": () => json(200, null),
    "GET /api/v1/admin/settings": () => json(200, ADMIN_SETTINGS),
    "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
    "GET /api/v1/admin/login-sources": () => json(200, { items: [] }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "PUT /api/v1/admin/settings": (c: Call) =>
      json(200, { ...ADMIN_SETTINGS, ...(bodyOf(c) as Record<string, unknown>) }),
  });

const orgRoutes = (settings: Record<string, unknown>, platformLongTtl: boolean) =>
  stubApi({
    "GET /api/v1/orgs/o1/settings": () =>
      json(200, {
        settings,
        deployment: deployment(platformLongTtl),
        effectiveNetwork: { mode: "open", hosts: [] },
      }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "GET /api/v1/orgs/o1/network-allowances": () => json(200, { allowances: [] }),
    "PATCH /api/v1/orgs/o1/settings": (c: Call) =>
      json(200, {
        settings: { ...settings, ...(bodyOf(c) as Record<string, unknown>) },
        deployment: deployment(platformLongTtl),
        effectiveNetwork: { mode: "open", hosts: [] },
      }),
  });

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;
const switchIn = (section: HTMLElement) =>
  within(section).getByRole("switch", { name: T.longTtl }) as HTMLButtonElement;
const isOn = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

beforeEach(() => resetNavigation());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("prompt cache settings", () => {
  it("platform: off by default, with the hint and no mention of idle compaction", async () => {
    resetNavigation("/admin/settings");
    adminRoutes();
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(T.title);
    expect(isOn(switchIn(section))).toBe(false);
    expect(within(section).getByText(T.longTtlHint)).toBeTruthy();
    expect(T.longTtlHint).toBe(
      "Requests use the model's cache tier of at least 30 minutes (such as 1 hour); cache writes are billed at the long tier's price (Anthropic about 2× the input price instead of 1.25×).",
    );
    for (const text of [section.textContent ?? "", T.longTtlHint, zh.promptCache.longTtlHint]) {
      expect(text).not.toMatch(/idle|空闲/i);
    }
    expect(zh.promptCache.title).toBe("提示缓存");
    expect(zh.promptCache.longTtl).toBe("长提示缓存");
  });

  it("platform: toggling saves promptCache and refreshes the cached org settings", async () => {
    resetNavigation("/admin/settings");
    const calls = adminRoutes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").orgSettings(), { settings: {} });
    const section = await sectionOf(T.title);
    const user = userEvent.setup();
    await user.click(switchIn(section));
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      promptCache: { longTtl: true },
    });
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").orgSettings())?.isInvalidated).toBe(true),
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("org: follows the platform value until the checkbox is turned off; save sends the override", async () => {
    resetNavigation("/settings/organization");
    const calls = orgRoutes({ toolSearch: "on" }, true);
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const follow = within(section).getByRole("checkbox", { name: T.follow }) as HTMLInputElement;
    expect(follow.checked).toBe(true);
    expect(isOn(switchIn(section))).toBe(true);
    expect(switchIn(section).disabled).toBe(true);

    const user = userEvent.setup();
    await user.click(follow);
    expect(switchIn(section).disabled).toBe(false);
    await user.click(switchIn(section));
    expect(isOn(switchIn(section))).toBe(false);
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      promptCache: { longTtl: false },
    });
  });

  it("org: an existing override wins; checking follow sends null", async () => {
    resetNavigation("/settings/organization");
    const calls = orgRoutes({ toolSearch: "on", promptCache: { longTtl: true } }, false);
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const follow = within(section).getByRole("checkbox", { name: T.follow }) as HTMLInputElement;
    expect(follow.checked).toBe(false);
    expect(isOn(switchIn(section))).toBe(true);
    const user = userEvent.setup();
    await user.click(follow);
    expect(isOn(switchIn(section))).toBe(false);
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ promptCache: null });
  });

  it("org: a member sees the designed read-only state", async () => {
    resetNavigation("/settings/organization");
    orgRoutes({ toolSearch: "on", promptCache: { longTtl: true } }, false);
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { me: MEMBER });
    const section = await sectionOf(T.title);
    expect(isOn(switchIn(section))).toBe(true);
    expect(switchIn(section).disabled).toBe(true);
    expect(
      (within(section).getByRole("checkbox", { name: T.follow }) as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
