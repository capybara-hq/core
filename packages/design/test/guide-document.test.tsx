import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, CheckRow, DesignProvider, type GuideBlock, GuideDocument } from "../src/index";
import { describeNestedBox, findNestedBoxes } from "../src/reference/index";

afterEach(cleanup);

const wrap = (ui: React.ReactElement, locale: "zh" | "en" = "zh") =>
  render(<DesignProvider locale={locale}>{ui}</DesignProvider>);

const blocks: GuideBlock[] = [
  { kind: "markdown", text: "## Create the app\n\nOpen **Slack** first." },
  {
    kind: "code",
    language: "yaml",
    title: "App manifest",
    text: "display_information:\n  name: x",
  },
  { kind: "check", id: "bot-token", label: "Bot token works" },
  { kind: "markdown", text: "Then install it." },
  { kind: "code", language: "", title: null, text: "echo hi" },
];

describe("GuideDocument (design spec §6.9)", () => {
  it("renders markdown, copyable titled code and checks in order", () => {
    const { container } = wrap(
      <GuideDocument
        blocks={blocks}
        renderCheck={(b) => <div data-testid={`check-${b.id}`}>{b.label}</div>}
      />,
    );
    const root = container.querySelector('[data-part="guide-document"]');
    expect(root).not.toBeNull();
    const parts = [...(root?.children ?? [])].map(
      (el) => el.getAttribute("data-part") ?? el.getAttribute("data-testid"),
    );
    expect(parts).toEqual(["markdown", "code-block", "check-bot-token", "markdown", "code-block"]);
    // Markdown is rendered, not shown as source
    expect(screen.getByText("Slack").tagName).toBe("STRONG");
    // code: the title, the language and a copy button; text as written
    const code = container.querySelectorAll('[data-part="code-block"]');
    expect(code[0]?.querySelector(".cb-code-title")?.textContent).toBe("App manifest");
    expect(code[0]?.querySelector(".cb-code-head-lang")?.textContent).toBe("yaml");
    expect(code[0]?.querySelector('[data-part="code-block-copy"]')).not.toBeNull();
    expect(code[0]?.querySelector("code")?.textContent).toBe("display_information:\n  name: x");
    // untitled code without a language is still copyable, with no language label
    expect(code[1]?.querySelector('[data-part="code-block-copy"]')).not.toBeNull();
    expect(code[1]?.querySelector(".cb-code-head-lang")).toBeNull();
    expect(code[1]?.querySelector(".cb-code-title")?.textContent).toBe("");
  });

  it("default check rendering is a static CheckRow", () => {
    const { container } = wrap(<GuideDocument blocks={blocks} />);
    const row = container.querySelector('[data-part="check-row"]');
    expect(row?.getAttribute("data-status")).toBe("static");
    expect(row?.textContent).toContain("Bot token works");
    expect(row?.textContent).toContain("保存后检查");
    expect(screen.queryByRole("button", { name: /重新检查/ })).toBeNull();
  });

  it("findNestedBoxes reports none inside a Card", () => {
    wrap(
      <Card title="Slack 应用">
        <GuideDocument blocks={blocks} />
        <CheckRow label="x" state={{ status: "ok" }} onRecheck={() => {}} />
      </Card>,
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    // the code blocks draw their borderless form inside the card
    for (const code of document.querySelectorAll('[data-part="code-block"]')) {
      expect(code.getAttribute("data-framed")).toBe("false");
    }
  });
});
