import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, ErrorDetail } from "../src/index";

afterEach(cleanup);

const RAW =
  "https://github.com/capybara-hq/plugins.git: cannot list the refs of https://github.com/capybara-hq/plugins.git";

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "en") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

describe("ErrorDetail", () => {
  it("shows the sentence and keeps the raw text behind a closed toggle", async () => {
    const { container } = wrap(<ErrorDetail summary="The refresh failed." detail={RAW} />);
    const summary = container.querySelector('[data-part="error-detail-summary"]');
    expect(summary?.textContent).toContain("The refresh failed.");
    // the circle-x icon leads the sentence (spec §2.4: never color alone)
    expect(summary?.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(RAW)).toBeNull();
    const toggle = screen.getByRole("button", { name: "Raw error" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const raw = screen.getByText(RAW);
    expect(raw.getAttribute("data-part")).toBe("error-detail-raw");
    expect(toggle.getAttribute("aria-controls")).toBe(raw.id);
    await userEvent.click(toggle);
    expect(screen.queryByText(RAW)).toBeNull();
  });

  it("opens with defaultOpen, names the toggle in Chinese, and takes a label", () => {
    wrap(<ErrorDetail summary="同步失败。" detail={RAW} defaultOpen />, "zh");
    expect(screen.getByRole("button", { name: "原始错误" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText(RAW)).toBeTruthy();
    cleanup();
    wrap(<ErrorDetail summary="x" detail={RAW} label="Kernel message" />);
    expect(screen.getByRole("button", { name: "Kernel message" })).toBeTruthy();
  });

  it("draws no toggle without a detail", () => {
    wrap(<ErrorDetail summary="The refresh failed." />);
    expect(screen.getByText("The refresh failed.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
