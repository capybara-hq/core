import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { cardMenuLabels, findCard, footControls, MORE } from "./support/cards";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * Every action of a card stays reachable on the object's detail page (responsive spec §2.4, D3):
 * on a phone a card's ⋯ menu is a sheet, so the detail page must offer the same actions.
 */
const T = "2026-10-19T12:00:00.000Z";
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const summary = (over: Record<string, unknown>) => ({
  slug: "fixture",
  connector: "mcp",
  endpoint: { url: "http://127.0.0.1:9/mcp" },
  status: "active",
  git: null,
  gitPushPolicy: "ask",
  createdAt: T,
  updatedAt: T,
  ...over,
});
const AUTH = {
  oauth: { type: "oauth_code", ownership: "personal", discovery: "manual", client: "manual" },
  bearer: { type: "bearer", ownership: "personal" },
};

beforeEach(() => resetNavigation("/connectors"));
afterEach(cleanup);

describe("connector card actions are on the connector's page", () => {
  it.each([
    ["c-slack", "Slack", AUTH.oauth],
    ["c-api", "Docs API", AUTH.bearer],
  ])("%s: the connected card's button and ⋯ items are on the 凭据 tab", async (id, name, auth) => {
    const connector = summary({ id, name, auth });
    const read = {
      connector: {
        ...connector,
        tools: [],
        credential: { ownership: "personal", status: "connected" },
      },
    };
    stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [connector] }),
      [`GET /api/v1/orgs/o1/connectors/${id}`]: () => json(200, read),
      "GET /api/v1/orgs/o1/components?kind=connector_template": () => json(200, { components: [] }),
    });
    await renderRouteWithCache("/connectors", lastStubRoutes(), { me: MEMBER });
    const card = await findCard(en.connectors.title, name);
    await within(card).findByText(en.connections.connected);
    await vi.waitFor(() => expect(footControls(card)).toContain(MORE.en));
    const onCard = [...footControls(card).slice(0, 1), ...(await cardMenuLabels(card))];
    expect(onCard.length).toBeGreaterThan(1);
    cleanup();
    resetNavigation(`/connectors/${id}`);
    await renderRouteWithCache(`/connectors/${id}?tab=credentials`, lastStubRoutes(), {
      me: MEMBER,
    });
    await screen.findByText(en.connectors.credential.personalTitle);
    for (const label of onCard) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });
});

describe("device cards carry no actions beyond opening the device", () => {
  it("a device card has no ⋯ menu", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/devices": () =>
        json(200, {
          items: [],
          defaultId: null,
          lastUsedId: null,
          providers: [],
          defaultProvider: null,
        }),
    });
    await renderRouteWithCache("/devices", lastStubRoutes());
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});
