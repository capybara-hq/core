import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import { renderEditAgent } from "./support/agents";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { fieldOptionLabels, pickOption } from "./support/select";
import { expectNoFirstPaintFetch, sessionRoutes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

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

/** The page's other section, answered empty. */
const PREVIEWERS = { [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }) };

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("org extensions page: default providers (web tools spec §6)", () => {
  beforeEach(() => resetNavigation("/extensions"));

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
        ...PREVIEWERS,
        [`GET ${ORG}/extensions`]: () =>
          json(200, { extensions: [webExtension("fake-web"), webExtension("fake-web-2")] }),
        [`GET ${ORG}/extension-points`]: () => json(200, { points }),
        [`GET ${ORG}/extension-points/available`]: () => json(200, { points: [] }),
        [`PUT ${ORG}/extension-points/web-search/default`]: (c) => {
          const { extension } = bodyOf(c) as { extension: string };
          points = points.map((p) =>
            p.point === "web-search" ? { ...p, default: extension, effective: extension } : p,
          );
          return noContent();
        },
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      const section = await screen.findByRole("region", { name: m.title });
      const select = within(section).getByRole("combobox", { name: m.points.webSearch });
      expect(select).toHaveProperty("value", "");
      expect(fieldOptionLabels(select)).toContain(m.none);
      expect(
        within(section).getByText(m.noneHint.replace("{point}", m.points.webSearch)),
      ).toBeTruthy();
      // one candidate: nothing to choose
      expect(within(section).queryByRole("combobox", { name: m.points.webFetch })).toBeNull();

      const user = userEvent.setup();
      await pickOption(select, "fake-web-2", user);
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT" && c.url.endsWith("/default")))).toEqual(
          { extension: "fake-web-2" },
        ),
      );
      await vi.waitFor(() => expect(select).toHaveProperty("value", "fake-web-2"));
      expect(fieldOptionLabels(select)).not.toContain(m.none);
      expect(
        within(section).queryByText(m.noneHint.replace("{point}", m.points.webSearch)),
      ).toBeNull();
    },
  );

  it("a stored default that is not a candidate now is listed as unavailable", async () => {
    const m = en.extensions.pointDefaults;
    stubApi({
      ...PREVIEWERS,
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
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "en" });
    const select = await screen.findByRole("combobox", { name: m.points.webSearch });
    expect(select).toHaveProperty("value", "fake-web-2");
    expect(fieldOptionLabels(select)).toContain(m.unavailable.replace("{extension}", "fake-web-2"));
    expect(screen.getByText(m.noneHint.replace("{point}", m.points.webSearch))).toBeTruthy();
  });

  it("hidden when no point has two candidates", async () => {
    stubApi({
      ...PREVIEWERS,
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [webExtension("fake-web")] }),
      [`GET ${ORG}/extension-points`]: () =>
        json(200, {
          points: [
            { point: "web-search", candidates: ["fake-web"], default: null, effective: "fake-web" },
          ],
        }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "en" });
    await screen.findByRole("row", { name: /fake-web/ });
    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: en.extensions.pointDefaults.title })).toBeNull(),
    );
  });

  it("a first render from the hydrated cache makes no browser read (the defaults are prefetched)", async () => {
    const routes = {
      [`GET ${ORG}/extensions`]: () =>
        json(200, { extensions: [webExtension("fake-web"), webExtension("fake-web-2")] }),
      [`GET ${ORG}/extension-points`]: () =>
        json(200, {
          points: [
            {
              point: "web-search",
              candidates: ["fake-web", "fake-web-2"],
              default: null,
              effective: null,
            },
          ],
        }),
      [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
    };
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/extensions", routes);
    expect(calls.map((c) => c.url)).toContain(`${ORG}/extension-points`);
    expect(screen.getByRole("region", { name: en.extensions.pointDefaults.title })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache reads the defaults with the extensions, then shows the section", async () => {
    await renderRouteEmptyCache("/extensions", {
      [`GET ${ORG}/extensions`]: () =>
        json(200, { extensions: [webExtension("fake-web"), webExtension("fake-web-2")] }),
      [`GET ${ORG}/extension-points`]: () =>
        json(200, {
          points: [
            {
              point: "web-search",
              candidates: ["fake-web", "fake-web-2"],
              default: "fake-web",
              effective: "fake-web",
            },
          ],
        }),
      [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
    });
    const select = await screen.findByRole("combobox", {
      name: en.extensions.pointDefaults.points.webSearch,
    });
    expect(select).toHaveProperty("value", "fake-web");
  });

  it("choosing a default invalidates the points and their availability", async () => {
    stubApi({
      ...PREVIEWERS,
      [`GET ${ORG}/extensions`]: () =>
        json(200, { extensions: [webExtension("fake-web"), webExtension("fake-web-2")] }),
      [`GET ${ORG}/extension-points`]: () =>
        json(200, {
          points: [
            {
              point: "web-search",
              candidates: ["fake-web", "fake-web-2"],
              default: null,
              effective: null,
            },
          ],
        }),
      [`PUT ${ORG}/extension-points/web-search/default`]: () => noContent(),
    });
    const { client } = await renderRouteWithCache("/extensions", lastStubRoutes());
    const spy = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    await pickOption(
      await screen.findByRole("combobox", { name: en.extensions.pointDefaults.points.webSearch }),
      "fake-web-2",
      user,
    );
    const k = keys.org("o1");
    await vi.waitFor(() =>
      expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual(
        expect.arrayContaining([k.extensionPointDefaults(), k.extensionPointsAvailable()]),
      ),
    );
  });

  it("enabling an extension invalidates the default providers", async () => {
    stubApi({
      ...PREVIEWERS,
      [`GET ${ORG}/extensions`]: () =>
        json(200, { extensions: [{ ...webExtension("fake-web"), enabled: false }] }),
      [`GET ${ORG}/extension-points`]: () => json(200, { points: [] }),
      [`PUT ${ORG}/extensions/fake-web`]: () => json(200, { extension: webExtension("fake-web") }),
    });
    const { client } = await renderRouteWithCache("/extensions", lastStubRoutes());
    const spy = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("switch", {
        name: en.extensions.enableLabel.replace("{plugin}", "fake-web"),
      }),
    );
    const k = keys.org("o1");
    await vi.waitFor(() =>
      expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual(
        expect.arrayContaining([k.extensionPointDefaults(), k.extensionPointsAvailable()]),
      ),
    );
  });
});

