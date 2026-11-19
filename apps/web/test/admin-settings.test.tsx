import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { cdnOriginOf, isCdnOrigin } from "../src/lib/admin";
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
 * Full access on the admin settings page (`devicesFullAccess`): one control, allowed or off, the
 * source line (env / file / nacos / db / default; a startup-config value is read-only), and a save
 * that invalidates every org's settings and devices. A signed-in super admin may set it either
 * way; only an API token or the Platform tool may narrow alone (a kernel rule, tested there).
 */

const A = en.admin.settings.fullAccess;

const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
  devicesFullAccess: { permission: "allowed", source: "default" },
};

type Mode = { permission: "allowed" | "off"; source: "env" | "file" | "nacos" | "db" | "default" };

const routeMap = (full: Mode = SETTINGS.devicesFullAccess as Mode) => ({
  "GET /api/v1/admin/platform/icons": () => json(200, { icons: [] }),
  "GET /api/v1/admin/settings": () => json(200, { ...SETTINGS, devicesFullAccess: full }),
  "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
  "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
  "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
  "PUT /api/v1/admin/settings": (c: Call) => {
    const body = bodyOf(c) as { devicesFullAccess?: { permission?: string } };
    return json(200, {
      ...SETTINGS,
      devicesFullAccess: {
        permission: body.devicesFullAccess?.permission ?? full.permission,
        source: "db",
      },
    });
  },
});

const routes = (full: Mode = SETTINGS.devicesFullAccess as Mode) => stubApi(routeMap(full));

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

beforeEach(() => resetNavigation("/admin/settings"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Full access on /admin/settings", () => {
  it("turning it off saves devicesFullAccess and invalidates every org's settings and devices", async () => {
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
      devicesFullAccess: { permission: "off" },
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
      routes({ permission: locked ? "off" : "allowed", source });
      await renderRouteWithCache("/admin/settings", lastStubRoutes());
      const section = await sectionOf(A.title);
      for (const radio of within(section).getAllByRole("radio")) {
        expect((radio as HTMLInputElement).disabled).toBe(locked);
      }
      const expected = locked
        ? `${A.sources[source]} · devices.fullAccess`
        : `Source: ${A.sources[source]}`;
      expect(within(section).getByText(expected)).toBeTruthy();
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it("a startup-config value is read-only with its source in Chinese too", async () => {
    routes({ permission: "off", source: "file" });
    await renderRouteWithCache("/admin/settings", lastStubRoutes(), { locale: "zh" });
    const z = zh.admin.settings.fullAccess;
    const section = await sectionOf(z.title);
    for (const radio of within(section).getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
    expect(within(section).getByText(`${z.sources.file} · devices.fullAccess`)).toBeTruthy();
  });

  it("a signed-in super admin may raise it: the page sends permission allowed", async () => {
    const calls = routes({ permission: "off", source: "db" });
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
      devicesFullAccess: { permission: "allowed" },
    });
  });
});

describe("External sharing on /admin/settings", () => {
  const S = en.admin.settings.sharing;
  type Src = "env" | "file" | "nacos" | "db" | "default";
  const stubSharing = (source: Src = "default") =>
    stubApi({
      ...routeMap(),
      "GET /api/v1/admin/platform/icons": () => json(200, { icons: [] }),
      "GET /api/v1/admin/settings": () =>
        json(200, {
          ...SETTINGS,
          externalSharing: { value: "deny", source },
          shareMaxExpiryDays: { value: 30, source },
          htmlRenderCdnAllowlist: ["https://unpkg.com"],
        }),
      "PUT /api/v1/admin/settings": (c: Call) =>
        json(200, { ...SETTINGS, ...(bodyOf(c) as object) }),
    });

  it("saves the switch, the maximum and the whole allowlist", async () => {
    const calls = stubSharing();
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(S.title);
    const user = userEvent.setup();
    await user.click(within(section).getByRole("switch", { name: S.external }));
    const days = within(section).getByRole("spinbutton", { name: S.maxExpiryDays });
    await user.clear(days);
    await user.type(days, "7");
    const list = within(section).getByRole("textbox", { name: S.cdnAllowlist });
    await user.type(list, "{Enter}HTTPS://CDN.Example.com:8443");
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      externalSharing: "allow",
      shareMaxExpiryDays: 7,
      htmlRenderCdnAllowlist: ["https://unpkg.com", "https://cdn.example.com:8443"],
    });
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an allowlist entry is checked trimmed and lower-cased, as it is sent", () => {
    expect(isCdnOrigin(" HTTPS://Cdn.Example.COM:8443 ")).toBe(true);
    expect(cdnOriginOf(" HTTPS://Cdn.Example.COM ")).toBe("https://cdn.example.com");
    expect(isCdnOrigin("HTTP://cdn.example.com")).toBe(false);
  });

  it("the allowlist editor rejects http:// and a path, and blocks saving", async () => {
    const calls = stubSharing();
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(S.title);
    const user = userEvent.setup();
    const list = within(section).getByRole("textbox", { name: S.cdnAllowlist });
    await user.type(list, "{Enter}http://insecure.example.com");
    expect(
      within(section).getByText(S.invalidOrigin.replace("{origin}", "http://insecure.example.com")),
    ).toBeTruthy();
    const save = screen.getByRole("button", { name: en.admin.settings.save });
    expect(save).toHaveProperty("disabled", true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it.each(["env", "file", "nacos"] as const)("a %s source is read-only", async (source) => {
    stubSharing(source);
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(S.title);
    expect(within(section).getByRole("switch", { name: S.external })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(section).getByRole("spinbutton", { name: S.maxExpiryDays })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(section).getByText(/sharing\.external/)).toBeTruthy();
  });
});
