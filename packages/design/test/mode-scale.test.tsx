import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, type DeviceMode, KeycapCommand, ModeScale } from "../src/index";

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

function scale(over: Partial<Parameters<typeof ModeScale>[0]> = {}, locale: "zh" | "en" = "zh") {
  return render(
    <DesignProvider locale={locale}>
      <ModeScale value="auto" onSelect={() => {}} {...over} />
    </DesignProvider>,
  );
}

/** A controlled scale: arrows move the value, as a page would. */
function Harness({ onSelect }: { onSelect?: (mode: DeviceMode) => void }) {
  const [value, setValue] = useState<DeviceMode>("auto");
  return (
    <DesignProvider locale="zh">
      <ModeScale
        value={value}
        onSelect={(mode) => {
          onSelect?.(mode);
          setValue(mode);
        }}
      />
    </DesignProvider>
  );
}

describe("ModeScale", () => {
  it("is one radiogroup of two modes with one sentence each, the effective one marked", () => {
    const { container } = scale();
    const group = screen.getByRole("radiogroup", { name: "运行模式" });
    const radios = within(group).getAllByRole("radio") as HTMLElement[];
    expect(
      radios.map((r) => r.querySelector('[data-part="mode-scale-name"]')?.textContent),
    ).toEqual(["自动", "沙箱"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("false");
    expect(radios[0]?.querySelector('[data-part="mode-scale-marker"]')).toBeTruthy();
    expect(
      screen.getByText("命令以你的身份在这台机器上运行，可以联网；每条命令都经过审查。"),
    ).toBeTruthy();
    expect(
      screen.getByText("命令在沙箱里运行，只能访问工作区、临时目录和设备允许的域名。"),
    ).toBeTruthy();
    // the scale line and the thin marker, never a full-bleed fill
    expect(ruleOf(".cb-mode-scale-track")).toMatch(/height:\s*1px/);
    expect(ruleOf(".cb-mode-scale-marker")).toMatch(/height:\s*2px/);
    expect(ruleOf('.cb-mode-scale-option[data-state="selected"] .cb-mode-scale-marker')).toMatch(
      /background:\s*var\(--cb-ink\)/,
    );
    // the selected name is ink, an unselected one muted
    expect(ruleOf(".cb-mode-scale-name")).toMatch(/color:\s*var\(--cb-muted\)/);
    expect(ruleOf('.cb-mode-scale-option[data-state="selected"] .cb-mode-scale-name')).toMatch(
      /color:\s*var\(--cb-ink\)/,
    );
    expect(container.querySelector('[data-part="mode-scale"]')).toBeTruthy();
  });

  it("chooses a different mode on click and does nothing on the selected one", async () => {
    const onSelect = vi.fn();
    scale({ onSelect });
    const sandbox = screen.getByRole("radio", { name: /沙箱/ });
    await userEvent.click(sandbox);
    expect(onSelect).toHaveBeenCalledWith("sandbox");
    onSelect.mockClear();
    await userEvent.click(screen.getByRole("radio", { name: /自动/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves the choice with arrows, Home and End (one tab stop)", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const auto = screen.getByRole("radio", { name: /自动/ });
    const sandbox = screen.getByRole("radio", { name: /沙箱/ });
    expect(auto.tabIndex).toBe(0);
    expect(sandbox.tabIndex).toBe(-1);
    auto.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("sandbox");
    expect(document.activeElement).toBe(sandbox);
    await userEvent.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("auto");
    expect(document.activeElement).toBe(auto);
    await userEvent.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("sandbox");
    await userEvent.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("auto");
  });

  it("is locked on a cloud device: the effective mode and why, nothing selectable", async () => {
    const onSelect = vi.fn();
    scale({ value: "sandbox", locked: true, lockedReason: "云端设备不能选择模式。", onSelect });
    expect(screen.getByText("云端设备不能选择模式。")).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLElement[];
    expect(radios.every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(radios.every((r) => r.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("radio", { name: /沙箱/ }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(radios[0] as HTMLElement);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("caps one mode with its reason (the org or the platform forbids it)", async () => {
    const onSelect = vi.fn();
    scale({ value: "sandbox", unavailable: { auto: "组织不允许" }, onSelect });
    const auto = screen.getByRole("radio", { name: /自动/ });
    expect(auto.getAttribute("aria-disabled")).toBe("true");
    expect(within(auto).getByText("组织不允许")).toBeTruthy();
    await userEvent.click(auto);
    expect(onSelect).not.toHaveBeenCalled();
    // the sandbox option still chooses
    await userEvent.click(screen.getByRole("radio", { name: /沙箱/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("turns the whole scale off with its reason", () => {
    scale({ disabled: true, disabledReason: "这台机器离线，暂时不能修改。" });
    expect(screen.getByText("这台机器离线，暂时不能修改。")).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLElement[];
    expect(radios.every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(display).toMatch(
      /\.cb-mode-scale-option\[aria-disabled="true"\] \.cb-mode-scale-name[\s\S]*?color:\s*var\(--cb-disabled\)/,
    );
  });

  it("draws the command slot under the scale", () => {
    scale({ command: <KeycapCommand command={COMMAND} /> });
    const command = document.querySelector('[data-part="mode-scale-command"]');
    expect(command?.querySelector('[data-part="keycap-command"]')).toBeTruthy();
  });

  it("says it in English too", () => {
    scale({}, "en");
    expect(screen.getByRole("radiogroup", { name: "Run mode" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Auto/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Sandbox/ })).toBeTruthy();
  });
});

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
