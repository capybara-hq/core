import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Card, CopyCode, CopyField, DesignProvider } from "../src/index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const COMMAND = "npm install -g @capybara-hq/device@next";
const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

/** Stubs the clipboard with a writeText that resolves, or rejects when `fail`. */
function clipboard(fail = false) {
  const writeText = vi.fn(async () => {
    if (fail) throw new Error("denied");
  });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

describe("CopyCode (spec §6.58)", () => {
  it("draws the value in a code line with a copy icon button inside the block", () => {
    const { container } = wrap(<CopyCode value={COMMAND} label="安装" />);
    const group = screen.getByRole("group", { name: "安装" });
    const line = container.querySelector('[data-part="copy-code-line"]') as HTMLElement;
    const code = line.querySelector("pre > code") as HTMLElement;
    expect(code.textContent).toBe(COMMAND);
    const button = screen.getByRole("button", { name: "复制" });
    // the button sits inside the block, after the value, and shows only its icon
    expect(line.contains(button)).toBe(true);
    expect(group.contains(line)).toBe(true);
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(container.querySelector('[data-part="copy-code-manual"]')).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("copies the value, shows a check and 已复制 for two seconds, then the icon again", async () => {
    vi.useFakeTimers();
    const writeText = clipboard();
    const { container } = wrap(<CopyCode value={COMMAND} label="安装" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制" }));
    });
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    const button = screen.getByRole("button", { name: "已复制" });
    expect(button.textContent).toBe("已复制");
    expect(container.querySelector('[data-part="copy-code"]')?.getAttribute("data-state")).toBe(
      "copied",
    );
    await act(async () => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "复制" }).textContent).toBe("");
    expect(container.querySelector('[data-part="copy-code"]')?.hasAttribute("data-state")).toBe(
      false,
    );
  });

  it("a refused clipboard selects the value and shows the copy-by-hand line", async () => {
    clipboard(true);
    const { container } = wrap(<CopyCode value={COMMAND} label="安装" />);
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(window.getSelection()?.toString()).toBe(COMMAND);
    const hint = container.querySelector('[data-part="copy-code-manual"]') as HTMLElement;
    expect(hint.getAttribute("role")).toBe("status");
    expect(hint.textContent).toContain("无法自动复制");
    // the button keeps its name: another try may work
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
  });

  it("without a clipboard falls back the same way, in English too", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { container } = wrap(<CopyCode value={COMMAND} label="Install" />, "en");
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    const hint = container.querySelector('[data-part="copy-code-manual"]') as HTMLElement;
    expect(hint.textContent).toContain("Ctrl+C");
    expect(window.getSelection()?.toString()).toBe(COMMAND);
  });

  it("an empty value cannot be copied", () => {
    wrap(<CopyCode value="" label="登录" />);
    expect(screen.getByRole("button", { name: "复制" })).toHaveProperty("disabled", true);
  });

  it("is reached by keyboard: Tab focuses the copy button, Enter copies", async () => {
    const writeText = clipboard();
    wrap(<CopyCode value={COMMAND} label="安装" />);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "复制" }));
    await userEvent.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    // the same element stays focused while it reads "Copied"
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "已复制" }));
  });

  it("is framed on the page ground and unframed inside a box", () => {
    const { container } = wrap(
      <>
        <CopyCode value="a" label="a" />
        <Card title="卡片">
          <CopyCode value="b" label="b" />
        </Card>
      </>,
    );
    const lines = [...container.querySelectorAll('[data-part="copy-code-line"]')];
    expect(lines.map((l) => l.getAttribute("data-framed"))).toEqual(["true", "false"]);
  });

  it("pins a look for the reference blocks", () => {
    const { container } = wrap(
      <>
        <CopyCode value="a" label="a" state="copied" />
        <CopyCode value="b" label="b" state="manual" />
      </>,
    );
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
    expect(container.querySelectorAll('[data-part="copy-code-manual"]')).toHaveLength(1);
  });
});

describe("CopyField (spec §6.44)", () => {
  const LINK = "https://capybara.example.com/s/k3Rf9TqW2a";

  it("labels a CopyCode with a visible label and describes it with the help", () => {
    const { container } = wrap(
      <CopyField label="链接" value={LINK} help="知道链接的人都能打开。" />,
    );
    const group = screen.getByRole("group", { name: "链接" });
    expect(group.querySelector("code")?.textContent).toBe(LINK);
    const help = container.querySelector('[data-part="copy-field-help"]') as HTMLElement;
    expect(group.getAttribute("aria-describedby")).toBe(help.id);
    expect(help.textContent).toBe("知道链接的人都能打开。");
    expect(container.textContent).not.toContain("只会显示这一次");
  });

  it("copies like CopyCode", async () => {
    const writeText = clipboard();
    wrap(<CopyField label="链接" value={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  });
});
