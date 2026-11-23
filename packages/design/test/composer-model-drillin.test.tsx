import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arrangePickerGroups,
  ComposerBox,
  DesignProvider,
  filterPickerGroups,
  LONG_PICKER_THRESHOLD,
  Picker,
  type PickerProps,
} from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

// The model picker with many models (maintainer 2026-11-23): on phones the options sheet's model
// is one row that drills into a model page inside the sheet (spec §6.59 "In-sheet drill-in",
// §6.16.2); the page and the wide model menu (§6.16.3) search above eight models and lead with
// the current and the agent's default model.

afterEach(cleanup);

const wrap = (ui: ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const PROVIDERS: [string, string, string[]][] = [
  ["ds", "DeepSeek", ["DeepSeek-V4-Pro", "DeepSeek-V4.1-Flash", "DeepSeek-R2"]],
  ["bl", "阿里云百炼", ["Qwen3.8-Max", "Qwen3.8-Plus", "Qwen3.8-Turbo", "QwQ-40B"]],
  ["ms", "Moonshot", ["Kimi-K3", "Kimi-K3-Thinking", "Kimi-Latest"]],
];

/** Ten models in three providers; the agent's default is Qwen3.8-Max. */
function manyModels(checked: string, onPick: (id: string) => void = vi.fn()): PickerProps {
  return {
    label: "切换模型",
    value: checked.split("/")[1] ?? checked,
    groups: PROVIDERS.map(([p, label, models]) => ({
      label,
      items: models.map((m) => ({
        id: `${p}/${m}`,
        label: m,
        checked: `${p}/${m}` === checked,
        ...(m === "Qwen3.8-Max" ? { tag: "智能体默认", pinned: true } : {}),
      })),
    })),
    note: "从下一条消息起生效",
    onPick,
  };
}

/** Three models: a short list. */
function fewModels(onPick: (id: string) => void = vi.fn()): PickerProps {
  return {
    label: "切换模型",
    value: "DeepSeek-V4-Pro",
    groups: [
      {
        label: "DeepSeek",
        items: [
          { id: "ds/pro", label: "DeepSeek-V4-Pro", checked: true },
          { id: "ds/flash", label: "DeepSeek-V4.1-Flash" },
        ],
      },
      { label: "Moonshot", items: [{ id: "ms/k3", label: "Kimi-K3", tag: "智能体默认" }] },
    ],
    onPick,
  };
}

/** The composer with a model picker whose pick is kept, the effort beside it. */
function Harness({ initial = "ds/DeepSeek-V4-Pro", few = false, onPick = vi.fn() }) {
  const [model, setModel] = useState(initial);
  const pick = (id: string) => {
    onPick(id);
    setModel(id);
  };
  return (
    <ComposerBox
      value=""
      onChange={() => {}}
      placeholder="p"
      onAttach={() => {}}
      pickers={{
        model: few ? fewModels(pick) : manyModels(model, pick),
        effort: {
          label: "思考档位",
          value: "高",
          groups: [{ items: [{ id: "high", label: "高", checked: true }] }],
          onPick: () => {},
        },
      }}
      send={{ mode: "send", disabled: true, onClick: () => {} }}
    />
  );
}

const openSheet = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^会话选项/ }));
  return screen.getByRole("dialog");
};
const modelRow = () => screen.getByRole("button", { name: /^模型/ });
const pane = () => document.querySelector('[data-part="sheet-pane"]') as HTMLElement;
const groupHeadings = () =>
  [...document.querySelectorAll('[data-part="sheet-group-heading"]')].map((h) => h.textContent);
const radioValues = () =>
  [...document.querySelectorAll<HTMLInputElement>('[data-part="options-models"] input')]
    .filter((i) => i.type === "radio")
    .map((i) => i.value);

