import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckRow, type CheckRowState, DesignProvider } from "../src/index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const row = (c: HTMLElement) => c.querySelector('[data-part="check-row"]') as HTMLElement;

describe("CheckRow (design spec §6.9)", () => {
  it.each([
    ["ok", "circle-check", "通过"],
    ["failing", "circle-x", "未通过"],
    ["unknown", "circle-alert", "无法确定"],
    ["not_run", "circle", "未检查"],
  ] as const)("CheckRow shows icon, label, reason, fix per status: %s", (status, icon, word) => {
    const state: CheckRowState = {
      status,
      reason: "Slack accepted the token.",
      fix: "Reinstall the app.",
    };
    const { container } = wrap(<CheckRow label="Bot token works" state={state} />);
    const r = row(container);
    expect(r.getAttribute("data-status")).toBe(status);
    expect(
      r.querySelector('[data-part="check-row-mark"] [data-icon]')?.getAttribute("data-icon"),
    ).toBe(icon);
    expect(screen.getByRole("group", { name: "Bot token works" })).toBe(r);
    expect(r.textContent).toContain(word);
    const reason = r.querySelector('[data-part="check-row-reason"]');
    const fix = r.querySelector('[data-part="check-row-fix"]');
    if (status === "not_run") {
      expect(reason).toBeNull();
    } else {
      expect(reason?.textContent).toBe("Slack accepted the token.");
    }
    // a fix is what to do when failing: only a failing row shows it
    if (status === "failing") expect(fix?.textContent).toBe("Reinstall the app.");
    else expect(fix).toBeNull();
  });

  it("reason and fix are plain text, never markup", () => {
    const { container } = wrap(
      <CheckRow
        label="x"
        state={{ status: "failing", reason: "<b>no</b> [l](https://x.example)", fix: "`a`" }}
      />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(row(container).textContent).toContain("<b>no</b> [l](https://x.example)");
  });

  it("shows the checked-at time relative to now", () => {
    const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const { container } = wrap(<CheckRow label="x" state={{ status: "ok", checkedAt }} />, "en");
    const time = container.querySelector('[data-part="check-row-time"]');
    expect(time?.getAttribute("dateTime")).toBe(checkedAt);
    expect(time?.textContent).toBe("Checked 5 minutes ago");
  });

  it("Re-check calls onRecheck", async () => {
    const onRecheck = vi.fn();
    wrap(<CheckRow label="Bot token works" state={{ status: "ok" }} onRecheck={onRecheck} />);
    const button = screen.getByRole("button", { name: "重新检查 Bot token works" });
    expect(button.textContent).toContain("重新检查");
    await userEvent.click(button);
    expect(onRecheck).toHaveBeenCalledOnce();
  });

  it("Re-check disabled until cooldownUntil", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const cooldownUntil = new Date(Date.now() + 10_000).toISOString();
    wrap(
      <CheckRow label="x" state={{ status: "failing", cooldownUntil }} onRecheck={() => {}} />,
      "en",
    );
    const button = screen.getByRole("button", { name: "Re-check x" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(button.disabled).toBe(false);
  });

  it("running shows a spinner and no button", () => {
    const { container } = wrap(
      <CheckRow label="x" state={{ status: "running", reason: "old" }} onRecheck={() => {}} />,
    );
    expect(screen.getByRole("img", { name: "检查中" })).toBeTruthy();
    expect(container.querySelector('[data-icon="spinner"]')).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[data-part="check-row-reason"]')).toBeNull();
  });

  it("static shows staticNote", () => {
    const { container } = wrap(
      <CheckRow
        label="x"
        state={{ status: "static" }}
        staticNote="保存渠道后检查"
        onRecheck={() => {}}
      />,
    );
    expect(container.querySelector('[data-part="check-row-note"]')?.textContent).toBe(
      "保存渠道后检查",
    );
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    const en = wrap(<CheckRow label="x" state={{ status: "static" }} />, "en");
    expect(en.container.querySelector('[data-part="check-row-note"]')?.textContent).toBe(
      "Checked after saving",
    );
  });
});
