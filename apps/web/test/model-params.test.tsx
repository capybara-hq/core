import { DesignProvider } from "@capybara-hq/design";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ModelParams } from "../src/components/ModelParams";
import type { ModelParameter, ParamValue } from "../src/lib/agents";
import { agentFormDefaults, renderEditAgent } from "./support/agents";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { optionValues, pickOption } from "./support/select";
import { sessionRoutes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const EFFORT: ModelParameter = {
  key: "effort",
  standard: "effort",
  schema: { type: "string", enum: ["low", "medium", "high"] },
  label: { zh: "思考深度", en: "Effort" },
  description: { zh: "越高越慢", en: "Higher is slower" },
};
const THINKING: ModelParameter = {
  key: "thinking",
  standard: "thinking",
  schema: { type: "string", enum: ["off", "on"] },
  default: "on",
  label: { zh: "思考模式", en: "Thinking" },
};
const TEMPERATURE: ModelParameter = {
  key: "temperature",
  standard: "temperature",
  schema: { type: "number", minimum: 0, maximum: 2 },
  default: 1,
  label: { zh: "温度", en: "Temperature" },
};
const MAX_TOKENS: ModelParameter = {
  key: "maxOutputTokens",
  standard: "maxOutputTokens",
  schema: { type: "integer", minimum: 1, maximum: 8192 },
  label: { zh: "最大输出", en: "Max output tokens" },
};
const STYLE: ModelParameter = {
  key: "model-fake.style",
  schema: { type: "string", enum: ["plain", "shout"] },
  label: { zh: "回复风格", en: "Reply style" },
  description: { zh: "shout 时回复全部转大写", en: "shout upper-cases the whole reply" },
};
const SEARCH: ModelParameter = {
  key: "model-fake.search",
  schema: { type: "boolean" },
  label: { zh: "联网搜索", en: "Web search" },
};
const TOP_K: ModelParameter = {
  key: "model-fake.topK",
  schema: { type: "integer", minimum: 1, maximum: 50 },
  label: { zh: "Top K", en: "Top K" },
};
/** 声明子集之外的 schema（例如插件升级后界面还不认识的类型）：渲染为文本框。 */
const ODD = {
  key: "model-fake.odd",
  schema: { type: "object" },
  label: { zh: "奇怪参数", en: "Odd parameter" },
} as unknown as ModelParameter;
/** 只有 en 文案时回退到 en。 */
const EN_ONLY = {
  key: "model-fake.tag",
  schema: { type: "string", maxLength: 10 },
  label: { en: "Tag" },
} as unknown as ModelParameter;

function Harness({
  parameters,
  locale,
  onChange,
}: {
  parameters: ModelParameter[];
  locale: "zh" | "en";
  onChange: (v: Record<string, ParamValue>) => void;
}) {
  const [value, setValue] = useState<Record<string, ParamValue>>({});
  return (
    <Providers locale={locale}>
      <ModelParams
        parameters={parameters}
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        locale={locale}
      />
    </Providers>
  );
}

function Providers({ locale, children }: { locale: "zh" | "en"; children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <DesignProvider locale={locale}>{children}</DesignProvider>
    </NextIntlClientProvider>
  );
}

/** 设计系统 Field 的「恢复默认」链接文案（design 包 i18n 的 field.reset）。 */
const RESET = { zh: "↺ 恢复默认", en: "↺ Reset to default" } as const;

beforeEach(() => resetNavigation("/agents/new"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const paramBox = (control: HTMLElement) => control.closest("[data-param]") as HTMLElement;

describe("ModelParams", () => {
  it("标准旋钮渲染专门控件：effort / thinking 分段按钮（按声明顺序），temperature 滑块加数字框，maxOutputTokens 数字框", async () => {
    const onChange = vi.fn();
    render(
      <Harness
        parameters={[EFFORT, THINKING, TEMPERATURE, MAX_TOKENS]}
        locale="en"
        onChange={onChange}
      />,
    );
    const effort = screen.getByRole("radiogroup", { name: "Effort" });
    expect(
      within(effort)
        .getAllByRole("radio")
        .map((b) => b.textContent),
    ).toEqual([
      en.agents.params.default,
      en.agents.params.effort.low,
      en.agents.params.effort.medium,
      en.agents.params.effort.high,
    ]);
    expect(screen.getByText("Higher is slower")).toBeTruthy();
    const thinking = screen.getByRole("radiogroup", { name: "Thinking" });
    // 未改动时按下的是「默认（开启）」段，而不是某个具体取值
    const thinkingDefault = en.agents.params.defaultValue.replace(
      "{value}",
      en.agents.params.thinking.on,
    );
    expect(
      within(thinking).getByRole("radio", { name: thinkingDefault }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(thinking)
        .getByRole("radio", { name: en.agents.params.thinking.on })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // 温度未改动：滑块为未设置（不冒充某个取值，spec §6.2），数字框留空并以占位提示默认
    expect(screen.getByRole("slider", { name: "Temperature" }).hasAttribute("aria-valuenow")).toBe(
      false,
    );
    const tempBox = screen.getByRole("spinbutton", { name: "Temperature" }) as HTMLInputElement;
    expect(tempBox.value).toBe("");
    expect(tempBox.placeholder).toBe(en.agents.params.defaultValue.replace("{value}", "1"));
    expect(screen.getByRole("spinbutton", { name: "Max output tokens" })).toBeTruthy();
    expect(screen.queryByRole("slider", { name: "Max output tokens" })).toBeNull();

    // 只提交改动过的参数
    const user = userEvent.setup();
    await user.click(within(effort).getByRole("radio", { name: en.agents.params.effort.high }));
    expect(onChange).toHaveBeenLastCalledWith({ effort: "high" });
    expect(
      within(effort)
        .getByRole("radio", { name: en.agents.params.effort.high })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.type(screen.getByRole("spinbutton", { name: "Max output tokens" }), "512");
    expect(onChange).toHaveBeenLastCalledWith({ effort: "high", maxOutputTokens: 512 });

    // 点「默认」段：回到未设置，不再提交该键
    await user.click(within(effort).getByRole("radio", { name: en.agents.params.default }));
    expect(onChange).toHaveBeenLastCalledWith({ maxOutputTokens: 512 });
    expect(
      within(effort)
        .getByRole("radio", { name: en.agents.params.default })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("开关与滑块设置后可「恢复默认」；没有默认值的滑块未设置时停在中点并显示「默认」", async () => {
    const onChange = vi.fn();
    render(<Harness parameters={[SEARCH, TOP_K, TEMPERATURE]} locale="zh" onChange={onChange} />);
    const search = screen.getByRole("switch", { name: "联网搜索" });
    const topK = screen.getByRole("slider", { name: "Top K" });
    const topKBox = screen.getByRole("spinbutton", { name: "Top K" }) as HTMLInputElement;
    const temperature = screen.getByRole("slider", { name: "温度" });
    /** 「恢复默认」在该参数自己的字段内。 */
    const resetOf = (control: HTMLElement) =>
      within(paramBox(control)).queryByRole("button", { name: RESET.zh });
    // 未设置：没有恢复按钮
    expect(resetOf(search)).toBeNull();
    expect(resetOf(topK)).toBeNull();
    // Top K（1..50，无默认值）：滑块未设置（拇指居中，不冒充最小值），数值框以占位显示「默认」
    expect(topK.hasAttribute("aria-valuenow")).toBe(false);
    expect(topK.getAttribute("data-state")).toBe("unset");
    expect(topKBox.value).toBe("");
    expect(topKBox.placeholder).toBe(zh.agents.params.default);

    const user = userEvent.setup();
    await user.click(search);
    expect(onChange).toHaveBeenLastCalledWith({ "model-fake.search": true });
    await user.click(resetOf(search) as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(resetOf(search)).toBeNull();

    fireEvent.change(topKBox, { target: { value: "10" } });
    expect(onChange).toHaveBeenLastCalledWith({ "model-fake.topK": 10 });
    expect(topK.getAttribute("aria-valuenow")).toBe("10");
    expect(topKBox.value).toBe("10");
    await user.click(resetOf(topK) as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(topK.hasAttribute("aria-valuenow")).toBe(false);
    expect(topKBox.value).toBe("");

    // 键盘操作滑块：从未设置（中点）按步长移动
    fireEvent.keyDown(topK, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith({ "model-fake.topK": 50 });
    await user.click(resetOf(topK) as HTMLElement);

    fireEvent.change(screen.getByRole("spinbutton", { name: "温度" }), {
      target: { value: "0.5" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.5 });
    expect(temperature.getAttribute("aria-valuenow")).toBe("0.5");
    await user.click(resetOf(temperature) as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("分段按钮组有错误时，aria-invalid 标在 radiogroup 上并关联错误文案", () => {
    render(
      <Providers locale="en">
        <ModelParams
          parameters={[EFFORT]}
          value={{}}
          onChange={vi.fn()}
          locale="en"
          errors={{ effort: "bad" }}
        />
      </Providers>,
    );
    const group = screen.getByRole("radiogroup", { name: "Effort" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    const err = screen.getByText("bad").closest('[data-part="field-error"]') as HTMLElement;
    expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(err.id);
  });

  it("厂商参数按 schema 渲染：枚举 → 下拉框，布尔 → 开关，带范围的数字 → 滑块，其余 → 文本框", async () => {
    const onChange = vi.fn();
    render(
      <Harness parameters={[STYLE, SEARCH, TOP_K, ODD, EN_ONLY]} locale="zh" onChange={onChange} />,
    );
    const style = screen.getByRole("combobox", { name: "回复风格" });
    expect(await optionValues(style)).toEqual(["", "plain", "shout"]);
    expect(screen.getByText("shout 时回复全部转大写")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "联网搜索" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Top K" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "奇怪参数" })).toBeTruthy();
    // label 缺 zh 时回退到 en
    expect(screen.getByRole("textbox", { name: "Tag" })).toBeTruthy();

    const user = userEvent.setup();
    await pickOption(style, "shout", user);
    expect(onChange).toHaveBeenLastCalledWith({ "model-fake.style": "shout" });
    await user.click(screen.getByRole("switch", { name: "联网搜索" }));
    expect(onChange).toHaveBeenLastCalledWith({
      "model-fake.style": "shout",
      "model-fake.search": true,
    });
    // 选回「默认」即不再提交该键
    await pickOption(style, "", user);
    expect(onChange).toHaveBeenLastCalledWith({ "model-fake.search": true });
  });

  it("极小范围的数字参数：步长不被指数写法误判，按键得到非零的小数", () => {
    const onChange = vi.fn();
    const EPS: ModelParameter = {
      key: "model-fake.eps",
      schema: { type: "number", minimum: 0, maximum: 1e-6 },
      label: { zh: "精度", en: "Epsilon" },
    };
    render(<Harness parameters={[EPS]} locale="en" onChange={onChange} />);
    const box = screen.getByRole("spinbutton", { name: "Epsilon" }) as HTMLInputElement;
    expect(box.step).toBe("1e-8");
    fireEvent.change(box, { target: { value: "0" } });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Epsilon" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ "model-fake.eps": 1e-8 });
  });

  it("没有声明参数时不渲染任何内容", () => {
    const { container } = render(<Harness parameters={[]} locale="en" onChange={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The Model section of the agent page (`/agents/<id>?s=model`): params by the chosen model
// ---------------------------------------------------------------------------

const caps = (reasoning: boolean) => ({
  tools: true,
  vision: false,
  reasoning,
  caching: false,
  midConversationSystem: false,
});
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        {
          id: "fake-1",
          displayName: "Fake 1",
          capabilities: caps(true),
          parameters: [EFFORT, STYLE],
        },
      ],
    },
    {
      provider: "other",
      models: [
        {
          id: "o-1",
          displayName: "O 1",
          capabilities: caps(false),
          parameters: [{ ...EFFORT, schema: { type: "string", enum: ["low", "high"] } }],
        },
        { id: "o-2", displayName: "O 2", capabilities: caps(false), parameters: [] },
      ],
    },
  ],
};

const ORG = "/api/v1/orgs/o1";
const T = "2026-10-20T08:00:00.000Z";
const SAVED = {
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 1,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
  definition: {
    name: "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [{ kind: "builtin", name: "AskUserQuestion" }],
    toolPolicies: {},
  },
};

type Handler = (c: Call) => Response | Promise<Response>;
/** The page's reads plus the agent PATCH (`patch` answers it). */
function stubModel(patch: Handler = () => json(200, { agent: SAVED, warnings: [] })) {
  return stubApi({
    ...sessionRoutes(),
    ...agentFormDefaults(),
    [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: SAVED }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`PATCH ${ORG}/agents/ag1`]: patch,
  });
}
const patches = (calls: Call[]) =>
  calls
    .filter((c) => c.method === "PATCH" && c.url === `${ORG}/agents/ag1`)
    .map((c) => bodyOf(c) as { definition: Record<string, unknown>; expectedVersion: number });

const modelBox = (locale: "zh" | "en") =>
  screen.getByRole("combobox", { name: (locale === "zh" ? zh : en).agents.form.modelLabel });
/** 兜底模型下拉框的名称带「可选」后缀。 */
const fallbackBox = (locale: "zh" | "en") => {
  const label = (locale === "zh" ? zh : en).agents.form.fallbackLabel;
  return screen.getByRole("combobox", { name: (n) => n.startsWith(label) });
};
const saveButton = (locale: "zh" | "en") =>
  screen.getByRole("button", { name: (locale === "zh" ? zh : en).agents.form.submit });

describe("the Model section's parameters (/agents/<id>?s=model)", () => {
  it("switching the main model re-renders the params and drops keys the new model does not declare or allow; the save sends modelParams", async () => {
    const calls = stubModel();
    await renderEditAgent({ locale: "en", section: "model" });
    const user = userEvent.setup();
    const main = await screen.findByRole("region", { name: en.agents.form.modelParamsTitle });
    await user.click(within(main).getByRole("radio", { name: en.agents.params.effort.high }));
    await pickOption(within(main).getByRole("combobox", { name: "Reply style" }), "shout", user);

    // o-1 declares only effort (low | high): style is dropped, effort=high stays
    await pickOption(modelBox("en"), "other/o-1", user);
    expect(within(main).queryByRole("combobox", { name: "Reply style" })).toBeNull();
    await user.click(saveButton("en"));
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toMatchObject({
      definition: { model: { provider: "other", model: "o-1" } },
      expectedVersion: 1,
    });
    expect(patches(calls)[0]?.definition.modelParams).toEqual({ effort: "high" });
  });

  it("switching to a model that no longer declares the tier drops the old value; a model without params has no params section", async () => {
    const calls = stubModel();
    await renderEditAgent({ locale: "en", section: "model" });
    const user = userEvent.setup();
    const main = await screen.findByRole("region", { name: en.agents.form.modelParamsTitle });
    await user.click(within(main).getByRole("radio", { name: en.agents.params.effort.medium }));
    // o-1 allows only low | high: medium is no longer legal
    await pickOption(modelBox("en"), "other/o-1", user);
    await pickOption(modelBox("en"), "other/o-2", user);
    expect(screen.queryByRole("region", { name: en.agents.form.modelParamsTitle })).toBeNull();
    await user.click(saveButton("en"));
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.definition).toMatchObject({
      model: { provider: "other", model: "o-2" },
    });
    expect(patches(calls)[0]?.definition.modelParams).toEqual({});
    expect(patches(calls)[0]?.definition.fallbackParams).toEqual({});
  });

  it("the fallback model has its own params; removing the fallback clears fallbackParams", async () => {
    const calls = stubModel();
    await renderEditAgent({ locale: "en", section: "model" });
    const user = userEvent.setup();
    await screen.findByRole("region", { name: en.agents.form.modelParamsTitle });
    expect(screen.queryByRole("region", { name: en.agents.form.fallbackParamsTitle })).toBeNull();
    await pickOption(fallbackBox("en"), "other/o-1", user);
    const fb = screen.getByRole("region", { name: en.agents.form.fallbackParamsTitle });
    await user.click(within(fb).getByRole("radio", { name: en.agents.params.effort.low }));
    await pickOption(fallbackBox("en"), "", user);
    expect(screen.queryByRole("region", { name: en.agents.form.fallbackParamsTitle })).toBeNull();

    // pick the fallback again: the earlier value was cleared
    await pickOption(fallbackBox("en"), "other/o-1", user);
    await user.click(saveButton("en"));
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.definition.fallback).toEqual({ provider: "other", model: "o-1" });
    expect(patches(calls)[0]?.definition.fallbackParams).toEqual({});
  });

  it("the fallback params the person sets are saved with the fallback", async () => {
    const calls = stubModel();
    await renderEditAgent({ locale: "en", section: "model" });
    const user = userEvent.setup();
    await screen.findByRole("region", { name: en.agents.form.modelParamsTitle });
    await pickOption(fallbackBox("en"), "other/o-1", user);
    const fb = screen.getByRole("region", { name: en.agents.form.fallbackParamsTitle });
    await user.click(within(fb).getByRole("radio", { name: en.agents.params.effort.low }));
    await user.click(saveButton("en"));
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.definition.fallbackParams).toEqual({ effort: "low" });
  });

  it.each(["zh", "en"] as const)(
    "validation_failed details show beside their fields (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      stubModel(() =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "Invalid model parameters",
            details: [
              { path: "modelParams.model-fake.style", message: 'parameter "x" must be one of' },
              { path: "fallbackParams.effort", message: 'parameter "effort" must be one of' },
              { path: "fallbackParams.gone", message: 'unknown parameter "gone"' },
            ],
          },
        }),
      );
      await renderEditAgent({ locale, section: "model" });
      const user = userEvent.setup();
      const main = await screen.findByRole("region", { name: m.agents.form.modelParamsTitle });
      await pickOption(fallbackBox(locale), "other/o-1", user);
      await user.click(saveButton(locale));

      const style = within(main).getByRole("combobox", { name: STYLE.label[locale] });
      expect(await within(paramBox(style)).findByText(`${m.agents.params.invalid}`)).toBeTruthy();
      expect(style.getAttribute("aria-invalid")).toBe("true");
      // the main model's effort has no error
      const mainEffort = within(main).getByRole("radiogroup", { name: EFFORT.label[locale] });
      expect(within(paramBox(mainEffort)).queryByText(`${m.agents.params.invalid}`)).toBeNull();

      const fb = screen.getByRole("region", { name: m.agents.form.fallbackParamsTitle });
      const fbEffort = within(fb).getByRole("radiogroup", { name: EFFORT.label[locale] });
      expect(within(paramBox(fbEffort)).getByText(`${m.agents.params.invalid}`)).toBeTruthy();
      // a key no field shows is listed with the total error
      const alert = screen.getByRole("alert");
      expect(within(alert).getByText(`${m.errors.validation_failed}`)).toBeTruthy();
      expect(
        within(alert).getByText(`${m.agents.params.invalidKey.replace("{key}", "gone")}`),
      ).toBeTruthy();
    },
  );
});
