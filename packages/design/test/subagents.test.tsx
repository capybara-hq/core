import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundTasks,
  DesignProvider,
  SubagentGroup,
  SubagentRow,
  type SubagentRowData,
  SubagentTask,
  subagentDuration,
  subagentRowFromView,
  subagentRowsFromViews,
  subagentStatusOfFinish,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const noSummary = ({ summary: _, ...r }: SubagentRowData): SubagentRowData => r;

const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
const NOW = T0 + 148_000;

const running: SubagentRowData[] = [
  {
    id: "sa_tree",
    agentType: "调研",
    description: "列出示例文档目录树",
    status: "running",
    toolCalls: 20,
    startedAt: T0,
  },
  {
    id: "sa_dedupe",
    agentType: "调研",
    description: "读流程 v12 的去重代码",
    status: "running",
    toolCalls: 5,
    startedAt: T0 + 100_000,
  },
];

const done: SubagentRowData[] = [
  {
    id: "sa_map",
    agentType: "调研",
    description: "核对映射表里的重复收款人",
    status: "completed",
    toolCalls: 8,
    startedAt: T0,
    finishedAt: T0 + 72_000,
    summary: { steps: ["已运行 4 个命令", "已读取 示例表.xlsx"], result: "结论：取第一行。" },
  },
  {
    id: "sa_ids",
    agentType: "调研",
    description: "收集流程引用的文档 ID",
    status: "completed",
    toolCalls: 9,
    startedAt: T0 + 30_000,
    finishedAt: T0 + 71_000,
  },
  {
    id: "sa_draft",
    agentType: "起草",
    description: "给财务的确认消息",
    status: "failed",
    toolCalls: 4,
    startedAt: T0 + 93_000,
    finishedAt: T0 + 160_000,
  },
];