describe("arrangePickerGroups / filterPickerGroups", () => {
  it("a long list leads with the checked and pinned items, moved out of their groups", () => {
    const groups = arrangePickerGroups(manyModels("ms/Kimi-K3").groups, "当前与默认");
    expect(groups.map((g) => g.label)).toEqual([
      "当前与默认",
      "DeepSeek",
      "阿里云百炼",
      "Moonshot",
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["ms/Kimi-K3", "bl/Qwen3.8-Max"]);
    expect(groups[2]?.items.map((i) => i.id)).not.toContain("bl/Qwen3.8-Max");
    // every item keeps its provider as what the search matches besides the label
    expect(groups[0]?.items[1]?.keywords).toBe("阿里云百炼");
  });

  it(`${LONG_PICKER_THRESHOLD} items or fewer keep the groups as they are`, () => {
    const groups = arrangePickerGroups(fewModels().groups, "当前与默认");
    expect(groups.map((g) => g.label)).toEqual(["DeepSeek", "Moonshot"]);
  });

  it("the search matches labels and provider names, case-insensitively; a group without a match goes", () => {
    const groups = arrangePickerGroups(manyModels("ms/Kimi-K3").groups, "当前与默认");
    const kimi = filterPickerGroups(groups, "  KIMI ");
    expect(kimi.map((g) => g.label)).toEqual(["当前与默认", "Moonshot"]);
    expect(filterPickerGroups(groups, "百炼").flatMap((g) => g.items.map((i) => i.label))).toEqual([
      "Qwen3.8-Max",
      "Qwen3.8-Plus",
      "Qwen3.8-Turbo",
      "QwQ-40B",
    ]);
    expect(filterPickerGroups(groups, "zzz")).toEqual([]);
    expect(filterPickerGroups(groups, " ")).toBe(groups);
  });
});

describe("the options sheet's model row and model page (phones, §6.59 in-sheet drill-in)", () => {
  it("the model is one row with the current model and a chevron", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    const sheet = await openSheet(user);
    const row = modelRow();
    expect(row.textContent).toContain("DeepSeek-V4-Pro");
    expect(row.querySelector(".cb-sheet-row-value")?.textContent).toBe("DeepSeek-V4-Pro");
    expect(row.querySelector('[data-icon="chevron-right"], svg')).not.toBeNull();
    expect(within(sheet).queryAllByRole("radio", { name: /Qwen/ })).toHaveLength(0);
    // the options page has no back control
    expect(within(sheet).queryByRole("button", { name: "返回会话选项" })).toBeNull();
  });

  it("pushes the model page in the same sheet and back returns to the options, the focus following", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    await openSheet(user);
    await user.click(modelRow());
    // the same dialog, now titled Model, with a back control at the head's start
    const sheet = screen.getByRole("dialog", { name: "模型" });
    expect(sheet.getAttribute("data-part")).toBe("composer-options-sheet");
    expect(pane().getAttribute("data-page")).toBe("model");
    expect(pane().getAttribute("data-nav")).toBe("push");
    const back = within(sheet).getByRole("button", { name: "返回会话选项" });
    expect(back.getAttribute("data-part")).toBe("sheet-back");
    expect(back.closest('[data-part="sheet-head"]')).not.toBeNull();
    // a tap focuses the current model, not the field (no keyboard pops up)
    expect((document.activeElement as HTMLInputElement).value).toBe("ds/DeepSeek-V4-Pro");
    await user.click(back);
    expect(screen.getByRole("dialog", { name: "会话选项" })).toBeTruthy();
    expect(pane().getAttribute("data-nav")).toBe("pop");
    expect(document.activeElement).toBe(modelRow());
  });

  it("from the keyboard the push focuses the search field; Esc goes back before it closes", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    await openSheet(user);
    modelRow().focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "搜索模型" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "会话选项" })).toBeTruthy();
    expect(document.activeElement).toBe(modelRow());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists the current and default models first, then the providers; no box inside the sheet", async () => {
    const user = userEvent.setup();
    wrap(<Harness initial="ms/Kimi-K3" />);
    await openSheet(user);
    await user.click(modelRow());
    expect(groupHeadings()).toEqual(["当前与默认", "DeepSeek", "阿里云百炼", "Moonshot"]);
    const pinned = document.querySelector('[data-part="options-model-pinned"]') as HTMLElement;
    expect(
      within(pinned)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["ms/Kimi-K3", "bl/Qwen3.8-Max"]);
    expect(pinned.textContent).toContain("智能体默认");
    expect(radioValues().filter((v) => v === "bl/Qwen3.8-Max")).toHaveLength(1);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(screen.getByRole("dialog").textContent).toContain("从下一条消息起生效");
  });

  it("searches above eight models, by model and provider name; nothing matched says so", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    await openSheet(user);
    await user.click(modelRow());
    const search = screen.getByRole("searchbox", { name: "搜索模型" });
    await user.type(search, "qwen3");
    expect(radioValues()).toEqual(["bl/Qwen3.8-Max", "bl/Qwen3.8-Plus", "bl/Qwen3.8-Turbo"]);
    await user.clear(search);
    await user.type(search, "moonshot");
    expect(radioValues()).toEqual(["ms/Kimi-K3", "ms/Kimi-K3-Thinking", "ms/Kimi-Latest"]);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(radioValues()).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("没有匹配的模型");
  });

  it("no search field and no pinned group with eight models or fewer", async () => {
    const user = userEvent.setup();
    wrap(<Harness few />);
    await openSheet(user);
    await user.click(modelRow());
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(groupHeadings()).toEqual(["DeepSeek", "Moonshot"]);
    // with no field a keyboard push focuses the current model
    await user.keyboard("{Escape}");
    modelRow().focus();
    await user.keyboard("{Enter}");
    expect((document.activeElement as HTMLInputElement).value).toBe("ds/pro");
  });

  it("a pick selects the model and returns to the options", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Harness onPick={onPick} />);
    await openSheet(user);
    await user.click(modelRow());
    await user.click(screen.getByRole("radio", { name: /Kimi-K3-Thinking/ }));
    expect(onPick).toHaveBeenCalledWith("ms/Kimi-K3-Thinking");
    expect(screen.getByRole("dialog", { name: "会话选项" })).toBeTruthy();
    expect(modelRow().textContent).toContain("Kimi-K3-Thinking");
    // tapping the current model returns too
    await user.click(modelRow());
    await user.click(screen.getByRole("radio", { name: /Kimi-K3-Thinking/ }));
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "会话选项" })).toBeTruthy();
  });

  it("arrows move between the models without picking; Enter picks; Enter in the field picks the first match", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Harness onPick={onPick} />);
    await openSheet(user);
    await user.click(modelRow());
    const search = screen.getByRole("searchbox", { name: "搜索模型" });
    await user.click(search);
    await user.keyboard("{ArrowDown}");
    expect((document.activeElement as HTMLInputElement).value).toBe("ds/DeepSeek-V4-Pro");
    // ↓ crosses into the next group
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect((document.activeElement as HTMLInputElement).value).toBe("bl/Qwen3.8-Max");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    expect(onPick).not.toHaveBeenCalled();
    await user.type(search, "turbo{Enter}");
    expect(onPick).toHaveBeenCalledWith("bl/Qwen3.8-Turbo");
    expect(screen.getByRole("dialog", { name: "会话选项" })).toBeTruthy();
    // the focus starts on the current model (now Turbo, pinned first); ↓ is the default, Enter picks
    await user.click(modelRow());
    expect((document.activeElement as HTMLInputElement).value).toBe("bl/Qwen3.8-Turbo");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith("bl/Qwen3.8-Max");
  });

  it("closing on the model page opens on the options next time", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    await openSheet(user);
    await user.click(modelRow());
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openSheet(user);
    expect(screen.getByRole("dialog", { name: "会话选项" })).toBeTruthy();
  });

  it("English copy", async () => {
    const user = userEvent.setup();
    wrap(<Harness />, "en");
    await user.click(screen.getByRole("button", { name: /^Conversation options/ }));
    await user.click(screen.getByRole("button", { name: /^Model/ }));
    expect(screen.getByRole("button", { name: "Back to conversation options" })).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "Search models" }), "zzz");
    expect(screen.getByRole("status").textContent).toBe("No matching models");
    expect(screen.queryByText("Current and default")).toBeNull();
  });
});

