import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignProvider, Markdown } from "../src/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const table = (rows: number) =>
  [
    "| a | b |",
    "| --- | ---: |",
    ...Array.from({ length: rows }, (_, i) => `| r${i} | ${i} |`),
  ].join("\n");

describe("Markdown (design spec §6.16.4)", () => {
  it("renders raw HTML as text, never as elements", () => {
    const { container } = wrap(<Markdown text={"<script>alert(1)</script>\n\nhi <b>x</b>"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("<b>x</b>");
  });

  it("renders no anchor for a javascript: link, keeping its text", () => {
    const { container } = wrap(<Markdown text="[x](javascript:alert(1)) and [y](/relative)" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("x");
    expect(container.textContent).toContain("y");
  });

  it("opens an http(s) link in a new tab without opener or referrer", () => {
    wrap(<Markdown text="[x](https://a.test)" />);
    const a = screen.getByRole("link", { name: "x" });
    expect(a.getAttribute("href")).toBe("https://a.test");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("resolves reference links with the same rule", () => {
    const { container } = wrap(
      <Markdown text={"[ok][a] [bad][b]\n\n[a]: https://a.test\n[b]: javascript:alert(1)"} />,
    );
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "ok" }).getAttribute("href")).toBe("https://a.test");
  });

  it("never loads images: an http(s) image is a link with its alt text", () => {
    const { container } = wrap(
      <Markdown text={"![chart](https://a.test/c.png) ![local](file.png)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "chart" }).getAttribute("href")).toBe(
      "https://a.test/c.png",
    );
    expect(container.textContent).toContain("local");
  });

  it("caps a table at 200 rows and says how many are left", () => {
    const { container } = wrap(<Markdown text={table(300)} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(200);
    expect(screen.getByText("还有 100 行")).toBeTruthy();
    cleanup();
    wrap(<Markdown text={table(201)} />, "en");
    expect(screen.getByText("1 more row")).toBeTruthy();
  });

  it("aligns columns as the delimiter row says and marks the parts", () => {
    const { container } = wrap(<Markdown text={table(1)} />);
    expect(container.querySelector('[data-part="md-table"]')).not.toBeNull();
    expect(container.querySelector('[data-part="md-table-head"]')).not.toBeNull();
    const cells = container.querySelectorAll("tbody td");
    expect(cells[1]?.getAttribute("data-align")).toBe("right");
  });

  it("renders a path chip for inline code naming a file output", async () => {
    const open = vi.fn();
    const paths = new Set(["reports/a.xlsx"]);
    wrap(<Markdown text="see `reports/a.xlsx` and `x.py`" paths={paths} onOpenPath={open} />);
    const chip = screen.getByRole("button", { name: "reports/a.xlsx" });
    expect(chip.getAttribute("data-part")).toBe("file-chip");
    await userEvent.click(chip);
    expect(open).toHaveBeenCalledWith("reports/a.xlsx");
    expect(screen.getByText("x.py").tagName).toBe("CODE");
  });

  it("renders a path chip for plain text naming a file output", () => {
    const paths = new Set(["reports/a.xlsx"]);
    wrap(<Markdown text="result in reports/a.xlsx, done" paths={paths} onOpenPath={() => {}} />);
    expect(screen.getByRole("button", { name: "reports/a.xlsx" })).toBeTruthy();
    expect(screen.getByText(/result in/).textContent).toContain(", done");
  });

  it("keeps plain inline code when the path names no file output", () => {
    wrap(<Markdown text="see `reports/a.xlsx`" onOpenPath={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("reports/a.xlsx").tagName).toBe("CODE");
  });

  it("maps headings # to ### onto h3 to h5", () => {
    const { container } = wrap(<Markdown text={"# Title\n\n## Sub\n\n### Third\n\n#### Deep"} />);
    expect(container.querySelector("h3")?.textContent).toBe("Title");
    expect(container.querySelector("h4")?.textContent).toBe("Sub");
    expect(container.querySelectorAll("h5")).toHaveLength(2);
    expect(container.querySelector("h1, h2")).toBeNull();
    expect(container.querySelector("h3")?.getAttribute("data-part")).toBe("prose-heading");
  });

  it("renders lists, quotes, code blocks, emphasis, strong and breaks", () => {
    const { container } = wrap(
      <Markdown
        text={
          "1. one\n2. **two**\n\n- *a*\n- ~~b~~\n\n> quote\n\n```py\nprint(1)\n```\n\n---\n\nend `c`"
        }
      />,
    );
    expect(container.querySelector("ol li strong")?.textContent).toBe("two");
    expect(container.querySelector("ul li em")?.textContent).toBe("a");
    expect(container.querySelector("del")?.textContent).toBe("b");
    expect(container.querySelector("blockquote")?.textContent).toContain("quote");
    expect(container.querySelector("pre code")?.textContent).toBe("print(1)");
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.querySelector('[data-part="inline-code"]')?.textContent).toBe("c");
  });

  it("survives deeply nested input", () => {
    const deep = `${"> ".repeat(500)}x`;
    const { container } = wrap(<Markdown text={deep} />);
    expect(container.textContent).toContain("x");
  });
});
