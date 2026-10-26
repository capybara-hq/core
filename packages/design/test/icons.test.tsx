import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ICON_NAMES, ICON_PATHS, Icon } from "../src/index";

afterEach(cleanup);

describe("Icon", () => {
  it("every name has a non-empty path list", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(40);
    for (const name of ICON_NAMES) {
      expect(ICON_PATHS[name]?.length, name).toBeGreaterThan(0);
    }
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it("is decorative by default: 16, stroke 1.5, aria-hidden", () => {
    const { container } = render(<Icon name="search" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("stroke-width")).toBe("1.5");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.getAttribute("fill")).toBe("none");
    expect(svg?.getAttribute("class")).toBe("cb-icon");
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  it("with a label it is an image with that accessible name", () => {
    render(<Icon name="x" size={12} label="关闭" />);
    const img = screen.getByRole("img", { name: "关闭" });
    expect(img.getAttribute("width")).toBe("12");
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("IconGallery", () => {
  it("shows every icon with its name", async () => {
    const { IconGallery, ICON_NAMES } = await import("../src/index");
    const { render } = await import("@testing-library/react");
    const { container } = render(<IconGallery size={12} />);
    expect(container.querySelectorAll("svg.cb-icon")).toHaveLength(ICON_NAMES.length);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("12");
  });
});
