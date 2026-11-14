import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, KeycapCommand } from "../src/index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const display = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
const ruleOf = (selector: string) =>
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
    display,
  )?.[1] ?? "";
const COMMAND = "capybara-device mode auto|sandbox";

/** A KeycapCommand in the design's provider (zh: the labels are the design's own). */
const capybara = (ui: React.ReactElement) =>
  render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("KeycapCommand", () => {
  it("draws each word of the command as a keycap", () => {
    render(
      <DesignProvider locale="zh">
        <KeycapCommand command={COMMAND} hint="在这台机器的终端里运行。" />
      </DesignProvider>,
    );
    const caps = document.querySelector('[data-part="keycap-command-caps"]') as HTMLElement;
    expect(
      [...caps.querySelectorAll('[data-part="keycap-command-cap"]')].map((c) => c.textContent),
    ).toEqual(["capybara-device", "mode", "auto|sandbox"]);
    expect(screen.getByText("在这台机器的终端里运行。")).toBeTruthy();
    // one inline row: the hint, the keycaps and the copy button beside them, not a stack
    expect(ruleOf(".cb-keycap")).toMatch(/display:\s*flex/);
    expect(ruleOf(".cb-keycap")).not.toMatch(/flex-direction:\s*column/);
  });

  it("copies the whole command and reads 已复制", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <DesignProvider locale="zh">
        <KeycapCommand command={COMMAND} />
      </DesignProvider>,
    );
    const button = screen.getByRole("button", { name: `复制 ${COMMAND}` });
    await userEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(button.textContent).toContain("已复制");
  });

  it("without a clipboard selects the keycaps and says to copy by hand", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(
      <DesignProvider locale="zh">
        <KeycapCommand command={COMMAND} />
      </DesignProvider>,
    );
    const button = screen.getByRole("button", { name: `复制 ${COMMAND}` });
    await userEvent.click(button);
    expect(button.textContent).toContain("已选中，请按 Ctrl+C（⌘C）复制");
    expect(window.getSelection()?.toString()).toBe(COMMAND);
  });
});
