import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { AgentForm } from "../src/components/AgentForm";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MODELS = {
  providers: [
    { provider: "model-fake", models: [{ id: "fake-1", displayName: "Fake 1" }] },
    { provider: "other", models: [{ id: "o-1", displayName: "O 1" }] },
  ],
};

function stub(warnings: string[]) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/orgs/o1/models") return json(200, MODELS);
      if (url === "/api/v1/orgs/o1/agents" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(201, { agent: { id: "ag1" }, warnings });
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
  return posts;
}

function renderForm(locale: "zh" | "en", onDone = vi.fn()) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <AgentForm orgId="o1" onDone={onDone} />
    </NextIntlClientProvider>,
  );
  return onDone;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentForm", () => {
  it("模型下拉框来自 /models；保存发送定义，没有警告时直接完成", async () => {
    const posts = stub([]);
    const onDone = renderForm("en");
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(screen.getByLabelText(en.agents.form.nameLabel), "Echo");
    await user.selectOptions(screen.getByLabelText(en.agents.form.modelLabel), "model-fake/fake-1");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(posts[0]).toEqual({
      definition: {
        name: "Echo",
        instructions: "",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
      },
      visibility: "private",
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each(["zh", "en"] as const)("保存后显示 warnings，点「继续」才完成（%s）", async (locale) => {
    const m = locale === "zh" ? zh : en;
    const posts = stub(["fallback_same_provider"]);
    const onDone = renderForm(locale);
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(screen.getByLabelText(m.agents.form.nameLabel), "Echo");
    await user.selectOptions(
      screen.getByLabelText(m.agents.form.fallbackLabel),
      "model-fake/fake-1",
    );
    await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
    expect(posts[0]).toMatchObject({ definition: { fallback: { provider: "model-fake" } } });
    expect(await screen.findByText(m.agents.warnings.fallback_same_provider)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: m.agents.form.continue }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
