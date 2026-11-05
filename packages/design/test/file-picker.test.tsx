import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, FilePicker } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const tgz = (name = "plugin.tgz") =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "application/gzip" });

/** jsdom has no DataTransfer: drops carry a minimal stub. */
const transfer = (files: File[]) => ({ files, types: ["Files"], items: [] });

describe("FilePicker", () => {
  it("is a drop zone with a real 选择文件 button, the upload icon and the hint", () => {
    const { container } = wrap(<FilePicker dropLabel="松开即选择" onFiles={() => {}} />);
    const zone = container.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(zone).not.toBeNull();
    // a labelled button with words, not a bare "+" icon button
    const button = screen.getByRole("button", { name: "选择文件" });
    expect(zone.contains(button)).toBe(true);
    expect(button.textContent).toBe("选择文件");
    expect(zone.querySelector('[data-part="file-picker-icon"] svg')).not.toBeNull();
    expect(screen.getByText("或拖放到这里。")).toBeTruthy();
    cleanup();
    wrap(<FilePicker dropLabel="Drop" onFiles={() => {}} />, "en");
    expect(screen.getByRole("button", { name: "Choose file" })).toBeTruthy();
    expect(screen.getByText("or drop it here.")).toBeTruthy();
  });

  it("takes a label and hint, passes the accept list, and hands chosen files to onFiles", async () => {
    const onFiles = vi.fn();
    const { container } = wrap(
      <FilePicker
        label="选择 .zip 文件"
        hint="或把 .zip 文件拖到这里。"
        dropLabel="松开即上传"
        accept=".zip"
        onFiles={onFiles}
      />,
    );
    expect(screen.getByText("或把 .zip 文件拖到这里。")).toBeTruthy();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe(".zip");
    const click = vi.spyOn(input, "click");
    await userEvent.click(screen.getByRole("button", { name: "选择 .zip 文件" }));
    expect(click).toHaveBeenCalledOnce();
    const f = tgz("skill.zip");
    fireEvent.change(input, { target: { files: [f] } });
    expect(onFiles).toHaveBeenCalledWith([f]);
  });

  it("takes a dropped file, and draws what is chosen inside the zone", () => {
    const onFiles = vi.fn();
    const { container } = wrap(
      <FilePicker dropLabel="松开即选择" onFiles={onFiles}>
        <span>plugin.tgz</span>
      </FilePicker>,
    );
    const zone = container.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(zone.textContent).toContain("plugin.tgz");
    const f = tgz();
    fireEvent.dragEnter(zone, { dataTransfer: transfer([f]) });
    expect(screen.getByText("松开即选择")).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: transfer([f]) });
    expect(onFiles).toHaveBeenCalledWith([f]);
  });

  it("disabled: the button is disabled and a drop is ignored", () => {
    const onFiles = vi.fn();
    const { container } = wrap(<FilePicker dropLabel="d" onFiles={onFiles} disabled />);
    expect(screen.getByRole("button", { name: "选择文件" }).hasAttribute("disabled")).toBe(true);
    const zone = container.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(zone.getAttribute("data-disabled")).toBe("true");
    fireEvent.drop(zone, { dataTransfer: transfer([tgz()]) });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("is drawn as a dashed zone (spec §6.25)", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
    const rule = css.match(/\.cb-file-picker \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("border: 1px dashed var(--cb-line-strong)");
    expect(rule).toContain("border-radius: var(--cb-radius-md)");
  });
});
