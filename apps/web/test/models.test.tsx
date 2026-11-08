import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { activeNavOf } from "../src/components/shell/nav";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const ROW_ACTIONS = { zh: "行操作", en: "Row actions" } as const;
/** The design ActionRow's count (design i18n `shell.unsaved`). */
const UNSAVED = { zh: "{n} 处未保存的修改", en: "{n} unsaved changes" } as const;
/** `models.purpose.savedAll` for one purpose (ICU plural in en). */
const SAVED_ONE = { zh: "已保存 1 个用途。", en: "Saved 1 purpose." } as const;
const NOT_ADMIN: Me = { ...ME, account: { ...ME.account, isSuperAdmin: false } };
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const caps = (over: Record<string, boolean> = {}) => ({
  tools: true,
  vision: false,
  reasoning: false,
  caching: false,
  midConversationSystem: true,
  ...over,
});

const EFFORT = {
  key: "effort",
  standard: "effort",
  schema: { type: "string", enum: ["low", "high"] },
  label: { zh: "思考深度", en: "Effort" },
};

const ALPHA = {
  provider: "alpha",
  plugin: "alpha",
  status: "ok",
  models: [
    {
      id: "alpha-large",
      displayName: "Alpha Large",
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      capabilities: caps({ vision: true, reasoning: true }),
      parameters: [EFFORT],
    },
    {
      id: "alpha-small",
      displayName: "Alpha Small",
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
      capabilities: caps(),
      parameters: [],
    },
  ],
};

const BROKEN = {
  provider: "broken",
  plugin: "broken",
  status: "error",
  error: "Model provider broken failed to list its models",
  models: [],
};

const PRICE = {
  provider: "alpha",
  model: "alpha-large",
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: null,
};

const target = (model: string, params: Record<string, unknown> = {}) => ({
  model: { provider: "alpha", model },
  params,
});

const evalView = (over: Record<string, unknown> = {}) => ({
  purpose: "eval",
  kind: "chat",
  label: { zh: "评测评委", en: "Eval judge" },
  declaredBy: "kernel",
  declaredByName: null,
  default: null,
  override: null,
  effective: null,
  ...over,
});

const pluginView = (over: Record<string, unknown> = {}) => ({
  purpose: "notes.summarize",
  kind: "chat",
  label: { zh: "摘要", en: "Summarize" },
  declaredBy: "notes",
  declaredByName: { zh: "笔记", en: "Notes" },
  default: null,
  override: null,
  effective: null,
  ...over,
});

const ADMIN_MODELS = { providers: [ALPHA, BROKEN], prices: [PRICE], currency: "EUR" };

function adminRoutes(extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    "GET /api/v1/admin/models": () => json(200, ADMIN_MODELS),
    "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [evalView(), pluginView()] }),
    ...extra,
  });
}

/** The page's one ActionRow (spec §4.4): one save for every changed purpose. */
const actionRow = () =>
  within(
    (() => {
      const el = document.querySelector('[data-part="action-row"]');
      if (!el) throw new Error("no action row");
      return el as HTMLElement;
    })(),
  );

/** The titles the stubbed purposes carry (both locales): rows are found by title, ids never show. */
const PURPOSE_TITLES: Record<string, string[]> = {
  eval: ["评测评委", "Eval judge"],
  title: ["会话标题", "Conversation titles"],
  "notes.summarize": ["摘要", "Summarize"],
  subagent_fast: ["Sub-agent: fast"],
  subagent_standard: ["Sub-agent: standard"],
  subagent_capable: ["Sub-agent: capable"],
};

/** A purpose's row (an ItemListItem, never a card): the row titled with the purpose's label. */
const purposeRow = (purpose: string): HTMLElement | null => {
  const titles = PURPOSE_TITLES[purpose] ?? [];
  const title = [...document.querySelectorAll('[data-part="item-list-title"]')].find((el) =>
    titles.includes(el.textContent ?? ""),
  );
  return (title?.closest('[data-part="item-list-row"]') as HTMLElement | null) ?? null;
};

const purposeBox = async (purpose: string) =>
  within(
    await vi.waitFor(() => {
      const el = purposeRow(purpose);
      if (!el) throw new Error(`no purpose ${purpose}`);
      return el;
    }),
  );

