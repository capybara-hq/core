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
 * 沙箱级别 on the admin settings page (sandbox dev tiers spec §4.1): the platform's highest and
 * default level and the unsandboxed switch; a field the startup config sets is read-only with its
 * source; raising the highest level to 开放 asks first.
 */

const T = en.admin.settings.sandboxTiers;
const L = en.devices.tier;

const TIERS = {
  max: "dev",
  default: "dev",
  allowUnsandboxed: true,
  sources: { max: "default", default: "default", allowUnsandboxed: "default" },
};

const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
  sandboxTiers: TIERS,
};

const routes = (tiers: Record<string, unknown> = TIERS) =>
  stubApi({
    "GET /api/v1/admin/settings": () => json(200, { ...SETTINGS, sandboxTiers: tiers }),
    "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "PUT /api/v1/admin/settings": (c: Call) =>
      json(200, {
        ...SETTINGS,
        sandboxTiers: {
          ...tiers,
          ...(bodyOf(c) as { sandboxTiers: object }).sandboxTiers,
        },
      }),
  });

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

beforeEach(() => resetNavigation("/admin/settings"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("沙箱级别 on /admin/settings", () => {
  it("raising the highest level to open asks first, then saves it and invalidates the orgs' settings", async () => {
    const calls = routes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").orgSettings(), { settings: {} });
    client.setQueryData(keys.org("o1").devices(), { devices: [] });
    const section = await sectionOf(T.title);
    const user = userEvent.setup();
    // cancelling the confirm keeps the saved level
    await user.click(within(section).getByRole("radio", { name: new RegExp(L.open) }));
    const dialog = await screen.findByRole("dialog", { name: T.openConfirmTitle });
    expect(within(dialog).getByText(T.openConfirmBody)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: T.cancel }));
    expect(
      (within(section).getByRole("radio", { name: new RegExp(L.dev) }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: en.admin.settings.save })).toBeTruthy();
    // confirming sets it
    await user.click(within(section).getByRole("radio", { name: new RegExp(L.open) }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: T.openConfirmSubmit,
      }),
    );
    expect(
      (within(section).getByRole("radio", { name: new RegExp(L.open) }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await user.click(within(section).getByRole("switch", { name: T.allowUnsandboxed }));
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      sandboxTiers: { max: "open", allowUnsandboxed: false },
    });
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").orgSettings())?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(keys.org("o1").devices())?.isInvalidated).toBe(true);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("lowering the highest level brings the default down with it; no confirm", async () => {
    const calls = routes({ ...TIERS, max: "open", default: "open" });
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(T.title);
    const user = userEvent.setup();
    await user.click(within(section).getByRole("radio", { name: new RegExp(L.strict) }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // the default select offers only levels at most the highest, and shows the lowered one
    const select = within(section).getByRole("combobox", { name: T.default });
    expect(select.textContent).toContain(L.strict);
    await user.click(select);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([L.strict]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      sandboxTiers: { max: "strict", default: "strict" },
    });
  });

  it("a field set in the startup config is read-only with its source (zh)", async () => {
    routes({
      ...TIERS,
      max: "strict",
      default: "strict",
      sources: { max: "env", default: "default", allowUnsandboxed: "file" },
    });
    await renderRouteWithCache("/admin/settings", lastStubRoutes(), { locale: "zh" });
    const z = zh.admin.settings.sandboxTiers;
    const section = await sectionOf(z.title);
    for (const radio of within(section).getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
    expect(within(section).getByText("来自环境变量（只读） · sandbox.tiers.max")).toBeTruthy();
    expect(within(section).getByRole("switch", { name: z.allowUnsandboxed })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(section).getByText("来自配置文件（只读） · sandbox.tiers.allowUnsandboxed"),
    ).toBeTruthy();
    // the default stays editable
    expect(within(section).getByRole("combobox", { name: z.default })).toHaveProperty(
      "disabled",
      false,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
