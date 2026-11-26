import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  InlineCard,
  MOBILE_SIZE_QUERY,
  PendingActions,
  ProcessBlock,
  type ProcessBlockProps,
  RailStep,
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

  it("rail rule spans first to last icon", () => {
    const { container } = wrap(
      <ProcessBlock {...base({ open: true })}>
        <RailStep icon={{ name: "lightbulb" }}>a</RailStep>
        <RailStep icon="dot">b</RailStep>
        <RailStep icon="spinner">c</RailStep>
      </ProcessBlock>,
    );
    const steps = [...container.querySelectorAll('[data-part="rail-step"]')];
    expect(steps.map((s) => s.getAttribute("data-edge"))).toEqual(["first", null, "last"]);
    cleanup();
    const one = wrap(
      <ProcessBlock {...base({ open: true })}>
        <RailStep icon="hand">only</RailStep>
      </ProcessBlock>,
    );
    expect(one.container.querySelector('[data-part="rail-step"]')?.getAttribute("data-edge")).toBe(
      "only",
    );
  });

  it("a step draws its icon in the gutter: kind icon, image, dot, spinner, hand", () => {
    const { container } = wrap(
      <ProcessBlock {...base({ open: true })}>
        <RailStep icon={{ name: "terminal" }}>a</RailStep>
        <RailStep icon={{ src: "https://x.test/i.png" }}>b</RailStep>
        <RailStep icon="dot">c</RailStep>
        <RailStep icon="spinner">d</RailStep>
        <RailStep icon="hand">e</RailStep>
      </ProcessBlock>,
    );
    const gutters = [...container.querySelectorAll('[data-part="rail-gutter"]')];
    expect(gutters[0]?.querySelector('[data-icon="terminal"]')).not.toBeNull();
    expect(gutters[1]?.querySelector("img")?.getAttribute("src")).toBe("https://x.test/i.png");
    expect(gutters[2]?.querySelector('[data-part="rail-dot"]')).not.toBeNull();
    expect(gutters[3]?.querySelector('[data-part="spinner"]')).not.toBeNull();
    expect(gutters[4]?.querySelector('[data-icon="hand"]')).not.toBeNull();
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

  it("the many-line in English", () => {
    const { container } = wrap(<PendingActions items={[item(1), item(2)]} />, "en");
    expect(container.querySelector('[data-part="pending-many"]')?.textContent).toBe(
      "2 things need you · not blocking, I carried on",
    );
  });

  it("no items draws nothing", () => {
    const { container } = wrap(<PendingActions items={[]} />);
    expect(container.firstChild).toBeNull();
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
