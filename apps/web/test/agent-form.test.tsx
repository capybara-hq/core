import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

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

function stub(warnings: string[], models: unknown = MODELS) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/orgs/o1/models") return json(200, models);
      if (url === "/api/v1/orgs/o1/agents" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(201, { agent: { id: "ag1" }, warnings });
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  return posts;
}

/** 兜底模型下拉框的名称带「可选」后缀。 */
const startsWith = (label: string) => (name: string) => name.startsWith(label);

beforeEach(() => resetNavigation("/agents/new"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("新建 Agent 页（FormPage）", () => {
  it("使用 FormPage 模板，分组「基本信息」「模型」，ActionRow 中「保存」为主操作", async () => {
    stub([]);
    const { container } = renderPage(<NewAgentPage />, { locale: "zh" });
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: zh.agents.form.basicSection })).toBeTruthy();
    expect(screen.getByRole("region", { name: zh.agents.form.modelSection })).toBeTruthy();
    const row = screen.getByRole("region", { name: "待提交改动" });
    const save = within(row).getByRole("button", { name: zh.agents.form.submit });
    expect(save.getAttribute("data-variant")).toBe("primary");
    expect(within(row).getByRole("button", { name: zh.common.cancel })).toBeTruthy();
  });

  it("模型下拉框来自 /models；保存发送定义，没有警告时直接回到列表", async () => {
    const posts = stub([]);
    renderPage(<NewAgentPage />);
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.agents.form.modelLabel }),
      "model-fake/fake-1",
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(posts[0]).toEqual({
      definition: {
        name: "Echo",
        instructions: "",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
        modelParams: {},
        fallbackParams: {},
      },
      visibility: "private",
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/agents");
  });

  it("在名称框按 Enter 即保存（只提交一次）；在指令多行框按 Enter 只换行", async () => {
    // 带数字参数框：表单里有多个单行输入框，浏览器不会做隐式提交
    const temperature = {
      key: "temperature",
      standard: "temperature",
      schema: { type: "number", minimum: 0, maximum: 2 },
      label: { zh: "温度", en: "Temperature" },
    };
    const posts = stub([], {
      providers: [
        {
          provider: "model-fake",
          models: [
            { id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [temperature] },
          ],
        },
      ],
    });
    renderPage(<NewAgentPage />);
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(
      screen.getByRole("textbox", { name: startsWith(en.agents.form.instructionsLabel) }),
      "a{Enter}b",
    );
    expect(posts).toHaveLength(0);
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo{Enter}");
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
    expect(posts).toHaveLength(1);
    expect(
      (posts[0] as { definition: { name: string; instructions: string } }).definition,
    ).toMatchObject({
      name: "Echo",
      instructions: "a\nb",
    });
  });

  it("名称为空时不提交，名称字段显示错误", async () => {
    const posts = stub([]);
    renderPage(<NewAgentPage />);
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(posts).toHaveLength(0);
    const name = screen.getByRole("textbox", { name: en.agents.form.nameLabel });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(`✗ ${en.agents.form.nameRequired}`)).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "保存后在表单顶部列出 warnings，点「继续」才回到列表（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const posts = stub(["fallback_same_provider"]);
      renderPage(<NewAgentPage />, { locale });
      const user = userEvent.setup();
      await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
      await user.type(screen.getByRole("textbox", { name: m.agents.form.nameLabel }), "Echo");
      await user.selectOptions(
        screen.getByRole("combobox", { name: startsWith(m.agents.form.fallbackLabel) }),
        "model-fake/fake-1",
      );
      await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
      expect(posts[0]).toMatchObject({ definition: { fallback: { provider: "model-fake" } } });
      const warning = await screen.findByText(`‖ ${m.agents.warnings.fallback_same_provider}`);
      expect(warning.closest('[data-tone="danger"]')).not.toBeNull();
      expect(router.push).not.toHaveBeenCalled();
      // 已保存：主操作换成「继续」，不会重复创建
      expect(screen.queryByRole("button", { name: m.agents.form.submit })).toBeNull();
      await user.click(screen.getByRole("button", { name: m.agents.form.continue }));
      expect(router.push).toHaveBeenCalledWith("/agents");
      expect(posts).toHaveLength(1);
    },
  );
});
