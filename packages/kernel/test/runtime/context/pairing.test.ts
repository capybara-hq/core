import type { ModelMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { guardToolPairs, UNKNOWN_RESULT_TEXT } from "../../../src/runtime/context/pairing.js";

describe("guardToolPairs", () => {
  it("leaves well-paired messages untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "t", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", callId: "c1", content: "ok", isError: false }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    expect(guardToolPairs(messages)).toEqual(messages);
  });

  it("adds an unknown error result after an assistant call that has no result", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "t", input: {} },
          { type: "tool_call", id: "c2", name: "t", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", callId: "c1", content: "ok", isError: false }],
      },
      { role: "user", content: [{ type: "text", text: "and?" }] },
    ];
    expect(guardToolPairs(messages)).toEqual([
      messages[0],
      messages[1],
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "c2", content: UNKNOWN_RESULT_TEXT, isError: true },
        ],
      },
      messages[2],
      messages[3],
    ]);
    expect(UNKNOWN_RESULT_TEXT).toBe(
      "Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying.",
    );
  });

  it("adds unknown results when the call is the last message", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "t", input: {} }] },
    ];
    expect(guardToolPairs(messages)[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", callId: "c1", content: UNKNOWN_RESULT_TEXT, isError: true }],
    });
  });

  it("treats a result after the next assistant message as missing", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "t", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "moving on" }] },
      {
        role: "user",
        content: [{ type: "tool_result", callId: "c1", content: "late", isError: false }],
      },
    ];
    expect(guardToolPairs(messages)).toEqual([
      messages[0],
      {
        role: "user",
        content: [
          { type: "tool_result", callId: "c1", content: UNKNOWN_RESULT_TEXT, isError: true },
        ],
      },
      messages[1],
    ]);
  });

  it("drops orphan tool results and messages left empty", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", callId: "x", content: "?", isError: false }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_result", callId: "y", content: "?", isError: false },
        ],
      },
    ];
    expect(guardToolPairs(messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("does not mutate its input", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "t", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", callId: "x", content: "?", isError: false }],
      },
    ];
    const copy = structuredClone(messages);
    guardToolPairs(messages);
    expect(messages).toEqual(copy);
  });
});
