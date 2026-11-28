import { describe, expect, it } from "vitest";
import { loadedToolKeys } from "../../src/runtime/context/build.js";
import { Log } from "./context/fixtures.js";

/** A user message naming one connector whose mention loaded `keys` (composer inline tokens §3.5). */
function mention(log: Log, keys: string[]): void {
  log.add(
    {
      type: "user_message",
      payload: {
        content: [{ type: "text", text: "[connector: Slack] hi" }],
        authorAccountId: "acc-1",
        connectorMentions: [
          { connectorId: "c1", slug: "slack", name: "Slack", toolCount: 2, loadedTools: keys },
        ],
      },
    },
    null,
  );
}

function toolSearchResult(log: Log, keys: string[]): void {
  log.add({
    type: "tool_result",
    payload: {
      step: 1,
      callId: "call-1",
      toolKey: "ToolSearch",
      content: "loaded",
      isError: false,
      loadedTools: keys,
    },
  });
}

describe("loadedToolKeys", () => {
  it("mentions add loaded keys in log order", () => {
    const log = new Log();
    log.user("before");
    mention(log, ["a", "b"]);
    log.assistant("ok");
    toolSearchResult(log, ["b", "c"]);
    expect(log.events[1]?.seq).toBe(2);
    expect(log.events[3]?.seq).toBe(4);
    expect(loadedToolKeys(log.events)).toEqual(["a", "b", "c"]);
  });

  it("orders by seq, not by array position", () => {
    const log = new Log();
    mention(log, ["a"]);
    toolSearchResult(log, ["z"]);
    expect(loadedToolKeys([...log.events].reverse())).toEqual(["a", "z"]);
  });

  it("a message without mentions loads nothing", () => {
    const log = new Log();
    log.user("plain");
    expect(loadedToolKeys(log.events)).toEqual([]);
  });
});
