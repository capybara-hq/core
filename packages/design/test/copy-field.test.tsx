import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyField, DesignProvider } from "../src/index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINK = "https://capybara.example.com/s/k3Rf9TqW2a";
const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

describe("CopyField (spec §6.44)", () => {
  it("labels a read-only field holding the value, with no shown-once warning", () => {
    const { container } = wrap(<CopyField label="链接" value={LINK} />);
    const input = screen.getByLabelText("链接") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(LINK);
    expect(container.textContent).not.toContain("只会显示这一次");
    expect(container.querySelector('[data-part="copy-field-manual"]')).toBeNull();
  });

  it("copy writes the value to the clipboard and reads 已复制", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    wrap(<CopyField label="链接" value={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("a refused clipboard selects the text and shows the manual hint", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container } = wrap(<CopyField label="链接" value={LINK} />);
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    const input = screen.getByLabelText("链接") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(LINK.length);
    const hint = container.querySelector('[data-part="copy-field-manual"]') as HTMLElement;
    expect(hint.textContent).toContain("无法自动复制");
  });

  it("without a clipboard falls back the same way, in English too", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { container } = wrap(<CopyField label="Link" value={LINK} />, "en");
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    const hint = container.querySelector('[data-part="copy-field-manual"]') as HTMLElement;
    expect(hint.textContent).toContain("Ctrl+C");
  });
});
