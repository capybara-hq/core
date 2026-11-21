import { ToolRow } from "@capybara-hq/design";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { buildTimeline } from "../src/lib/timeline";
import { renderPage } from "./support/render";

afterEach(cleanup);

let t = 0;
const ev = (seq: number, type: string, payload: unknown, runId: string | null = "r1") => {
  t += 1000;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(t).toISOString(),
  } as ConversationEvent;
};

const rowFor = (source: "full-access" | "review-model") => {
  const entries = buildTimeline(
    [
      ev(1, "user_message", { content: [{ type: "text", text: "go" }] }, null),
      ev(2, "assistant_message", {
        step: 0,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: "k1", name: "Platform", input: {} }],
      }),
      ev(3, "tool_ask_decided", {
        step: 0,
        callId: "k1",
        toolKey: "Platform",
        specHash: "s",
        bindingHash: "b",
        outcome: "allow",
        decisionSource: source,
        reason: "r",
        profileRevision: 1,
      }),
      ev(4, "tool_result", {
        step: 0,
        callId: "k1",
        toolKey: "Platform",
        content: "ok",
        isError: false,
      }),
    ],
    [],
    new Map(),
    "zh",
  );
  const tools = entries.find((e) => e.kind === "tools");
  if (tools?.kind !== "tools" || tools.rows[0] === undefined) throw new Error("no row");
  return tools.rows[0].row;
};

describe("a row the profile approved", () => {
  it.each([
    ["full-access", "已自动批准"],
    ["review-model", "审查模型已批准"],
  ] as const)("%s reads %s", (source, words) => {
    renderPage(<ToolRow row={rowFor(source)} />, { locale: "zh" });
    expect(screen.getByText(new RegExp(words))).toBeTruthy();
  });
});
