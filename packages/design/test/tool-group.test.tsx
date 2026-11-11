import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesignProvider,
  DiffBlock,
  summarizeTools,
  ToolGroup,
  ToolRow,
  type ToolRowData,
} from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

let seq = 0;
const row = (over: Partial<ToolRowData> = {}): ToolRowData => ({
  id: `t${++seq}`,
  kind: "connector",
  name: "Acme",
  tool: "search_tickets",
  status: "done",
  ...over,
});
/** A builtin row: its name, no brackets. */
const builtin = (name: string, over: Partial<ToolRowData> = {}): ToolRowData => {
  const { tool: _, ...r } = row(over);
  return { ...r, name };
};
const many = (n: number, over: Partial<ToolRowData> = {}) =>
  Array.from({ length: n }, () => row(over));

describe("summarizeTools (spec §7 verb table)", () => {
  it("counts by kind in the fixed order commands, tools, reads, edits", () => {
    const rows = [row({ kind: "command", description: "x" }), ...many(19)];
    expect(summarizeTools(rows, "zh")).toBe("已运行 1 个命令，已使用 19 个工具");
    expect(summarizeTools(rows, "en")).toBe("Ran 1 command, used 19 tools");
    expect(summarizeTools([...many(2), row({ kind: "command" })], "zh")).toBe(
      "已运行 1 个命令，已使用 2 个工具",
    );
    const mixed = [
      row({ kind: "edit", keyArg: "a.ts" }),
      row({ kind: "edit", keyArg: "b.ts" }),
      row({ kind: "read", keyArg: "c.ts" }),
      row({ kind: "read", keyArg: "d.ts" }),
      row({ kind: "search" }),
      row({ kind: "command" }),
    ];
    expect(summarizeTools(mixed, "zh")).toBe(
      "已运行 1 个命令，已使用 1 个工具，已读取 2 个文件，已修改 2 个文件",
    );
    expect(summarizeTools(mixed, "en")).toBe(
      "Ran 1 command, used 1 tool, read 2 files, edited 2 files",
    );
  });

  it("counts search and meta rows with tools", () => {
    const rows = [row({ kind: "meta" }), row({ kind: "search" }), row({ kind: "tool" })];
    expect(summarizeTools(rows, "zh")).toBe("已使用 3 个工具");
  });

  it("appends failures", () => {
    const rows = [row({ kind: "command" }), ...many(17), ...many(2, { status: "failed" })];
    expect(summarizeTools(rows, "zh")).toContain("（2 个失败）");
    expect(summarizeTools(rows, "en")).toContain(" (2 failed)");
  });

  it("names the one object a kind touches", () => {
    const p = "reports/示例表.xlsx";
    const rows = [row({ kind: "read", keyArg: p }), row({ kind: "read", keyArg: p })];
    expect(summarizeTools(rows, "zh")).toBe(`已读取 ${p}`);
    expect(
      summarizeTools(
        [row({ kind: "read", keyArg: "a" }), row({ kind: "read", keyArg: "b" })],
        "zh",
      ),
    ).toBe("已读取 2 个文件");
  });

  it("adds edit line counts", () => {
    const rows = [
      row({ kind: "edit", keyArg: "a.py", added: 10, removed: 1 }),
      row({ kind: "edit", keyArg: "b.py", added: 2, removed: 2 }),
    ];
    expect(summarizeTools(rows, "zh")).toBe("已修改 2 个文件 · +12 −3");
  });

  it("running: the running row's verb and the done count", () => {
    const rows = [
      row({ kind: "command" }),
      row({ kind: "command" }),
      row({ kind: "read", status: "running" }),
    ];
    expect(summarizeTools(rows, "zh")).toBe("正在读取文件 · 已完成 2 个");
    expect(summarizeTools(rows, "en")).toBe("Reading file · 2 done");
  });
});

