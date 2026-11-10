// The core findings of the 2026-11-10 browser detail review: what jsdom can see (structure,
// attributes, the copy button) is rendered; what only layout shows (fades, shrink order, word
// breaking) is read from the design stylesheets, where the rule lives.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, ContextSection, DesignProvider, Markdown, Tabs } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const STYLES = resolve(__dirname, "../src/styles");

/** Every `selector { body }` rule of the design stylesheets (comments stripped), by selector. */
function rules(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(resolve(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of (m[1] ?? "").split(",")) {
        const key = selector.trim().replace(/\s+/g, " ");
        out.set(key, `${out.get(key) ?? ""}${m[2] ?? ""}`);
      }
    }
  }
  return out;
}

/** The declarations of one selector as a map (the last one wins, as in CSS). */
function decls(selector: string): Map<string, string> {
  const body = rules().get(selector);
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  const out = new Map<string, string>();
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0)
      out.set(
        d.slice(0, i).trim(),
        d
          .slice(i + 1)
          .trim()
          .replace(/\s+/g, " "),
      );
  }
  return out;
}

describe("F06: links never take the browser's colours", () => {
  it("a plain anchor is ink with a line-strong underline, at zero specificity", () => {
    const a = decls(":where(a:any-link)");
    expect(a.get("color")).toBe("var(--cb-ink)");
    expect(a.get("text-decoration-color")).toBe("var(--cb-line-strong)");
    expect(decls(":where(a:any-link:hover)").get("text-decoration-color")).toBe("var(--cb-ink)");
  });
});

describe("F12: disabled never adds a border", () => {
  it("the shared disabled rule sets no border; only secondary turns its accent border to line", () => {
    expect(decls(".cb-btn:disabled").has("border-color")).toBe(false);
    expect(decls(".cb-btn:disabled").has("border")).toBe(false);
    expect(decls('.cb-btn[data-variant="secondary"]:disabled').get("border-color")).toBe(
      "var(--cb-line)",
    );
    expect(decls('.cb-btn[data-variant="ghost"]').get("border-color")).toBe("transparent");
  });
});

describe("F14: the status bar keeps the page status whole", () => {
  it("the prompt shrinks far before the page status", () => {
    const context = decls(".cb-statusbar-context").get("flex") ?? "";
    const page = decls(".cb-statusbar-page").get("flex") ?? "";
    const shrink = (flex: string) => Number(flex.split(" ")[1]);
    expect(shrink(context)).toBeGreaterThanOrEqual(100 * shrink(page));
  });
});

describe("F15: the thread fades at both scroll edges", () => {
  it("masks the top and bottom space.4", () => {
    const mask = decls('.cb-conv-scroll:not([data-center="true"])').get("mask-image") ?? "";
    expect(mask).toContain("transparent, black var(--cb-space-4)");
    expect(mask).toContain("black calc(100% - var(--cb-space-4)), transparent");
  });
});

describe("F21: context lines break between words", () => {
  it("draws every context line with keep-all", () => {
    expect(decls(".cb-context-line").get("word-break")).toBe("keep-all");
    wrap(
      <ContextSection
        ratio={4}
        model="deepseek-flash"
        sandbox="设备：个人设备 · 已暂停"
        connectors={["Slack"]}
        lastRun="上次运行 · deepseek-flash · 19 秒"
        total="共 146,405 token"
      />,
    );
    const lines = document.querySelectorAll(".cb-context-line");
    expect([...lines].map((l) => l.textContent)).toEqual([
      "deepseek-flash · 设备：个人设备 · 已暂停",
      expect.stringContaining("Slack"),
      "上次运行 · deepseek-flash · 19 秒",
      "共 146,405 token",
    ]);
  });
});

describe("F23: header actions sit on the title line", () => {
  it("the row aligns to its top and the actions take the h1's line box", () => {
    expect(decls(".cb-pageheader-row").get("align-items")).toBe("flex-start");
    expect(decls(".cb-pageheader-actions").get("min-height")).toBe("var(--cb-type-h1-line)");
  });
});

describe("F24: a tab row that does not fit fades where tabs are hidden", () => {
  const items = ["全部", "模型", "网页", "连接器", "沙箱", "存储", "工具与界面"].map(
    (label, i) => ({
      id: `t${i}`,
      label,
    }),
  );
  const size = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  };

  it("marks the end, then both edges once scrolled, then the start at the end", () => {
    const { rerender } = wrap(<Tabs label="Tabs" items={items} value="t0" />);
    const row = screen.getByRole("tablist");
    // jsdom lays nothing out: a row that fits has no fade
    expect(row.getAttribute("data-fade-start")).toBeNull();
    expect(row.getAttribute("data-fade-end")).toBeNull();
    size(row, 600, 358);
    act(() => {
      fireEvent.scroll(row);
    });
    expect(row.getAttribute("data-fade-start")).toBeNull();
    expect(row.getAttribute("data-fade-end")).toBe("true");
    row.scrollLeft = 100;
    act(() => {
      fireEvent.scroll(row);
    });
    expect(row.getAttribute("data-fade-start")).toBe("true");
    expect(row.getAttribute("data-fade-end")).toBe("true");
    row.scrollLeft = 242;
    act(() => {
      fireEvent.scroll(row);
    });
    expect(row.getAttribute("data-fade-start")).toBe("true");
    expect(row.getAttribute("data-fade-end")).toBeNull();
    rerender(
      <DesignProvider locale="zh">
        <Tabs label="Tabs" items={items} value="t1" />
      </DesignProvider>,
    );
    expect(screen.getByRole("tablist")).toBe(row);
  });

  it("link tabs fade the same way", () => {
    wrap(
      <Tabs
        label="Views"
        items={items.map((it) => ({ ...it, href: `/x?tab=${it.id}` }))}
        value="t0"
      />,
    );
    const row = screen.getByRole("navigation", { name: "Views" });
    size(row, 600, 358);
    act(() => {
      fireEvent.scroll(row);
    });
    expect(row.getAttribute("data-fade-end")).toBe("true");
  });

  it("the stylesheet masks the marked edges", () => {
    expect(decls('.cb-tabs[data-fade-end="true"]').get("mask-image")).toContain("transparent");
    expect(decls('.cb-tabs[data-fade-start="true"]').get("mask-image")).toContain("to left");
  });
});

describe("F25: markdown code blocks can be copied", () => {
  it("draws the CodeBlock head with the language and the copy button", () => {
    wrap(<Markdown text={"```python\nprint(1)\n```"} />, "en");
    const block = document.querySelector('[data-part="code-block"]') as HTMLElement;
    expect(block.querySelector('[data-part="code-block-head"]')?.textContent).toContain("python");
    expect(within(block).getByRole("button", { name: /Copy/ })).toBeTruthy();
  });

  it("stays one box inside a box (the borderless form)", () => {
    wrap(
      <Card>
        <Markdown text={"```sh\nls\n```"} />
      </Card>,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

describe("F26: markdown tables have row lines and room", () => {
  it("pads both sides, lines the head and the rows", () => {
    const cell = decls(".cb-md-table td");
    expect(cell.get("padding")).toBe("var(--cb-pad-dense-y) var(--cb-space-3)");
    expect(cell.get("min-width")).toBe("4em");
    expect(decls(".cb-md-table th").get("border-bottom")).toBe("1px solid var(--cb-line)");
    expect(decls(".cb-md-table tbody tr + tr").get("border-top")).toBe("1px solid var(--cb-line)");
  });
});