beforeEach(() => {
  resetNavigation("/admin/models");
  // The tabs and the open provider live in the address: every test starts on a bare one
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("导航", () => {
  it("/settings/models belongs to Settings", () => {
    expect(activeNavOf("/settings/models")).toBe("settings");
    expect(activeNavOf("/admin/models")).toBe("admin");
  });
});

describe("/admin/models（ListPage）", () => {
  it.each(LOCALES)("供应商、模型的能力、上下文长度与价格（%s）", async (locale) => {
    const m = msgs[locale];
    adminRoutes();
    const { container } = await renderRouteWithCache("/admin/models", lastStubRoutes(), { locale });
    // One frame: no inner navigation (the sidebar's admin context navigates)
    expect(template("ListPage")).not.toBeNull();
    expect(container.querySelector(".cb-settings-nav")).toBeNull();
    const table = await screen.findByRole("table", { name: "alpha" });
    const large = within(table).getByText("Alpha Large").closest("tr") as HTMLElement;
    // Capabilities are text, not badges (「工具 · 图片 · 推理」), one no-break unit per item
    const caps = [m.models.capability.tools, m.models.capability.vision];
    // the model name wraps too; the capabilities cell is the wrapping list
    const capsCell = [...large.querySelectorAll('td[data-wrap="true"]')].find((td) =>
      td.querySelector('[data-part="cell-list-item"]'),
    ) as HTMLElement;
    expect(capsCell.textContent).toBe([...caps, m.models.capability.reasoning].join(" · "));
    expect(
      [...capsCell.querySelectorAll('[data-part="cell-list-item"]')].map((i) => i.textContent),
    ).toEqual([`${caps[0]} ·`, `${caps[1]} ·`, m.models.capability.reasoning]);
    // Capabilities are never cut to 「工具 ·…」: the cell wraps instead of an ellipsis
    expect(capsCell.getAttribute("data-wrap")).toBe("true");
    // The price columns are narrowed to their figures so the table fits the 1120 content width
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const th = within(table).getByRole("columnheader", { name: m.models.admin.columns[k] });
      expect(th.style.width).toBe("80px");
    }
    // The model column keeps a 240 px minimum so names are not cut to 「deepseek/dee」
    const head = within(table).getByRole("columnheader", { name: m.models.admin.columns.model });
    expect(head.style.width).toBe("240px");
    expect(within(large).getByText("200,000")).toBeTruthy();
    expect(within(large).getByText("3")).toBeTruthy();
    expect(within(large).getByText("15")).toBeTruthy();
    expect(within(large).getByText("0.3")).toBeTruthy();
    expect(within(large).getByText(m.models.admin.sameAsInput)).toBeTruthy();
    const small = within(table).getByText("Alpha Small").closest("tr") as HTMLElement;
    expect(within(small).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    // 币种来自部署设置，价格标为估算依据（C2）
    expect(
      screen.getByText(fill(m.models.admin.providers.description, { currency: "EUR" })),
    ).toBeTruthy();
  });

  it.each(LOCALES)("某个供应商出错：显示错误，不影响其他供应商（%s）", async (locale) => {
    const m = msgs[locale];
    adminRoutes();
    await renderRouteWithCache("/admin/models", lastStubRoutes(), { locale });
    expect(await screen.findByRole("table", { name: "alpha" })).toBeTruthy();
    // The list marks the failed provider; its error is the detail once it is opened
    const list = screen.getByRole("table", { name: m.models.providers.label });
    const row = within(list).getByText("broken").closest("tr") as HTMLElement;
    expect(within(row).getByText(m.models.providers.failed)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(row);
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(window.location.search).toBe("?provider=broken");
    expect(screen.queryByRole("table", { name: "alpha" })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "broken" })).toBeTruthy();
    // One sentence in the reader's language, the kernel's text behind 「原始错误」 (ErrorDetail)
    expect(
      screen.getByText(fill(m.models.admin.providerError, { provider: "broken" })),
    ).toBeTruthy();
    expect(screen.queryByText(BROKEN.error)).toBeNull();
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(BROKEN.error)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "broken" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: m.models.catalog.search })).toBeNull();
  });

  it.each(LOCALES)(
    "行内编辑价格 → PUT /admin/model-prices，行内显示新价格（%s）",
    async (locale) => {
      const m = msgs[locale];
      const p = m.models.admin.price;
      const next = {
        provider: "alpha",
        model: "alpha-small",
        inputPerMTok: 0.25,
        outputPerMTok: 1.25,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      };
      const calls = adminRoutes({
        "PUT /api/v1/admin/model-prices": () =>
          json(200, { prices: [PRICE, next], currency: "EUR" }),
      });
      await renderRouteWithCache("/admin/models", lastStubRoutes(), { locale });
      const table = await screen.findByRole("table", { name: "alpha" });
      const row = () => within(table).getByText("Alpha Small").closest("tr") as HTMLElement;
      const user = userEvent.setup();
      await user.click(within(row()).getByRole("button", { name: ROW_ACTIONS[locale] }));
      await user.click(
        await screen.findByRole("menuitem", { name: m.models.admin.menu.editPrice }),
      );
      await user.type(await screen.findByRole("textbox", { name: p.input }), "0.25");
      await user.type(screen.getByRole("textbox", { name: p.output }), "1.25");
      await user.click(
        screen.getByRole("button", { name: fill(p.saveLabel, { model: "Alpha Small" }) }),
      );
      await vi.waitFor(() => expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual(next));
      expect(await screen.findByText(fill(p.saved, { model: "Alpha Small" }))).toBeTruthy();
      await vi.waitFor(() => expect(screen.queryByRole("textbox", { name: p.input })).toBeNull());
      expect(within(row()).getByText("0.25")).toBeTruthy();
      expect(within(row()).getByText("1.25")).toBeTruthy();
    },
  );

  it("价格不合法：保存不可用、不发请求；留空输出价也不行", async () => {
    const p = en.models.admin.price;
    const calls = adminRoutes();
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    const table = await screen.findByRole("table", { name: "alpha" });
    const row = within(table).getByText("Alpha Small").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(await screen.findByRole("menuitem", { name: en.models.admin.menu.editPrice }));
    await user.type(await screen.findByRole("textbox", { name: p.input }), "-1");
    const save = screen.getByRole("button", { name: fill(p.saveLabel, { model: "Alpha Small" }) });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(`${p.invalid}`)).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: p.input }));
    await user.type(screen.getByRole("textbox", { name: p.input }), "1");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("清除价格 → PUT price: null", async () => {
    const calls = adminRoutes({
      "PUT /api/v1/admin/model-prices": () => json(200, { prices: [], currency: "EUR" }),
    });
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    const table = await screen.findByRole("table", { name: "alpha" });
    const row = () => within(table).getByText("Alpha Large").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(row()).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(
      await screen.findByRole("menuitem", { name: en.models.admin.menu.clearPrice }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        provider: "alpha",
        model: "alpha-large",
        price: null,
      }),
    );
    await vi.waitFor(() => expect(within(row()).queryByText("15")).toBeNull());
  });

  it.each(LOCALES)(
    "用途默认映射：插件用途旁注、eval 未映射提示；设默认 → PUT，提示消失（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = adminRoutes({
        "PUT /api/v1/admin/model-purposes/eval": (c) => {
          const t = (bodyOf(c) as { target: unknown }).target;
          return json(200, { purpose: evalView({ default: t, effective: t }) });
        },
      });
      await renderRouteWithCache("/admin/models?tab=purposes", lastStubRoutes(), { locale });
      expect(await screen.findByText(m.models.evalUnmapped)).toBeTruthy();
      // The eval row carries the warning (a warn line with its icon), not a line above the rows
      expect((await purposeBox("eval")).getByText(m.models.evalUnmapped)).toBeTruthy();
      const plugin = await purposeBox("notes.summarize");
      expect(plugin.getByText(m.models.purpose.pluginNote)).toBeTruthy();
      // An extension's purpose names the extension by its display name
      expect(
        plugin.getByText(
          fill(m.models.purpose.declaredByPlugin, { plugin: locale === "zh" ? "笔记" : "Notes" }),
        ),
      ).toBeTruthy();
      const ev = await purposeBox("eval");
      expect(ev.queryByText(m.models.purpose.pluginNote)).toBeNull();
      // A kernel purpose has no source line, only what happens while it is unset
      expect(ev.getByText(m.models.purpose.hint.eval)).toBeTruthy();
      // Purpose ids are internal: never on the page
      expect(document.querySelector('[data-part="item-list-code"]')).toBeNull();
      expect(document.body.textContent).not.toContain("notes.summarize");
      // No save per purpose: the page has one ActionRow, shown once something changed
      expect(ev.queryByRole("button")).toBeNull();
      expect(document.querySelector('[data-part="action-row"]')).toBeNull();
      const user = userEvent.setup();
      await pickOption(
        ev.getByRole("combobox", { name: m.models.purpose.model }),
        "alpha/alpha-large",
        user,
      );
      // 选中模型后出现它的参数（复用 ModelParams）
      const effort = ev.getByRole("radiogroup", { name: locale === "zh" ? "思考深度" : "Effort" });
      await user.click(within(effort).getByRole("radio", { name: m.agents.params.effort.high }));
      expect(actionRow().getByText(fill(UNSAVED[locale], { n: 1 }))).toBeTruthy();
      await user.click(actionRow().getByRole("button", { name: m.models.purpose.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
          target: target("alpha-large", { effort: "high" }),
        }),
      );
      // Only the changed purpose is written
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
      await vi.waitFor(() => expect(screen.queryByText(m.models.evalUnmapped)).toBeNull());
      expect(await screen.findByText(SAVED_ONE[locale])).toBeTruthy();
      await vi.waitFor(() => expect(document.querySelector('[data-part="action-row"]')).toBeNull());
    },
  );

  it("validation_failed：参数错误显示在对应参数下", async () => {
    adminRoutes({
      "PUT /api/v1/admin/model-purposes/eval": () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "invalid",
            details: [{ path: "target.params.effort", message: "bad" }],
          },
        }),
    });
    await renderRouteWithCache("/admin/models?tab=purposes", lastStubRoutes());
    const ev = await purposeBox("eval");
    const user = userEvent.setup();
    await pickOption(
      ev.getByRole("combobox", { name: en.models.purpose.model }),
      "alpha/alpha-large",
      user,
    );
    await user.click(
      within(ev.getByRole("radiogroup", { name: "Effort" })).getByRole("radio", { name: "Low" }),
    );
    await user.click(actionRow().getByRole("button", { name: en.models.purpose.save }));
    expect(await ev.findByText(`${en.agents.params.invalid}`)).toBeTruthy();
    // The failed purpose stays changed: the ActionRow keeps it and counts the error
    expect(actionRow().getByText(fill(UNSAVED.en, { n: 1 }))).toBeTruthy();
  });

  it("非超级管理员：没有访问权限，不请求后台接口", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/admin/models", lastStubRoutes(), { me: NOT_ADMIN });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    expect(calls).toEqual([]);
  });
});