const available = (search: boolean, fetch: boolean) => () =>
  json(200, {
    points: [
      { point: "web-search", available: search },
      { point: "web-fetch", available: fetch },
    ],
  });

const agentWith = (tools: unknown[]) => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "private",
  currentVersion: 2,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
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

describe("agent page Tools section: web tools", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  it.each(["zh", "en"] as const)(
    "listed only when their point is available, unchecked until picked (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const tools = [{ kind: "builtin", name: "AskUserQuestion" }];
      const calls = stubApi({
        ...sessionRoutes(),
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith(tools) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/extension-points/available`]: available(true, false),
        [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith(tools), warnings: [] }),
      });
      await renderEditAgent({ section: "tools", locale });
      const search = await screen.findByRole("checkbox", { name: m.builtin.WebSearch });
      expect(search).toHaveProperty("checked", false);
      expect(screen.queryByRole("checkbox", { name: m.builtin.WebFetch })).toBeNull();

      const user = userEvent.setup();
      await user.click(search);
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
        definition: { tools: unknown[] };
      };
      expect(body.definition.tools).toEqual([
        { kind: "builtin", name: "AskUserQuestion" },
        { kind: "builtin", name: "WebSearch" },
      ]);
    },
  );

  it("an agent that selected WebFetch keeps it listed (with a hint) while no provider serves it", async () => {
    const m = en.agents.form;
    const tools = [
      { kind: "builtin", name: "AskUserQuestion" },
      { kind: "builtin", name: "WebFetch" },
    ];
    stubApi({
      ...sessionRoutes(),
      [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith(tools) }),
      [`GET ${ORG}/models`]: () => json(200, MODELS),
      [`GET ${ORG}/extension-points/available`]: available(false, false),
    });
    await renderEditAgent({ section: "tools" });
    const fetch = await screen.findByRole("checkbox", { name: m.builtin.WebFetch });
    expect(fetch).toHaveProperty("checked", true);
    expect(await screen.findByText(m.webUnavailable)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: m.builtin.WebSearch })).toBeNull();
  });

  it("the availability is part of the first paint (no browser read)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderEditAgent({
      section: "tools",
      routes: {
        [`GET ${ORG}/agents/ag1`]: () =>
          json(200, { agent: agentWith([{ kind: "builtin", name: "AskUserQuestion" }]) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/extension-points/available`]: available(true, true),
      },
    });
    expect(calls.map((c) => c.url)).toContain(`${ORG}/extension-points/available`);
    expect(screen.getByRole("checkbox", { name: en.agents.form.builtin.WebFetch })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });
});

describe("agent page Tools section: the CurrentTime builtin", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  it.each([
    ["zh", "获取当前时间"],
    ["en", "Current time"],
  ] as const)(
    "its row reads %s %s and is listed whatever providers exist",
    async (locale, label) => {
      expect(msgs[locale].agents.form.builtin.CurrentTime).toBe(label);
      stubApi({
        ...sessionRoutes(),
        [`GET ${ORG}/agents/ag1`]: () =>
          json(200, {
            agent: agentWith([
              { kind: "builtin", name: "AskUserQuestion" },
              { kind: "builtin", name: "CurrentTime" },
            ]),
          }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/extension-points/available`]: available(false, false),
      });
      await renderEditAgent({ section: "tools", locale });
      const row = await screen.findByRole("checkbox", { name: label });
      expect(row).toHaveProperty("checked", true);
    },
  );
});
