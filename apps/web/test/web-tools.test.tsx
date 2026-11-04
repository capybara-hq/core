import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import EditAgentPage from "../src/app/[locale]/(app)/agents/[id]/page";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import ExtensionsPage from "../src/app/[locale]/(app)/settings/extensions/page";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "ag1" }) }));

const msgs = { zh, en } as const;
const ORG = "/api/v1/orgs/o1";
const T = "2026-11-04T08:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const webExtension = (plugin: string) => ({
  plugin,
  version: "0.1.0",
  enabled: true,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [],
  orgConfigSchema: null,
});

type Point = {
  point: string;
  candidates: string[];
  default: string | null;
  effective: string | null;
};

describe("org extensions page: default providers (web tools spec §6)", () => {
  beforeEach(() => resetNavigation("/settings/extensions"));

  it.each(["zh", "en"] as const)(
    "two candidates and none chosen: Not selected with the hint; choosing PUTs the default (%s)",
    async (locale) => {
      const m = msgs[locale].extensions.pointDefaults;
      let points: Point[] = [
        {
          point: "web-search",
          candidates: ["fake-web", "fake-web-2"],
          default: null,
          effective: null,
        },
        { point: "web-fetch", candidates: ["fake-web"], default: null, effective: "fake-web" },
      ];
      const calls = stubApi({
        [`GET ${ORG}/extensions`]: () =>
          json(200, { extensions: [webExtension("fake-web"), webExtension("fake-web-2")] }),
        [`GET ${ORG}/extension-points`]: () => json(200, { points }),
        [`PUT ${ORG}/extension-points/web-search/default`]: (c) => {
          const { extension } = bodyOf(c) as { extension: string };
          points = points.map((p) =>
            p.point === "web-search" ? { ...p, default: extension, effective: extension } : p,
          );
          return noContent();
        },
      });
      renderPage(<ExtensionsPage />, { locale });
      const section = await screen.findByRole("region", { name: m.title });
      const select = within(section).getByRole("combobox", { name: m.points.webSearch });
      expect(select).toHaveProperty("value", "");
      expect(within(select).getByRole("option", { name: m.none })).toBeTruthy();
      expect(
        within(section).getByText(m.noneHint.replace("{point}", m.points.webSearch)),
      ).toBeTruthy();
      // one candidate: nothing to choose
      expect(within(section).queryByRole("combobox", { name: m.points.webFetch })).toBeNull();

      const user = userEvent.setup();
      await user.selectOptions(select, "fake-web-2");
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT" && c.url.endsWith("/default")))).toEqual(
          { extension: "fake-web-2" },
        ),
      );
      await vi.waitFor(() => expect(select).toHaveProperty("value", "fake-web-2"));
      expect(within(select).queryByRole("option", { name: m.none })).toBeNull();
      expect(
        within(section).queryByText(m.noneHint.replace("{point}", m.points.webSearch)),
      ).toBeNull();
    },
  );

  it("a stored default that is not a candidate now is listed as unavailable", async () => {
    const m = en.extensions.pointDefaults;
    stubApi({
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [webExtension("fake-web")] }),
      [`GET ${ORG}/extension-points`]: () =>
        json(200, {
          points: [
            {
              point: "web-search",
              candidates: ["fake-web", "fake-web-3"],
              default: "fake-web-2",
              effective: null,
            },
          ],
        }),
    });
    renderPage(<ExtensionsPage />, { locale: "en" });
    const select = await screen.findByRole("combobox", { name: m.points.webSearch });
    expect(select).toHaveProperty("value", "fake-web-2");
    expect(
      within(select).getByRole("option", {
        name: m.unavailable.replace("{extension}", "fake-web-2"),
      }),
    ).toBeTruthy();
    expect(screen.getByText(m.noneHint.replace("{point}", m.points.webSearch))).toBeTruthy();
  });

  it("hidden when no point has two candidates", async () => {
    stubApi({
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [webExtension("fake-web")] }),
      [`GET ${ORG}/extension-points`]: () =>
        json(200, {
          points: [
            { point: "web-search", candidates: ["fake-web"], default: null, effective: "fake-web" },
          ],
        }),
    });
    renderPage(<ExtensionsPage />, { locale: "en" });
    await screen.findByRole("region", { name: "fake-web" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: en.extensions.pointDefaults.title })).toBeNull(),
    );
  });
});

const CAPS = { tools: true, vision: false, reasoning: false };
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};
const available = (search: boolean, fetch: boolean) => () =>
  json(200, {
    points: [
      { point: "web-search", available: search },
      { point: "web-fetch", available: fetch },
    ],
  });

describe("agent form: web tools", () => {
  it.each(["zh", "en"] as const)(
    "listed only when their point is available, never checked by default (%s)",
    async (locale) => {
      resetNavigation("/agents/new");
      const m = msgs[locale].agents.form;
      const calls = stubApi({
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
        [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
        [`GET ${ORG}/extension-points/available`]: available(true, false),
        [`POST ${ORG}/agents`]: () => json(201, { agent: { id: "ag1" }, warnings: [] }),
      });
      renderPage(<NewAgentPage />, { locale });
      const search = await screen.findByRole("checkbox", { name: m.builtin.WebSearch });
      expect(search).toHaveProperty("checked", false);
      expect(screen.queryByRole("checkbox", { name: m.builtin.WebFetch })).toBeNull();

      const user = userEvent.setup();
      await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
      await user.type(screen.getByRole("textbox", { name: m.nameLabel }), "Web");
      await user.click(search);
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
      const body = bodyOf(calls.find((c) => c.method === "POST")) as {
        definition: { tools: unknown[] };
      };
      expect(body.definition.tools).toEqual([
        { kind: "builtin", name: "AskUserQuestion" },
        { kind: "builtin", name: "ReadToolOutput" },
        { kind: "builtin", name: "WebSearch" },
      ]);
    },
  );

  it("an agent that selected WebFetch keeps it listed (with a hint) while no provider serves it", async () => {
    resetNavigation("/agents/ag1");
    const m = en.agents.form;
    const tools = [
      { kind: "builtin", name: "AskUserQuestion" },
      { kind: "builtin", name: "WebFetch" },
    ];
    const calls = stubApi({
      [`GET ${ORG}/agents/ag1`]: () =>
        json(200, {
          agent: {
            id: "ag1",
            orgId: "o1",
            ownerAccountId: "a1",
            visibility: "private",
            currentVersion: 2,
            memberIds: null,
            createdAt: T,
            updatedAt: T,
            definition: {
              name: "Reader",
              instructions: "Read.",
              model: { provider: "model-fake", model: "fake-1" },
              fallback: null,
              modelParams: {},
              fallbackParams: {},
              tools,
              toolPolicies: {},
            },
          },
        }),
      [`GET ${ORG}/models`]: () => json(200, MODELS),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
      [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
      [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: [] }),
      [`GET ${ORG}/extension-points/available`]: available(false, false),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: { id: "ag1" }, warnings: [] }),
    });
    renderPage(<EditAgentPage />, { locale: "en" });
    const fetch = await screen.findByRole("checkbox", { name: m.builtin.WebFetch });
    expect(fetch).toHaveProperty("checked", true);
    expect(await screen.findByText(m.webUnavailable)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: m.builtin.WebSearch })).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition?: { tools?: unknown[] };
    };
    // unchanged: the saved reference is kept as is
    expect(body.definition?.tools ?? tools).toEqual(tools);
  });
});
