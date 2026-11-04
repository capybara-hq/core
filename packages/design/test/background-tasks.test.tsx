import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

describe("BackgroundTasks task rows", () => {
  it("a running task has a spinner, the description, the elapsed time and a named stop button", async () => {
    const onStop = vi.fn();
    const onOpen = vi.fn();
    const { container } = wrap(
      <BackgroundTasks items={[task()]} now={NOW} onStop={onStop} onOpen={onOpen} />,
    );
    expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
    expect(screen.getByText("2分28秒")).toBeTruthy();
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

describe("TaskOutputPanel", () => {
  it("shows the command in mono and the text in a CodeBlock", async () => {
    const onStop = vi.fn();
    const { container } = wrap(
      <TaskOutputPanel
        description="pnpm dev"
        command="pnpm dev --port 3000"
        status="running"
        elapsed="2分28秒"
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

  it('source "event" puts the unavailable note above the last lines; a finished task has no stop', () => {
    const { container } = wrap(
      <TaskOutputPanel
        description="pnpm dev"
        command="pnpm dev"
        status="completed"
        elapsed="5s"
        text="tail"
        source="event"
        onStop={vi.fn()}
      />,
      "en",
    );
    const note = container.querySelector('[data-part="task-output-note"]');
    expect(note?.textContent).toBe("Output unavailable (sandbox suspended)");
    const code = container.querySelector(".cb-code") as Element;
    expect(note?.compareDocumentPosition(code)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });
});