describe("SubagentGroup (§6.16.15)", () => {
  it("running: a spinner header naming the count, and a spinner per running row", () => {
    wrap(<SubagentGroup rows={running} onOpen={() => {}} now={NOW} />);
    expect(screen.getByText("正在运行 2 个子 agent")).toBeTruthy();
    // header + two rows
    expect(screen.getAllByRole("img", { name: "进行中" })).toHaveLength(3);
    expect(screen.getByText("2分28秒", { exact: false })).toBeTruthy();
  });

  it("done: a collapsed header with the failure count in fail and the totals", async () => {
    wrap(<SubagentGroup rows={done} onOpen={() => {}} />);
    const head = screen.getByRole("button", { name: /3 个子 agent 已完成/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    const fail = within(head).getByText("（1 个失败）");
    expect(fail.getAttribute("data-part")).toBe("fail-word");
    // totals: 21 calls, from the first start to the last finish (2:40)
    expect(head.textContent).toContain("共 21 次调用 · 2分40秒");
    expect(screen.queryByText("给财务的确认消息")).toBeNull();
    await userEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const failedRow = screen.getByRole("button", { name: /给财务的确认消息/ });
    expect(within(failedRow).getByText("失败")).toBeTruthy();
  });

  it("no failure count when nothing failed", () => {
    wrap(<SubagentGroup rows={done.slice(0, 2)} onOpen={() => {}} />);
    expect(screen.queryByText(/个失败/)).toBeNull();
  });

  it("the row open in the right panel is current and marked open", () => {
    wrap(<SubagentGroup rows={running} openId="sa_tree" onOpen={() => {}} now={NOW} />);
    const row = screen.getByRole("button", { name: "在右侧打开 列出示例文档目录树" });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("data-open")).toBe("true");
    const other = screen.getByRole("button", { name: "在右侧打开 读流程 v12 的去重代码" });
    expect(other.getAttribute("aria-current")).toBeNull();
  });

  it("clicking a row opens it on the right", async () => {
    const onOpen = vi.fn();
    wrap(<SubagentGroup rows={running} onOpen={onOpen} now={NOW} />);
    await userEvent.click(screen.getByRole("button", { name: "在右侧打开 读流程 v12 的去重代码" }));
    expect(onOpen).toHaveBeenCalledWith("sa_dedupe");
  });

  it("en copy", () => {
    wrap(<SubagentGroup rows={running} onOpen={() => {}} now={NOW} />, "en");
    expect(screen.getByText("2 subagents running")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open 列出示例文档目录树 on the right" }),
    ).toBeTruthy();
  });
});

describe("SubagentRow", () => {
  it("success has no status mark; failure says 失败", () => {
    const [ok, , bad] = done;
    if (!ok || !bad) throw new Error("fixture");
    const { container } = wrap(
      <>
        <SubagentRow row={noSummary(ok)} onOpen={() => {}} />
        <SubagentRow row={bad} onOpen={() => {}} />
      </>,
    );
    const rows = container.querySelectorAll('[data-part="subagent-row"]');
    expect(rows[0]?.textContent).not.toContain("失败");
    expect(rows[0]?.textContent).toContain("8 次调用 · 1分12秒");
    expect(rows[1]?.textContent).toContain("失败");
    expect(rows[1]?.querySelector('[data-part="agent-tag"]')?.textContent).toBe("起草");
  });

  it("a row with a summary expands in place with steps, result and open-on-the-right", async () => {
    const [row] = done;
    if (!row) throw new Error("fixture");
    const onOpen = vi.fn();
    const { container } = wrap(<SubagentRow row={row} onOpen={onOpen} />);
    const btn = screen.getByRole("button", { name: /核对映射表里的重复收款人/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-part="subagent-steps"]')?.textContent).toContain(
      "已读取 示例表.xlsx",
    );
    expect(container.querySelector('[data-part="subagent-result"]')?.textContent).toBe(
      "结论：取第一行。",
    );
    await userEvent.click(screen.getByRole("button", { name: "在右侧打开完整记录" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("waiting for a person names what it waits for", () => {
    wrap(
      <SubagentRow
        row={{ ...running[0], status: "waiting", waiting: "approval" } as SubagentRowData}
        onOpen={() => {}}
        now={NOW}
      />,
    );
    expect(screen.getByText("等待批准")).toBeTruthy();
  });

  it("a stopped sub-agent says so in muted, not as a failure", () => {
    const [row] = done;
    if (!row) throw new Error("fixture");
    wrap(<SubagentRow row={{ ...noSummary(row), status: "aborted" }} onOpen={() => {}} />);
    expect(screen.getByText("已停止")).toBeTruthy();
    expect(screen.queryByText("失败")).toBeNull();
  });
});

describe("SubagentTask", () => {
  it("draws the task block and the agent · model · tools line", () => {
    const { container } = wrap(
      <SubagentTask text="列出目录树" agent="研究助手" model="opus 5.5" tools="只读工具" />,
    );
    const task = container.querySelector('[data-part="subagent-task"]');
    expect(task?.textContent).toContain("任务 · 主 agent 派出");
    expect(task?.textContent).toContain("列出目录树");
    expect(screen.getByText("研究助手 · 子 agent · opus 5.5 · 只读工具")).toBeTruthy();
  });
});

describe("BackgroundTasks", () => {
  it("stop buttons are named after the task; completed opens the list", async () => {
    const onStop = vi.fn();
    const onCompleted = vi.fn();
    const onOpen = vi.fn();
    wrap(
      <BackgroundTasks
        running={[{ id: "sa_tree", name: "列出示例文档目录树", elapsed: "2:28" }]}
        completed={6}
        onStop={onStop}
        onOpen={onOpen}
        onCompleted={onCompleted}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "停止 列出示例文档目录树" }));
    expect(onStop).toHaveBeenCalledWith("sa_tree");
    await userEvent.click(screen.getByRole("button", { name: "列出示例文档目录树" }));
    expect(onOpen).toHaveBeenCalledWith("sa_tree");
    await userEvent.click(screen.getByRole("button", { name: /已完成 6 项/ }));
    expect(onCompleted).toHaveBeenCalled();
  });
});

describe("phase C shapes (sub-agents spec §14)", () => {
  const view = (over: Record<string, unknown> = {}) => ({
    id: "cnv_child_1",
    agentType: "general-purpose",
    description: "列出目录树",
    status: "running" as const,
    toolCalls: 3,
    startedAt: "2026-10-26T06:00:00.000Z",
    finishedAt: null,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    pendingApprovalIds: [],
    pendingQuestionIds: [],
    ...over,
  });

  it("maps a SubagentView to a row", () => {
    expect(subagentRowFromView(view())).toEqual({
      id: "cnv_child_1",
      agentType: "general-purpose",
      description: "列出目录树",
      status: "running",
      toolCalls: 3,
      startedAt: T0,
    });
    const r = subagentRowFromView(
      view({ status: "completed", finishedAt: "2026-10-26T06:01:12.000Z" }),
    );
    expect(r.finishedAt).toBe(T0 + 72_000);
  });

  it("a waiting view with a pending approval waits for an approval", () => {
    expect(
      subagentRowFromView(view({ status: "waiting", pendingApprovalIds: ["apr_1"] })).waiting,
    ).toBe("approval");
    expect(
      subagentRowFromView(view({ status: "waiting", pendingQuestionIds: ["q_1"] })).waiting,
    ).toBe("input");
  });

  it("progress raises the call count of a running row", () => {
    const [r] = subagentRowsFromViews([view()], { cnv_child_1: { toolCalls: 7, step: 3 } });
    expect(r?.toolCalls).toBe(7);
  });

  it("orders rows by child creation (the API lists newest first)", () => {
    const rows = subagentRowsFromViews([
      view({ id: "c3" }),
      view({ id: "c2" }),
      view({ id: "c1" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("subagent_finished statuses fold into the view's", () => {
    expect(subagentStatusOfFinish("completed")).toBe("completed");
    expect(subagentStatusOfFinish("aborted")).toBe("aborted");
    for (const s of ["failed", "max_steps", "max_duration", "budget", "timed_out"] as const)
      expect(subagentStatusOfFinish(s)).toBe("failed");
  });

  it("formats durations like the reference", () => {
    expect(subagentDuration(41_000, "zh")).toBe("41 秒");
    expect(subagentDuration(72_000, "zh")).toBe("1分12秒");
    expect(subagentDuration(67_000, "en")).toBe("1m 07s");
  });
});