describe("one box is enough (acceptance item AB)", () => {
  const noNested = () => expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);

  it("/admin/models 用途默认: the purposes are rows of one flush card", async () => {
    adminRoutes();
    await renderRouteWithCache("/admin/models?tab=purposes", lastStubRoutes());
    await purposeBox("eval");
    const purposes = document.getElementById("purposes") as HTMLElement;
    // the tab's one section: its head above the card, no side label column
    expect(purposes.getAttribute("data-layout")).toBe("stacked");
    const card = purposes.querySelector('[data-part="form-card"]') as HTMLElement;
    expect(card.getAttribute("data-flush")).toBe("true");
    // rows, not cards: one flush ItemList holding a row per purpose
    expect(card.querySelector('[data-part="card"]')).toBeNull();
    const list = within(card).getByRole("list", { name: en.models.admin.purposes.title });
    expect(list.getAttribute("data-inset")).toBe("flush");
    expect(list.querySelectorAll(':scope > [data-part="item-list-row"]')).toHaveLength(2);
    // the purpose's row is a group named by its title, the model select one of its fields
    const row = screen.getByRole("group", { name: "Eval judge" });
    expect(within(row).getByRole("combobox", { name: en.models.purpose.model })).toBeTruthy();
    // the models tab is not drawn
    expect(screen.queryByRole("table", { name: en.models.providers.label })).toBeNull();
    noNested();
  });

  it("/admin/models 模型: the providers beside the open one's kinds, no card around them", async () => {
    adminRoutes();
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    const list = await screen.findByRole("table", { name: en.models.providers.label });
    const grid = list.closest('[data-columns="list-detail"]') as HTMLElement;
    expect(grid.getAttribute("data-divided")).toBe("true");
    // no form card: the grid sits on the page ground
    expect(document.querySelector('[data-part="form-card"]')).toBeNull();
    // one row per provider, the first open
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-row-key"))).toEqual(["alpha", "broken"]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(within(rows[0] as HTMLElement).getByText("2")).toBeTruthy();
    // the detail: the name as an h3, then a divided subsection per kind over its table
    const detail = grid.children[1] as HTMLElement;
    expect(within(detail).getByRole("heading", { level: 3, name: "alpha" })).toBeTruthy();
    const chat = within(detail).getByRole("region", { name: en.models.kind.chat });
    expect(chat.getAttribute("data-variant")).toBe("divided");
    // its count and bulk switches sit in the heading row, not in a table toolbar
    expect(chat.querySelector('[data-part="table-toolbar"]')).toBeNull();
    const head = chat.querySelector('[data-part="subsection-head"]') as HTMLElement;
    expect(within(head).getByText("2")).toBeTruthy();
    // both bulk buttons share one variant: a disabled one reads as off, never as the primary
    const bulk = [en.models.catalog.turnAllOff, en.models.catalog.turnAllOn].map((name) =>
      within(head).getByRole("button", { name }),
    );
    expect(bulk.map((b) => b.getAttribute("data-variant"))).toEqual(["default", "default"]);
    // the model name wraps inside its cell, which never widens the table (not a wrap column)
    const name = within(chat).getByText("Alpha Large");
    expect(name.getAttribute("data-pre")).toBe("true");
    expect(name.closest("td")?.getAttribute("data-wrap")).toBeNull();
    expect(within(chat).getByRole("table", { name: "alpha" })).toBeTruthy();
    noNested();
  });

  it("/admin/models while loading: the providers grid with loading tables", async () => {
    stubApi({
      "GET /api/v1/admin/models": () => new Promise<Response>(() => {}),
      "GET /api/v1/admin/model-purposes": () => new Promise<Response>(() => {}),
    });
    await renderRouteEmptyCache("/admin/models", lastStubRoutes());
    const grid = await vi.waitFor(() => {
      const el = document.querySelector('[data-columns="list-detail"]');
      if (el === null) throw new Error("no loading grid yet");
      return el as HTMLElement;
    });
    expect(grid.getAttribute("data-divided")).toBe("true");
    expect(grid.querySelectorAll('[data-part="table"]')).toHaveLength(2);
    // the loaded chat table's header is there (drawn, hidden from the accessibility tree)
    const heads = [...grid.querySelectorAll("th")].map((th) => th.textContent);
    expect(heads).toContain(en.models.admin.columns.input);
    noNested();
  });

  it("/settings/models 用途默认: the purposes are rows of one flush card", async () => {
    resetNavigation("/settings/models");
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: [evalView()] }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
    });
    await renderRouteWithCache("/settings/models?tab=purposes", lastStubRoutes());
    const ev = await purposeBox("eval");
    expect(ev.getByText(en.models.evalUnmapped)).toBeTruthy();
    const card = document.querySelector('#purposes [data-part="form-card"]') as HTMLElement;
    expect(card.getAttribute("data-flush")).toBe("true");
    expect(card.querySelector('[data-part="card"]')).toBeNull();
    noNested();
  });

  it("/settings/models 模型: the org's providers beside the open one's models", async () => {
    resetNavigation("/settings/models");
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: [evalView()] }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [ALPHA, BROKEN] }),
      "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
    });
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    // beside the settings nav there is no providers column: a select picks the provider
    const picker = await screen.findByRole("combobox", { name: en.models.providers.label });
    expect(document.querySelector('[data-columns="list-detail"]')).toBeNull();
    expect(screen.queryByRole("table", { name: en.models.providers.label })).toBeNull();
    expect(screen.queryByRole("heading", { level: 3, name: "alpha" })).toBeNull();
    expect(picker.textContent).toContain("alpha · 2 models");
    expect(screen.getByRole("table", { name: "alpha" })).toBeTruthy();
    // a failed provider is marked among the options and shows its error once picked
    const user = userEvent.setup();
    await pickOption(picker, "broken", user);
    expect(window.location.search).toBe("?provider=broken");
    expect(screen.getByRole("combobox", { name: en.models.providers.label }).textContent).toContain(
      fill(en.models.providers.optionFailed, { name: "broken" }),
    );
    expect(
      screen.getByText(fill(en.models.admin.providerError, { provider: "broken" })),
    ).toBeTruthy();
    noNested();
  });
});