describe("the wide model menu (§6.16.3)", () => {
  const menu = () => screen.getByRole("menu");
  const items = () =>
    within(menu())
      .getAllByRole("menuitemradio")
      .map((i) => i.textContent);

  it("above eight models: a search field, the current and default first, provider names match", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    wrap(<Picker {...manyModels("ms/Kimi-K3", onPick)} searchable />);
    await user.click(screen.getByRole("button", { name: "切换模型: Kimi-K3" }));
    const field = await screen.findByRole("textbox", { name: "搜索模型" });
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    const labels = () =>
      [...menu().querySelectorAll('[data-part="menu-label"]')].map((l) => l.textContent);
    expect(labels()).toEqual(["当前与默认", "DeepSeek", "阿里云百炼", "Moonshot"]);
    expect(items().slice(0, 2)).toEqual(["Kimi-K3", "Qwen3.8-Max智能体默认"]);
    // typing filters by the provider's name too
    await user.keyboard("百炼");
    expect(items()).toEqual(["Qwen3.8-Max智能体默认", "Qwen3.8-Plus", "Qwen3.8-Turbo", "QwQ-40B"]);
    // ↓ moves into the matches; Enter picks
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("Qwen3.8-Max");
    await user.clear(field);
    await user.keyboard("zzz");
    expect(within(menu()).getAllByText("没有匹配的模型").length).toBeGreaterThan(0);
    await user.clear(field);
    await user.keyboard("turbo{Enter}");
    expect(onPick).toHaveBeenCalledWith("bl/Qwen3.8-Turbo");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("eight models or fewer: no field, the groups as they are", async () => {
    const user = userEvent.setup();
    wrap(<Picker {...fewModels()} searchable />);
    await user.click(screen.getByRole("button", { name: "切换模型: DeepSeek-V4-Pro" }));
    expect(within(menu()).queryByRole("textbox")).toBeNull();
    expect(items()).toEqual(["DeepSeek-V4-Pro", "DeepSeek-V4.1-Flash", "Kimi-K3智能体默认"]);
  });

  it("the composer's model picker is the searchable one", async () => {
    const user = userEvent.setup();
    wrap(<Harness />);
    const trigger = document.querySelector(
      '[data-part="composer-pickers"] [aria-label^="切换模型"]',
    ) as HTMLElement;
    await user.click(trigger);
    expect(await screen.findByRole("textbox", { name: "搜索模型" })).toBeTruthy();
  });
});
