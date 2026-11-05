import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Badge,
  ConversationPage,
  DesignProvider,
  Dither,
  ListPage,
  ObjectRow,
  StatusBar,
} from "../src/index";

// The colour roles (spec §2.3, unslop audit 2026-11-03): orange is the primary action, focus and
// the current location; yellow needs attention; red is failure; selection is neutral.

afterEach(cleanup);

const style = (file: string) =>
  readFileSync(resolve(import.meta.dirname, "../src/styles", file), "utf8");
const tokens = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../docs/design/tokens.json"), "utf8"),
) as {
  color: Record<string, { dark: string; light: string }>;
  contrast: [string, string, number][];
};
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}
const zh = (ui: React.ReactElement) => render(<DesignProvider locale="zh">{ui}</DesignProvider>);

describe("selection is neutral", () => {
  it("a checked radio card: selected ground + line-strong border; the dot stays accent", () => {
    const css = style("controls.css");
    const card = rule(css, '.cb-radio[data-variant="card"][data-state="checked"]');
    expect(card).toContain("background: var(--cb-selected)");
    expect(card).toContain("border-color: var(--cb-line-strong)");
    expect(card).not.toContain("accent");
    expect(rule(css, '.cb-radio[data-state="checked"] .cb-box::after')).toContain(
      "background: var(--cb-accent)",
    );
  });

  it("the palette's selected row: selected ground + line-strong outline, no accent", () => {
    const row = rule(style("overlays.css"), '.cb-palette-item[data-selected="true"]');
    expect(row).toContain("background: var(--cb-selected)");
    expect(row).toContain("outline: 1px solid var(--cb-line-strong)");
    expect(row).not.toContain("accent");
  });

  it("the waterfall's selected row: selected ground + a neutral left marker", () => {
    const row = rule(style("display.css"), '.cb-waterfall-row[aria-selected="true"]');
    expect(row).toContain("background: var(--cb-selected)");
    expect(row).toContain("box-shadow: inset 2px 0 0 var(--cb-ink)");
    expect(row).not.toMatch(/accent|fail/);
  });
});

describe("empty lists show one primary", () => {
  const header = {
    path: [{ label: "capybara" }],
    title: "技能",
    actions: [
      { label: "导出", variant: "default" as const, onSelect: () => {} },
      { label: "上传技能", variant: "primary" as const, onSelect: () => {} },
    ],
  };

  it("the head primary hides while the empty state carries a primary action", () => {
    zh(
      <ListPage
        header={header}
        empty={{
          text: "还没有技能。",
          action: { label: "上传技能", variant: "primary", onSelect: () => {} },
        }}
      />,
    );
    expect(screen.getAllByRole("button", { name: "上传技能" })).toHaveLength(1);
    expect(document.querySelector('[data-part="empty-state"]')?.textContent).toContain("上传技能");
    // The head's other actions stay.
    expect(screen.getByRole("button", { name: "导出" })).toBeTruthy();
  });

  it("the head primary stays when the empty state has no primary action", () => {
    zh(<ListPage header={header} empty={{ text: "还没有技能。" }} />);
    expect(screen.getAllByRole("button", { name: "上传技能" })).toHaveLength(1);
  });

  it("the head primary stays while the list has rows or is loading", () => {
    zh(<ListPage header={header}>x</ListPage>);
    expect(screen.getAllByRole("button", { name: "上传技能" })).toHaveLength(1);
    cleanup();
    zh(
      <ListPage
        header={header}
        loading
        empty={{ text: "空", action: { label: "上传技能", variant: "primary" } }}
      />,
    );
    expect(screen.getAllByRole("button", { name: "上传技能" })).toHaveLength(1);
  });
});

describe("attention is a yellow text mark", () => {
  it("Badge tone warn: warn text, no border, no fill", () => {
    zh(<Badge tone="warn">敏感</Badge>);
    expect(screen.getByText("敏感").getAttribute("data-tone")).toBe("warn");
    const mark = rule(style("display.css"), '.cb-badge[data-tone="warn"]');
    expect(mark).toContain("color: var(--cb-warn)");
    expect(mark).toContain("border-color: transparent");
    expect(mark).toContain("padding: 0");
    expect(mark).not.toContain("background");
  });

  it("an ObjectRow warn chip is the same mark", () => {
    zh(<ObjectRow mark={{ text: "d" }} name="demo" chips={[{ label: "敏感", tone: "warn" }]} />);
    expect(screen.getByText("敏感").getAttribute("data-tone")).toBe("warn");
    const chip = rule(style("templates.css"), '.cb-object-chip[data-tone="warn"]');
    expect(chip).toContain("color: var(--cb-warn)");
    expect(chip).toContain("border-color: transparent");
    expect(chip).toContain("padding: 0");
    expect(chip).not.toContain("background");
  });
});

