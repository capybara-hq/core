import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentPanel,
  AgentRow,
  type AgentRowItem,
  ComposerBox,
  ConversationPage,
  DesignProvider,
  Greeting,
  gridStep,
  QuickActions,
} from "../src/index";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

/** Every media query answers `matches` for the reduced-motion query only. */
function reducedMotion() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/conversation.css"), "utf8");

const AGENTS: AgentRowItem[] = [
  { id: "a1", name: "研究助手", description: "检索资料并整理报告", avatar: null },
  { id: "a2", name: "数据分析", description: "核对账目", avatar: { kind: "preset", id: "owl" } },
  { id: "a3", name: "Writer", description: "Drafts release notes", avatar: null },
  { id: "a4", name: "客服", description: "回答工单", avatar: { kind: "preset", id: "panda" } },
  { id: "a5", name: "法务", description: "审合同条款", avatar: null },
  { id: "a6", name: "Ops", description: "Watches the deploy QUEUE", avatar: null },
  { id: "a7", name: "翻译", description: "中英互译", avatar: null },
  { id: "a8", name: "Recruiter", description: "Screens résumés", avatar: null },
];

describe("Greeting (spec §6.16.25)", () => {
  it("greeting types once and shows whole under reduced motion", () => {
    vi.useFakeTimers();
    const text = "早上好，Grant";
    const { container, rerender } = wrap(<Greeting text={text} sub="选一个" />);
    const typed = () =>
      container.querySelector('[data-part="greeting-typed"]')?.textContent ?? "<none>";
    const caret = () => container.querySelector('[data-part="greeting-caret"]');
    // the heading reads the whole line once; the typed copy is hidden from assistive tech
    const heading = screen.getByRole("heading", { name: text });
    expect(heading.querySelector('[data-part="greeting-typed"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(typed()).toBe("");
    expect(caret()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(typed()).toBe("早");
    act(() => {
      vi.advanceTimersByTime(40 * 3);
    });
    expect(typed()).toBe("早上好，");
    act(() => {
      vi.advanceTimersByTime(40 * 20);
    });
    expect(typed()).toBe(text);
    // the caret goes when the line is complete
    expect(caret()).toBeNull();
    // once: a re-render with the same line does not type it again
    rerender(
      <DesignProvider locale="zh">
        <Greeting text={text} sub="选一个" />
      </DesignProvider>,
    );
    expect(typed()).toBe(text);
    // the mark is the working line's capybara at pixel unit 2
    const svg = container.querySelector('[data-part="greeting-mark"] svg') as SVGElement;
    expect(svg.getAttribute("width")).toBe("28");
    expect(svg.getAttribute("height")).toBe("20");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(container.querySelector('[data-part="greeting-sub"]')?.textContent).toBe("选一个");
    cleanup();

    // reduced motion: the whole line at once, no caret, no timer needed
    reducedMotion();
    const reduced = wrap(<Greeting text={text} />);
    expect(reduced.container.querySelector('[data-part="greeting-typed"]')?.textContent).toBe(text);
    expect(reduced.container.querySelector('[data-part="greeting-caret"]')).toBeNull();
    cleanup();

    // `still` (the reference set) draws the reduced-motion form too
    window.matchMedia = originalMatchMedia;
    const still = wrap(<Greeting text={text} still />);
    expect(still.container.querySelector('[data-part="greeting-typed"]')?.textContent).toBe(text);
  });

  it("types once under StrictMode, one character per 40 ms", () => {
    vi.useFakeTimers();
    const { container } = render(
      <StrictMode>
        <DesignProvider locale="zh">
          <Greeting text="晚上好" />
        </DesignProvider>
      </StrictMode>,
    );
    const typed = () => container.querySelector('[data-part="greeting-typed"]')?.textContent;
    expect(typed()).toBe("");
    act(() => {
      vi.advanceTimersByTime(40);
    });
    // one timer only: the effect run twice by StrictMode left no second interval behind
    expect(typed()).toBe("晚");
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(typed()).toBe("晚上好");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(typed()).toBe("晚上好");
  });

  it("a new line mid-typing starts again from 0 with no stale timer", () => {
    vi.useFakeTimers();
    const { container, rerender } = wrap(<Greeting text="早上好，Grant" />);
    const typed = () => container.querySelector('[data-part="greeting-typed"]')?.textContent;
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(typed()).toBe("早上");
    rerender(
      <DesignProvider locale="zh">
        <Greeting text="下午好" />
      </DesignProvider>,
    );
    expect(typed()).toBe("");
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(typed()).toBe("下");
    act(() => {
      vi.advanceTimersByTime(40 * 10);
    });
    expect(typed()).toBe("下午好");
    expect(container.querySelector('[data-part="greeting-caret"]')).toBeNull();
  });

  it("without a line yet draws a same-height placeholder with no text, and the default sub line", () => {
    const { container } = wrap(<Greeting />);
    const line = container.querySelector('[data-part="greeting-line"]') as HTMLElement;
    expect(line).not.toBeNull();
    const placeholder = line.querySelector('[data-part="greeting-placeholder"]') as HTMLElement;
    expect(placeholder.textContent).toBe("");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("heading")).toBeNull();
    // the mark is drawn already (the same on the server and the client)
    expect(line.querySelector('[data-part="greeting-mark"] svg')).not.toBeNull();
    expect(container.querySelector('[data-part="greeting-sub"]')?.textContent).toBe(
      "选一个智能体，或从常用任务开始",
    );
    // the line keeps one height with or without text: the h1 line height, set on the line box
    const block = css.slice(css.indexOf(".cb-greeting-line {"));
    expect(block.slice(0, block.indexOf("}"))).toContain("var(--cb-type-h1-line)");
    // the caret is accent and blinks only without reduced motion
    const caret = css.slice(css.indexOf(".cb-greeting-caret {"));
    expect(caret.slice(0, caret.indexOf("}"))).toContain("var(--cb-accent)");
  });

  it("speaks English", () => {
    const { container } = wrap(<Greeting />, "en");
    expect(container.querySelector('[data-part="greeting-sub"]')?.textContent).toBe(
      "Pick an agent, or start from a common task",
    );
  });
});

describe("AgentRow and AgentPanel (spec §6.16.26)", () => {
  it("agent row shows 5 then 更多 +N; the panel searches by name and description", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = wrap(
      <AgentRow agents={AGENTS} selected="a2" onSelect={onSelect} recent={["a3", "a1"]} />,
    );
    const chips = [...container.querySelectorAll('[data-part="agent-chip"]')];
    expect(chips).toHaveLength(5);
    expect(chips.map((c) => c.querySelector('[data-part="agent-chip-name"]')?.textContent)).toEqual(
      ["研究助手", "数据分析", "Writer", "客服", "法务"],
    );
    // each chip carries the 24 avatar; the selected one is pressed
    expect(
      chips.every(
        (c) => c.querySelector('[data-part="avatar"]')?.getAttribute("data-size") === "24",
      ),
    ).toBe(true);
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
    await user.click(chips[2] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("a3");

    const more = screen.getByRole("button", { name: "更多 +3" });
    await user.click(more);
    const search = screen.getByRole("combobox");
    expect(search.getAttribute("placeholder")).toBe("搜索名称或描述");
    // the groups: the recent ids in order, then every agent; each group is named by its label
    const listbox = screen.getByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-labelledby") !== null),
    ).toEqual([true, true]);
    const labels = [...document.querySelectorAll('[data-part="agent-group-label"]')].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(["最近用过", "全部 8 个"]);
    const names = () =>
      [...document.querySelectorAll('[data-part="agent-option"]')].map(
        (o) => o.querySelector('[data-part="agent-option-name"]')?.textContent,
      );
    expect(names().slice(0, 2)).toEqual(["Writer", "研究助手"]);
    expect(names()).toHaveLength(2 + 8);
    // the rows carry the 28 avatar and the description on the same line
    const first = document.querySelector('[data-part="agent-option"]') as HTMLElement;
    expect(first.querySelector('[data-part="avatar"]')?.getAttribute("data-size")).toBe("28");
    expect(first.querySelector('[data-part="agent-option-desc"]')?.textContent).toBe(
      "Drafts release notes",
    );

    // by name, case-insensitively
    await user.type(search, "writer");
    expect(names()).toEqual(["Writer", "Writer"]);
    // by description, case-insensitively
    await user.clear(search);
    await user.type(search, "queue");
    expect(names()).toEqual(["Ops"]);
    expect(document.querySelector('[data-part="agent-group-label"]')?.textContent).toBe(
      "全部 1 个",
    );
    // nothing matches: a quiet line, no listbox
    await user.clear(search);
    await user.type(search, "zzz");
    expect(names()).toEqual([]);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.querySelector('[data-part="agent-empty"]')?.textContent).toBe(
      "没有匹配的智能体",
    );
    // clicking a row selects it and closes the panel
    await user.clear(search);
    await user.type(search, "recruit");
    await user.click(document.querySelector('[data-part="agent-option"]') as HTMLElement);
    expect(onSelect).toHaveBeenLastCalledWith("a8");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("panel keyboard: arrows, Enter selects, Escape closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    wrap(<AgentRow agents={AGENTS} selected="a1" onSelect={onSelect} recent={["a4"]} />);
    const more = screen.getByRole("button", { name: "更多 +3" });
    await user.click(more);
    const search = screen.getByRole("combobox");
    expect(document.activeElement).toBe(search);
    const active = () =>
      document
        .getElementById(search.getAttribute("aria-activedescendant") ?? "")
        ?.querySelector('[data-part="agent-option-name"]')?.textContent;
    // 最近用过: [客服]; 全部 8 个, two columns: 研究助手 数据分析 / Writer 客服 / 法务 Ops / 翻译 Recruiter
    expect(active()).toBe("客服");
    // ↓ from the recent group's last row: the all group's first row, same column
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("研究助手");
    // → and ← move within the row and stop at its ends
    await user.keyboard("{ArrowRight}");
    expect(active()).toBe("数据分析");
    await user.keyboard("{ArrowRight}");
    expect(active()).toBe("数据分析");
    // ↓ moves one row (two options), keeping the column
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("客服");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(active()).toBe("Writer");
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe("研究助手");
    // ↑ from the first row of 全部 in column 2: the recent group's last row, nearest column
    await user.keyboard("{ArrowRight}{ArrowUp}");
    expect(active()).toBe("客服");
    expect(
      document
        .getElementById(search.getAttribute("aria-activedescendant") ?? "")
        ?.closest('[role="group"]')
        ?.querySelector('[data-part="agent-group-label"]')?.textContent,
    ).toBe("最近用过");
    // ↑ at the top stays; ↓ to the last row, where ↓ stays
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe("客服");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(active()).toBe("Recruiter");
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe("Recruiter");
    // the active row is the listbox's selected option
    const option = document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
    expect(option?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("a8");
    expect(screen.queryByRole("combobox")).toBeNull();

    // Escape closes and gives focus back to 更多
    await user.click(screen.getByRole("button", { name: "更多 +3" }));
    expect(screen.getByRole("combobox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多 +3" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("panel grid: ↓ with no option below the column goes to the group's last option", () => {
    // a group of three: [0 1] / [2]; from 1 ↓ is 2, from 2 ↓ is the next group's column 1
    expect(gridStep([3, 8], [0, 1], "ArrowDown")).toEqual([0, 2]);
    expect(gridStep([3, 8], [0, 2], "ArrowDown")).toEqual([1, 0]);
    // ↑ into a group whose last row is short: the nearest column that exists
    expect(gridStep([3, 8], [1, 1], "ArrowUp")).toEqual([0, 2]);
    expect(gridStep([4, 8], [1, 1], "ArrowUp")).toEqual([0, 3]);
    // → on the short last row has nowhere to go
    expect(gridStep([3], [0, 2], "ArrowRight")).toEqual([0, 2]);
    // the groups are two-column grids, their labels across both columns
    const at = css.indexOf(".cb-agent-group {");
    expect(css.slice(at, css.indexOf("}", at))).toContain("repeat(2, minmax(0, 1fr))");
    const label = css.indexOf(".cb-agent-group-label {");
    expect(css.slice(label, css.indexOf("}", label))).toContain("grid-column: 1 / -1");
  });

  it("the search leaves Enter and the arrows to an IME while it composes", () => {
    const onSelect = vi.fn();
    wrap(<AgentPanel agents={AGENTS} recent={[]} onSelect={onSelect} onClose={() => {}} />);
    const search = screen.getByRole("combobox");
    const activeId = () => search.getAttribute("aria-activedescendant");
    const first = activeId();
    fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true });
    expect(activeId()).toBe(first);
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("a1");
  });

  it("the list fits the room below the row and the overflow menu has a bounded width", () => {
    const at = css.indexOf(".cb-agent-list {");
    expect(css.slice(at, css.indexOf("overflow-y", at))).toContain(
      "--radix-popover-content-available-height",
    );
    const page = readFileSync(
      resolve(import.meta.dirname, "../src/styles/conversation-page.css"),
      "utf8",
    );
    const m = page.indexOf('.cb-cmenu[data-bounded="true"] {');
    expect(page.slice(m, page.indexOf("}", m))).toContain("min(320px, calc(100vw - 16px))");
  });

  it("the panel alone calls onClose on Escape and speaks English", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    wrap(<AgentPanel agents={AGENTS} recent={[]} onSelect={() => {}} onClose={onClose} />, "en");
    const search = screen.getByRole("combobox");
    expect(search.getAttribute("placeholder")).toBe("Search name or description");
    // no recent ids: only the all group
    expect(
      [...document.querySelectorAll('[data-part="agent-group-label"]')].map((l) => l.textContent),
    ).toEqual(["All 8"]);
    search.focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a selected agent past the first five visible in the row", () => {
    const { container } = wrap(<AgentRow agents={AGENTS} selected="a7" onSelect={() => {}} />);
    const names = [...container.querySelectorAll('[data-part="agent-chip-name"]')].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["研究助手", "数据分析", "Writer", "客服", "翻译"]);
    expect(screen.getByRole("button", { name: "更多 +3" })).toBeTruthy();
  });

  it("five agents or fewer: no 更多 chip", () => {
    const { container } = wrap(
      <AgentRow agents={AGENTS.slice(0, 5)} selected="a1" onSelect={() => {}} />,
    );
    expect(container.querySelectorAll('[data-part="agent-chip"]')).toHaveLength(5);
    expect(container.querySelector('[data-part="agent-more"]')).toBeNull();
  });

  it("one agent: the row renders nothing", () => {
    const { container } = wrap(
      <AgentRow agents={AGENTS.slice(0, 1)} selected="a1" onSelect={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
    const none = wrap(<AgentRow agents={[]} onSelect={() => {}} />);
    expect(none.container.innerHTML).toBe("");
  });
});

describe("QuickActions (spec §6.16.27)", () => {
  const ITEMS = [
    { id: "q1", title: "周报" },
    { id: "q2", title: "核对上月账目并列出差异，按收款人汇总成一张很长很长的表格" },
    { id: "q3", title: "翻译" },
    { id: "q4", title: "审合同" },
    { id: "q5", title: "写发布说明" },
    { id: "q6", title: "排查告警" },
  ];
  const picker = (label: string, value: string) => ({
    label,
    value,
    groups: [{ items: [{ id: value, label: value, checked: true }] }],
    onPick: () => {},
  });
  const box = (quickActions?: React.ReactNode) => (
    <ComposerBox
      value=""
      onChange={() => {}}
      placeholder="p"
      onAttach={() => {}}
      pickers={{ model: picker("模型", "fake-1"), effort: picker("思考档位", "高") }}
      {...(quickActions !== undefined ? { quickActions } : {})}
      send={{ mode: "send", disabled: true, onClick: () => {} }}
    />
  );

  it("a zap button right after the effort picker in the composer's control row", () => {
    const { container } = wrap(box(<QuickActions items={ITEMS} onPick={() => {}} />));
    const bar = container.querySelector('[data-part="composer-bar"]') as HTMLElement;
    const button = within(bar).getByRole("button", { name: "常用任务" });
    expect(button.getAttribute("data-part")).toBe("quick-actions");
    // the line icon of the set, not a character
    expect(button.querySelector("svg.cb-icon")).not.toBeNull();
    expect(button.textContent).toBe("");
    const parts = [...bar.children].map((e) => e.getAttribute("data-part") ?? e.className);
    const at = parts.indexOf("quick-actions");
    expect(parts.slice(at - 2, at + 2)).toEqual(["picker", "picker", "quick-actions", "cb-grow"]);
    // no quick actions: no button, nothing left in its place
    cleanup();
    const none = wrap(box(<QuickActions items={[]} onPick={() => {}} />));
    expect(none.container.querySelector('[data-part="quick-actions"]')).toBeNull();
    expect(none.container.textContent).not.toContain("常用任务");
  });

  it("opens a menu listing every quick action; choosing one calls onPick", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    wrap(box(<QuickActions items={ITEMS} onPick={onPick} />));
    // closed: no line of links over the composer
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "常用任务" }));
    expect(screen.getByRole("menu", { name: "常用任务" })).toBeTruthy();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(ITEMS.map((i) => i.title));
    await user.click(items[5] as HTMLElement);
    expect(onPick).toHaveBeenLastCalledWith("q6");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("speaks English", () => {
    wrap(<QuickActions items={ITEMS} onPick={() => {}} />, "en");
    expect(screen.getByRole("button", { name: "Common tasks" })).toBeTruthy();
  });
});

describe("ConversationPage new-conversation slots", () => {
  const base = {
    titleBar: {
      title: "t",
      untitled: "u",
      menu: [],
      properties: { pressed: false, onToggle: () => {} },
      panels: [],
    },
    composer: <div data-testid="composer">composer</div>,
    status: { context: "c", version: "v" },
    right: "none" as const,
    onCloseRight: () => {},
  };

  it("draws the greeting and the agents row above the composer (the quick actions are in it)", () => {
    const { container } = wrap(
      <ConversationPage
        {...base}
        newConversation={{
          greeting: <div data-testid="greeting">g</div>,
          agents: <div data-testid="agents">a</div>,
        }}
      />,
    );
    const body = container.querySelector('[data-part="new-conversation-body"]') as HTMLElement;
    const order = [...body.querySelectorAll("[data-testid]")].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(order).toEqual(["greeting", "agents", "composer"]);
    // the greeting replaces the agent's name and description
    expect(body.querySelector(".cb-conv-new-name")).toBeNull();
    expect(within(body).queryByRole("heading")).toBeNull();
  });

  it("lays out the start column whenever a greeting or the agents row is given", () => {
    const { container } = wrap(
      <ConversationPage
        {...base}
        newConversation={{ agentName: "研究助手", agents: <div data-testid="agents">a</div> }}
      />,
    );
    const body = container.querySelector('[data-part="new-conversation-body"]') as HTMLElement;
    expect(body.getAttribute("data-start")).toBe("true");
    cleanup();
    const plain = wrap(<ConversationPage {...base} newConversation={{ agentName: "研究助手" }} />);
    expect(
      plain.container
        .querySelector('[data-part="new-conversation-body"]')
        ?.getAttribute("data-start"),
    ).toBeNull();
  });

  it("keeps the name and description form without a greeting", () => {
    const { container } = wrap(
      <ConversationPage {...base} newConversation={{ agentName: "研究助手", description: "d" }} />,
    );
    const body = container.querySelector('[data-part="new-conversation-body"]') as HTMLElement;
    expect(within(body).getByRole("heading", { name: "研究助手" })).toBeTruthy();
  });
});