describe("ToolRow (§6.16.9)", () => {
  it("a connector row: bold display name and [tool], the title as tooltip, then the key argument", () => {
    const { container } = wrap(<ToolRow row={row({ tooltip: "搜索工单", keyArg: "#反馈" })} />);
    const r = container.querySelector('[data-part="tool-row"]') as HTMLElement;
    expect(r.textContent).toBe("Acme [search_tickets] #反馈");
    const name = container.querySelector('[data-part="tool-name"]') as HTMLElement;
    expect(name.textContent).toBe("Acme [search_tickets]");
    expect(container.querySelector('[data-part="tool-label"]')?.getAttribute("title")).toBe(
      "搜索工单",
    );
    // the title never takes the brackets' place
    expect(r.textContent).not.toContain("搜索工单");
  });

  it("a builtin row names the tool untranslated, in both locales", () => {
    for (const locale of ["zh", "en"] as const) {
      const { container } = wrap(
        <ToolRow row={builtin("Read", { kind: "read", keyArg: "a.md" })} />,
        locale,
      );
      expect(container.querySelector('[data-part="tool-name"]')?.textContent).toBe("Read");
      expect(container.textContent).toBe("Read a.md");
      cleanup();
    }
  });

  it("the key argument preview is its first line, cut at 80 characters with …", () => {
    const long = "x".repeat(120);
    const { container } = wrap(<ToolRow row={row({ keyArg: long })} />);
    expect(container.querySelector('[data-part="key-arg"]')?.textContent).toBe(
      `${"x".repeat(80)}…`,
    );
    cleanup();
    const multi = wrap(<ToolRow row={row({ keyArg: "first line\nsecond" })} />).container;
    expect(multi.querySelector('[data-part="key-arg"]')?.textContent).toBe("first line…");
  });

  it("a done row has no status mark", () => {
    const { container } = wrap(<ToolRow row={row({ keyArg: "#反馈" })} />);
    expect(container.querySelector('[data-part="fail-word"]')).toBeNull();
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.querySelector('[data-part="key-arg"]')?.textContent).toBe("#反馈");
    // no detail: not a button
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a shell row shows Bash in bold, then the description", () => {
    const { container } = wrap(
      <ToolRow row={builtin("Bash", { kind: "command", description: "检查配置" })} />,
    );
    expect(container.querySelector('[data-part="tool-name"]')?.textContent).toBe("Bash");
    expect(container.textContent).toBe("Bash 检查配置");
  });

  it("failed shows 失败 and the error's first line", () => {
    const { container } = wrap(
      <ToolRow row={row({ status: "failed", error: "404 文件不存在\nstack…" })} />,
    );
    expect(container.querySelector('[data-part="fail-word"]')?.textContent).toBe("失败");
    expect(container.textContent).toContain("404 文件不存在");
    expect(container.textContent).not.toContain("stack");
  });

  it("running shows a spinner and the elapsed time as the reference writes it", () => {
    const { container } = wrap(
      <ToolRow row={row({ status: "running", startedAt: 1_000 })} now={1_000 + 63_000} />,
    );
    expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
    expect(container.textContent).toContain("1 分 03 秒");
    cleanup();
    const en = wrap(
      <ToolRow row={row({ status: "running", startedAt: 0 })} now={63_000} />,
      "en",
    ).container;
    expect(en.textContent).toContain("1m 03s");
  });

  it("a running row without `now` ticks its own clock each second (final review I3)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { container } = wrap(<ToolRow row={row({ status: "running", startedAt: 0 })} />);
      expect(container.textContent).toContain("10 秒");
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(container.textContent).toContain("12 秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the ticking elapsed time is hidden from screen readers (final review I2)", () => {
    const { container } = wrap(
      <ToolRow row={row({ status: "running", startedAt: 0 })} now={12_000} />,
    );
    const timer = Array.from(container.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("12 秒"),
    );
    expect(timer?.closest('[aria-hidden="true"]')).not.toBeNull();
    cleanup();
    const group = wrap(
      <ToolGroup rows={[row({ status: "running", startedAt: 0 })]} now={12_000} />,
    ).container;
    const t2 = Array.from(group.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("12 秒"),
    );
    expect(t2?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("an expanded command shows $ command, output, duration and Copy output", async () => {
    const copy = vi.fn();
    const toggle = vi.fn();
    const r = row({
      kind: "command",
      description: "更新链接",
      durationMs: 2100,
      detail: { command: "python a.py", output: "done" },
    });
    const { container, rerender } = wrap(<ToolRow row={r} onToggle={toggle} onCopy={copy} />);
    const btn = screen.getByRole("button", { name: /更新链接/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(btn);
    expect(toggle).toHaveBeenCalled();
    rerender(
      <DesignProvider locale="zh">
        <ToolRow row={r} open onToggle={toggle} onCopy={copy} />
      </DesignProvider>,
    );
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-part="tool-command"]')?.textContent).toBe(
      "$ python a.py",
    );
    // IN holds the command, OUT the output
    const labels = [...container.querySelectorAll('[data-part="tool-io-label"]')].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(["输入", "输出"]);
    const io = [...container.querySelectorAll('[data-part="tool-io"]')];
    expect(io[0]?.querySelector('[data-part="tool-command"]')).not.toBeNull();
    expect(io[1]?.querySelector('[data-part="tool-output"]')).not.toBeNull();
    expect(container.querySelector('[data-part="tool-output"]')?.textContent).toBe("done");
    const footer = container.querySelector('[data-part="tool-footer"]');
    expect(footer?.textContent).toContain("2.1 秒");
    await userEvent.click(screen.getByRole("button", { name: "复制输出" }));
    expect(copy).toHaveBeenCalled();
  });

  it("IN / OUT read IN and OUT in English; IN is omitted without input", () => {
    const { container } = wrap(
      <ToolRow row={row({ detail: { input: [["id", "7"]], output: "{}" } })} open />,
      "en",
    );
    expect(
      [...container.querySelectorAll('[data-part="tool-io-label"]')].map((l) => l.textContent),
    ).toEqual(["IN", "OUT"]);
    cleanup();
    const outOnly = wrap(<ToolRow row={row({ detail: { output: "{}" } })} open />, "en").container;
    expect(
      [...outOnly.querySelectorAll('[data-part="tool-io-label"]')].map((l) => l.textContent),
    ).toEqual(["OUT"]);
  });

  it("uncontrolled rows toggle themselves", async () => {
    const { container } = wrap(<ToolRow row={row({ detail: { input: [["id", "7"]] } })} />);
    await userEvent.click(screen.getByRole("button"));
    expect(container.querySelector('[data-part="kv-key"]')?.textContent).toBe("id");
    expect(container.querySelector('[data-part="kv-value"]')?.textContent).toBe("7");
  });

  it("a prefix of a large output offers View all", async () => {
    const all = vi.fn();
    const r = row({
      kind: "command",
      detail: { command: "grep", output: "x", outputBytes: 82 * 1024, outputShownBytes: 4096 },
    });
    wrap(<ToolRow row={r} open onViewAll={all} />);
    expect(screen.getByText("输出 82 KB，已显示前 4 KB")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制输出" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看全文" }));
    expect(all).toHaveBeenCalled();
  });

  it("a hook denial reads Denied by extension <name>", () => {
    wrap(<ToolRow row={row({ status: "failed", blockedBy: "policy-x", error: "denied" })} />);
    expect(screen.getByText(/被扩展「policy-x」拒绝/)).toBeTruthy();
    cleanup();
    wrap(<ToolRow row={row({ status: "failed", blockedBy: "policy-x" })} />, "en");
    expect(screen.getByText(/Denied by extension "policy-x"/)).toBeTruthy();
  });

  it("an expanded hook denial has no footer: no duration, no Copy output", () => {
    const { container } = wrap(
      <ToolRow
        row={row({
          status: "failed",
          blockedBy: "policy-x",
          detail: { input: [["id", "7"]], errorText: "denied" },
        })}
        open
        onCopy={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-part="tool-output"]')?.textContent).toBe("denied");
    expect(container.querySelector('[data-part="tool-footer"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "复制输出" })).toBeNull();
  });

  it("an expanded failure shows the full error text", () => {
    const { container } = wrap(
      <ToolRow
        row={row({ status: "failed", error: "boom", detail: { errorText: "boom\nline 2" } })}
        open
      />,
    );
    expect(container.querySelector('[data-part="tool-output"]')?.textContent).toBe("boom\nline 2");
  });

  it("edits show +a −b as the extra", () => {
    const { container } = wrap(
      <ToolRow row={builtin("Edit", { kind: "edit", keyArg: "a.py", added: 2, removed: 1 })} />,
    );
    expect(container.textContent).toBe("Edit a.py · +2 −1");
  });
});

describe("ToolGroup (§6.16.8)", () => {
  it("a single-row group renders one line with no box", async () => {
    const { container } = wrap(
      <ToolGroup
        rows={[builtin("Read", { kind: "read", keyArg: "a.md", detail: { output: "x" } })]}
      />,
    );
    const line = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    expect(line.textContent).toBe("Read a.md");
    expect(container.querySelector('[data-part="tool-box"]')).toBeNull();
    await userEvent.click(line);
    expect(container.querySelector('[data-part="tool-box"]')).not.toBeNull();
    expect(container.querySelector('[data-part="tool-output"]')?.textContent).toBe("x");
  });

  it("a finished group is collapsed by default and opens into a box of rows", async () => {
    const rows = [row({ kind: "command", description: "a" }), ...many(2)];
    const { container } = wrap(<ToolGroup rows={rows} />);
    const head = screen.getByRole("button", { name: "已运行 1 个命令，已使用 2 个工具" });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(head);
    expect(
      container.querySelectorAll('[data-part="tool-box"] [data-part="tool-row"]'),
    ).toHaveLength(3);
  });

  it("a guard refusal is counted apart in the header's own color, never as a failure", () => {
    const rows = [
      builtin("Read", { kind: "read", keyArg: "/w/a.py" }),
      builtin("Edit", { kind: "edit", keyArg: "/w/a.py", guard: "modified" }),
    ];
    expect(summarizeTools(rows, "zh")).toBe("已读取 /w/a.py，已修改 /w/a.py（1 个已拦下）");
    expect(summarizeTools(rows, "en")).toContain(" (1 blocked)");
    const { container } = wrap(<ToolGroup rows={rows} />);
    expect(container.querySelector('[data-part="fail-word"]')).toBeNull();
  });

  it("a guarded row reads as done with the neutral word, no failure", () => {
    const { container } = wrap(
      <ToolRow row={builtin("Edit", { kind: "edit", keyArg: "/w/a.py", guard: "modified" })} />,
    );
    expect(container.querySelector('[data-part="guard-word"]')?.textContent).toBe(
      " · 已拦下：需先重新读取",
    );
    expect(container.querySelector('[data-part="fail-word"]')).toBeNull();
    cleanup();
    const en = wrap(
      <ToolRow row={builtin("Write", { kind: "edit", keyArg: "/w/b", guard: "not_read" })} />,
      "en",
    );
    expect(en.container.querySelector('[data-part="guard-word"]')?.textContent).toBe(
      " · Blocked: read the file first",
    );
  });

  it("a failed group marks the failures in fail", () => {
    const { container } = wrap(<ToolGroup rows={[row(), row({ status: "failed" })]} />);
    expect(container.querySelector('[data-part="fail-word"]')?.textContent).toBe("（1 个失败）");
  });

  it("names a single object in ink", () => {
    const { container } = wrap(
      <ToolGroup rows={[row({ kind: "command" }), row({ kind: "read", keyArg: "x.pdf" })]} />,
    );
    expect(
      container.querySelector('[data-part="tool-line"] [data-part="key-arg"]')?.textContent,
    ).toBe("x.pdf");
  });

  it("a running group is open, has no toggle and shows the done count", () => {
    const rows = [
      row({ kind: "command" }),
      row({ kind: "command", status: "running", startedAt: 0 }),
    ];
    const { container } = wrap(<ToolGroup rows={rows} now={12_000} />);
    expect(container.querySelector('[data-part="tool-line"]')?.tagName).not.toBe("BUTTON");
    expect(container.querySelector('[data-part="tool-line"]')?.textContent).toContain(
      "正在运行命令 · 已完成 1 个",
    );
    expect(container.querySelector('[data-part="tool-box"]')).not.toBeNull();
    expect(container.textContent).toContain("12 秒");
  });

  it("passes row callbacks with the row id", async () => {
    const all = vi.fn();
    const r = row({
      kind: "command",
      detail: { output: "o", outputBytes: 9000, outputShownBytes: 10 },
    });
    wrap(<ToolGroup rows={[r, row()]} open defaultOpenRows={[r.id]} onViewAll={all} />);
    await userEvent.click(screen.getByRole("button", { name: "查看全文" }));
    expect(all).toHaveBeenCalledWith(r.id);
  });
});

describe("the running spinner of tool lines and rows (§6.16, §6.16.9)", () => {
  const spinnerWidth = (c: HTMLElement) =>
    c.querySelector('[data-part="spinner"] svg')?.getAttribute("width");

  it("is 16 on a running row, a single running line and a running group header", () => {
    const live = row({ status: "running", startedAt: 0 });
    expect(spinnerWidth(wrap(<ToolRow row={live} now={1_000} />).container)).toBe("16");
    cleanup();
    expect(spinnerWidth(wrap(<ToolGroup rows={[live]} now={1_000} />).container)).toBe("16");
    cleanup();
    const group = wrap(<ToolGroup rows={[row(), live]} now={1_000} />).container;
    const widths = Array.from(group.querySelectorAll('[data-part="spinner"] svg')).map((s) =>
      s.getAttribute("width"),
    );
    expect(widths).toEqual(["16", "16"]);
  });
});

describe("a call waiting for a person (§6.16.9)", () => {
  const waiting = (w: NonNullable<ToolRowData["waiting"]>, over: Partial<ToolRowData> = {}) =>
    row({ status: "running", startedAt: 0, waiting: w, ...over });

  it("shows no spinner and no timer, but the waiting word in accent", () => {
    const { container } = wrap(<ToolRow row={waiting("input")} now={18_000} />);
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.textContent).not.toContain("18 秒");
    const word = container.querySelector('[data-part="waiting-word"]');
    expect(word?.textContent).toBe("等待你回答");
    expect(word?.className).toContain("cb-accent-word");
    expect(container.querySelector('[data-part="tool-row"]')?.getAttribute("data-waiting")).toBe(
      "input",
    );
  });

  it("words an approval and a connection, in both locales", () => {
    expect(wrap(<ToolRow row={waiting("approval")} />).container.textContent).toContain(
      "等待你批准",
    );
    cleanup();
    expect(wrap(<ToolRow row={waiting("approval")} />, "en").container.textContent).toContain(
      "Waiting for your approval",
    );
    cleanup();
    expect(wrap(<ToolRow row={waiting("input")} />, "en").container.textContent).toContain(
      "Waiting for your answer",
    );
    cleanup();
    expect(wrap(<ToolRow row={waiting("connect")} />).container.textContent).toContain(
      "等待你连接",
    );
  });

  it("someone else to act: the waiting word names them, on the row and the group header", () => {
    const { container } = wrap(
      <ToolRow row={waiting("approval", { waitingFor: "张三" })} now={18_000} />,
    );
    expect(container.textContent).toContain("等待 张三 批准");
    expect(container.textContent).not.toContain("等待你");
    cleanup();
    const rows = [
      row({ kind: "command" }),
      waiting("input", { kind: "command", waitingFor: "张三" }),
    ];
    expect(summarizeTools(rows, "zh")).toBe("等待 张三 回答 · 已完成 1 个");
    expect(summarizeTools(rows, "en")).toBe("Waiting for 张三 to answer · 1 done");
  });

  it("a pending call waiting for its approval shows no spinner either", () => {
    const { container } = wrap(<ToolRow row={row({ status: "pending", waiting: "approval" })} />);
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.textContent).toContain("等待你批准");
  });

  it("once the wait ends the row runs as before; a finished row ignores a stale wait", () => {
    const { container } = wrap(
      <ToolRow row={row({ status: "running", startedAt: 0 })} now={18_000} />,
    );
    expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
    expect(container.textContent).toContain("18 秒");
    cleanup();
    const done = wrap(<ToolRow row={row({ status: "done", waiting: "input" })} />).container;
    expect(done.querySelector('[data-part="waiting-word"]')).toBeNull();
  });

  it("a single waiting line has no spinner or timer and says what it waits for", () => {
    const { container } = wrap(<ToolGroup rows={[waiting("input")]} now={18_000} />);
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.textContent).not.toContain("18 秒");
    expect(container.querySelector('[data-part="waiting-word"]')?.textContent).toBe(
      " · 等待你回答",
    );
  });

  it("a group whose live calls all wait: no spinner, the waiting word instead of the verb", () => {
    const rows = [row({ kind: "command" }), waiting("approval", { kind: "command" })];
    expect(summarizeTools(rows, "zh")).toBe("等待你批准 · 已完成 1 个");
    const { container } = wrap(<ToolGroup rows={rows} now={18_000} />);
    const head = container.querySelector('[data-part="tool-line"]');
    expect(head?.querySelector('[data-part="spinner"]')).toBeNull();
    expect(head?.querySelector('[data-part="waiting-word"]')?.className).toContain(
      "cb-accent-word",
    );
    expect(container.querySelector('[data-part="tool-box"]')).not.toBeNull();
    // another call still running: the running verb and its spinner
    const mixed = [...rows, row({ kind: "read", status: "running", startedAt: 0 })];
    expect(summarizeTools(mixed, "zh")).toBe("正在读取文件 · 已完成 1 个");
  });
});

describe("the question tool's row (§6.16.9)", () => {
  it("reads 已提问 / Asked and the preview, with no tool name", () => {
    const q = builtin("AskUserQuestion", { kind: "question", keyArg: "数据库" });
    const zh = wrap(<ToolRow row={q} />).container;
    expect(zh.querySelector('[data-part="tool-name"]')?.textContent).toBe("已提问");
    expect(zh.querySelector('[data-part="key-arg"]')?.textContent).toBe("数据库");
    expect(zh.textContent).not.toContain("AskUserQuestion");
    cleanup();
    const en = wrap(<ToolRow row={q} />, "en").container;
    expect(en.querySelector('[data-part="tool-name"]')?.textContent).toBe("Asked");
  });

  it("counts with tools in a group", () => {
    expect(summarizeTools([row({ kind: "question" }), row()], "zh")).toBe("已使用 2 个工具");
  });
});

describe("DiffBlock (§6.16.10)", () => {
  const diff = {
    hunks: [
      {
        oldStart: 258,
        newStart: 258,
        lines: [
          { kind: "ctx" as const, text: "a" },
          { kind: "del" as const, text: "b" },
          { kind: "add" as const, text: "c" },
          { kind: "add" as const, text: "d" },
          { kind: "ctx" as const, text: "e" },
        ],
      },
    ],
    truncated: false,
  };

  it("numbers lines (new numbers, old for removed) and marks kinds", () => {
    const { container } = wrap(<DiffBlock diff={diff} />);
    const lines = [...container.querySelectorAll('[data-part="diff-line"]')];
    expect(lines.map((l) => l.querySelector('[data-part="diff-gutter"]')?.textContent)).toEqual([
      "258",
      "259",
      "259",
      "260",
      "261",
    ]);
    expect(lines.map((l) => l.getAttribute("data-kind"))).toEqual([
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
    expect(lines[1]?.textContent).toContain("−");
    expect(lines[2]?.textContent).toContain("+");
    expect(container.querySelector('[data-part="diff-cut"]')).toBeNull();
  });

  it("says when the diff is truncated and offers View all", async () => {
    const all = vi.fn();
    wrap(<DiffBlock diff={{ ...diff, truncated: true, totalLines: 10_000 }} onViewAll={all} />);
    const cut = screen.getByText(/差异过长，已截断/);
    expect(cut.textContent).toContain("显示前 5 / 10,000 行");
    await userEvent.click(screen.getByRole("button", { name: "查看全文" }));
    expect(all).toHaveBeenCalled();
  });

  it("shows an edit row's diff when it opens", () => {
    const { container } = wrap(
      <ToolGroup rows={[row({ kind: "edit", keyArg: "a.py", detail: { diff } })]} open />,
    );
    expect(container.querySelectorAll('[data-part="diff-line"]')).toHaveLength(5);
  });
});
