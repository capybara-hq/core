import { cleanup, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { useSelection } from "../src/components/conversation/useSelection";
import { ModelCatalog } from "../src/components/ModelCatalog";
import { listModels, type ModelInfo, type ModelKind } from "../src/lib/agents";
import { type AdminModelInfo, pickerOptions, targetName } from "../src/lib/models";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { renderPage } from "./support/render";
import { optionValues, pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const caps = {
  tools: true,
  vision: false,
  reasoning: false,
  caching: false,
  midConversationSystem: true,
};

const model = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  displayName: id,
  contextWindow: 1000,
  maxOutputTokens: 100,
  capabilities: caps,
  parameters: [],
  ...over,
});

/** 300 generated models: 120 chat (two publishers), 100 embedding, 80 rerank. */
function generated(disabled: string[] = []) {
  const out: AdminModelInfo[] = [];
  const add = (n: number, kind: ModelKind, prefix: string, pubs: string[]) => {
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${i}`;
      out.push(
        model(id, {
          kind,
          publisher: pubs[i % pubs.length],
          disabled: disabled.includes(id),
        }) as AdminModelInfo,
      );
    }
  };
  add(120, "chat", "chat", ["acme", "zeta"]);
  add(100, "embedding", "emb", ["acme"]);
  add(80, "rerank", "rr", ["acme"]);
  return out;
}

const regionOf = (kind: string) => within(screen.getByRole("region", { name: kind }));

beforeEach(() => {
  resetNavigation("/settings/models");
  // The tabs and the open provider live in the address: every test starts on a bare one
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelCatalog", () => {
  it("groups 300 models by kind with counts and filters by search and publisher", async () => {
    const user = userEvent.setup();
    renderPage(
      <ModelCatalog provider="big" title="Big" models={generated()} onChange={() => {}} />,
    );
    const k = en.models.kind;
    expect(regionOf(k.chat).getByText("120")).toBeTruthy();
    expect(regionOf(k.embedding).getByText("100")).toBeTruthy();
    expect(regionOf(k.rerank).getByText("80")).toBeTruthy();
    expect(screen.queryByRole("region", { name: k.image_generation })).toBeNull();
    // A kind's table is paged: 50 rows and the header
    const chat = screen.getByRole("table", { name: "big · Chat" });
    expect(within(chat).getAllByRole("row")).toHaveLength(51);

    // The search narrows every kind; a kind without a match disappears
    await user.type(screen.getByRole("textbox", { name: en.models.catalog.search }), "chat-7");
    // chat-7, chat-70..chat-79
    expect(regionOf(k.chat).getByText("11")).toBeTruthy();
    expect(screen.queryByRole("region", { name: k.embedding })).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: en.models.catalog.search }));

    // The publisher filter appears because the models have two publishers
    await pickOption(
      screen.getByRole("combobox", { name: en.models.catalog.publisher }),
      "zeta",
      user,
    );
    expect(regionOf(k.chat).getByText("60")).toBeTruthy();
    expect(screen.queryByRole("region", { name: k.embedding })).toBeNull();
  });

  it("no publisher filter when the models have one publisher", () => {
    renderPage(
      <ModelCatalog
        provider="one"
        title="One"
        models={[model("a", { publisher: "acme" }) as AdminModelInfo]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("combobox", { name: en.models.catalog.publisher })).toBeNull();
  });

  it("turn all off for a kind sends only the kind's ids that are on, once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPage(
      <ModelCatalog provider="big" title="Big" models={generated(["emb-3"])} onChange={onChange} />,
    );
    await user.click(
      regionOf(en.models.kind.chat).getByRole("button", { name: en.models.catalog.turnAllOff }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const sent = onChange.mock.calls[0]?.[0] as { disable: string[]; enable: string[] };
    const chatIds = Array.from({ length: 120 }, (_, i) => `chat-${i}`);
    expect([...sent.disable].sort()).toEqual([...chatIds].sort());
    expect(sent.enable).toEqual([]);
  });

  it("bulk follows the publisher filter; turn all on enables only that kind's disabled ids", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const off = ["chat-0", "chat-1", "emb-3"];
    renderPage(
      <ModelCatalog provider="big" title="Big" models={generated(off)} onChange={onChange} />,
    );
    await pickOption(
      screen.getByRole("combobox", { name: en.models.catalog.publisher }),
      "acme",
      user,
    );
    await user.click(
      regionOf(en.models.kind.chat).getByRole("button", { name: en.models.catalog.turnAllOn }),
    );
    // chat-0 is acme (even index), chat-1 is zeta: only chat-0 comes back on
    expect(onChange).toHaveBeenCalledWith({ disable: [], enable: ["chat-0"] });
  });

  it("a switch changes one model; the retiring marker is shown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPage(
      <ModelCatalog
        provider="p"
        title="P"
        models={[
          model("old", {
            displayName: "Old Model",
            retiresAt: "2026-12-01T00:00:00Z",
          }) as AdminModelInfo,
          model("new", { displayName: "New Model" }) as AdminModelInfo,
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(en.models.catalog.retiring)).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Old Model" }));
    expect(onChange).toHaveBeenCalledWith({ disable: ["old"], enable: [] });
  });
});

describe("bulk follows the rows on screen", () => {
  it("with a search showing 11 of 120 chat models, turn all off disables exactly those 11", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPage(
      <ModelCatalog provider="big" title="Big" models={generated(["emb-3"])} onChange={onChange} />,
    );
    await user.type(screen.getByRole("textbox", { name: en.models.catalog.search }), "chat-7");
    const chat = regionOf(en.models.kind.chat);
    expect(chat.getByText("11")).toBeTruthy();
    await user.click(chat.getByRole("button", { name: en.models.catalog.turnAllOff }));
    const want = ["chat-7", ...Array.from({ length: 10 }, (_, i) => `chat-7${i}`)];
    const sent = (onChange.mock.calls[0] ?? [])[0] as { disable: string[]; enable: string[] };
    expect([...sent.disable].sort()).toEqual(want.sort());
    // emb-3 (off, not on screen) is not named: it keeps its stored state
    expect(sent.enable).toEqual([]);
  });
});

describe("a model disabled after it was saved keeps its name", () => {
  it("the composer's picker shows the model id when the list no longer has it", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={en}>
        {children}
      </NextIntlClientProvider>
    );
    const ref = { provider: "alpha", model: "gone-model" };
    const { result } = renderHook(
      () =>
        useSelection([{ provider: "alpha", models: [model("other") as ModelInfo] }], undefined, {
          model: ref,
        } as never),
      { wrapper },
    );
    expect(result.current.modelPicker.value).toBe("gone-model");
  });

  it("the agent map names it by its id", () => {
    expect(
      targetName(
        [{ provider: "alpha", models: [] }],
        { provider: "alpha", model: "gone-model" },
        "en",
      ),
    ).toBe("alpha / gone-model");
  });
});

describe("pickerOptions and the chat-only read", () => {
  it("groups by provider, then publisher, skips disabled models", () => {
    const opts = pickerOptions(
      [
        {
          provider: "p1",
          models: [
            model("a", { publisher: "zeta" }),
            model("b", { publisher: "acme" }),
            model("c", { publisher: "zeta", disabled: true }),
            model("d", { publisher: "acme" }),
          ] as ModelInfo[],
        },
        { provider: "p2", models: [model("e", { publisher: "solo" })] as ModelInfo[] },
      ],
      "en",
    );
    expect(opts.map((o) => o.value)).toEqual(["p1/b", "p1/d", "p1/a", "p2/e"]);
    expect(opts.map((o) => o.label)).toEqual([
      "p1 / acme / b",
      "p1 / acme / d",
      "p1 / zeta / a",
      "p2 / e",
    ]);
  });

  it("the pickers ask the kernel for chat models only", async () => {
    const calls = stubApi({ "GET /api/v1/orgs/o1/models": () => json(200, { providers: [] }) });
    await listModels("o1", "chat");
    expect(calls[0]?.url).toBe("/api/v1/orgs/o1/models?kind=chat");
  });
});

const CATALOG_ALPHA = {
  provider: "alpha",
  plugin: "alpha",
  status: "ok",
  displayName: null,
  models: [
    model("alpha-large", { displayName: "Alpha Large" }),
    model("alpha-small", { displayName: "Alpha Small", disabled: true }),
  ],
};

const ORG_VIEWS = [
  { purpose: "eval", kind: "chat", label: { zh: "评测评委", en: "Eval judge" } },
  { purpose: "embed.docs", kind: "embedding", label: { zh: "向量", en: "Embeddings" } },
].map((v) => ({ ...v, declaredBy: "kernel", default: null, override: null, effective: null }));

function orgRoutes(state: "following" | "copy", extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: ORG_VIEWS }),
    "GET /api/v1/orgs/o1/models": () =>
      json(200, {
        providers: [
          {
            provider: "alpha",
            models: [
              model("alpha-large", { displayName: "Alpha Large" }),
              model("embed-1", { displayName: "Embed One", kind: "embedding", embedding: {} }),
            ],
          },
        ],
      }),
    "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [CATALOG_ALPHA] }),
    "GET /api/v1/orgs/o1/extensions": () =>
      json(200, { extensions: [{ plugin: "alpha", overrideState: state }] }),
    ...extra,
  });
}

describe("/settings/models: the org's catalog", () => {
  it.each([
    ["following", "zh", zh.models.catalog.following],
    ["copy", "zh", zh.models.catalog.orgConfigured],
    ["following", "en", en.models.catalog.following],
    ["copy", "en", en.models.catalog.orgConfigured],
  ] as const)(
    "a provider %s shows its state with a link to its config (%s)",
    async (state, locale, text) => {
      orgRoutes(state);
      await renderRouteWithCache("/settings/models", lastStubRoutes(), { locale });
      expect(await screen.findByText(text)).toBeTruthy();
      const link = screen.getByRole("link", {
        name: (locale === "zh" ? zh : en).models.catalog.configure,
      });
      expect(link.getAttribute("href")).toBe("/extensions?tab=model");
    },
  );

  it("a switch sends only its model; the affected agents are listed and undo sends the inverse", async () => {
    const calls = orgRoutes("following", {
      "PATCH /api/v1/orgs/o1/models/alpha/disabled": (c) =>
        (bodyOf(c) as { disable: string[] }).disable.includes("alpha-large")
          ? json(200, {
              affected: {
                agents: [{ id: "ag1", name: "Support bot", orgId: "o1" }],
                purposes: [{ purpose: "eval", orgId: "o1" }],
              },
            })
          : json(200, { affected: { agents: [], purposes: [] } }),
    });
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Alpha Large" }));
    const puts = () => calls.filter((c) => c.method === "PATCH");
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    // alpha-small was already off: it is not named, so it keeps its state
    expect(bodyOf(puts()[0])).toEqual({ disable: ["alpha-large"], enable: [] });
    expect(await screen.findByText(/These agents or purposes use these models:/)).toBeTruthy();
    expect(screen.getByText(/Support bot, Eval judge/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: en.models.catalog.undo }));
    await vi.waitFor(() => expect(puts()).toHaveLength(2));
    expect(bodyOf(puts()[1])).toEqual({ disable: [], enable: ["alpha-large"] });
    await vi.waitFor(() =>
      expect(screen.queryByText(/These agents or purposes use these models:/)).toBeNull(),
    );
  });

  it("the purpose editor lists only models of the purpose's kind", async () => {
    orgRoutes("following");
    await renderRouteWithCache("/settings/models?tab=purposes", lastStubRoutes());
    await screen.findByRole("list", { name: en.models.org.title });
    // rows are found by their title (purpose ids never show)
    const TITLES: Record<string, string> = { eval: "Eval judge", "embed.docs": "Embeddings" };
    const rowOf = (purpose: string) =>
      [...document.querySelectorAll('[data-part="item-list-title"]')]
        .find((el) => el.textContent === TITLES[purpose])
        ?.closest('[data-part="item-list-row"]') as HTMLElement;
    const evalBox = within(rowOf("eval"));
    expect(
      await optionValues(evalBox.getByRole("combobox", { name: en.models.purpose.model })),
    ).toEqual(["", "alpha/alpha-large"]);
    const embBox = within(rowOf("embed.docs"));
    expect(
      await optionValues(embBox.getByRole("combobox", { name: en.models.purpose.model })),
    ).toEqual(["", "alpha/embed-1"]);
  });
});

describe("/admin/models: the platform's switches", () => {
  it("a switch sends its model to the admin route; an org-configured provider says so", async () => {
    resetNavigation("/admin/models");
    const calls = stubApi({
      "GET /api/v1/admin/models": () =>
        json(200, {
          providers: [
            { ...CATALOG_ALPHA, models: CATALOG_ALPHA.models },
            { provider: "own", plugin: "own", status: "org_configured", models: [] },
          ],
          prices: [],
          currency: "EUR",
        }),
      "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [] }),
      "PATCH /api/v1/admin/models/alpha/disabled": () =>
        json(200, { affected: { agents: [], purposes: [] } }),
    });
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Alpha Large" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/v1/admin/models/alpha/disabled");
    expect(bodyOf(patch)).toEqual({ disable: ["alpha-large"], enable: [] });
    // the org-configured provider says so in the detail once it is opened
    expect(screen.queryByText(en.models.catalog.orgsConfigure)).toBeNull();
    const list = screen.getByRole("table", { name: en.models.providers.label });
    await user.click(within(list).getByText("own"));
    expect(screen.getByText(en.models.catalog.orgsConfigure)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

/** Three providers for the tab and selection cases: one per kind mix, the last failed. */
const MIXED = {
  provider: "mixed",
  plugin: "mixed",
  status: "ok",
  displayName: { zh: "混合", en: "Mixed" },
  models: [
    model("rr-1", { displayName: "Rerank One", kind: "rerank" }),
    model("emb-1", {
      displayName: "Embed One",
      kind: "embedding",
      embedding: {
        dimensions: [256, 1024],
        defaultDimensions: 1024,
        maxInputTokens: 8192,
        maxBatch: 10,
      },
    }),
    model("chat-1", { displayName: "Chat One" }),
    model("img-1", { displayName: "Image One", kind: "image_generation" }),
  ],
};
const FAILED = {
  provider: "down",
  plugin: "down",
  status: "error",
  error: "Model provider down failed to list its models",
  models: [],
};

function adminMixed(extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    "GET /api/v1/admin/models": () =>
      json(200, {
        providers: [CATALOG_ALPHA, MIXED, FAILED],
        prices: [
          {
            provider: "mixed",
            model: "emb-1",
            inputPerMTok: 0.5,
            outputPerMTok: 0,
            cacheReadPerMTok: null,
            cacheWritePerMTok: null,
          },
        ],
        currency: "EUR",
      }),
    "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [] }),
    ...extra,
  });
}

const tabOf = (name: string) => screen.getByRole("tab", { name });
const providerList = () => screen.getByRole("table", { name: en.models.providers.label });

describe("the models pages' tabs and provider selection", () => {
  it.each(["/admin/models", "/settings/models"] as const)(
    "%s: 模型 is the default tab; 用途默认 is ?tab=purposes and back",
    async (path) => {
      resetNavigation(path);
      if (path === "/admin/models") adminMixed();
      else orgRoutes("following");
      await renderRouteWithCache(path, lastStubRoutes());
      expect(await screen.findByRole("table", { name: en.models.providers.label })).toBeTruthy();
      expect(tabOf(en.models.tabs.models).getAttribute("aria-selected")).toBe("true");
      const purposesTitle =
        path === "/admin/models" ? en.models.admin.purposes.title : en.models.org.title;
      expect(screen.queryByRole("region", { name: purposesTitle })).toBeNull();
      const user = userEvent.setup();
      await user.click(tabOf(en.models.tabs.purposes));
      expect(window.location.search).toBe("?tab=purposes");
      expect(screen.getByRole("region", { name: purposesTitle })).toBeTruthy();
      expect(screen.queryByRole("table", { name: en.models.providers.label })).toBeNull();
      await user.click(tabOf(en.models.tabs.models));
      expect(window.location.search).toBe("");
      expect(screen.getByRole("table", { name: en.models.providers.label })).toBeTruthy();
    },
  );

  it("?provider= opens that provider; an unknown one opens the first; a row click selects", async () => {
    resetNavigation("/admin/models");
    adminMixed();
    const { unmount } = await renderRouteWithCache(
      "/admin/models?provider=mixed",
      lastStubRoutes(),
    );
    expect(await screen.findByRole("heading", { level: 3, name: "Mixed" })).toBeTruthy();
    const active = () =>
      within(providerList())
        .getAllByRole("row")
        .filter((r) => r.getAttribute("aria-current") === "true")
        .map((r) => r.getAttribute("data-row-key"));
    expect(active()).toEqual(["mixed"]);
    unmount();

    adminMixed();
    await renderRouteWithCache("/admin/models?provider=nope", lastStubRoutes());
    expect(await screen.findByRole("heading", { level: 3, name: "alpha" })).toBeTruthy();
    expect(active()).toEqual(["alpha"]);
    // each row: the name, the plugin id when it differs, the count or the failure
    const row = (key: string) =>
      within(providerList())
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-row-key") === key) as HTMLElement;
    expect(row("mixed").textContent).toContain("Mixed");
    expect(row("mixed").textContent).toContain("mixed");
    expect(within(row("mixed")).getByText("4")).toBeTruthy();
    expect(within(row("down")).getByText(en.models.providers.failed)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(row("mixed"));
    expect(window.location.search).toBe("?provider=mixed");
    expect(screen.getByRole("heading", { level: 3, name: "Mixed" })).toBeTruthy();
  });

  it("the open provider's models are grouped by kind in order, each with its kind's columns", async () => {
    resetNavigation("/admin/models");
    adminMixed();
    await renderRouteWithCache("/admin/models?provider=mixed", lastStubRoutes());
    await screen.findByRole("heading", { level: 3, name: "Mixed" });
    const k = en.models.kind;
    const regions = [...document.querySelectorAll('[data-part="subsection"]')].map(
      (r) => r.querySelector('[data-part="subsection-title"]')?.textContent,
    );
    expect(regions).toEqual([k.chat, k.embedding, k.rerank, k.image_generation]);
    const heads = (kind: string) =>
      within(screen.getByRole("table", { name: `Mixed · ${kind}` }))
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
    const c = en.models.admin.columns;
    const on = en.models.catalog.enabled;
    expect(heads(k.chat)).toEqual(
      expect.arrayContaining([
        c.model,
        c.capabilities,
        c.context,
        c.input,
        c.output,
        c.cacheRead,
        c.cacheWrite,
        on,
      ]),
    );
    // an embedding model: its dimensions, its input limit and only the input price
    const emb = heads(k.embedding);
    expect(emb).toEqual(expect.arrayContaining([c.model, c.dimensions, c.maxInput, c.input, on]));
    for (const chatOnly of [c.capabilities, c.context, c.output, c.cacheRead, c.cacheWrite]) {
      expect(emb).not.toContain(chatOnly);
    }
    const embRow = within(screen.getByRole("table", { name: `Mixed · ${k.embedding}` }))
      .getByText("Embed One")
      .closest("tr") as HTMLElement;
    expect(embRow.textContent).toContain("256");
    expect(embRow.textContent).toContain("1,024");
    expect(embRow.textContent).toContain("8,192");
    expect(within(embRow).getByText("0.5")).toBeTruthy();
    // the kinds that are not billed: the model and its switch, no price menu
    const rerank = screen.getByRole("table", { name: `Mixed · ${k.rerank}` });
    expect(heads(k.rerank).filter((h) => h !== "")).toEqual([c.model, on]);
    expect(within(rerank).queryByRole("button", { name: "Row actions" })).toBeNull();
  });

  it("an embedding model's price editor asks for the input price only", async () => {
    resetNavigation("/admin/models");
    const calls = adminMixed({
      "PUT /api/v1/admin/model-prices": () => json(200, { prices: [], currency: "EUR" }),
    });
    await renderRouteWithCache("/admin/models?provider=mixed", lastStubRoutes());
    const table = await screen.findByRole("table", { name: `Mixed · ${en.models.kind.embedding}` });
    const row = within(table).getByText("Embed One").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "Row actions" }));
    await user.click(await screen.findByRole("menuitem", { name: en.models.admin.menu.editPrice }));
    const p = en.models.admin.price;
    const input = await screen.findByRole("textbox", { name: p.input });
    expect(screen.queryByRole("textbox", { name: p.output })).toBeNull();
    await user.clear(input);
    await user.type(input, "0.75");
    await user.click(
      screen.getByRole("button", { name: p.saveLabel.replace("{model}", "Embed One") }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        provider: "mixed",
        model: "emb-1",
        inputPerMTok: 0.75,
        outputPerMTok: 0,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      }),
    );
  });

  it("a search with no match is a compact empty state", async () => {
    resetNavigation("/admin/models");
    adminMixed();
    await renderRouteWithCache("/admin/models?provider=mixed", lastStubRoutes());
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox", { name: en.models.catalog.search }),
      "zzz-nothing",
    );
    expect(screen.getByText(en.models.catalog.noMatch)).toBeTruthy();
    expect(document.querySelectorAll('[data-part="subsection"]')).toHaveLength(0);
  });

  it.each(["/admin/models", "/settings/models"] as const)(
    "%s with no providers: the page empty state links to the plugins page",
    async (path) => {
      resetNavigation(path);
      if (path === "/admin/models") {
        stubApi({
          "GET /api/v1/admin/models": () =>
            json(200, { providers: [], prices: [], currency: "EUR" }),
          "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [] }),
        });
      } else {
        stubApi({
          "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: [] }),
          "GET /api/v1/orgs/o1/models": () => json(200, { providers: [] }),
          "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [] }),
          "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
        });
      }
      await renderRouteWithCache(path, lastStubRoutes());
      const admin = path === "/admin/models";
      expect(
        await screen.findByText(admin ? en.models.admin.noProviders : en.models.org.noProviders),
      ).toBeTruthy();
      const link = screen.getByRole("link", {
        name: admin ? en.models.admin.toPlugins : en.models.org.toPlugins,
      });
      expect(link.getAttribute("href")).toBe(admin ? "/admin/plugins" : "/plugins");
    },
  );
});
