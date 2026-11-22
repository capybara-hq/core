import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { cardMenuLabels, findCard, footControls, MORE } from "./support/cards";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { stubWindowWidth } from "./support/width";

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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("connector card actions are on the connector's page", () => {
  it.each([
    ["c-slack", "Slack", AUTH.oauth, "connected"],
    ["c-api", "Docs API", AUTH.bearer, "connected"],
    ["c-slack2", "Slack two", AUTH.oauth, "missing"],
  ])(
    "%s: the %s card's button and ⋯ items are on the 凭据 tab (%s)",
    async (id, name, auth, status) => {
      const connector = summary({ id, name, auth });
      const read = {
        connector: {
          ...connector,
          tools: [],
          credential: { ownership: "personal", status },
        },
      };
      stubApi({
        "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [connector] }),
        [`GET /api/v1/orgs/o1/connectors/${id}`]: () => json(200, read),
        "GET /api/v1/orgs/o1/components?kind=connector_template": () =>
          json(200, { components: [] }),
      });
      await renderRouteWithCache("/connectors", lastStubRoutes(), { me: MEMBER });
      const card = await findCard(en.connectors.title, name);
      const shown = status === "connected" ? en.connections.connected : en.connections.missing;
      await within(card).findByText(shown);
      // not connected: the one button (connect); connected: the primary and the ⋯ items
      await vi.waitFor(() =>
        expect(footControls(card)).toContain(
          status === "connected" ? MORE.en : en.connections.oauthConnect,
        ),
      );
      const onCard = [
        ...footControls(card).filter((l) => l !== MORE.en),
        ...(status === "connected" ? await cardMenuLabels(card) : []),
      ];
      expect(onCard.length).toBeGreaterThan(status === "connected" ? 1 : 0);
      cleanup();
      resetNavigation(`/connectors/${id}`);
      await renderRouteWithCache(`/connectors/${id}?tab=credentials`, lastStubRoutes(), {
        me: MEMBER,
      });
      await screen.findByText(en.connectors.credential.personalTitle);
      for (const label of onCard) {
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
      }
    },
  );
});

const DEVICE = {
  id: "e1",
  name: "Sandbox",
  isDefault: false,
  ownerKind: "personal",
  dialIn: false,
  provider: "sandbox-docker",
  available: true,
  sessionIsolation: false,
  filesLost: false,
  instance: null,
  limits: { cpu: 2, memoryMb: 2048, diskMb: 10240, network: { kind: "open-public", hosts: [] } },
  report: null,
  sandbox: {
    network: "open",
    networkCeiling: "open",
    hosts: [],
    ownNetwork: null,
    allowedDomains: [],
    outsideSandbox: false,
    layer: { network: null, outsideSandbox: "provider" },
    pendingNextUse: false,
    pendingFilesReset: false,
    recent: [],
  },
  createdAt: T,
};

describe("device cards carry no actions beyond opening the device", () => {
  it("a device card has no button and no ⋯ menu: its only control is the link to the device", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/devices": () =>
        json(200, {
          items: [DEVICE],
          defaultId: null,
          lastUsedId: null,
          providers: [{ plugin: "sandbox-docker", displayName: null }],
          defaultProvider: "sandbox-docker",
        }),
    });
    await renderRouteWithCache("/devices", lastStubRoutes());
    const card = await findCard(en.devices.listLabel, "Sandbox");
    expect(footControls(card)).toEqual([]);
    expect(within(card).queryByRole("button")).toBeNull();
    const links = within(card).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/devices/e1"]);
  });
});

describe("the skill detail tables at 390 draw grouped rows", () => {
  it("files and versions use their roles; the file count is hidden", async () => {
    stubWindowWidth(390);
    resetNavigation("/skills/s1");
    const version = (n: number, files: { path: string; size: number; sha256: string }[]) => ({
      version: n,
      description: `Version ${n}.`,
      files,
      createdBy: "a1",
      createdAt: T,
    });
    stubApi({
      "GET /api/v1/orgs/o1/skills/s1": () =>
        json(200, {
          id: "s1",
          scope: "org",
          agentId: null,
          name: "pdf-tools",
          description: "Use for pdf-tools.",
          currentVersion: 2,
          createdBy: "a1",
          createdAt: T,
          updatedAt: T,
          body: "# PDF tools\n",
          versions: [
            version(2, [{ path: "scripts/run.py", size: 2048, sha256: "b" }]),
            version(1, [{ path: "SKILL.md", size: 90, sha256: "c" }]),
          ],
        }),
    });
    const { container } = await renderRouteWithCache("/skills/s1", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: en.skills.detail.tabs.files }));
    await screen.findByText("scripts/run.py");
    const file = container.querySelector<HTMLElement>("[data-part=compact-row]");
    expect(file?.querySelector("[data-part=compact-title]")?.textContent).toBe("scripts/run.py");
    expect(file?.querySelector("[data-part=compact-meta]")?.textContent).toBe("2 KB");
    await user.click(screen.getByRole("tab", { name: en.skills.detail.tabs.versions }));
    await screen.findByText("Version 2.");
    const row = Array.from(container.querySelectorAll<HTMLElement>("[data-part=compact-row]")).find(
      (r) => r.textContent?.includes("Version 2."),
    );
    expect(row?.querySelector("[data-part=compact-title]")?.textContent).toBe("v2");
    expect(row?.querySelector("[data-part=compact-subtitle]")?.textContent).toBe("Version 2.");
    // the meta is the creation time alone (a local-time stamp): the file count is hidden in compact rows
    expect(row?.querySelector("[data-part=compact-meta]")?.textContent).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });
});
