import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_THEME_SWATCHES,
  DesignProvider,
  ThemeSwatch,
  ThemeSwatchGroup,
  TOKEN_NAMES,
} from "../src/index";

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

describe("ThemeSwatchGroup", () => {
  const ITEMS = [
    { value: "builtin", name: "Built-in", swatches: BUILTIN_THEME_SWATCHES },
    { value: "night", name: "Night City", swatches: { dark: SWATCHES } },
    { value: "paper", name: "Paper", swatches: { light: SWATCHES, dark: SWATCHES } },
  ];

  function Group({ initial = "night", disabled = false, onChange = vi.fn() }) {
    const [value, setValue] = useState(initial);
    return (
      <DesignProvider locale="en">
        <ThemeSwatchGroup
          label="Theme"
          value={value}
          items={ITEMS}
          scheme="light"
          disabled={disabled}
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
        />
      </DesignProvider>
    );
  }

  const radios = () => screen.getAllByRole("radio");

  it("is one radiogroup named by its label; the selected card is the only tab stop", () => {
    render(<Group />);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(radios().map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("without a selection the first card is the tab stop", () => {
    render(<Group initial="none" />);
    expect(radios().map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("arrows move, focus and select, wrapping; Home and End go to the ends", () => {
    const onChange = vi.fn();
    render(<Group onChange={onChange} />);
    const [a, b, c] = radios() as [HTMLElement, HTMLElement, HTMLElement];
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowRight" });
    expect(document.activeElement).toBe(c);
    expect(c.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(c, { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "Home" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "End" });
    expect(document.activeElement).toBe(c);
    expect(onChange.mock.calls.map((x) => x[0])).toEqual([
      "paper",
      "builtin",
      "paper",
      "builtin",
      "paper",
    ]);
    expect(radios().map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it("disabled: every card disabled, the selection kept, the arrows do nothing", () => {
    const onChange = vi.fn();
    render(<Group disabled onChange={onChange} />);
    for (const r of radios()) expect((r as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(radios()[1] as HTMLElement, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("draws each card in the page's scheme when it has it, else in its own", () => {
    const { container } = render(<Group />);
    const schemes = [...container.querySelectorAll('[data-part="theme-swatch"]')].map((e) =>
      e.getAttribute("data-scheme"),
    );
    // the built-in and Paper have light; Night City is dark only
    expect(schemes).toEqual(["light", "dark", "light"]);
  });
});
