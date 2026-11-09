import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRow,
  ComposerBox,
  type ComposerBoxProps,
  ConversationPage,
  DesignProvider,
  isShortPickerValue,
  type PickerProps,
  QuickActionList,
  QuickActions,
  shortEnvironmentLabel,
  shortModelLabel,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

// Phones (below 640; maintainer decision 2026-11-09, spec §5.4, §6.16.2, §6.16.27): the new
// conversation's layout, the composer's options button and sheet, the listed quick actions, and
// the effort label that was cut in half.

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const css = readFileSync(resolve(__dirname, "../src/styles/conversation-page.css"), "utf8");
/** The body of the `@media (max-width: 639px)` blocks, joined. */
const phoneCss = [...css.matchAll(/@media \(max-width: 639px\) \{([\s\S]*?)\n\}/g)]
  .map((m) => m[1])
  .join("\n");

function modelPicker(
  onPick: (id: string) => void = vi.fn(),
  value = "DeepSeek-V4.1-Flash",
): PickerProps {
  return {
    label: "切换模型",
    value,
    groups: [
      {
        label: "DeepSeek",
        items: [
          {
            id: "ds/flash",
            label: "DeepSeek-V4.1-Flash",
            checked: value === "DeepSeek-V4.1-Flash",
          },
          { id: "ds/pro", label: "DeepSeek-V4-Pro", checked: value === "DeepSeek-V4-Pro" },
        ],
      },
      { label: "Qwen", items: [{ id: "qw/max", label: "Qwen3.8-Max" }] },
    ],
    note: "从下一条消息起生效",
    onPick,
  };
}

function effortPicker(onPick: (id: string) => void = vi.fn(), value = "高"): PickerProps {
  return {
    label: "思考档位",
    value,
    groups: [
      {
        items: [
          { id: "low", label: "低", checked: value === "低" },
          { id: "high", label: "高", checked: value === "高" },
        ],
      },
    ],
    onPick,
  };
}

function environmentPicker(onPick = vi.fn()): PickerProps {
  return {
    label: "切换环境",
    value: "个人环境",
    groups: [
      {
        items: [
          { id: "personal", label: "个人环境", checked: true },
          { id: "e2b", label: "个人环境（E2B 沙箱）", disabled: true, tag: "不可用" },
        ],
      },
    ],
    onPick,
  };
}

const box = (over: Partial<ComposerBoxProps> = {}) => (
  <ComposerBox
    value=""
    onChange={() => {}}
    placeholder="p"
    onAttach={() => {}}
    pickers={{ environment: environmentPicker(), model: modelPicker(), effort: effortPicker() }}
    send={{ mode: "send", disabled: true, onClick: () => {} }}
    {...over}
  />
);

