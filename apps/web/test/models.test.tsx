import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import AdminModelsPage from "../src/app/[locale]/(app)/admin/models/page";
import OrgModelsPage from "../src/app/[locale]/(app)/settings/models/page";
import { activeNavOf } from "../src/components/shell/nav";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const ROW_ACTIONS = { zh: "行操作", en: "Row actions" } as const;
const NOT_ADMIN: Me = { ...ME, account: { ...ME.account, isEnterpriseAdmin: false } };
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

const purposeBox = async (purpose: string) =>
  within(
    await vi.waitFor(() => {
      const el = document.querySelector(`[data-purpose="${purpose}"]`);
      if (!el) throw new Error(`no purpose ${purpose}`);
      return el as HTMLElement;
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

describe("/admin/models（SettingsPage）", () => {
  it.each(LOCALES)("供应商、模型的能力、上下文长度与价格（%s）", async (locale) => {
    const m = msgs[locale];
    adminRoutes();
    const { container } = renderPage(<AdminModelsPage />, { locale });
    expect(template("SettingsPage")).not.toBeNull();
    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe(m.admin.nav.models);
    expect(current?.getAttribute("href")).toBe("/admin/models");
    const table = await screen.findByRole("table", { name: "alpha" });
    const large = within(table).getByText("Alpha Large").closest("tr") as HTMLElement;
    expect(within(large).getByText(m.models.capability.vision)).toBeTruthy();
    expect(within(large).getByText(m.models.capability.reasoning)).toBeTruthy();
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
    renderPage(<AdminModelsPage />, { locale });
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
      renderPage(<AdminModelsPage />, { locale });
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
    renderPage(<AdminModelsPage />);
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
    renderPage(<AdminModelsPage />);
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
      renderPage(<AdminModelsPage />, { locale });
      expect(await screen.findByText(m.models.evalUnmapped)).toBeTruthy();
      const plugin = await purposeBox("notes.summarize");
      expect(plugin.getByText(m.models.purpose.pluginNote)).toBeTruthy();
      expect(
        plugin.getByText(fill(m.models.purpose.declaredByPlugin, { plugin: "notes" })),
      ).toBeTruthy();
      const ev = await purposeBox("eval");
      expect(ev.queryByText(m.models.purpose.pluginNote)).toBeNull();
      const user = userEvent.setup();
      await user.selectOptions(
        ev.getByRole("combobox", { name: m.models.purpose.model }),
        "alpha/alpha-large",
      );
      // 选中模型后出现它的参数（复用 ModelParams）
      const effort = ev.getByRole("radiogroup", { name: locale === "zh" ? "思考深度" : "Effort" });
      await user.click(within(effort).getByRole("radio", { name: m.agents.params.effort.high }));
      await user.click(
        ev.getByRole("button", { name: fill(m.models.purpose.saveLabel, { purpose: "eval" }) }),
      );
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
          target: target("alpha-large", { effort: "high" }),
        }),
      );
      await vi.waitFor(() => expect(screen.queryByText(m.models.evalUnmapped)).toBeNull());
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
    renderPage(<AdminModelsPage />);
    const ev = await purposeBox("eval");
    const user = userEvent.setup();
    await user.selectOptions(
      ev.getByRole("combobox", { name: en.models.purpose.model }),
      "alpha/alpha-large",
    );
    await user.click(
      within(ev.getByRole("radiogroup", { name: "Effort" })).getByRole("radio", { name: "Low" }),
    );
    await user.click(
      ev.getByRole("button", { name: fill(en.models.purpose.saveLabel, { purpose: "eval" }) }),
    );
    expect(await ev.findByText(`${en.agents.params.invalid}`)).toBeTruthy();
  });

  it("非企业管理员：StatusPage 403，不请求后台接口", () => {
    const calls = stubApi({});
    renderPage(<AdminModelsPage />, { me: NOT_ADMIN });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("403");
    expect(calls).toEqual([]);
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
      const { container } = renderPage(<OrgModelsPage />, { locale });
      expect(template("SettingsPage")).not.toBeNull();
      const current = container.querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe(m.connections.nav.models);
      expect(current?.getAttribute("href")).toBe("/settings/models");
      const ev = await purposeBox("eval");
      const defText = fill(m.models.purpose.deploymentDefault, { target: "alpha / Alpha Small" });
      expect(ev.getByText(defText)).toBeTruthy();
      expect(ev.queryByText(m.models.purpose.overridden)).toBeNull();
      expect(
        ev.queryByRole("button", {
          name: fill(m.models.purpose.restoreLabel, { purpose: "eval" }),
        }),
      ).toBeNull();
      const user = userEvent.setup();
      await user.selectOptions(
        ev.getByRole("combobox", { name: m.models.purpose.model }),
        "alpha/alpha-large",
      );
      await user.click(
        ev.getByRole("button", { name: fill(m.models.purpose.saveLabel, { purpose: "eval" }) }),
      );
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
          target: target("alpha-large"),
        }),
      );
      expect(await ev.findByText(m.models.purpose.overridden)).toBeTruthy();
      await user.click(
        ev.getByRole("button", { name: fill(m.models.purpose.restoreLabel, { purpose: "eval" }) }),
      );
      await vi.waitFor(() =>
        expect(bodyOf(calls.filter((c) => c.method === "PUT")[1])).toEqual({ target: null }),
      );
      await vi.waitFor(() => expect(ev.queryByText(m.models.purpose.overridden)).toBeNull());
      expect(
        (ev.getByRole("combobox", { name: m.models.purpose.model }) as HTMLSelectElement).value,
      ).toBe("");
      expect(ev.getByText(defText)).toBeTruthy();
    },
  );

  it("部署默认未设置、组织也未覆盖：显示 eval 未映射提示", async () => {
    resetNavigation("/settings/models");
    orgRoutes([evalView()]);
    renderPage(<OrgModelsPage />);
    expect(await screen.findByText(en.models.evalUnmapped)).toBeTruthy();
    const ev = await purposeBox("eval");
    expect(
      ev.getByText(fill(en.models.purpose.deploymentDefault, { target: en.models.purpose.unset })),
    ).toBeTruthy();
  });

  it("设置导航：管理员看到「模型用途」", async () => {
    resetNavigation("/settings/models");
    orgRoutes([evalView()]);
    renderPage(<OrgModelsPage />);
    expect(await screen.findByRole("link", { name: en.connections.nav.models })).toBeTruthy();
  });
});