describe("provider icons (maintainer decision 2026-11-08)", () => {
  it("/admin/models: a provider row draws its plugin's icon, one without its initial", async () => {
    const icon = "/api/v1/admin/catalog/items/i1/icon?v=1.0.0";
    adminRoutes({
      "GET /api/v1/admin/models": () =>
        json(200, {
          ...ADMIN_MODELS,
          providers: [
            { ...ALPHA, icon },
            { ...BROKEN, icon: null },
          ],
        }),
    });
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    const table = await screen.findByRole("table", { name: en.models.providers.label });
    const tiles = [...table.querySelectorAll<HTMLElement>(".cb-cell-initial")];
    expect(tiles).toHaveLength(2);
    const img = tiles[0]?.querySelector('img[data-part="mark-image"]');
    expect(img?.getAttribute("src")).toBe(icon);
    expect(img?.getAttribute("alt")).toBe("");
    expect(tiles[1]?.querySelector("img")).toBeNull();
    expect(tiles[1]?.textContent).toBe("B");
  });

  it("/settings/models: the provider select is led by the open provider's icon", async () => {
    resetNavigation("/settings/models");
    const icon = "/api/v1/orgs/o1/catalog/i1/icon?v=1.0.0";
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: [evalView()] }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/models/catalog": () =>
        json(200, { providers: [{ ...ALPHA, icon }, BROKEN] }),
      "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
    });
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    await screen.findByRole("combobox", { name: en.models.providers.label });
    const mark = document.querySelector('[data-part="object-mark"]') as HTMLElement;
    expect(mark.querySelector("img")?.getAttribute("src")).toBe(icon);
    // the failed one has no icon: the initial
    await pickOption(
      screen.getByRole("combobox", { name: en.models.providers.label }),
      "broken",
      userEvent.setup(),
    );
    const after = document.querySelector('[data-part="object-mark"]') as HTMLElement;
    expect(after.querySelector("img")).toBeNull();
    expect(after.textContent).toBe("B");
  });
});

