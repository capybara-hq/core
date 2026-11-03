// The conversation page through the query cache (web query cache spec §6): the stream appends to
// the cached log, `changed` frames invalidate their key, and a return reads only what changed.
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  appendEvents,
  CONVERSATION_SIDE_KEYS,
  eventsQuery,
  toolInfoQuery,
} from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { ev } from "./support/conversation";
import { testQueryClient } from "./support/query";

const seqs = (list: readonly ConversationEvent[] | undefined) => (list ?? []).map((e) => e.seq);
const msg = (seq: number) => ev(seq, "user_message", { content: [] }, null);

describe("appendEvents", () => {
  it("appendEvents ignores seqs it already holds and keeps order", () => {
    const qc = testQueryClient();
    const key = eventsQuery("o1", "c1").queryKey;
    qc.setQueryData(key, [msg(1), msg(2), msg(3)]);
    const r = appendEvents(qc, "o1", "c1", [msg(3), msg(2), msg(4), msg(6), msg(5)]);
    expect(seqs(qc.getQueryData<ConversationEvent[]>(key))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.added).toBe(3);
  });

  it("appends newer events in order, once each, and keeps the list when nothing is new", () => {
    const qc = testQueryClient();
    const key = eventsQuery("o1", "c1").queryKey;
    qc.setQueryData(key, [msg(1)]);
    expect(appendEvents(qc, "o1", "c1", [msg(3), msg(2), msg(3)]).added).toBe(2);
    const list = qc.getQueryData<ConversationEvent[]>(key);
    expect(seqs(list)).toEqual([1, 2, 3]);
    expect(appendEvents(qc, "o1", "c1", [msg(2)]).added).toBe(0);
    expect(qc.getQueryData<ConversationEvent[]>(key)).toBe(list);
  });

  it("does nothing while the log is not cached", () => {
    const qc = testQueryClient();
    expect(appendEvents(qc, "o1", "c1", [msg(1)]).added).toBe(0);
    expect(qc.getQueryData(eventsQuery("o1", "c1").queryKey)).toBeUndefined();
  });
});

describe("conversation query keys", () => {
  it("tool info holds its keys sorted: the same set is one key", () => {
    expect(toolInfoQuery("o1", "c1", ["b", "a"]).queryKey).toEqual(
      toolInfoQuery("o1", "c1", ["a", "b"]).queryKey,
    );
  });

  it("the side keys are the conversation's pieces outside the log, scoped to the org", () => {
    const side = CONVERSATION_SIDE_KEYS("o1", "c1");
    for (const k of side) expect(k.slice(0, 2)).toEqual(["org", "o1"]);
    expect(side).toContainEqual(keys.org("o1").conversation("c1").queue());
    expect(side).toContainEqual(keys.org("o1").conversation("c1").row());
    expect(side).not.toContainEqual(keys.org("o1").conversation("c1").events());
  });
});
