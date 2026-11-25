import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { buildTimeline, type TimelineEntry } from "../src/lib/timeline";

/**
 * Images in tool results (tool result images design §4): `tool_result.media` reaches the call's
 * timeline row, which the thread draws as thumbnails that open the image viewer.
 */

let t = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  t += 1000;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(t).toISOString(),
  } as ConversationEvent;
}

const KEY = "plugin__browser__browser_screenshot";
const IMAGE = {
  attachmentId: "00000000-0000-4000-8000-000000000001",
  name: "browser_screenshot.jpg",
  mediaType: "image/jpeg",
  size: 50308,
};

const events = (media?: unknown[]): ConversationEvent[] => [
  ev(1, "user_message", { content: [{ type: "text", text: "shot" }], authorAccountId: "a1" }, null),
  ev(2, "assistant_message", {
    step: 0,
    stopReason: "tool_use",
    content: [{ type: "tool_call", id: "k1", name: KEY, input: { fullPage: true } }],
  }),
  ev(3, "tool_result", {
    step: 0,
    callId: "k1",
    toolKey: KEY,
    content: `Screenshot.\n[Image (image/jpeg, 49.1 KB, 1280×800), file_id ${IMAGE.attachmentId}]`,
    isError: false,
    contentTypes: ["text", "image"],
    ...(media !== undefined && { media }),
  }),
];

const rows = (entries: TimelineEntry[]) =>
  entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));
const build = (evs: ConversationEvent[]) => buildTimeline(evs, [], new Map(), "en");

describe("tool result images in the timeline", () => {
  it("the call's row carries the stored images", () => {
    const [row] = rows(build(events([IMAGE])));
    expect(row?.images).toEqual([IMAGE]);
    expect(row?.row.status).toBe("done");
  });

  it("a result without stored images carries none", () => {
    const [row] = rows(build(events()));
    expect(row?.images).toBeUndefined();
  });
});
