import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
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
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * 自动模式 on the admin settings page (auto mode spec §4.3): one control, allowed or off, the
 * source line (env / file / nacos / db / default; a startup-config value is read-only), and a save
 * that invalidates every org's settings and devices. A signed-in super admin may set it either
 * way; only an API token or the Platform tool may narrow alone (a kernel rule, tested there).
 */

const A = en.admin.settings.autoMode;

const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
  devicesAutoMode: { mode: "allowed", source: "default" },
};

type Mode = { mode: "allowed" | "off"; source: "env" | "file" | "nacos" | "db" | "default" };

const routeMap = (auto: Mode = SETTINGS.devicesAutoMode as Mode) => ({
  "GET /api/v1/admin/settings": () => json(200, { ...SETTINGS, devicesAutoMode: auto }),
  "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
  "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
  "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
  "PUT /api/v1/admin/settings": (c: Call) => {
    const body = bodyOf(c) as { devicesAutoMode?: { mode?: string } };
    return json(200, {
      ...SETTINGS,
      devicesAutoMode: { mode: body.devicesAutoMode?.mode ?? auto.mode, source: "db" },
    });
  },
});

const routes = (auto: Mode = SETTINGS.devicesAutoMode as Mode) => stubApi(routeMap(auto));

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

beforeEach(() => resetNavigation("/admin/settings"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("自动模式 on /admin/settings", () => {
  it("turning it off saves devicesAutoMode and invalidates every org's settings and devices", async () => {
    const calls = routes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").orgSettings(), { settings: {} });
    client.setQueryData(keys.org("o1").devices(), { devices: [] });
    const section = await sectionOf(A.title);
    const user = userEvent.setup();
    expect(
      within(section).getByRole("radio", { name: new RegExp(`^${A.allowed}`) }),
    ).toHaveProperty("checked", true);
    expect(within(section).getByText(`Source: ${A.sources.default}`)).toBeTruthy();
    await user.click(within(section).getByRole("radio", { name: new RegExp(`^${A.off}`) }));
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      devicesAutoMode: { mode: "off" },
    });
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").orgSettings())?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(keys.org("o1").devices())?.isInvalidated).toBe(true);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it.each(["env", "file", "nacos", "db", "default"] as const)(
    "the source line names where the switch comes from (%s)",
    async (source) => {
      const locked = source === "env" || source === "file" || source === "nacos";
      routes({ mode: locked ? "off" : "allowed", source });
      await renderRouteWithCache("/admin/settings", lastStubRoutes());
      const section = await sectionOf(A.title);
      for (const radio of within(section).getAllByRole("radio")) {
        expect((radio as HTMLInputElement).disabled).toBe(locked);
      }
      const expected = locked
        ? `${A.sources[source]} · devices.autoMode`
        : `Source: ${A.sources[source]}`;
      expect(within(section).getByText(expected)).toBeTruthy();
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it("a startup-config value is read-only with its source in Chinese too", async () => {
    routes({ mode: "off", source: "file" });
    await renderRouteWithCache("/admin/settings", lastStubRoutes(), { locale: "zh" });
    const z = zh.admin.settings.autoMode;
    const section = await sectionOf(z.title);
    for (const radio of within(section).getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
    expect(within(section).getByText(`${z.sources.file} · devices.autoMode`)).toBeTruthy();
  });

  it("a signed-in super admin may raise it: the page sends mode allowed", async () => {
    const calls = routes({ mode: "off", source: "db" });
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(A.title);
    const user = userEvent.setup();
    expect(within(section).getByRole("radio", { name: new RegExp(`^${A.off}`) })).toHaveProperty(
      "checked",
      true,
    );
    // The narrow-only rule (an API token or the Platform tool may only turn it off) lives in the
    // kernel; a session PUT may raise, and this asserts the real write the page makes.
    await user.click(within(section).getByRole("radio", { name: new RegExp(`^${A.allowed}`) }));
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      devicesAutoMode: { mode: "allowed" },
    });
  });
});
