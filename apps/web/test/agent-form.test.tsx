import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { agentFormDefaults, renderNewAgent } from "./support/agents";
import { json as apiJson, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CAPS = {
  tools: true,
  vision: false,
  reasoning: false,
  caching: false,
  midConversationSystem: false,
};
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] }],
    },
    {
      provider: "other",
      models: [{ id: "o-1", displayName: "O 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};

/**
 * The browser answers only the create (`posts`); the server reads the models from the same routes.
 */
function _stub(warnings: string[], models: unknown = MODELS) {
  const posts: unknown[] = [];
  stubApi({
    "GET /api/v1/orgs/o1/models": () => json(200, models),
    "POST /api/v1/orgs/o1/agents": (c) => {
      posts.push(JSON.parse(String(c.body)));
      return json(201, { agent: { id: "ag1" }, warnings });
    },
  });
  return posts;
}

/** 兜底模型下拉框的名称带「可选」后缀。 */
const _startsWith = (label: string) => (name: string) => name.startsWith(label);

beforeEach(() => resetNavigation("/agents/new"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe("the agent pages render on the server (web-SSR spec §6)", () => {
  const ORG = "/api/v1/orgs/o1";
  const T = "2026-10-20T08:00:00.000Z";
  const as = (role: "guest" | "member" | "admin") => ({
    ...ME,
    account: { ...ME.account, isEnterpriseAdmin: false },
    memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
  });
  const agent = (id: string, name: string, owner = "a1") => ({
    id,
    orgId: "o1",
    ownerAccountId: owner,
    visibility: "org",
    currentVersion: 1,
    profile: {
      avatar: null,
      description: "",
      quickActions: [],
      updatedAt: "2026-11-04T10:00:00.000Z",
    },
    memberIds: null,
    needsReassignment: false,
    createdAt: T,
    updatedAt: T,
    definition: {
      name,
      instructions: "",
      model: { provider: "model-fake", model: "fake-1" },
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      tools: [{ kind: "connector", connectorId: "cn1", tools: "all" }],
      toolPolicies: {},
    },
  });
  const connector = {
    id: "cn1",
    name: "Tracker",
    status: "active",
    tools: [{ key: "mcp__tracker__find", status: "enabled" }],
  };
  const ok = (body: unknown) => () => apiJson(200, body);
  const formRoutes = {
    [`GET ${ORG}/models`]: ok(MODELS),
    [`GET ${ORG}/connectors`]: ok({ connectors: [connector] }),
    [`GET ${ORG}/connectors/cn1`]: ok({ connector }),
    [`GET ${ORG}/skills`]: ok({
      skills: [{ id: "s1", name: "notes-style", description: "Notes.", source: "org" }],
    }),
  };
  const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

  it("/agents: the list is the first paint, guests included", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache(
      "/agents",
      { [`GET ${ORG}/agents`]: ok({ agents: [agent("ag1", "Echo agent")] }) },
      { me: as("guest") },
    );
    expect(calls.map((c) => c.url)).toContain(`${ORG}/agents`);
    expect(screen.getByText("Echo agent")).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.agents.new })).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/agents: without a current org it renders nothing; while the org is in setup it goes home", async () => {
    const none = await renderRouteWithCache("/agents", {}, { me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(template("ListPage")).toBeNull();
    cleanup();
    stubApi({});
    await renderRouteWithCache(
      "/agents",
      { [`GET ${ORG}/agents`]: ok({ agents: [] }) },
      { readiness: NOT_READY },
    );
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(template("ListPage")).toBeNull();
  });

  it("/agents: a first render from the hydrated cache makes no browser read", async () => {
    const browser = stubApi({});
    await renderRouteWithCache("/agents", {
      [`GET ${ORG}/agents`]: ok({ agents: [agent("ag1", "Echo agent")] }),
    });
    expect(screen.getByText("Echo agent")).toBeTruthy();
    await settle();
    expect(browser.filter((c) => c.method === "GET")).toEqual([]);
  });

  it("/agents: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/agents", {
      [`GET ${ORG}/agents`]: async () => {
        await held;
        return apiJson(200, { agents: [agent("ag1", "Echo agent")] });
      },
    });
    const page = await vi.waitFor(() => {
      const el = template("ListPage");
      if (el === null) throw new Error("no page yet");
      return el as HTMLElement;
    });
    expect(page.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Echo agent")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Echo agent")).toBeTruthy();
    await vi.waitFor(() => expect(page.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/agents/new: the models are in the first paint", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderNewAgent({ routes: formRoutes });
    expect(
      (screen.getByRole("combobox", { name: en.agents.form.modelLabel }) as HTMLSelectElement)
        .value,
    ).toBe("model-fake/fake-1");
    expect(screen.queryByRole("checkbox", { name: /Tracker/ })).toBeNull();
    expect(browser).toEqual([]);
  });

  it("/agents/new: a guest gets no access and nothing is read; it is a setup step", async () => {
    const guest = await renderNewAgent({ routes: formRoutes, me: as("guest") });
    expect(new Set(guest.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    expectNoFirstPaintFetch();
    await renderNewAgent({ routes: formRoutes, readiness: NOT_READY });
    expect(template("FormPage")).not.toBeNull();
    cleanup();
    const none = await renderNewAgent({ me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(template("FormPage")).toBeNull();
  });

  it("/agents/new: a section the kernel fails (agent templates) still renders the form", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderNewAgent({
      routes: {
        ...formRoutes,
        [`GET ${ORG}/agent-templates`]: () => apiJson(500, { error: { code: "internal" } }),
      },
    });
    expect(screen.getByRole("button", { name: en.agents.form.submit })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/agents/new: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/agents/new", {
      ...agentFormDefaults(),
      ...formRoutes,
      [`GET ${ORG}/models`]: async () => {
        await held;
        return apiJson(200, MODELS);
      },
    });
    const page = await vi.waitFor(() => {
      const el = template("FormPage");
      if (el === null) throw new Error("no page yet");
      return el as HTMLElement;
    });
    expect(page.querySelector("[aria-busy='true']")).not.toBeNull();
    // the loaded section's fields: the eleven avatar tiles, the name with its counter line, the
    // model and visibility selects
    expect(
      page.querySelectorAll('[data-part="loading-plain-radios"] [data-part="loading-radio"]'),
    ).toHaveLength(11);
    const fields = page.querySelectorAll('[data-part="loading-field"]');
    expect(fields).toHaveLength(3);
    expect(fields[0]?.querySelector('[data-size="small"]')).not.toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("textbox", { name: en.agents.form.nameLabel })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/agents/new: a first render from the hydrated cache makes no browser read", async () => {
    const browser = stubApi({});
    await renderNewAgent({ routes: formRoutes });
    expect(screen.getByRole("textbox", { name: en.agents.form.nameLabel })).toBeTruthy();
    await settle();
    expect(browser.filter((c) => c.method === "GET")).toEqual([]);
  });
});