describe("the composer's options button (phones, §6.16.2)", () => {
  it("shows the current values, shortened, and the whole values in its name", () => {
    wrap(box());
    const button = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-label")).toBe("会话选项: DeepSeek-V4.1-Flash · 高 · 个人环境");
    const parts = [...button.querySelectorAll(".cb-options-value")].map((e) => [
      e.getAttribute("data-part"),
      e.textContent,
    ]);
    expect(parts).toEqual([
      ["options-model", "DeepSeek-V4.1-Flash"],
      ["options-effort", "高"],
      ["options-environment", "个人"],
    ]);
    // the pickers stay for 640 and up; CSS shows one of the two
    const pickers = document.querySelector('[data-part="composer-pickers"]') as HTMLElement;
    expect(within(pickers).getAllByRole("button")).toHaveLength(3);
    expect(phoneCss).toMatch(/\.cb-composer-pickers \{\s*display: none;/);
    expect(phoneCss).toMatch(
      /\.cb-composer-bar > \.cb-composer-options\.cb-btn \{\s*display: inline-flex;/,
    );
    expect(css).toMatch(/\.cb-composer-bar > \.cb-composer-options\.cb-btn \{\s*display: none;/);
  });

  it("opens a bottom sheet with the environment, model and effort groups", async () => {
    const user = userEvent.setup();
    wrap(box());
    await user.click(screen.getByRole("button", { name: /^会话选项/ }));
    const sheet = screen.getByRole("dialog", { name: "会话选项" });
    expect(sheet.getAttribute("data-part")).toBe("composer-options-sheet");
    const groups = [...sheet.querySelectorAll('[data-part="options-group"]')];
    expect(groups.map((g) => g.getAttribute("data-group"))).toEqual([
      "environment",
      "model",
      "effort",
    ]);
    expect(
      within(sheet)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["环境", "模型", "思考档位"]);
    // the picker's contents: provider labels, checked items, a disabled item with its reason, the note
    const model = within(sheet).getByRole("radiogroup", { name: "模型" });
    expect(
      within(model)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["ds/flash", "ds/pro", "qw/max"]);
    expect(
      (within(model).getByRole("radio", { name: "DeepSeek-V4.1-Flash" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(model.textContent).toContain("Qwen");
    expect(sheet.textContent).toContain("从下一条消息起生效");
    const e2b = within(sheet).getByRole("radio", { name: /E2B/ }) as HTMLInputElement;
    expect(e2b.disabled).toBe(true);
    expect(e2b.closest("label")?.textContent).toContain("不可用");
    // one box: nothing boxed inside the sheet
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("choosing in the sheet changes the value and keeps the sheet open", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [model, setModel] = useState("DeepSeek-V4.1-Flash");
      const [effort, setEffort] = useState("高");
      const label = (id: string) => (id === "ds/pro" ? "DeepSeek-V4-Pro" : "DeepSeek-V4.1-Flash");
      return box({
        pickers: {
          model: modelPicker((id) => setModel(label(id)), model),
          effort: effortPicker((id) => setEffort(id === "low" ? "低" : "高"), effort),
        },
      });
    }
    wrap(<Harness />);
    await user.click(screen.getByRole("button", { name: /^会话选项/ }));
    await user.click(screen.getByRole("radio", { name: "DeepSeek-V4-Pro" }));
    await user.click(screen.getByRole("radio", { name: "低" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: "DeepSeek-V4-Pro" }) as HTMLInputElement).checked,
    ).toBe(true);
    const button = document.querySelector('[data-part="composer-options"]') as HTMLElement;
    expect(button.getAttribute("aria-label")).toBe("会话选项: DeepSeek-V4-Pro · 低");
    // no environment picker: two groups
    expect(document.querySelectorAll('[data-part="options-group"]')).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a locked environment (an existing conversation) is read-only in the sheet", async () => {
    const user = userEvent.setup();
    wrap(
      box({
        pickers: {
          environment: {
            label: "环境",
            value: "个人环境",
            locked: { hint: "发送第一条消息后不能再换环境" },
            groups: [],
            onPick: () => {},
          },
          model: modelPicker(),
          effort: effortPicker(),
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /^会话选项/ }));
    const env = document.querySelector('[data-group="environment"]') as HTMLElement;
    expect(within(env).queryAllByRole("radio")).toHaveLength(0);
    const locked = env.querySelector('[data-part="options-locked"]') as HTMLElement;
    expect(locked.textContent).toBe("个人环境发送第一条消息后不能再换环境");
  });

  it("shortens names sensibly", () => {
    expect(shortModelLabel("deepseek/DeepSeek-V4-Pro")).toBe("DeepSeek-V4-Pro");
    expect(shortModelLabel("claude-opus-5-5-20261101")).toBe("claude-opus-5-5");
    expect(shortModelLabel("gpt-latest")).toBe("gpt");
    expect(shortModelLabel("Qwen3.8-Max")).toBe("Qwen3.8-Max");
    expect(shortEnvironmentLabel("个人环境")).toBe("个人");
    expect(shortEnvironmentLabel("Personal environment")).toBe("Personal");
    expect(shortEnvironmentLabel("环境")).toBe("环境");
    expect(shortEnvironmentLabel("Grant's MacBook")).toBe("Grant's MacBook");
  });
});

describe("the effort label is never cut in half", () => {
  it("a short value's picker keeps its width (data-short + flex: none)", () => {
    wrap(box());
    const pickers = [
      ...document.querySelectorAll('[data-part="composer-pickers"] [data-part="picker"]'),
    ];
    expect(pickers.map((p) => p.getAttribute("data-short"))).toEqual([null, null, "true"]);
    expect(css).toMatch(
      /\.cb-composer-bar \.cb-picker\.cb-btn\[data-short="true"\] \{\s*flex: none;/,
    );
    expect(isShortPickerValue("高")).toBe(true);
    expect(isShortPickerValue("max")).toBe(true);
    expect(isShortPickerValue("个人环境")).toBe(false);
  });
});

describe("QuickActionList (phones, §6.16.27)", () => {
  const ITEMS = [
    { id: "0", title: "总结这个仓库" },
    { id: "1", title: "跑一遍测试" },
  ];

  it("lists every title as a row; a tap runs the same handler as the zap menu", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    wrap(
      <>
        <QuickActionList items={ITEMS} onPick={onPick} />
        <QuickActions items={ITEMS} onPick={onPick} />
      </>,
    );
    const list = document.querySelector('[data-part="quick-action-list"]') as HTMLElement;
    expect(within(list).getByRole("heading").textContent).toBe("常用任务");
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["总结这个仓库", "跑一遍测试"]);
    await user.click(rows[1] as HTMLElement);
    expect(onPick).toHaveBeenLastCalledWith("1");
    await user.click(screen.getByRole("button", { name: "常用任务" }));
    await user.click(screen.getAllByRole("menuitem")[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith("1");
  });

  it("draws nothing without quick actions", () => {
    const { container } = wrap(<QuickActionList items={[]} onPick={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("the new conversation on a phone (§5.4)", () => {
  const base = {
    titleBar: {
      title: "t",
      untitled: "u",
      menu: [],
      properties: { pressed: false, onToggle: () => {} },
      panels: [],
    },
    status: { context: "c", version: "v" },
    right: "none" as const,
    onCloseRight: () => {},
  };
  const agents = [
    { id: "a", name: "塞尔达", avatar: null },
    { id: "b", name: "技术调研", avatar: null },
    { id: "c", name: "Stella", avatar: null },
  ];

  it("greeting, agents row, the listed quick actions, then the composer in its pinned wrapper", () => {
    const { container } = wrap(
      <ConversationPage
        {...base}
        newConversation={{
          greeting: <div data-testid="greeting">g</div>,
          agents: <AgentRow agents={agents} selected="b" onSelect={() => {}} />,
          quickActions: <QuickActionList items={[{ id: "0", title: "总结" }]} onPick={() => {}} />,
        }}
        composer={box({
          quickActions: <QuickActions items={[{ id: "0", title: "总结" }]} onPick={() => {}} />,
        })}
      />,
    );
    const body = container.querySelector('[data-part="new-conversation-body"]') as HTMLElement;
    expect(body.getAttribute("data-quick")).toBe("true");
    expect(
      [...body.children].map((e) => e.getAttribute("data-part") ?? e.getAttribute("data-testid")),
    ).toEqual(["greeting", "agent-row", "new-quick-actions", "new-composer"]);
    const composer = body.querySelector('[data-part="new-composer"]') as HTMLElement;
    expect(composer.querySelector('[data-part="composer"]')).not.toBeNull();
    // the CSS those attributes drive: the list below 640 only, the zap button gone there, the
    // composer pinned at the bottom, the agents in one scrolling line
    expect(css).toMatch(/\.cb-conv-new-quick \{\s*display: none;/);
    expect(phoneCss).toMatch(/\.cb-conv-new-quick \{\s*display: block;/);
    expect(phoneCss).toMatch(
      /\.cb-conv-new\[data-quick="true"\] \.cb-composer-bar \[data-part="quick-actions"\] \{\s*display: none;/,
    );
    expect(phoneCss).toMatch(/\.cb-conv-new-composer \{\s*position: sticky;\s*bottom: 0;/);
    expect(phoneCss).toMatch(
      /\.cb-conv-new \.cb-agent-row \{\s*flex-wrap: nowrap;\s*overflow-x: auto;/,
    );
    expect(findNestedBoxes(container).map(describeNestedBox)).toEqual([]);
  });

  it("without quick actions nothing is listed and the zap stays", () => {
    const { container } = wrap(
      <ConversationPage {...base} newConversation={{ agentName: "a" }} composer={box()} />,
    );
    const body = container.querySelector('[data-part="new-conversation-body"]') as HTMLElement;
    expect(body.getAttribute("data-quick")).toBeNull();
    expect(body.querySelector('[data-part="new-quick-actions"]')).toBeNull();
  });

  it("the agents row's chips are keyboard reachable buttons, the selected one pressed", async () => {
    const user = userEvent.setup();
    wrap(<AgentRow agents={agents} selected="c" onSelect={() => {}} />);
    const chips = screen.getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-agent"))).toEqual(["a", "b", "c"]);
    await user.tab();
    expect(document.activeElement).toBe(chips[0]);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(chips[2]);
    expect(chips[2]?.getAttribute("aria-pressed")).toBe("true");
  });
});
