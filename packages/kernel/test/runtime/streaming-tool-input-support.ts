import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";

/**
 * Support for the streaming tool input end-to-end tests (spec 2026-11-26) in `stream.http.test.ts`:
 * a hold on the provider stream of a streamed Write, an SSE reader that fails fast when the run
 * ends first, and parsers of the tool frames.
 */

/** Pause between the 4-character fragments of a streamed input. */
export const FRAGMENT_MS = 25;

/**
 * A hold on the provider stream of the next streamed Write request: the stream is delivered up to
 * `at` input fragments (`Infinity`: all of them) and then waits, so what the kernel does while the
 * model is still streaming is observed deterministically. Armed by a test, consumed by the first
 * request that offers `Write` and ends in a `streamtool:` message; released by the test, or by
 * `beforeEach` when a test failed first.
 */
export interface Hold {
  at: number;
  promise: Promise<void>;
  release(): void;
}
let hold: Hold | undefined;
let held: Hold | undefined;
export const armHold = (at = Number.POSITIVE_INFINITY): Hold => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  hold = { at, promise, release };
  held = hold;
  return hold;
};
let unwrapResolve: (() => void) | undefined;
/** Wraps the provider registry's resolve (after `captureProviderRequests().install()`). */
export function installHold(): void {
  const wrapped = ProviderRegistry.prototype.resolve;
  ProviderRegistry.prototype.resolve = async function (this: ProviderRegistry, orgId, ref, opts) {
    const r = await wrapped.call(this, orgId, ref, opts);
    const inner = r.provider;
    return {
      ...r,
      provider: {
        ...inner,
        stream(req, o) {
          const stream = inner.stream(req, o);
          const last = JSON.stringify(req.messages.at(-1));
          const offersWrite = req.tools.some((t) => t.name === "Write");
          if (hold === undefined || !offersWrite || !last.includes("streamtool:")) return stream;
          const h = hold;
          hold = undefined;
          return (async function* () {
            let fragments = 0;
            for await (const ev of stream) {
              if (ev.type === "tool_call_delta" && ++fragments === h.at) await h.promise;
              if (ev.type === "message_complete") await h.promise;
              yield ev;
            }
          })();
        },
      },
    };
  };
  unwrapResolve = () => {
    ProviderRegistry.prototype.resolve = wrapped;
  };
}
/** Releases a hold a failed test left armed, and forgets one nobody consumed. */
export function clearHold(): void {
  held?.release();
  hold = undefined;
}
/** Undoes {@link installHold}. */
export function uninstallHold(): void {
  held?.release();
  unwrapResolve?.();
}

export interface SseMessage {
  event?: string;
  data?: string;
}

/** A minimal SSE reader: every message of the stream, with a wait on a condition. */
export interface Sse {
  messages: SseMessage[];
  /**
   * Seq of the message that started the awaited run: a terminal event after it that the awaited
   * condition did not need fails the wait at once (a missed frame must not hang the test).
   */
  after: number;
  until(pred: (m: SseMessage[]) => boolean, label: string): Promise<void>;
  close(): void;
}

export async function openToolSse(url: string, cookie: string): Promise<Sse> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { cookie }, signal: ac.signal });
  expect(res.status).toBe(200);
  const messages: SseMessage[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  void (async () => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m: SseMessage = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const c = line.indexOf(":");
            const key = line.slice(0, c);
            const v = line.slice(c + 1).replace(/^ /, "");
            if (key === "event") m.event = v;
            else if (key === "data") m.data = m.data === undefined ? v : `${m.data}\n${v}`;
          }
          messages.push(m);
        }
        for (const w of [...waiters]) w();
      }
    } catch {
      // aborted by the test
    } finally {
      ended = true;
      for (const w of [...waiters]) w();
    }
  })();
  const sse: Sse = {
    messages,
    after: Number.POSITIVE_INFINITY,
    until(pred, label) {
      // bounded by the test run itself: the stream ends or the awaited frame arrives
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          const over = messages.find(
            (m) =>
              m.event === "event" &&
              (() => {
                const e = JSON.parse(m.data as string) as { seq: number; type: string };
                return (
                  e.seq > sse.after &&
                  ["run_finished", "run_failed", "run_aborted"].includes(e.type)
                );
              })(),
          );
          if (pred(messages)) {
            waiters.delete(check);
            resolve();
          } else if (over !== undefined) {
            waiters.delete(check);
            reject(new Error(`the run ended before ${label}`));
          } else if (ended) {
            waiters.delete(check);
            reject(new Error(`stream ended before ${label}`));
          }
        };
        waiters.add(check);
        check();
      });
    },
    close: () => ac.abort(),
  };
  return sse;
}

export interface ToolDelta {
  runId: string;
  step: number;
  delta: "tool_start" | "tool_input" | "tool_base";
  callId: string;
  name?: string;
  text?: string;
  offset?: number;
  sha256?: string;
}
export interface DraftTool {
  id: string;
  name: string;
  input: string;
  inputTruncated?: boolean;
  base?: { text: string; sha256: string };
}
export interface DraftFrame {
  runId: string;
  step: number;
  tools: DraftTool[];
}

export const toolDeltas = (msgs: SseMessage[]): ToolDelta[] =>
  msgs
    .filter((m) => m.event === "delta")
    .map((m) => JSON.parse(m.data as string) as ToolDelta)
    .filter((d) => d.delta === "tool_start" || d.delta === "tool_input" || d.delta === "tool_base");
export const draftFrames = (msgs: SseMessage[]): DraftFrame[] =>
  msgs.filter((m) => m.event === "draft").map((m) => JSON.parse(m.data as string) as DraftFrame);

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
export const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

export const NEW_CONTENT = Array.from({ length: 12 }, (_, i) => `print("line ${i}")`).join("\n");
/** `file_path` first: the base read starts as soon as it closes, early in the stream. */
export const writeInput = (path: string) => ({ file_path: path, content: NEW_CONTENT });
export const streamedWrite = (input: unknown, ms = FRAGMENT_MS) =>
  `streamtool:${ms}:Write:${JSON.stringify(input)}`;

export const finishedAfter = (after: number) => (m: SseMessage[]) =>
  m.some(
    (x) =>
      x.event === "event" &&
      (() => {
        const e = JSON.parse(x.data as string) as { seq: number; type: string };
        return e.seq > after && e.type === "run_finished";
      })(),
  );
export const baseSeen = (m: SseMessage[]) => toolDeltas(m).some((d) => d.delta === "tool_base");
/** Every fragment of the call's input has been published (the stream is then at its last event). */
export const inputComplete = (input: unknown) => (m: SseMessage[]) => {
  const last = toolDeltas(m)
    .filter((d) => d.delta === "tool_input")
    .at(-1);
  return (
    last !== undefined &&
    (last.offset as number) + (last.text as string).length === JSON.stringify(input).length
  );
};
