import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentSection, DesignProvider } from "../src/index";

afterEach(cleanup);
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8");
/** The declarations of one rule of display.css. */
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} not found`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", at), css.indexOf("}", at));
};

describe("ContentSection (spec §6.31)", () => {
  it("a labelled region whose title is a heading, with its count, help and children", () => {
    zh(
      <ContentSection title="技能" count={2} description="插件自带的技能。">
        <span>pdf</span>
      </ContentSection>,
    );
    const region = screen.getByRole("region", { name: "技能" });
    const heading = within(region).getByRole("heading", { name: "技能" });
    expect(heading.tagName).toBe("H2");
    expect(heading.getAttribute("data-part")).toBe("content-section-title");
    expect(within(region).getByText("2").getAttribute("data-part")).toBe("content-section-count");
    expect(within(region).getByText("插件自带的技能。").getAttribute("data-part")).toBe(
      "content-section-description",
    );
    expect(within(region).getByText("pdf")).toBeTruthy();
  });

  it("empty draws the muted line instead of the children", () => {
    zh(
      <ContentSection title="扩展" empty="没有扩展。">
        <span>never</span>
      </ContentSection>,
    );
    const region = screen.getByRole("region", { name: "扩展" });
    expect(within(region).getByText("没有扩展。").getAttribute("data-part")).toBe(
      "content-section-empty",
    );
    expect(within(region).queryByText("never")).toBeNull();
  });

  it("the title is the h2 step (16 / 24, 500, ink); help and empty text are small and muted", () => {
    const title = rule(".cb-content-section-title");
    expect(title).toContain("font-size: var(--cb-type-h2-size)");
    expect(title).toContain("font-weight: 500");
    expect(title).toContain("color: var(--cb-ink)");
    for (const part of [".cb-content-section-description", ".cb-content-section-empty"]) {
      const r = rule(part);
      expect(r).toContain("font-size: var(--cb-type-small-size)");
      expect(r).toContain("color: var(--cb-muted)");
      expect(r).toContain("font-family: var(--cb-font-prose)");
    }
  });
});
