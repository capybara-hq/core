import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DesignProvider, IconPreview } from "../src/index";

afterEach(cleanup);
const wrap = (ui: React.ReactElement) => render(<DesignProvider locale="en">{ui}</DesignProvider>);

describe("IconPreview (spec §6.49)", () => {
  it("draws the icon on a light and a dark ground, decorative without labels", () => {
    const { container } = wrap(<IconPreview src="/icon-512.png" />);
    const tiles = [...container.querySelectorAll('[data-part="icon-preview-tile"]')];
    expect(tiles.map((t) => t.getAttribute("data-ground"))).toEqual(["light", "dark"]);
    for (const t of tiles) {
      expect(t.getAttribute("aria-hidden")).toBe("true");
      expect(t.querySelector("img")?.getAttribute("src")).toBe("/icon-512.png");
    }
    expect(container.querySelector('[data-part="icon-preview-label"]')).toBeNull();
  });

  it("names each tile and captions it when labels are given", () => {
    wrap(<IconPreview src="/a.png" labels={{ light: "On light", dark: "On dark" }} />);
    expect(screen.getByRole("img", { name: "On light" }).getAttribute("data-ground")).toBe("light");
    expect(screen.getByRole("img", { name: "On dark" }).getAttribute("data-ground")).toBe("dark");
    expect(screen.getAllByText(/On (light|dark)/)).toHaveLength(2);
  });
});