describe("failure in the status bar is red", () => {
  it("StatusBar systemTone colours the first system item", () => {
    zh(<StatusBar context="g@c:~" version="v1" system={["失败", "上下文 3%"]} systemTone="fail" />);
    expect(screen.getByText("失败").getAttribute("data-tone")).toBe("fail");
    expect(screen.getByText("上下文 3%").getAttribute("data-tone")).toBeNull();
    expect(rule(style("shell.css"), '.cb-statusbar-right > [data-tone="fail"]')).toContain(
      "color: var(--cb-fail)",
    );
  });

  it("ConversationPage passes status.tone to the status bar", () => {
    zh(
      <ConversationPage
        titleBar={{
          title: "t",
          untitled: "u",
          menu: [],
          properties: { pressed: false, onToggle: () => {} },
          panels: [],
        }}
        thread={null}
        composer={null}
        status={{ context: "g@c:~", version: "v1", right: ["失败"], tone: "fail" }}
        right="none"
        onCloseRight={() => {}}
      />,
    );
    expect(screen.getByText("失败").getAttribute("data-tone")).toBe("fail");
  });
});

describe("the login dither is greyscale", () => {
  it("draws no accent squares", () => {
    const { container } = render(<Dither side="left" seed={7} />);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
    expect(container.querySelector("rect[data-accent]")).toBeNull();
    expect(style("display.css")).not.toContain("data-accent");
  });
});

describe("dark theme legibility", () => {
  it("disabled, card hairline and scrollbar thumb are tokens", () => {
    expect(tokens.color.disabled).toBeDefined();
    expect(tokens.color["line-card"]?.dark).toBe("rgba(255,255,255,0.08)");
    expect(tokens.color["scroll-thumb"]?.dark).toBe("rgba(255,255,255,0.15)");
    expect(tokens.color["scroll-thumb"]?.light).toBeDefined();
  });

  it("check:tokens holds muted at 4.5:1 and disabled at 3:1 on every ground they sit on", () => {
    const pairs = tokens.contrast.map(([a, b, f]) => `${a}/${b}/${f}`);
    for (const ground of ["bg", "panel", "panel-2", "raised", "selected", "hover"]) {
      expect(pairs).toContain(`muted/${ground}/4.5`);
    }
    for (const ground of ["bg", "panel", "hover", "selected"]) {
      expect(pairs).toContain(`disabled/${ground}/3`);
    }
  });

  it("disabled controls use the disabled token with a visible line border", () => {
    const css = style("controls.css");
    const btn = rule(css, ".cb-btn:disabled");
    expect(btn).toContain("color: var(--cb-disabled)");
    expect(btn).toContain("border-color: var(--cb-line)");
    const field = rule(
      css,
      '.cb-input[data-state="disabled"],\n.cb-select[data-state="disabled"],\n.cb-textarea[data-state="disabled"]',
    );
    expect(field).toContain("color: var(--cb-disabled)");
    expect(field).toContain("border-color: var(--cb-line)");
  });

  it("cards draw the line-card hairline", () => {
    expect(rule(style("controls.css"), ".cb-card")).toContain(
      "border: 1px solid var(--cb-line-card)",
    );
    expect(rule(style("shell.css"), ".cb-stat-card")).toContain(
      "box-shadow: inset 0 0 0 1px var(--cb-line-card)",
    );
    expect(rule(style("templates.css"), ".cb-form-section-fields")).toContain(
      "box-shadow: inset 0 0 0 1px var(--cb-line-card)",
    );
  });

  it("scrollbars use the scroll-thumb token", () => {
    expect(rule(style("base.css"), "html")).toContain(
      "scrollbar-color: var(--cb-scroll-thumb) transparent",
    );
  });

  it("path segments are muted (separators stay faint); KeyValue keys are not overridden to faint", () => {
    const shell = style("shell.css");
    expect(rule(shell, ".cb-pageheader-path-seg")).toContain("color: var(--cb-muted)");
    expect(rule(shell, ".cb-pageheader-path-sep")).toContain("color: var(--cb-faint)");
    expect(rule(style("conversation-page.css"), ".cb-title-path-seg")).toContain(
      "color: var(--cb-muted)",
    );
    expect(style("conversation.css")).not.toMatch(/\n\.cb-kv-key \{/);
  });
});
