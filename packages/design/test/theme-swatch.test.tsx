import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_THEME_SWATCHES, DesignProvider, ThemeSwatch, TOKEN_NAMES } from "../src/index";

afterEach(cleanup);

const SWATCHES = { bg: "#05070D", panel: "#0B1020", ink: "#E6F1FF", accent: "#F3E600" };

function swatch(props: Partial<React.ComponentProps<typeof ThemeSwatch>> = {}) {
  return render(
    <DesignProvider locale="en">
      <ThemeSwatch name="Night City" swatches={SWATCHES} scheme="dark" {...props} />
    </DesignProvider>,
  );
}

describe("ThemeSwatch", () => {
  it("is a radio named by the theme, aria-checked follows selected", () => {
    const { unmount } = swatch();
    const r = screen.getByRole("radio", { name: /Night City/ });
    expect(r.getAttribute("aria-checked")).toBe("false");
    unmount();
    swatch({ selected: true });
    expect(screen.getByRole("radio").getAttribute("aria-checked")).toBe("true");
  });

  it("applies the swatch colors as data and marks the scheme", () => {
    const { container } = swatch({ scheme: "light" });
    const root = container.querySelector('[data-part="theme-swatch"]') as HTMLElement;
    expect(root.getAttribute("data-scheme")).toBe("light");
    const preview = container.querySelector('[data-part="theme-swatch-preview"]') as HTMLElement;
    expect(preview.style.getPropertyValue("--cb-swatch-bg")).toBe("#05070D");
    expect(preview.style.getPropertyValue("--cb-swatch-accent")).toBe("#F3E600");
  });

  it("calls onSelect on click and on Space", async () => {
    const onSelect = vi.fn();
    swatch({ onSelect });
    const r = screen.getByRole("radio");
    await userEvent.click(r);
    expect(onSelect).toHaveBeenCalledTimes(1);
    r.focus();
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});

describe("BUILTIN_THEME_SWATCHES", () => {
  it("names tokens.css values outside the token names, so a theme never overrides them", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    for (const scheme of ["dark", "light"] as const) {
      for (const [part, ref] of Object.entries(BUILTIN_THEME_SWATCHES[scheme])) {
        const name = /^var\(--cb-(.+)\)$/.exec(ref)?.[1];
        expect(name).toBe(`builtin-${scheme}-${part}`);
        expect(css).toMatch(new RegExp(`--cb-${name}: #[0-9A-F]{6};`));
        expect((TOKEN_NAMES as readonly string[]).includes(name as string)).toBe(false);
      }
    }
  });
});