describe("sub-agent model tiers on the purposes page", () => {
  it.each(LOCALES)("the three tiers are listed with the fallback hint (%s)", async (locale) => {
    const m = msgs[locale];
    resetNavigation("/settings/models");
    const tier = (purpose: string, en: string) => evalView({ purpose, label: { zh: en, en } });
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () =>
        json(200, {
          purposes: [
            evalView(),
            tier("subagent_fast", "Sub-agent: fast"),
            tier("subagent_standard", "Sub-agent: standard"),
            tier("subagent_capable", "Sub-agent: capable"),
          ],
        }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
    });
    await renderRouteWithCache("/settings/models?tab=purposes", lastStubRoutes(), { locale });
    const box = (p: string) =>
      vi.waitFor(() => {
        const el = purposeRow(p);
        if (!el) throw new Error(`no purpose ${p}`);
        return el;
      });
    for (const p of ["subagent_fast", "subagent_standard", "subagent_capable"]) {
      expect((await box(p)).textContent).toContain(m.models.purpose.subagentHint);
    }
    expect((await box("eval")).textContent).not.toContain(m.models.purpose.subagentHint);
  });

  it.each(LOCALES)("the title purpose says what happens while it is unset (%s)", async (locale) => {
    const m = msgs[locale];
    resetNavigation("/settings/models");
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () =>
        json(200, {
          purposes: [
            evalView({ purpose: "title", label: { zh: "会话标题", en: "Conversation titles" } }),
          ],
        }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
    });
    await renderRouteWithCache("/settings/models?tab=purposes", lastStubRoutes(), { locale });
    expect((await purposeBox("title")).getByText(m.models.purpose.hint.titles)).toBeTruthy();
  });
});

