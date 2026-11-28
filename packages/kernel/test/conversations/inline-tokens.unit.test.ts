import { describe, expect, it } from "vitest";
import {
  connectorMentionText,
  countMarkers,
  fileLine,
  foldLabel,
  MAX_CONNECTOR_MENTIONS,
  MAX_TOKENS,
  MENTION_LOAD_MAX_TOOLS,
  numberLabels,
  placeholder,
  renderInline,
  TOKEN_MARKER,
  tokenEntityKey,
} from "../../src/conversations/inline-tokens.js";

describe("inline tokens", () => {
  it("exports the limits", () => {
    expect(TOKEN_MARKER).toBe("\uFFFC");
    expect(MAX_TOKENS).toBe(20);
    expect(MAX_CONNECTOR_MENTIONS).toBe(3);
    expect(MENTION_LOAD_MAX_TOOLS).toBe(20);
  });

  it("counts markers", () => {
    expect(countMarkers("a\uFFFCb\uFFFC")).toBe(2);
    expect(countMarkers("none")).toBe(0);
  });

  it("builds entity keys with normalized project paths", () => {
    expect(tokenEntityKey({ type: "connector", connectorId: "c" })).toBe("connector:c");
    expect(tokenEntityKey({ type: "resource", connectorId: "c", uri: "u://x" })).toBe(
      "resource:c:u://x",
    );
    expect(tokenEntityKey({ type: "file", id: "f" })).toBe("file:f");
    expect(tokenEntityKey({ type: "projectFile", path: "./src//a/../app.ts" })).toBe(
      "projectFile:src/app.ts",
    );
    expect(tokenEntityKey({ type: "conversation", id: "k" })).toBe("conversation:k");
  });

  it("folds labels", () => {
    expect(foldLabel("a\nb\u0007c")).toBe("a b c");
    expect(foldLabel("[x]")).toBe("(x)");
    expect(foldLabel("  y  ")).toBe("y");
    expect(foldLabel("字".repeat(81))).toBe(`${"字".repeat(80)}…`);
    expect(foldLabel("字".repeat(80))).toBe("字".repeat(80));
    const emoji = "😀".repeat(80);
    expect(foldLabel(emoji)).toBe(emoji);
    expect(foldLabel("😀".repeat(81))).toBe(`${emoji}…`);
  });

  it("numbers colliding labels in first-seen order", () => {
    const m = numberLabels([
      { key: "file:1", label: "a.png" },
      { key: "file:2", label: "a.png" },
      { key: "file:1", label: "a.png" },
      { key: "file:3", label: "a.png" },
    ]);
    expect(m.get("file:1")).toBe("a.png");
    expect(m.get("file:2")).toBe("a.png (2)");
    expect(m.get("file:3")).toBe("a.png (3)");
  });

  it("renders placeholders", () => {
    expect(placeholder("resource", "Send Message", "Slack")).toBe(
      "[resource: Send Message from Slack]",
    );
    expect(placeholder("connector", "Slack")).toBe("[connector: Slack]");
    expect(placeholder("file", "report.pdf")).toBe("[file: report.pdf]");
    expect(placeholder("projectFile", "src/app.ts")).toBe("[project file: src/app.ts]");
    expect(placeholder("conversation", "Untitled conversation")).toBe(
      "[conversation: Untitled conversation]",
    );
    expect(fileLine("report.pdf")).toBe("[file: report.pdf]");
  });

  it("renders inline text and offsets", () => {
    const r = renderInline(
      "\uFFFC 给小明发消息",
      [{ type: "connector", connectorId: "c" }],
      () => "Slack",
      () => "Slack",
    );
    expect(r.text).toBe("[connector: Slack] 给小明发消息");
    expect(r.inline).toEqual([
      { kind: "connector", start: 0, end: 18, label: "Slack", ref: { connectorId: "c" } },
    ]);
  });

  it("renders resource tokens with the connector label and later offsets", () => {
    const r = renderInline(
      "x \uFFFC y",
      [{ type: "resource", connectorId: "c", uri: "u://1" }],
      () => "Send Message",
      () => "Slack",
    );
    expect(r.text).toBe("x [resource: Send Message from Slack] y");
    expect(r.inline[0]).toMatchObject({
      start: 2,
      end: 37,
      ref: { connectorId: "c", uri: "u://1" },
    });
  });

  it("throws when the marker count differs from the tokens", () => {
    expect(() =>
      renderInline(
        "\uFFFC\uFFFC",
        [{ type: "file", id: "f" }],
        () => "a",
        () => "b",
      ),
    ).toThrow();
  });

  it("states connector mentions", () => {
    const base = { label: "Slack", name: "Slack", slug: "slack" };
    const head =
      '[connector: Slack] The person named the connector "Slack" for this message. Its tools are named mcp__slack__<tool>.';
    expect(connectorMentionText({ ...base, toolCount: 7, toolSearch: true })).toBe(
      `${head} Its 7 tools are loaded from this message on.`,
    );
    expect(connectorMentionText({ ...base, toolCount: 31, toolSearch: true })).toBe(
      `${head} It has 31 tools; load the ones this message needs with ToolSearch.`,
    );
    expect(connectorMentionText({ ...base, toolCount: 7, toolSearch: false })).toBe(head);
  });
});
