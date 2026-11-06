import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundTasks,
  DesignProvider,
  SubagentGroup,
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

const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
const NOW = T0 + 148_000;

const running: SubagentRowData[] = [
  {
    id: "sa_tree",
    agentType: "调研",
    description: "列出示例文档目录树",
    prompt: "只读地列出文档文件夹「示例项目」下的完整目录树。",
    current: "Bash 列出「02 流程」下的子目录",
    status: "running",
    toolCalls: 20,
    startedAt: T0,
  },
  {
    id: "sa_dedupe",
    agentType: "调研",
    description: "读流程 v12 的去重代码",
    prompt: "读流程 v12 里处理重复收款人的代码，说明去重规则。",
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
    prompt: "核对映射表里的重复收款人。",
    status: "completed",
    toolCalls: 8,
    tokens: 63_400,
    startedAt: T0,
    finishedAt: T0 + 72_000,
  },
  {
    id: "sa_ids",
    agentType: "调研",
    description: "收集流程引用的文档 ID",
    prompt: "收集流程引用的文档 ID。",
    status: "completed",
    toolCalls: 9,
    startedAt: T0 + 30_000,
    finishedAt: T0 + 71_000,
  },
  {
    id: "sa_draft",
    agentType: "起草",
    description: "给财务的确认消息",
    prompt: "起草给财务的确认消息。",
    status: "failed",
    toolCalls: 4,
    tokens: 12_800,
    startedAt: T0 + 93_000,
    finishedAt: T0 + 160_000,
  },
];

const blocks = (root: ParentNode = document) =>
  [...root.querySelectorAll('[data-part="agent-call-block"]')] as HTMLElement[];
const statusText = (b: HTMLElement) =>
  b.querySelector('[data-part="agent-call-text"]')?.textContent;

