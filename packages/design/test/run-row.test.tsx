import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, formatDuration, RunRow } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

describe("RunRow (spec §6.16.23)", () => {
  it("a finished run is one quiet collapsed line: Run · parts, the check and Done", async () => {
    const { container } = wrap(
      <RunRow
        status="ok"
        parts={["deepseek-flash", "3.7s", "1,234 tokens"]}
        facts={["Input 1,000"]}
      />,
    );
    const line = container.querySelector('[data-part="run-row"]') as HTMLElement;
    expect(line.tagName).toBe("BUTTON");
    expect(line.textContent).toContain("Run · deepseek-flash · 3.7s · 1,234 tokens");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    const status = container.querySelector('[data-part="run-status"]');
    expect(status?.textContent).toBe("Done");
    expect(status?.getAttribute("data-status")).toBe("ok");
    expect(container.querySelector('[data-part="run-mark"] svg')).not.toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    await userEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    const region = screen.getByRole("region", { name: "Run details" });
    expect(line.getAttribute("aria-controls")).toBe(region.id);
    expect(region.textContent).toContain("Input 1,000");
  });

  it("a label names the row instead of Run (a manual compaction)", () => {
    const { container } = wrap(
      <RunRow status="ok" label="Compaction" parts={["deepseek-flash", "3.7s"]} />,
    );
    expect(container.querySelector('[data-part="run-row"]')?.textContent).toContain(
      "Compaction · deepseek-flash · 3.7s",
    );
  });

  it("without a detail the line is plain text, no disclosure", () => {
    const { container } = wrap(<RunRow status="ok" parts={["m"]} />);
    const line = container.querySelector('[data-part="run-row"]') as HTMLElement;
    expect(line.tagName).toBe("DIV");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a failed run starts open: the error sentence, raw text behind its toggle, Retry and links", async () => {
    const onRetry = vi.fn();
    wrap(
      <RunRow
        status="failed"
        parts={["deepseek-flash", "3.7s"]}
        error={{ summary: "认证失败。", detail: "401 Unauthorized" }}
        onRetry={onRetry}
        links={[
          { label: "查看轨迹", href: "/trajectories/c1" },
          { label: "去配置模型服务", href: "/admin/extensions" },
        ]}
      />,
      "zh",
    );
    const line = screen.getByRole("button", { name: /运行 · deepseek-flash · 3.7s/ });
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(line.textContent).toContain("失败");
    const region = screen.getByRole("region", { name: "运行详情" });
    expect(region.textContent).toContain("认证失败。");
    expect(screen.queryByText("401 Unauthorized")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "原始错误" }));
    expect(screen.getByText("401 Unauthorized")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "查看轨迹" }).getAttribute("href")).toBe(
      "/trajectories/c1",
    );
    expect(screen.getByRole("link", { name: "去配置模型服务" }).getAttribute("href")).toBe(
      "/admin/extensions",
    );
  });

  it("a stopped run uses the page's status words and stays closed", () => {
    const { container } = wrap(
      <RunRow status="stopped" parts={["m"]} statusText="Stopped · you 14:03" facts={["x"]} />,
    );
    expect(container.querySelector('[data-part="run-status"]')?.textContent).toBe(
      "Stopped · you 14:03",
    );
    expect(container.querySelector('[data-part="run-row"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
});

describe("formatDuration (the one duration format, F29)", () => {
  it("reads one decimal below 10 s, then whole seconds, minutes, hours", () => {
    expect(formatDuration(850, "en")).toBe("0.9s");
    expect(formatDuration(3_700, "en")).toBe("3.7s");
    expect(formatDuration(9_949, "en")).toBe("9.9s");
    expect(formatDuration(9_950, "en")).toBe("10s");
    expect(formatDuration(42_400, "en")).toBe("42s");
    expect(formatDuration(108_600, "en")).toBe("1m 49s");
    expect(formatDuration(125_000, "en")).toBe("2m 05s");
    expect(formatDuration(3_725_000, "en")).toBe("1h 02m");
  });

  it("is localized", () => {
    expect(formatDuration(2_100, "zh")).toBe("2.1 秒");
    expect(formatDuration(41_000, "zh")).toBe("41 秒");
    expect(formatDuration(108_600, "zh")).toBe("1 分 49 秒");
    expect(formatDuration(72_000, "zh")).toBe("1 分 12 秒");
    expect(formatDuration(3_725_000, "zh")).toBe("1 小时 02 分");
  });

  it("a live timer counts whole seconds rounded down, never ahead of the clock", () => {
    expect(formatDuration(3_400, "zh", { live: true })).toBe("3 秒");
    expect(formatDuration(108_600, "zh", { live: true })).toBe("1 分 48 秒");
    expect(formatDuration(59_999, "en", { live: true })).toBe("59s");
  });

  it("the status bar and the run row agree once the run has ended", () => {
    // the same span through both: the run row and the status bar's 已用 (not live after the end)
    expect(formatDuration(108_600, "zh")).toBe(formatDuration(108_600, "zh", { live: false }));
  });

  it("clamps negative and non-finite input to zero", () => {
    expect(formatDuration(-5, "en")).toBe("0.0s");
    expect(formatDuration(Number.NaN, "zh")).toBe("0.0 秒");
  });
});
