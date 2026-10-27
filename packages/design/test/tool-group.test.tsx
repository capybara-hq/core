import { cleanup, render, screen } from "@testing-library/react";
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
  title: "搜索工单",
  status: "done",
  ...over,
});
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
  it("a done row has no status mark", () => {
    const { container } = wrap(<ToolRow row={row({ source: "Acme", keyArg: "#反馈" })} />);
    const r = container.querySelector('[data-part="tool-row"]') as HTMLElement;
    expect(r.textContent).toBe("已使用 Acme: 搜索工单 #反馈");
    expect(container.querySelector('[data-part="fail-word"]')).toBeNull();
    expect(container.querySelector('[data-part="spinner"]')).toBeNull();
    expect(container.querySelector('[data-part="key-arg"]')?.textContent).toBe("#反馈");
    // no detail: not a button
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a shell row shows the description instead of verb and title", () => {
    wrap(
      <ToolRow row={row({ kind: "command", title: "sandbox_bash", description: "检查配置" })} />,
    );
    expect(screen.getByText("检查配置")).toBeTruthy();
    expect(screen.queryByText(/sandbox_bash/)).toBeNull();
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
    expect(container.querySelector('[data-part="tool-output"]')?.textContent).toBe("done");
    const footer = container.querySelector('[data-part="tool-footer"]');
    expect(footer?.textContent).toContain("2.1 秒");
    await userEvent.click(screen.getByRole("button", { name: "复制输出" }));
    expect(copy).toHaveBeenCalled();
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
      <ToolRow row={row({ kind: "edit", title: "", keyArg: "a.py", added: 2, removed: 1 })} />,
    );
    expect(container.textContent).toBe("已修改 a.py · +2 −1");
  });
});

describe("ToolGroup (§6.16.8)", () => {
  it("a single-row group renders one line with no box", async () => {
    const { container } = wrap(
      <ToolGroup
        rows={[row({ kind: "read", title: "", keyArg: "a.md", detail: { output: "x" } })]}
      />,
    );
    const line = container.querySelector('[data-part="tool-line"]') as HTMLElement;
    expect(line.textContent).toBe("已读取 a.md");
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