describe("SubagentGroup (§6.16.15)", () => {
  it("running: a spinner header naming the count over one Agent call block per sub-agent", () => {
    wrap(<SubagentGroup rows={running} onOpen={() => {}} />);
    expect(screen.getByText("正在运行 2 个子 agent")).toBeTruthy();
    // the header's spinner only: a running block shows the pulsing dot instead
    const spinners = screen.getAllByRole("img", { name: "进行中" });
    expect(spinners).toHaveLength(1);
    expect(spinners[0]?.querySelector("svg")?.getAttribute("width")).toBe("16");
    const [tree, dedupe] = blocks();
    expect(tree?.querySelector('[data-part="agent-call-head"]')?.textContent).toBe(
      "Agent 列出示例文档目录树",
    );
    expect(within(tree as HTMLElement).getByText(running[0]?.prompt ?? "")).toBeTruthy();
    expect(statusText(tree as HTMLElement)).toBe("后台运行中：Bash 列出「02 流程」下的子目录");
    expect(statusText(dedupe as HTMLElement)).toBe("后台运行中");
  });

  it("waiting: every active row waits, so no spinner anywhere and the header says what for", () => {
    const rows = running.map((r) => ({
      ...r,
      status: "waiting" as const,
      waiting: "approval" as const,
    }));
    const { container } = wrap(
      <SubagentGroup rows={[...rows, ...done.slice(0, 1)]} onOpen={() => {}} />,
    );
    expect(screen.queryByRole("img", { name: "进行中" })).toBeNull();
    const head = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    expect(within(head).getByText("等待批准")).toBeTruthy();
    expect(within(head).getByText("· 已完成 1 个", { exact: false })).toBeTruthy();
    expect(within(head).queryByText("正在运行", { exact: false })).toBeNull();
    const [first] = blocks();
    expect(first?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "waiting",
    );
  });

  it("one row running and one waiting: the header keeps its spinner and the count", () => {
    const rows = [running[0], { ...running[1], status: "waiting", waiting: "approval" }];
    wrap(<SubagentGroup rows={rows as SubagentRowData[]} onOpen={() => {}} />);
    expect(screen.getByText("正在运行 2 个子 agent")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "进行中" })).toHaveLength(1);
  });

  it("a queued sub-agent shows as working in the background", () => {
    wrap(
      <SubagentGroup
        rows={[{ ...(running[1] as SubagentRowData), status: "queued" }]}
        onOpen={() => {}}
      />,
    );
    const [b] = blocks();
    expect(b?.querySelector('[data-part="agent-dot"]')?.getAttribute("data-status")).toBe(
      "running",
    );
    expect(statusText(b as HTMLElement)).toBe("后台运行中");
  });

  it("done: a collapsed header with the failure count in fail and the totals", async () => {
    wrap(<SubagentGroup rows={done} onOpen={() => {}} />);
    const head = screen.getByRole("button", { name: /3 个子 agent 已完成/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    const fail = within(head).getByText("（1 个失败）");
    expect(fail.getAttribute("data-part")).toBe("fail-word");
    // totals: 21 calls, from the first start to the last finish (2:40)
    expect(head.textContent).toContain("共 21 次调用 · 2分40秒");
    expect(blocks()).toHaveLength(0);
    await userEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const [map, ids, draft] = blocks();
    expect(statusText(map as HTMLElement)).toBe("完成 · 1分12秒 · 63.4k tokens");
    expect(statusText(ids as HTMLElement)).toBe("完成 · 41 秒");
    expect(statusText(draft as HTMLElement)).toBe("失败 · 1分07秒 · 12.8k tokens");
  });

  it("a finished call's time is its exact duration when known", async () => {
    const row = { ...(done[0] as SubagentRowData), durationMs: 65_000 };
    wrap(<SubagentGroup rows={[row]} onOpen={() => {}} defaultOpen />);
    expect(statusText(blocks()[0] as HTMLElement)).toBe("完成 · 1分05秒 · 63.4k tokens");
  });

  it("no failure count when nothing failed", () => {
    wrap(<SubagentGroup rows={done.slice(0, 2)} onOpen={() => {}} />);
    expect(screen.queryByText(/个失败/)).toBeNull();
  });

  it("a stopped sub-agent says so, not as a failure", () => {
    wrap(
      <SubagentGroup
        rows={[{ ...(done[0] as SubagentRowData), status: "aborted" }]}
        onOpen={() => {}}
        defaultOpen
      />,
    );
    expect(statusText(blocks()[0] as HTMLElement)).toBe("已停止 · 1分12秒 · 63.4k tokens");
  });

  it("a block's action opens that sub-agent", async () => {
    const onOpen = vi.fn();
    wrap(<SubagentGroup rows={running} onOpen={onOpen} />);
    const second = blocks()[1] as HTMLElement;
    await userEvent.click(within(second).getByRole("button", { name: "在智能体图中查看" }));
    expect(onOpen).toHaveBeenCalledWith("sa_dedupe");
  });

  it("a refused row (no child) has its reason and no open action; a foreground row no 后台", () => {
    wrap(
      <SubagentGroup
        rows={[
          {
            ...(done[2] as SubagentRowData),
            openable: false,
            refusal: "Subagent limit reached.",
          },
          { ...(running[0] as SubagentRowData), background: false },
        ]}
        onOpen={() => {}}
        defaultOpen
      />,
    );
    const [refused, fg] = blocks();
    expect(statusText(refused as HTMLElement)).toBe("失败 · Subagent limit reached.");
    expect(
      within(refused as HTMLElement).queryByRole("button", { name: "在智能体图中查看" }),
    ).toBeNull();
    expect(statusText(fg as HTMLElement)).toBe("运行中：Bash 列出「02 流程」下的子目录");
  });

  it("onOpenMap: an Agent map link at the end of the header, beside the toggle", async () => {
    const onOpenMap = vi.fn();
    const { unmount } = wrap(
      <SubagentGroup rows={running} onOpen={() => {}} onOpenMap={onOpenMap} />,
    );
    const line = document.querySelector('[data-part="tool-line"]') as HTMLElement;
    await userEvent.click(within(line).getByRole("button", { name: "智能体图" }));
    expect(onOpenMap).toHaveBeenCalledTimes(1);
    unmount();
    wrap(<SubagentGroup rows={done} onOpen={() => {}} onOpenMap={onOpenMap} />);
    const head = screen.getByRole("button", { name: /3 个子 agent 已完成/ });
    const link = screen.getByRole("button", { name: "智能体图" });
    // never nested in the toggle; the toggle still opens the group
    expect(head.contains(link)).toBe(false);
    await userEvent.click(link);
    expect(onOpenMap).toHaveBeenCalledTimes(2);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  it("without onOpenMap there is no map link", () => {
    wrap(<SubagentGroup rows={done} onOpen={() => {}} />);
    expect(screen.queryByRole("button", { name: "智能体图" })).toBeNull();
  });

  it("prompts listed in defaultExpanded start expanded", () => {
    wrap(<SubagentGroup rows={running} onOpen={() => {}} defaultExpanded={["sa_dedupe"]} />);
    const prompts = document.querySelectorAll('[data-part="agent-call-prompt"]');
    expect((prompts[0] as HTMLElement).dataset.expanded).toBe("false");
    expect((prompts[1] as HTMLElement).dataset.expanded).toBe("true");
  });

  it("en copy", () => {
    wrap(<SubagentGroup rows={running} onOpen={() => {}} />, "en");
    expect(screen.getByText("2 subagents running")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "View in agent map" })).toHaveLength(2);
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

  it("an org agent's name links to the agent; a template's name is plain", () => {
    const { unmount } = wrap(
      <SubagentTask
        text="t"
        agent="研究助手"
        agentHref="/agents/a1"
        model="opus 5.5"
        tools="只读工具"
      />,
    );
    const link = screen.getByRole("link", { name: "研究助手" });
    expect(link.getAttribute("href")).toBe("/agents/a1");
    expect(link.closest('[data-part="subagent-meta"]')?.textContent).toBe(
      "研究助手 · 子 agent · opus 5.5 · 只读工具",
    );
    unmount();
    wrap(<SubagentTask text="t" agent="研究助手" model="m" tools="" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("BackgroundTasks", () => {
  it("stop buttons are named after the task; completed opens the newest", async () => {
    const onStop = vi.fn();
    const onOpen = vi.fn();
    wrap(
      <BackgroundTasks
        items={[
          {
            kind: "subagent",
            id: "sa_tree",
            name: "列出示例文档目录树",
            status: "running",
            startedAt: T0,
          },
          {
            kind: "subagent",
            id: "sa_done",
            name: "核对映射表",
            status: "completed",
            startedAt: T0,
            finishedAt: T0 + 1000,
          },
        ]}
        now={NOW}
        onStop={onStop}
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "停止「列出示例文档目录树」" }));
    expect(onStop).toHaveBeenCalledWith("sa_tree");
    await userEvent.click(screen.getByRole("button", { name: "列出示例文档目录树" }));
    expect(onOpen).toHaveBeenCalledWith("sa_tree");
    await userEvent.click(screen.getByRole("button", { name: /已完成 1 项/ }));
    expect(onOpen).toHaveBeenCalledWith("sa_done");
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
