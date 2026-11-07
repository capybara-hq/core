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

/** A purpose's row (an ItemListItem, never a card): the row whose mono id is `purpose`. */
const purposeRow = (purpose: string): HTMLElement | null => {
  const code = [...document.querySelectorAll('[data-part="item-list-code"]')].find(
    (el) => el.textContent === purpose,
  );
  return (code?.closest('[data-part="item-list-row"]') as HTMLElement | null) ?? null;
};

const purposeBox = async (purpose: string) =>
  within(
    await vi.waitFor(() => {
      const el = purposeRow(purpose);
      if (!el) throw new Error(`no purpose ${purpose}`);
      return el;
    }),
  );

beforeEach(() => resetNavigation("/admin/models"));
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
    const capsCell = large.querySelector('td[data-wrap="true"]') as HTMLElement;
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
    expect(
      screen.getByText(fill(m.models.admin.providerError, { provider: "broken" }), {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.getByText(BROKEN.error, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "broken" })).toBeNull();
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
      await renderRouteWithCache("/admin/models", lastStubRoutes(), { locale });
      expect(await screen.findByText(m.models.evalUnmapped)).toBeTruthy();
      // The eval row carries the warning (a warn line with its icon), not a line above the rows
      expect((await purposeBox("eval")).getByText(m.models.evalUnmapped)).toBeTruthy();
      const plugin = await purposeBox("notes.summarize");
      expect(plugin.getByText(m.models.purpose.pluginNote)).toBeTruthy();
      expect(
        plugin.getByText(fill(m.models.purpose.declaredByPlugin, { plugin: "notes" })),
      ).toBeTruthy();
      const ev = await purposeBox("eval");
      expect(ev.queryByText(m.models.purpose.pluginNote)).toBeNull();
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
    await renderRouteWithCache("/admin/models", lastStubRoutes());
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

  it("/admin/models: the purposes are rows of one flush card; each provider a flush subsection over its unframed table", async () => {
    adminRoutes();
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    await purposeBox("eval");
    const purposes = document.getElementById("purposes") as HTMLElement;
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
    // the providers: a flush card, one flush subsection (an h3) per provider
    const providers = document.getElementById("providers") as HTMLElement;
    const pcard = providers.querySelector('[data-part="form-card"]') as HTMLElement;
    expect(pcard.getAttribute("data-flush")).toBe("true");
    const alpha = within(pcard).getByRole("region", { name: "alpha" });
    expect(alpha.getAttribute("data-variant")).toBe("flush");
    expect(within(alpha).getByRole("heading", { level: 3, name: "alpha" })).toBeTruthy();
    expect(within(alpha).getByRole("table", { name: "alpha" })).toBeTruthy();
    // the failed provider says so under its heading, with no table
    const broken = within(pcard).getByRole("region", { name: "broken" });
    // the error is a block under the heading: the message in body size, the detail on its own row
    const alert = within(broken).getByRole("alert");
    expect(alert.closest('[data-part="subsection-description"]')?.tagName).toBe("DIV");
    const lines = [...alert.querySelectorAll(".cb-text")];
    expect(lines.map((l) => l.getAttribute("data-variant"))).toEqual(["body", "small"]);
    expect(lines[1]?.textContent).toBe(BROKEN.error);
    expect(within(broken).queryByRole("table")).toBeNull();
    noNested();
  });

  it("/admin/models while loading: the providers card holds a heading row over the table", async () => {
    stubApi({
      "GET /api/v1/admin/models": () => new Promise<Response>(() => {}),
      "GET /api/v1/admin/model-purposes": () => new Promise<Response>(() => {}),
    });
    await renderRouteEmptyCache("/admin/models", lastStubRoutes());
    const card = await vi.waitFor(() => {
      const el = document.querySelector('#providers [data-part="form-card"]');
      if (el === null) throw new Error("no loading card yet");
      return el as HTMLElement;
    });
    expect(card.getAttribute("data-flush")).toBe("true");
    const sub = card.querySelector('[data-part="subsection"]') as HTMLElement;
    expect(sub.getAttribute("data-variant")).toBe("flush");
    expect(
      sub.querySelector('[data-part="subsection-title"] [data-part="skeleton-text"]'),
    ).not.toBeNull();
    expect(sub.querySelector('[data-part="table"]')).not.toBeNull();
    noNested();
  });

  it("/settings/models: the purposes are rows of one flush card", async () => {
    resetNavigation("/settings/models");
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: [evalView()] }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
    });
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    const ev = await purposeBox("eval");
    expect(ev.getByText(en.models.evalUnmapped)).toBeTruthy();
    const card = document.querySelector('#purposes [data-part="form-card"]') as HTMLElement;
    expect(card.getAttribute("data-flush")).toBe("true");
    expect(card.querySelector('[data-part="card"]')).toBeNull();
    noNested();
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
    });
    await renderRouteWithCache("/settings/models", lastStubRoutes(), { locale });
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
});

describe("/settings/models（组织管理员）", () => {
  const orgRoutes = (purposes: unknown[], extra: Record<string, (c: Call) => Response> = {}) =>
    stubApi({
      "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes }),
      "GET /api/v1/orgs/o1/models": () => json(200, { providers: [ALPHA] }),
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
      const { container } = await renderRouteWithCache("/settings/models", lastStubRoutes(), {
        locale,
      });
      expect(template("SettingsPage")).not.toBeNull();
      const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.models);
      expect(current?.getAttribute("href")).toBe("/settings/models");
      const ev = await purposeBox("eval");
      const defText = fill(m.models.purpose.deploymentDefault, { target: "alpha / Alpha Small" });
      expect(ev.getByText(defText)).toBeTruthy();
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
      expect(ev.getByText(defText)).toBeTruthy();
    },
  );

  it("部署默认未设置、组织也未覆盖：显示 eval 未映射提示", async () => {
    resetNavigation("/settings/models");
    orgRoutes([evalView()]);
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    expect(await screen.findByText(en.models.evalUnmapped)).toBeTruthy();
    const ev = await purposeBox("eval");
    expect(
      ev.getByText(fill(en.models.purpose.deploymentDefault, { target: en.models.purpose.unset })),
    ).toBeTruthy();
  });

  it("设置导航：管理员看到「模型用途」", async () => {
    resetNavigation("/settings/models");
    orgRoutes([evalView()]);
    await renderRouteWithCache("/settings/models", lastStubRoutes());
    expect(await screen.findByRole("link", { name: en.connections.nav.models })).toBeTruthy();
  });
});