describe("/settings/models（组织管理员）", () => {
  const orgRoutes = (purposes: unknown[], extra: Record<string, (c: Call) => Response> = {}) =>
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/models/catalog": () => json(200, { providers: [ALPHA] }),
      "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
      ...extra,
    });

  it.each(LOCALES)(
    "显示部署默认；覆盖 → PUT 组织接口；恢复默认 → target null（%s）",
    async (locale) => {
      const m = msgs[locale];
      const def = target("alpha-small");
      resetNavigation("/settings/models");
      const calls = orgRoutes([evalView({ default: def, effective: def })], {
        "PUT /api/v1/orgs/o1/model-purposes/eval": (c) => {
          const t = (bodyOf(c) as { target: unknown }).target;
          return json(200, {
            purpose: evalView({ default: def, override: t, effective: t ?? def }),
          });
        },
      });
      const { container } = await renderRouteWithCache(
        "/settings/models?tab=purposes",
        lastStubRoutes(),
        { locale },
      );
      expect(template("SettingsPage")).not.toBeNull();
      const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.models);
      expect(current?.getAttribute("href")).toBe("/settings/models");
      const ev = await purposeBox("eval");
      // The deployment default rides on the select's default option, not a line of its own
      const defText = fill(m.models.purpose.useDefault, { target: "alpha / Alpha Small" });
      const select = () => ev.getByRole("combobox", { name: m.models.purpose.model });
      expect(select().textContent).toContain(defText);
      expect(ev.queryByText(m.models.purpose.overridden)).toBeNull();
      expect(ev.queryByRole("button")).toBeNull();
      const user = userEvent.setup();
      await pickOption(
        ev.getByRole("combobox", { name: m.models.purpose.model }),
        "alpha/alpha-large",
        user,
      );
      await user.click(actionRow().getByRole("button", { name: m.models.purpose.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
          target: target("alpha-large"),
        }),
      );
      const overridden = await ev.findByText(m.models.purpose.overridden);
      // the answer is written into the cached purposes: nothing is read again
      expect(calls.filter((c) => c.method === "GET")).toEqual([]);
      // A state reads as muted text, never an accent badge
      expect(overridden.closest(".cb-badge")).toBeNull();
      // Restoring the default is choosing 「使用部署默认」 and saving
      await pickOption(ev.getByRole("combobox", { name: m.models.purpose.model }), "", user);
      await user.click(actionRow().getByRole("button", { name: m.models.purpose.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.filter((c) => c.method === "PUT")[1])).toEqual({ target: null }),
      );
      await vi.waitFor(() => expect(ev.queryByText(m.models.purpose.overridden)).toBeNull());
      expect(
        (ev.getByRole("combobox", { name: m.models.purpose.model }) as HTMLButtonElement).value,
      ).toBe("");
      expect(select().textContent).toContain(defText);
    },
  );

  it("部署默认未设置、组织也未覆盖：显示 eval 未映射提示", async () => {
    resetNavigation("/settings/models");
    orgRoutes([evalView()]);
    await renderRouteWithCache("/settings/models?tab=purposes", lastStubRoutes());
    expect(await screen.findByText(en.models.evalUnmapped)).toBeTruthy();
    const ev = await purposeBox("eval");
    expect(ev.getByRole("combobox", { name: en.models.purpose.model }).textContent).toContain(
      fill(en.models.purpose.useDefault, { target: en.models.purpose.unset }),
    );
  });

  it("设置导航：管理员看到「模型用途」", async () => {
    resetNavigation("/settings/models");
    orgRoutes([evalView()]);
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    expect(await screen.findByRole("link", { name: en.connections.nav.models })).toBeTruthy();
  });
});
