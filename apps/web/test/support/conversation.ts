/** Shared helpers for the conversation page tests: events, a fake EventSource, routes. */
import type { ConversationEvent } from "../../src/lib/conversations";

let seqTime = 0;
export function ev(
  seq: number,
  type: string,
  payload: unknown,
  runId: string | null = "r1",
  conversationId = "c1",
): ConversationEvent {
  seqTime += 1000;
  return {
    conversationId,
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(Date.UTC(2026, 9, 26, 6, 0, 0) + seqTime).toISOString(),
  } as ConversationEvent;
}
export const userMsg = (seq: number, text: string, extra: Record<string, unknown> = {}) =>
  ev(
    seq,
    "user_message",
    { content: [{ type: "text", text }], authorAccountId: "a1", ...extra },
    null,
  );
export const runStarted = (seq: number, runId = "r1") =>
  ev(
    seq,
    "run_started",
    { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } },
    runId,
  );

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    const e =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  /** The browser gave up reconnecting: CLOSED and a plain error event. */
  giveUp() {
    this.readyState = 2;
    this.emit("error");
  }
}

export const CONV = (id = "c1", extra: Record<string, unknown> = {}) => ({
  conversation: {
    id,
    orgId: "o1",
    agentId: "ag1",
    accountId: "a1",
    title: null,
    titleSource: null,
    selection: { model: null, effort: null },
    lastSeq: 0,
    createdAt: "2026-10-26T06:02:00.000Z",
    updatedAt: "2026-10-26T06:02:00.000Z",
    ...extra,
  },
});

export const AGENTS = {
  agents: [
    {
      id: "ag1",
      orgId: "o1",
      ownerAccountId: "a1",
      visibility: "org",
      currentVersion: 1,
      definition: {
        name: "Echo agent",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
      },
      updatedAt: "2026-10-26T06:00:00.000Z",
    },
    {
      id: "ag2",
      orgId: "o1",
      ownerAccountId: "a1",
      visibility: "org",
      currentVersion: 1,
      definition: {
        name: "Second agent",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
      },
      updatedAt: "2026-10-26T06:00:00.000Z",
    },
  ],
};

export const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        {
          id: "fake-1",
          displayName: "Fake 1",
          contextWindow: 1000,
          capabilities: { reasoning: true },
          parameters: [],
        },
        {
          id: "fake-2",
          displayName: "Fake 2",
          capabilities: { reasoning: true },
          parameters: [
            {
              key: "effort",
              standard: "effort",
              schema: { type: "string", enum: ["low", "high"] },
              default: "low",
              label: { zh: "档位", en: "Effort" },
            },
          ],
        },
      ],
    },
  ],
};
