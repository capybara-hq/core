import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, RunRow, runDuration } from "../src/index";

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

describe("runDuration", () => {
  it("reads as a short mono figure", () => {
    expect(runDuration(850)).toBe("0.9s");
    expect(runDuration(3_700)).toBe("3.7s");
    expect(runDuration(42_400)).toBe("42s");
    expect(runDuration(125_000)).toBe("2m 05s");
    expect(runDuration(3_725_000)).toBe("1h 02m");
  });
});
