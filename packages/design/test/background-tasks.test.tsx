import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundFinishedList,
  type BackgroundItem,
  BackgroundTaskRow,
  BackgroundTasks,
  DesignProvider,
  TaskOutputPanel,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const T0 = Date.UTC(2026, 10, 5, 6, 0, 0);
const NOW = T0 + 148_000;

const task = (over: Partial<Extract<BackgroundItem, { kind: "task" }>> = {}): BackgroundItem => ({
  kind: "task",
  id: "bgt_1",
  description: "pnpm dev",
  status: "running",
  startedAt: T0,
  ...over,
});

const agent = (
  over: Partial<Extract<BackgroundItem, { kind: "subagent" }>> = {},
): BackgroundItem => ({
  kind: "subagent",
  id: "sa_1",
  name: "列出目录树",
  status: "running",
  startedAt: T0,
  ...over,
});

describe("BackgroundTasks sub-agent rows", () => {
  it("a sub-agent waiting for a person has no spinner and says what for instead of the time", () => {
    const { container } = wrap(
      <BackgroundTasks
        items={[agent({ status: "waiting", waiting: "input" })]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(screen.getByText("等待回答")).toBeTruthy();
    expect(screen.queryByText("2 分 28 秒")).toBeNull();
  });
});

describe("BackgroundTasks task rows", () => {
  it("a running task has a spinner, the description, the elapsed time and a named stop button", async () => {
    const onStop = vi.fn();
    const onOpen = vi.fn();
    const { container } = wrap(
      <BackgroundTasks items={[task()]} now={NOW} onStop={onStop} onOpen={onOpen} />,
    );
    expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
    expect(screen.getByText("2 分 28 秒")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "pnpm dev" }));
    expect(onOpen).toHaveBeenCalledWith("bgt_1");
    await userEvent.click(screen.getByRole("button", { name: "停止「pnpm dev」" }));
    expect(onStop).toHaveBeenCalledWith("bgt_1");
  });

  it("a stopping task keeps the spinner, has no stop button and says so", () => {
    const { container } = wrap(
      <BackgroundTasks
        items={[task({ stopping: true })]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
      "en",
    );
    expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.getByText("Stopping…")).toBeTruthy();
  });

  it("a failed row has the fail mark and no spinner", () => {
    const { container } = wrap(
      <BackgroundTaskRow
        item={task({ status: "failed", finishedAt: T0 + 5_000, exitCode: 2 })}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.querySelector('[data-part="fail-word"]')?.textContent).toBe("失败");
    expect(screen.queryByRole("button", { name: /停止/ })).toBeNull();
  });

  it.each([
    ["completed", "Done", "task-status"],
    ["stopped", "Stopped", "task-status"],
    ["lost", "Lost", "task-status"],
    ["timed_out", "Timed out", "fail-word"],
  ] as const)("a %s row says %s", (status, word, part) => {
    const { container } = wrap(
      <BackgroundTaskRow
        item={task({ status, finishedAt: T0 + 5_000 })}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
      "en",
    );
    expect(container.querySelector(`[data-part="${part}"]`)?.textContent).toBe(word);
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
  });

  it("a nested task is indented under its sub-agent", () => {
    const { container } = wrap(
      <BackgroundTasks
        items={[{ ...agent(), tasks: [task({ id: "bgt_n" })] } as BackgroundItem]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const rows = [...container.querySelectorAll('[data-part="task-row"]')];
    expect(rows.map((r) => r.getAttribute("data-nested"))).toEqual([null, "true"]);
    expect(within(rows[0] as HTMLElement).getByText("列出目录树")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("pnpm dev")).toBeTruthy();
  });

  it("a task under a finished sub-agent is still nested; the finished parent is no row", () => {
    const { container } = wrap(
      <BackgroundTasks
        items={[
          {
            ...agent({ status: "completed", finishedAt: T0 + 1_000 }),
            tasks: [task({ id: "bgt_n" })],
          } as BackgroundItem,
        ]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const rows = [...container.querySelectorAll('[data-part="task-row"]')];
    expect(rows.map((r) => r.getAttribute("data-nested"))).toEqual(["true"]);
  });

  it("the stopping text is announced politely", () => {
    wrap(
      <BackgroundTasks
        items={[task({ stopping: true })]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
      />,
      "en",
    );
    const el = screen.getByText("Stopping…");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });

  it("N completed counts finished tasks and sub-agents together and opens the newest", async () => {
    const onOpen = vi.fn();
    wrap(
      <BackgroundTasks
        items={[
          task({ id: "t_old", status: "completed", finishedAt: T0 + 1_000 }),
          agent({ id: "sa_new", status: "completed", finishedAt: T0 + 9_000 }),
          {
            ...agent({ id: "sa_run" }),
            tasks: [task({ id: "t_failed", status: "failed", finishedAt: T0 + 3_000 })],
          } as BackgroundItem,
        ]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={onOpen}
      />,
      "en",
    );
    await userEvent.click(screen.getByRole("button", { name: /3 completed/ }));
    expect(onOpen).toHaveBeenCalledWith("sa_new");
  });

  it("with onOpenCompleted, N completed opens the finished list instead of the newest", async () => {
    const onOpen = vi.fn();
    const onOpenCompleted = vi.fn();
    wrap(
      <BackgroundTasks
        items={[task({ id: "t_old", status: "completed", finishedAt: T0 + 1_000 })]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={onOpen}
        onOpenCompleted={onOpenCompleted}
      />,
      "en",
    );
    await userEvent.click(screen.getByRole("button", { name: /1 completed/ }));
    expect(onOpenCompleted).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("completedLabel replaces the default wording", () => {
    wrap(
      <BackgroundTasks
        items={[task({ status: "completed", finishedAt: T0 + 1_000 })]}
        now={NOW}
        onStop={vi.fn()}
        onOpen={vi.fn()}
        completedLabel={(n) => `done ${n}`}
      />,
    );
    expect(screen.getByRole("button", { name: /done 1/ })).toBeTruthy();
  });
});

describe("BackgroundFinishedList", () => {
  it("lists the finished tasks and sub-agents newest first, with status, time and when; a row opens", async () => {
    const onOpen = vi.fn();
    const { container } = wrap(
      <BackgroundFinishedList
        items={[
          task({ id: "t_run" }),
          task({ id: "t_old", description: "old", status: "completed", finishedAt: T0 + 1_000 }),
          agent({ id: "sa_new", name: "newest", status: "completed", finishedAt: T0 + 9_000 }),
          {
            ...agent({ id: "sa_run" }),
            tasks: [
              task({ id: "t_fail", description: "mid", status: "failed", finishedAt: T0 + 3_000 }),
            ],
          } as BackgroundItem,
        ]}
        onOpen={onOpen}
      />,
      "en",
    );
    const rows = [...container.querySelectorAll('[data-part="task-row"]')];
    expect(rows.map((r) => r.querySelector("button")?.textContent)).toEqual([
      "newest",
      "mid",
      "old",
    ]);
    // no spinner, no stop, a status word, the elapsed time and the finish time on every row
    expect(container.querySelector(".cb-spinner")).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(rows[1]?.textContent).toContain("Failed");
    expect(rows.every((r) => r.querySelector('[data-part="task-time"]') !== null)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "mid" }));
    expect(onOpen).toHaveBeenCalledWith("t_fail");
  });

  it("an empty list says so", () => {
    wrap(<BackgroundFinishedList items={[task()]} onOpen={vi.fn()} />, "en");
    expect(screen.getByText("No finished background tasks")).toBeTruthy();
  });
});

describe("TaskOutputPanel", () => {
  it("stopping: no stop button, Stopping… announced politely", () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="pnpm dev"
        command="pnpm dev"
        status="running"
        elapsed="2m 28s"
        text="ready"
        source="sandbox"
        stopping
        onStop={vi.fn()}
      />,
      "en",
    );
    expect(screen.queryByRole("button", { name: "Stop pnpm dev" })).toBeNull();
    const el = container.querySelector('[data-part="task-output-stopping"]') as HTMLElement;
    expect(el.textContent).toBe("Stopping…");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });

  it("a finished task ignores stopping: neither the button nor the stopping text", () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="pnpm dev"
        command="pnpm dev"
        status="stopped"
        elapsed="2m 28s"
        text="ready"
        source="sandbox"
        stopping
        onStop={vi.fn()}
      />,
      "en",
    );
    expect(screen.queryByRole("button", { name: "Stop pnpm dev" })).toBeNull();
    expect(container.querySelector('[data-part="task-output-stopping"]')).toBeNull();
  });

  it("shows the command in mono and the text in a CodeBlock", async () => {
    const onStop = vi.fn();
    const { container } = wrap(
      <TaskOutputPanel
        description="pnpm dev"
        command="pnpm dev --port 3000"
        status="running"
        elapsed="2 分 28 秒"
        text={"ready\nlistening"}
        source="sandbox"
        onStop={onStop}
      />,
    );
    expect(container.querySelector('[data-part="task-command"]')?.textContent).toBe(
      "pnpm dev --port 3000",
    );
    expect(container.querySelector(".cb-code code")?.textContent).toBe("ready\nlistening");
    expect(container.querySelector('[data-part="task-output-note"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "停止「pnpm dev」" }));
    expect(onStop).toHaveBeenCalled();
  });

  it('source "event" puts the reason above the last lines; a finished task has no stop', () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="pnpm dev"
        command="pnpm dev"
        status="completed"
        elapsed="5s"
        text="tail"
        source="event"
        unavailable={{ reason: "suspended", environment: "sandbox" }}
        onStop={vi.fn()}
      />,
      "en",
    );
    const note = container.querySelector('[data-part="task-output-note"]');
    expect(note?.textContent).toBe(
      "The sandbox is suspended; the full output can't be read. Below are the last lines kept when it finished.",
    );
    const code = container.querySelector(".cb-code") as Element;
    expect(note?.compareDocumentPosition(code)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("names the device, never the sandbox, for a task on a local device", () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="t"
        command="c"
        status="completed"
        elapsed="5s"
        text=""
        source="none"
        unavailable={{ reason: "device_offline", environment: "device" }}
        onStop={vi.fn()}
      />,
    );
    const note = container.querySelector('[data-part="task-output-note"]')?.textContent ?? "";
    expect(note).toBe("设备离线，读不到完整输出。");
    expect(note).not.toContain("沙箱");
  });

  it("a task that never started says so with the launch's reason and draws no output box", () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="t"
        command="c"
        status="failed"
        elapsed="0.2 秒"
        text=""
        source="none"
        unavailable={{
          reason: "not_started",
          environment: "device",
          detail: "setsid is missing",
        }}
        onStop={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-part="task-output-note"]')?.textContent).toBe(
      "任务没有启动。",
    );
    expect(container.querySelector('[data-part="task-output-detail"]')?.textContent).toBe(
      "setsid is missing",
    );
    expect(container.querySelector(".cb-code")).toBeNull();
    expect(container.querySelector('[data-part="task-output-empty"]')).toBeNull();
  });

  it("empty output: a muted 'No output' line instead of an empty box", () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="t"
        command="c"
        status="completed"
        elapsed="1s"
        text=""
        source="sandbox"
        onStop={vi.fn()}
      />,
      "en",
    );
    expect(container.querySelector(".cb-code")).toBeNull();
    const empty = container.querySelector('[data-part="task-output-empty"]');
    expect(empty?.textContent).toBe("No output");
    expect(empty?.className).toContain("cb-muted");
  });

  it("the device and sandbox words of each reason are in both languages", () => {
    for (const environment of ["device", "sandbox"] as const) {
      for (const locale of ["zh", "en"] as const) {
        const { container, unmount } = wrap(
          <TaskOutputPanel
            description="t"
            command="c"
            status="completed"
            elapsed="1s"
            text=""
            source="none"
            unavailable={{ reason: "output_missing", environment }}
            onStop={vi.fn()}
          />,
          locale,
        );
        const note = container.querySelector('[data-part="task-output-note"]')?.textContent ?? "";
        const word = {
          device: { zh: "设备", en: "device" },
          sandbox: { zh: "沙箱", en: "sandbox" },
        };
        expect(note).toContain(word[environment][locale]);
        unmount();
      }
    }
  });
});
