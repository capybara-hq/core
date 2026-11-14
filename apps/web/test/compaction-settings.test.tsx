import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/**
 * 对话压缩 on both settings pages (context compaction spec §4.8): the platform's defaults on
 * /admin/settings, and the organization's override with the "follow the platform" state on
 * /settings/organization.
 */

const T = en.compaction;
const PLATFORM = {
  enabled: true,
  threshold: 0.9,
  keepRecentTurns: 4,
  reserveTokens: 12_000,
  maxOutputTokens: 20_000,
};

const DEPLOYMENT = {
  autoMode: { mode: "allowed", source: "default" },
  cloudNetwork: { mode: "open", allowHosts: [] as string[] },
  compaction: PLATFORM,
};

const ADMIN_SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
  compaction: PLATFORM,
};

const adminRoutes = () =>
  stubApi({
    "GET /api/v1/admin/settings": () => json(200, ADMIN_SETTINGS),
    "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "PUT /api/v1/admin/settings": (c: Call) => {
      const body = bodyOf(c) as { compaction?: Record<string, unknown> };
      return json(200, {
        ...ADMIN_SETTINGS,
        ...body,
        compaction: { ...PLATFORM, ...body.compaction },
      });
    },
  });

const orgRoutes = (settings: Record<string, unknown>) =>
  stubApi({
    "GET /api/v1/orgs/o1/settings": () => json(200, { settings, deployment: DEPLOYMENT }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "PATCH /api/v1/orgs/o1/settings": (c: Call) =>
      json(200, { settings: bodyOf(c), deployment: DEPLOYMENT }),
  });

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;
const textbox = (section: HTMLElement, label: string) =>
  within(section).getByRole("textbox", { name: label }) as HTMLInputElement;

beforeEach(() => resetNavigation());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("对话压缩 settings", () => {
  it("platform: saves only the changed threshold and refreshes the cached org settings", async () => {
    resetNavigation("/admin/settings");
    const calls = adminRoutes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    // an org's settings carry the platform compaction values the org page follows
    client.setQueryData(keys.org("o1").orgSettings(), { settings: {} });
    const section = await sectionOf(T.title);
    const threshold = textbox(section, T.threshold.label);
    expect(threshold.value).toBe("0.9");
    expect(textbox(section, T.keepRecentTurns.label).value).toBe("4");

    const user = userEvent.setup();
    await user.clear(threshold);
    await user.type(threshold, "0.7");
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      compaction: { threshold: 0.7 },
    });
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").orgSettings())?.isInvalidated).toBe(true),
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("platform: an out-of-range draft is not committed and reverts on blur", async () => {
    resetNavigation("/admin/settings");
    const calls = adminRoutes();
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(T.title);
    const threshold = textbox(section, T.threshold.label);
    const user = userEvent.setup();
    await user.clear(threshold);
    await user.type(threshold, "0.99");
    expect(threshold.value).toBe("0.99");
    await user.tab();
    expect(textbox(section, T.threshold.label).value).toBe("0.9");
    // nothing to save: the page has no pending changes
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(screen.queryByRole("button", { name: en.admin.settings.save })).toBeTruthy();
  });

  it("org: follows the platform (fields read-only) until the checkbox is turned off", async () => {
    resetNavigation("/settings/organization");
    const calls = orgRoutes({ toolSearch: "on" });
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const follow = within(section).getByRole("checkbox", { name: T.follow }) as HTMLInputElement;
    expect(follow.checked).toBe(true);
    expect(textbox(section, T.threshold.label).value).toBe("0.9");
    expect(textbox(section, T.threshold.label).disabled).toBe(true);

    const user = userEvent.setup();
    await user.click(follow);
    expect(follow.checked).toBe(false);
    expect(textbox(section, T.threshold.label).disabled).toBe(false);
    // turning follow off and on again without an edit is no change at all
    await user.click(follow);
    expect(follow.checked).toBe(true);
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await user.click(follow);
    const threshold = textbox(section, T.threshold.label);
    await user.clear(threshold);
    await user.type(threshold, "0.6");
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    // only the field the admin edited: the rest keep following the platform, so a later
    // platform change (such as reserveTokens) still reaches the org
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      compaction: { threshold: 0.6 },
    });
  });

  it("org: an existing override wins and checking follow clears it", async () => {
    resetNavigation("/settings/organization");
    const calls = orgRoutes({ toolSearch: "on", compaction: { threshold: 0.6 } });
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    const section = await sectionOf(T.title);
    const follow = within(section).getByRole("checkbox", { name: T.follow }) as HTMLInputElement;
    expect(follow.checked).toBe(false);
    // the org's threshold wins; the fields it leaves out follow the platform
    expect(textbox(section, T.threshold.label).value).toBe("0.6");
    expect(textbox(section, T.reserveTokens.label).value).toBe("12000");

    const user = userEvent.setup();
    await user.click(follow);
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ compaction: null });
  });
});
