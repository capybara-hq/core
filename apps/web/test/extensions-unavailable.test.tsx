import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const BASE = "/api/v1/orgs/o1";

/** An extension installed on the platform but not loaded: its deployment API key is missing. */
const KEYED = {
  plugin: "keyed-ai",
  version: "1.0.0",
  enabled: false,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [],
  orgConfigSchema: null,
  available: false,
  status: "pending_config",
  reason: "needs_deployment_config",
  provides: ["model-provider@2"],
};

const api = () =>
  stubApi({
    [`GET ${BASE}/extensions`]: () => json(200, { extensions: [KEYED] }),
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
  });

const as = (role: "owner" | "admin" | "member", superAdmin: boolean): Me => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: superAdmin },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => {
  resetNavigation("/extensions");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openSheet() {
  const user = userEvent.setup();
  await user.click(await screen.findByText("keyed-ai", { selector: ".cb-cell-title-name" }));
  return screen.findByRole("dialog", { name: "keyed-ai" });
}

/** Spec §14.2 problem 1 / §14.5 item 4: the org page shows why, and the next step by role. */
describe("/extensions: an unavailable extension shows its reason", () => {
  it.each(["zh", "en"] as const)(
    "the row says unavailable with the reason; the super admin's Sheet links to the admin console (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      api();
      await renderRouteWithCache("/extensions", lastStubRoutes(), {
        locale,
        me: as("owner", true),
      });
      const row = await screen.findByRole("row", { name: /keyed-ai/ });
      const label = m.unavailableWith.replace("{reason}", m.reasons.needs_deployment_config);
      expect(within(row).getByText(label).getAttribute("data-tone")).toBe("warn");
      const sheet = await openSheet();
      expect(within(sheet).getByText(m.unavailableNext.superAdmin)).toBeTruthy();
      expect(within(sheet).getByRole("link", { name: m.openAdmin }).getAttribute("href")).toContain(
        "/admin/extensions/keyed-ai",
      );
    },
  );

  it.each([
    ["admin", "orgAdmin"],
    ["member", "member"],
  ] as const)("a %s gets their step and no admin console link", async (role, key) => {
    const m = en.extensions;
    api();
    await renderRouteWithCache("/extensions", lastStubRoutes(), {
      locale: "en",
      me: as(role, false),
    });
    const sheet = await openSheet();
    expect(within(sheet).getByText(m.unavailableNext[key])).toBeTruthy();
    expect(within(sheet).queryByRole("link", { name: m.openAdmin })).toBeNull();
  });
});

describe("/extensions: plugin icons (maintainer decision 2026-11-08)", () => {
  it.each(["admin", "member"] as const)(
    "a row and its Sheet draw the plugin's icon; a row without one its initial (%s)",
    async (role) => {
      const icon = `${BASE}/catalog/i1/icon?v=1.0.0`;
      stubApi({
        [`GET ${BASE}/extensions`]: () =>
          json(200, {
            extensions: [
              { ...KEYED, icon },
              { ...KEYED, plugin: "plain-ext", icon: null },
            ],
          }),
        [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
        [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
        "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), {
        locale: "en",
        me: as(role, false),
      });
      const row = await screen.findByRole("row", { name: /keyed-ai/ });
      const img = row.querySelector('img[data-part="mark-image"]');
      expect(img?.getAttribute("src")).toBe(icon);
      expect(img?.getAttribute("alt")).toBe("");
      const plain = screen.getByRole("row", { name: /plain-ext/ });
      expect(plain.querySelector(".cb-cell-initial")?.textContent).toBe("P");
      const sheet = await openSheet();
      expect(sheet.querySelector('.cb-sheet-head img[data-part="mark-image"]')).not.toBeNull();
    },
  );
});
