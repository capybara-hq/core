// The three account tables (grants, identities, notification devices) declare compact rows: at
// 390 the title / trailing roles are drawn and the row action is in the row menu (spec §4, §6.2).
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/** A `matchMedia` for a window `width` px wide (min-/max-width features only). */
const mediaFor = (width: number) => (q: string) => {
  const features = [...q.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  const matches =
    features.length > 0 &&
    features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n)));
  return { matches, media: q, addEventListener: () => {}, removeEventListener: () => {} };
};

const O = "/api/v1/orgs/o1";
const GRANT = {
  agentId: "ag1",
  agentName: "Helper",
  toolKey: "Bash",
  createdAt: "2026-11-01T08:00:00Z",
};
const IDENTITY = {
  source: "fake-im:t1",
  externalId: "u-alice",
  email: "alice@corp.example",
  emailVerified: true,
  displayName: "Alice Wong",
  avatarUrl: null,
  linkedVia: "bind",
  createdAt: "2026-11-01T08:00:00Z",
};
const REG = {
  id: "r2",
  platform: "ios",
  appId: "com.example.app",
  provider: "push-apns",
  deviceName: "Phone r2",
  locale: "en",
  createdAt: "2026-11-01T08:00:00.000Z",
  lastSeenAt: "2026-11-20T08:00:00.000Z",
  current: false,
};

beforeEach(() => vi.stubGlobal("matchMedia", mediaFor(390)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The compact table of the page: grouped rows, no wide `<table>` header. */
const compact = () => {
  const el = document.querySelector('[data-part="table-compact"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
};

describe("account tables at 390", () => {
  it("/account/grants: title = the tool, revoke in the row menu", async () => {
    resetNavigation("/account/grants");
    const calls = stubApi({
      [`GET ${O}/me/tool-grants`]: () => json(200, { grants: [GRANT] }),
      [`DELETE ${O}/me/tool-grants/ag1/Bash`]: () => noContent(),
    });
    await renderRouteWithCache("/account/grants", lastStubRoutes(), { locale: "en", me: ME });
    const table = await vi.waitFor(compact);
    expect(within(table).getByText("Helper")).toBeTruthy();
    expect(within(table).queryByText("Bash", { selector: "[data-part='cell']" })).toBeNull();
    await userEvent.setup().click(within(table).getByRole("button", { name: /Row actions/ }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.connections.grants.revoke }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/ag1/Bash"))).toBe(true),
    );
  });

  it("/account/identities: title = the identity, unlink in the row menu", async () => {
    resetNavigation("/account/identities");
    stubApi({
      "GET /api/v1/me/identities": () => json(200, { identities: [IDENTITY] }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    await renderRouteWithCache("/account/identities", lastStubRoutes(), { locale: "en", me: ME });
    const table = await vi.waitFor(compact);
    expect(within(table).getByText("Alice Wong")).toBeTruthy();
    expect(within(table).queryByText("u-alice")).toBeNull();
    await userEvent.setup().click(within(table).getByRole("button", { name: /Row actions/ }));
    expect(screen.getByRole("button", { name: en.identities.unlink })).toBeTruthy();
  });

  it("/account/notifications: title = the device, remove in the row menu", async () => {
    resetNavigation("/account/notifications");
    const calls = stubApi({
      "GET /api/v1/me/push-registrations": () => json(200, { items: [REG] }),
      "GET /api/v1/me/push-preferences": () =>
        json(200, { waiting: true, replies: true, tasks: true, schedules: true }),
      "DELETE /api/v1/me/push-registrations/r2": () => noContent(),
    });
    await renderRouteWithCache("/account/notifications", lastStubRoutes(), {
      locale: "en",
      me: ME,
    });
    const table = await vi.waitFor(compact);
    expect(within(table).getByText("Phone r2")).toBeTruthy();
    expect(within(table).queryByRole("button", { name: /Remove/ })).toBeNull();
    await userEvent.setup().click(within(table).getByRole("button", { name: /Row actions/ }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.notifications.devices.remove }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
