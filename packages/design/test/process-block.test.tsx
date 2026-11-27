import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  InlineCard,
  MOBILE_SIZE_QUERY,
  PendingActions,
  ProcessBlock,
  type ProcessBlockProps,
  RAIL_VIRTUAL_MIN,
  type RailRow,
  RailSection,
  RailStep,
  RailText,
  ToolGroup,
  type ToolRowData,
} from "../src/index";
import { findNestedBoxes } from "../src/reference/index";
import { css, parseCss } from "./css-rules";

// The process block (conversation process blocks spec §1.3, §3, §4; design spec §6.16.8a): the head
// with kind chips, the rail of steps, the fold row, and the pending-actions list.

afterEach(cleanup);

const wrap = (ui: ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const KINDS = ["thinking", "command", "read", "edit", "search", "web", "skill", "connector"].map(
  (key) => ({ key, icon: { name: "file-text" as const }, label: key }),
);

const base = (over: Partial<ProcessBlockProps> = {}): ProcessBlockProps => ({
  state: "finished",
  elapsedMs: 163_000,
  summary: { thoughts: 4, tools: 12, errors: 1, pinned: { title: "待办", badge: "4/4" } },
  kinds: KINDS,
  open: false,
  onToggle: () => {},
  children: (
    <RailStep icon="dot">
      <span>第一步</span>
    </RailStep>
  ),
  ...over,
});

const head = (c: HTMLElement) => c.querySelector('[data-part="process-head"]') as HTMLElement;

describe("ProcessBlock head", () => {
  it("finished head", async () => {
    const onToggle = vi.fn();
    const { container } = wrap(<ProcessBlock {...base({ onToggle })} />);
    const h = head(container);
    // at most six kind chips, in the given order
    const chips = [...h.querySelectorAll('[data-part="process-chip"]')];
    expect(chips.map((c) => c.getAttribute("data-kind"))).toEqual(
      KINDS.slice(0, 6).map((k) => k.key),
    );
    expect(h.querySelector('[data-part="process-summary"]')?.textContent).toBe(
      "已处理 2 分 43 秒 · 待办 4/4 · 思考 4 次 · 12 个工具",
    );
    // the error dot names itself; the count is drawn once
    expect(within(h).getByRole("img", { name: "1 个调用返回了错误" })).toBeTruthy();
    // each chip is an image named by its kind
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(
      KINDS.slice(0, 6).map((k) => k.label),
    );
    expect(chips.every((c) => c.getAttribute("role") === "img")).toBe(true);
    // a chevron and the toggle state
    expect(h.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
    const toggle = within(h).getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    // the head is the polite live region
    expect(h.getAttribute("aria-live")).toBe("polite");
  });

  it("finished head in English and without pinned title, thoughts or errors", () => {
    const { container } = wrap(
      <ProcessBlock {...base({ summary: { thoughts: 0, tools: 2, errors: 0 } })} />,
      "en",
    );
    const h = head(container);
    expect(h.querySelector('[data-part="process-summary"]')?.textContent).toBe(
      "Worked for 2m 43s · 2 tools",
    );
    expect(h.querySelector('[data-part="error-dot"]')).toBeNull();
  });

  it("running head has no chevron and shows the elapsed time", () => {
    const { container } = wrap(
      <ProcessBlock
        {...base({ state: "running", open: true, elapsedMs: 5_000, current: "读取 report.md" })}
      />,
    );
    const h = head(container);
    expect(h.querySelector('[data-icon^="chevron"]')).toBeNull();
    expect(within(h).queryByRole("button")).toBeNull();
    expect(h.textContent).toContain("正在运行 · 读取 report.md");
    expect(h.querySelector('[data-part="process-time"]')?.textContent).toBe("5 秒");
    expect(h.querySelector('[data-part="spinner"]')).not.toBeNull();
  });

  it("waiting head shows the waiting words in accent", () => {
    const { container } = wrap(
      <ProcessBlock
        {...base({
          state: "waiting",
          open: true,
          waiting: "等待你批准",
          current: "运行 pnpm test",
        })}
      />,
    );
    const h = head(container);
    const word = h.querySelector('[data-part="process-waiting"]') as HTMLElement;
    expect(word.textContent).toBe("等待你批准");
    expect(word.classList.contains("cb-accent-word")).toBe(true);
    expect(h.textContent).toContain("运行 pnpm test");
    expect(h.querySelector('[data-icon="hand"]')).not.toBeNull();
    expect(h.querySelector('[data-part="spinner"]')).toBeNull();
  });

  it("stopped and failed heads keep the summary and add the word", () => {
    const stopped = wrap(<ProcessBlock {...base({ state: "stopped" })} />);
    const word = head(stopped.container).querySelector('[data-part="process-state-word"]');
    expect(word?.textContent).toBe("已停止");
    expect(word?.classList.contains("cb-muted")).toBe(true);
    cleanup();
    const failed = wrap(<ProcessBlock {...base({ state: "failed" })} />);
    const fw = head(failed.container).querySelector('[data-part="process-state-word"]');
    expect(fw?.textContent).toBe("失败");
    expect(fw?.classList.contains("cb-fail-word")).toBe(true);
  });

  it("singular counts use the singular copy", () => {
    const { container } = wrap(
      <ProcessBlock
        {...base({
          summary: { thoughts: 1, tools: 1, errors: 0 },
          backgroundRunning: 1,
        })}
      />,
      "en",
    );
    expect(head(container).querySelector('[data-part="process-summary"]')?.textContent).toBe(
      "Worked for 2m 43s · Thought once · 1 tool",
    );
    expect(screen.getByText("1 background task still running")).toBeTruthy();
  });

  it("shows how many background tasks still run", () => {
    wrap(<ProcessBlock {...base({ backgroundRunning: 2 })} />);
    expect(screen.getByText("2 个后台任务仍在运行")).toBeTruthy();
  });
});

describe("ProcessBlock rail", () => {
  it("fold row opens earlier steps", async () => {
    const onShowEarlier = vi.fn();
    wrap(<ProcessBlock {...base({ open: true, hiddenBefore: 3, onShowEarlier })} />);
    await userEvent.click(screen.getByRole("button", { name: "前 3 步" }));
    expect(onShowEarlier).toHaveBeenCalledTimes(1);
  });

  it("no fold row without hidden steps; a closed block draws no rail", () => {
    const open = wrap(<ProcessBlock {...base({ open: true })} />);
    expect(open.container.querySelector('[data-part="process-fold"]')).toBeNull();
    expect(open.container.querySelector('[data-part="process-rail"]')).not.toBeNull();
    cleanup();
    const closed = wrap(<ProcessBlock {...base({ open: false, hiddenBefore: 3 })} />);
    expect(closed.container.querySelector('[data-part="process-rail"]')).toBeNull();
  });

  it("the toggle controls the rail", () => {
    const { container } = wrap(<ProcessBlock {...base({ open: true })} />);
    const toggle = within(head(container)).getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls") ?? "")}`),
    ).toBe(container.querySelector('[data-part="process-rail"]'));
  });

  it("rail rule spans first to last icon, however the steps are wrapped", () => {
    const Wrapper = () => (
      <>
        <RailStep icon="dot">b</RailStep>
        <RailStep icon={{ name: "terminal" }}>c</RailStep>
      </>
    );
    const { container } = wrap(
      <ProcessBlock {...base({ open: true, hiddenBefore: 2 })}>
        <RailStep icon={{ name: "lightbulb" }}>a</RailStep>
        <>
          <Wrapper />
        </>
      </ProcessBlock>,
    );
    const rail = container.querySelector('[data-part="process-rail"]') as HTMLElement;
    const steps = [...rail.querySelectorAll('[data-part="rail-step"]')];
    expect(steps).toHaveLength(3);
    // the edges come from CSS on the rail's own children; the fold row (a button) is not counted
    expect(rail.querySelector(":scope > .cb-rail-step:first-of-type")).toBe(steps[0]);
    expect(rail.querySelector(":scope > .cb-rail-step:last-of-type")).toBe(steps[2]);
    const sels = parseCss(css("conversation.css")).map((r) => r.selector);
    expect(sels).toContain(".cb-rail-step:first-of-type::before");
    expect(sels).toContain(".cb-rail-step:last-of-type::before");
    expect(sels).toContain(".cb-rail-step:not(:last-of-type)");
  });

  it("the fold row's chevron stands in the rail's icon column, on its text's line", () => {
    const rules = parseCss(css("conversation.css"));
    const gutter = rules.find((x) => x.selector === ".cb-process-fold > .cb-rail-gutter");
    // a step's gutter (20 wide, row.dense high), centred on the row instead of its top
    expect(gutter?.decls["align-self"]).toBe("center");
    expect(gutter?.decls.height).toBeUndefined();
    const fold = rules.find((x) => x.selector === ".cb-process-fold");
    expect(fold?.decls["grid-template-columns"]).toBe("20px minmax(0, 1fr)");
    expect(fold?.decls["column-gap"]).toBe("var(--cb-space-2)");
  });

  it("rail steps sit space.1 apart by padding", () => {
    const r = parseCss(css("conversation.css")).find(
      (x) => x.selector === ".cb-rail-step:not(:last-of-type)",
    );
    expect(r?.decls["padding-bottom"]).toBe("var(--cb-space-1)");
  });

  it("a step draws its icon in the gutter: kind icon, image, dot; never a spinner", () => {
    const { container } = wrap(
      <ProcessBlock {...base({ open: true })}>
        <RailStep icon={{ name: "terminal" }}>a</RailStep>
        <RailStep icon={{ src: "https://x.test/i.png" }}>b</RailStep>
        <RailStep icon="dot">c</RailStep>
      </ProcessBlock>,
    );
    const gutters = [...container.querySelectorAll('[data-part="rail-gutter"]')];
    expect(gutters[0]?.querySelector('[data-icon="terminal"]')).not.toBeNull();
    expect(gutters[1]?.querySelector("img")?.getAttribute("src")).toBe("https://x.test/i.png");
    expect(gutters[2]?.querySelector('[data-part="rail-dot"]')).not.toBeNull();
    expect(container.querySelector('[data-part="rail-gutter"] [data-part="spinner"]')).toBeNull();
  });

  it("a live parallel command group: spinners only in the head and on each running row", () => {
    const rows: ToolRowData[] = [
      {
        id: "a",
        kind: "command",
        name: "Bash",
        description: "检查依赖",
        status: "running",
        startedAt: 0,
      },
      {
        id: "b",
        kind: "command",
        name: "Bash",
        description: "运行测试",
        status: "pending",
        startedAt: 1_000,
      },
    ];
    const { container } = wrap(
      <ProcessBlock {...base({ state: "running", open: true, current: "检查依赖 等 2 个命令" })}>
        <RailStep icon={{ name: "terminal" }}>
          <ToolGroup inRail rows={rows} now={4_000} />
        </RailStep>
      </ProcessBlock>,
    );
    const spinners = [...container.querySelectorAll('[data-part="spinner"]')];
    // the head's, then one per running row; none in the gutter or the group header
    expect(spinners).toHaveLength(3);
    expect(head(container).querySelectorAll('[data-part="spinner"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-part="tool-row"] [data-part="spinner"]')).toHaveLength(
      2,
    );
    const gutter = container.querySelector('[data-part="rail-gutter"]') as HTMLElement;
    expect(gutter.querySelector('[data-icon="terminal"]')).not.toBeNull();
    expect(container.textContent).toContain("正在运行 2 个命令 · 已完成 0 个");
    // every running row shows its time from its start, a queued one too
    const times = [...container.querySelectorAll('[data-part="tool-row"] .cb-tool-end')].map(
      (e) => e.textContent,
    );
    expect(times).toEqual(["4 秒", "3 秒"]);
  });

  it("the planning row ends the rail, the head names no step, and it stands before any step", () => {
    const { container } = wrap(
      <ProcessBlock
        {...base({
          state: "running",
          open: true,
          current: "读取 a.md",
          planning: true,
          children: undefined,
        })}
      />,
    );
    const rail = container.querySelector('[data-part="process-rail"]') as HTMLElement;
    expect(rail.querySelector('[data-part="rail-planning"]')).not.toBeNull();
    expect(head(container).textContent).not.toContain("读取 a.md");
    expect(head(container).textContent).toContain("正在运行");
    // the capybara is the rail's only animated node: no spinner beside it
    expect(rail.querySelector('[data-part="spinner"]')).toBeNull();
    expect(rail.querySelector('[data-part="working-mark"]')).not.toBeNull();
  });

  it("the planning row is the last rail row and takes the last edge (windowed rows)", () => {
    const rows: RailRow[] = ["a", "b"].map((k) => ({
      key: k,
      render: () => <RailStep icon={{ name: "terminal" }}>{k}</RailStep>,
    }));
    const { container, rerender } = wrap(
      <ProcessBlock
        {...base({ state: "running", open: true, rows, planning: true, children: undefined })}
      />,
    );
    const list = () => [...container.querySelectorAll('[data-part="rail-list"] > [data-edge]')];
    expect(list().map((e) => e.getAttribute("data-part"))).toEqual([
      "rail-step",
      "rail-step",
      "rail-planning",
    ]);
    expect(list().at(-1)?.getAttribute("data-edge")).toBe("last");
    // the next step starts: it stands where the planning row stood
    const next = [
      ...rows,
      { key: "c", render: () => <RailStep icon={{ name: "lightbulb" }}>c</RailStep> },
    ];
    rerender(
      <DesignProvider locale="zh">
        <ProcessBlock
          {...base({ state: "running", open: true, rows: next, children: undefined })}
        />
      </DesignProvider>,
    );
    expect(container.querySelector('[data-part="rail-planning"]')).toBeNull();
    expect(list().at(-1)?.textContent).toBe("c");
    expect(list().at(-1)?.getAttribute("data-edge")).toBe("last");
  });

  it("narration renders its Markdown compactly: code and bold, no raw marks", () => {
    const { container } = wrap(
      <ProcessBlock {...base({ open: true })}>
        <RailStep icon="dot">
          <RailText>{"core `29e091ba1`、plugins `7f2d874` 都**已发布**"}</RailText>
        </RailStep>
      </ProcessBlock>,
    );
    const say = container.querySelector('[data-part="rail-text"]') as HTMLElement;
    expect([...say.querySelectorAll("code")].map((c) => c.textContent)).toEqual([
      "29e091ba1",
      "7f2d874",
    ]);
    expect(say.querySelector("strong")?.textContent).toBe("已发布");
    expect(say.textContent).not.toMatch(/[`*]/);
  });

  it("a finished block draws no planning row", () => {
    const { container } = wrap(<ProcessBlock {...base({ open: true, planning: true })} />);
    expect(container.querySelector('[data-part="rail-planning"]')).toBeNull();
  });

  it("pinned content sits under the head, before the rail", () => {
    const { container } = wrap(
      <ProcessBlock {...base({ open: true, pinned: <div data-testid="pin">待办卡</div> })} />,
    );
    const order = [
      ...container.querySelectorAll(
        '[data-part="process-head"], [data-testid="pin"], [data-part="process-rail"]',
      ),
    ].map((e) => e.getAttribute("data-part") ?? e.getAttribute("data-testid"));
    expect(order).toEqual(["process-head", "pin", "process-rail"]);
  });
});

describe("PendingActions", () => {
  const item = (n: number) => ({
    key: `k${n}`,
    icon: { name: "external-link" as const },
    title: `事项 ${n}`,
    description: "需要你确认",
    action: { label: "去处理", href: `/p/${n}` },
  });

  it("pending actions merge with the many-line only for two or more", () => {
    const one = wrap(<PendingActions items={[item(1)]} />);
    expect(one.container.querySelector('[data-part="pending-many"]')).toBeNull();
    expect(screen.getByRole("link", { name: "去处理" }).getAttribute("href")).toBe("/p/1");
    cleanup();
    const two = wrap(<PendingActions items={[item(1), item(2)]} />);
    expect(two.container.querySelector('[data-part="pending-many"]')?.textContent).toBe(
      "2 项需要你处理 · 不阻塞，我已继续",
    );
    expect(screen.getAllByRole("link", { name: "去处理" })).toHaveLength(2);
  });

  it("a page link goes through the app's design link (client navigation)", () => {
    const AppLink = ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
      <a href={href} data-app-link="" {...rest}>
        {children}
      </a>
    );
    render(
      <DesignProvider locale="zh" link={AppLink}>
        <PendingActions items={[item(1)]} />
      </DesignProvider>,
    );
    const a = screen.getByRole("link", { name: "去处理" });
    expect(a.hasAttribute("data-app-link")).toBe(true);
    expect(a.getAttribute("data-part")).toBe("pending-action");
    expect(a.getAttribute("href")).toBe("/p/1");
  });

  it("the many-line in English", () => {
    const { container } = wrap(<PendingActions items={[item(1), item(2)]} />, "en");
    expect(container.querySelector('[data-part="pending-many"]')?.textContent).toBe(
      "2 things need you · not blocking, I carried on",
    );
  });

  it("a button action starts the thing in place; busy disables it", async () => {
    const onClick = vi.fn();
    const button = (busy?: boolean) => ({
      ...item(1),
      action: { label: "连接", onClick, ...(busy !== undefined ? { busy } : {}) },
    });
    wrap(<PendingActions items={[button()]} />);
    const b = screen.getByRole("button", { name: "连接" });
    expect(b.getAttribute("data-part")).toBe("pending-action");
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.setup().click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    cleanup();
    wrap(<PendingActions items={[button(true)]} />);
    const busy = screen.getByRole("button", { name: "连接" });
    expect(busy).toHaveProperty("disabled", true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
  });

  it("no items draws nothing", () => {
    const { container } = wrap(<PendingActions items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ProcessBlock spacing in the thread", () => {
  it("space.5 only to what follows the block in its turn, never before it", () => {
    const rules = parseCss(css("conversation.css"));
    // the block itself adds no margin: a block after a message keeps the stack's gap
    const own = rules.find((r) => r.at === null && r.selector === ".cb-process");
    expect(own?.decls["margin-bottom"]).toBeUndefined();
    expect(own?.decls["margin-top"]).toBeUndefined();
    const after = rules.filter((r) => r.selector.includes(":has(> .cb-process:only-child) +"));
    expect(after).toHaveLength(1);
    // the thread's space.3 gap plus space.2; a user message or the run row after it is left out
    expect(after[0]?.selector).toContain('.cb-stack[data-gap="12"]');
    expect(after[0]?.selector).toContain(":not(:has(> .cb-user-msg, > .cb-run-row))");
    expect(after[0]?.decls["margin-top"]).toBe("var(--cb-space-2)");
  });
});

describe("ProcessBlock on touch and boxes", () => {
  const rules = parseCss(css("conversation.css"));
  const touch = (selector: string): Record<string, string> => {
    const hits = rules.filter(
      (r) =>
        r.at === MOBILE_SIZE_QUERY &&
        r.selector
          .split(",")
          .map((s) => s.trim())
          .includes(selector),
    );
    if (hits.length === 0) throw new Error(`no touch rule for ${selector}`);
    return Object.assign({}, ...hits.map((r) => r.decls));
  };

  it("head stays one line at compact", () => {
    // the head's toggle is hit high and full width; its label is the one part that ellipsizes
    expect(touch(".cb-process-head .cb-tool-line")["min-height"]).toBe("var(--cb-touch-hit)");
    expect(touch(".cb-process-head .cb-tool-line")).toMatchObject({ width: "100%" });
    expect(touch(".cb-process-head .cb-tool-label")).toMatchObject({ flex: "1 1 auto" });
    const label = rules.find(
      (r) => r.at === null && r.selector === ".cb-process-head .cb-tool-label",
    );
    expect(label?.decls["white-space"]).toBe("nowrap");
    expect(label?.decls["text-overflow"]).toBe("ellipsis");
  });

  it("no box in box", () => {
    const rows: ToolRowData[] = [
      { id: "a", kind: "read", name: "Read", keyArg: "a.ts", status: "done" },
      { id: "b", kind: "read", name: "Read", keyArg: "b.ts", status: "done" },
    ];
    wrap(
      <ProcessBlock
        {...base({
          open: true,
          pinned: <InlineCard source="todo" title="待办" state="ready" />,
        })}
      >
        <RailStep icon={{ name: "file-text" }}>
          <ToolGroup rows={rows} open />
        </RailStep>
      </ProcessBlock>,
    );
    expect(document.querySelector(".cb-tool-box")).not.toBeNull();
    expect(findNestedBoxes(document.body)).toEqual([]);
  });
});

describe("the tool line's key argument stays faint", () => {
  const rules = parseCss(css("conversation.css"));
  const color = (sel: string) =>
    rules
      .filter((r) =>
        r.selector
          .split(",")
          .map((s) => s.trim())
          .includes(sel),
      )
      .at(-1)?.decls.color;

  it("in a row and in a single tool line, whatever the row state", () => {
    expect(color('.cb-tool-row [data-part="key-arg"]')).toBe("var(--cb-faint)");
    expect(color('.cb-tool-line [data-part="key-arg"]:not(.cb-ink)')).toBe("var(--cb-faint)");
    // the running label turns `ink`; the key argument is its own element with its own colour
    expect(color('.cb-tool-row[data-status="running"] .cb-tool-label')).toBe("var(--cb-ink)");
  });

  it("no rule with a higher specificity recolours the key argument", () => {
    const hits = rules.filter(
      (r) => r.selector.includes("key-arg") && r.decls.color !== undefined && r.at === null,
    );
    for (const r of hits) {
      expect(r.decls.color, r.selector).toBe("var(--cb-faint)");
    }
  });
});

describe("ProcessBlock rail list (#924, #925)", () => {
  const stepRows = (n: number): RailRow[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `s${i}`,
      render: () => (
        <RailStep icon="dot">
          <button type="button">{`step ${i}`}</button>
        </RailStep>
      ),
    }));
  const rail = (c: HTMLElement) => c.querySelector('[data-part="rail-list"]') as HTMLElement;
  const edges = (c: HTMLElement) =>
    [...c.querySelectorAll("[data-edge]")].map((e) => e.getAttribute("data-edge"));

  it("a short list mounts every row with its place on the rule", () => {
    const { container } = wrap(<ProcessBlock {...base({ open: true, rows: stepRows(3) })} />);
    expect(rail(container).getAttribute("data-virtual")).toBeNull();
    expect(edges(container)).toEqual(["first", "mid", "last"]);
    cleanup();
    const one = wrap(<ProcessBlock {...base({ open: true, rows: stepRows(1) })} />);
    expect(edges(one.container)).toEqual(["only"]);
  });

  it("the edge rules follow data-edge after the child-position rules", () => {
    const rules = parseCss(css("conversation.css"));
    const at = (sel: string) => rules.findIndex((r) => r.selector === sel);
    expect(at('.cb-rail-step[data-edge="first"]::before')).toBeGreaterThan(
      at(".cb-rail-step:first-of-type::before"),
    );
    expect(at('.cb-rail-step[data-edge="last"]::before')).toBeGreaterThan(
      at(".cb-rail-step:last-of-type::before"),
    );
    expect(rules[at('.cb-rail-step[data-edge="only"]::before')]?.decls.display).toBe("none");
    // a spacer carries the rule through the rows it stands for
    expect(rules.find((r) => r.selector === ".cb-rail-spacer::before")?.decls.width).toBe("1px");
  });

  it("a long list mounts the rows near the viewport, a spacer keeps the rest", () => {
    const n = RAIL_VIRTUAL_MIN * 4;
    const { container } = wrap(<ProcessBlock {...base({ open: true, rows: stepRows(n) })} />);
    const list = rail(container);
    expect(list.getAttribute("data-virtual")).toBe("true");
    const mounted = list.querySelectorAll('[data-part="rail-step"]');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(n);
    expect(mounted[0]?.getAttribute("data-edge")).toBe("first");
    const spacer = list.lastElementChild as HTMLElement;
    expect(spacer.getAttribute("data-part")).toBe("rail-spacer");
    expect(spacer.getAttribute("aria-hidden")).toBe("true");
    expect(Number.parseFloat(spacer.style.height)).toBeGreaterThan(0);
  });

  it("a focused row stays mounted when the window moves away from it", async () => {
    const n = RAIL_VIRTUAL_MIN * 4;
    const { container, rerender } = wrap(
      <ProcessBlock {...base({ open: true, rows: stepRows(n) })} />,
    );
    const first = screen.getByRole("button", { name: "step 0" });
    first.focus();
    // the list moves far above the viewport: its rows near the top leave the window
    const list = rail(container);
    list.getBoundingClientRect = () => ({ top: -20_000, bottom: 0 }) as DOMRect;
    rerender(
      <DesignProvider locale="zh">
        <ProcessBlock {...base({ open: true, rows: stepRows(n) })} />
      </DesignProvider>,
    );
    expect(screen.queryByRole("button", { name: "step 1" })).toBeNull();
    // the focused row is still there, alone between two spacers, in rail order
    expect(document.activeElement).toBe(first);
    expect(first.closest("[data-edge]")?.getAttribute("data-edge")).toBe("first");
    const parts = [...list.children].map((c) => c.getAttribute("data-part"));
    expect(parts[0]).toBe("rail-step");
    expect(parts[1]).toBe("rail-spacer");
  });

  it("a section header names its item, counts its steps and toggles", async () => {
    const onToggle = vi.fn();
    const rows: RailRow[] = [
      {
        key: "sec",
        render: () => (
          <RailSection title="Read the spec" done steps={3} open={false} onToggle={onToggle} />
        ),
      },
      ...stepRows(1),
    ];
    const { container } = wrap(<ProcessBlock {...base({ open: true, rows })} />, "en");
    const header = container.querySelector('[data-part="rail-section"]') as HTMLElement;
    expect(header.getAttribute("data-edge")).toBe("first");
    expect(header.querySelector('[data-icon="check"]')).not.toBeNull();
    const toggle = within(header).getByRole("button");
    expect(toggle.textContent).toContain("Read the spec");
    expect(toggle.textContent).toContain("3 steps");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
