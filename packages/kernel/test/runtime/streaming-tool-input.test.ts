import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Streaming tool input, end to end (spec 2026-11-26): model-fake streams every tool call as
 * `tool_call_start` + `tool_call_delta`, and `streamtool:<ms>:<name>:<json>` pauses between the
 * fragments. The kernel publishes bus deltas `tool_start` / `tool_input` / `tool_base`, keeps the
 * live draft (SSE `event: draft`, the draft route) and, for the builtin `Write` after its
 * file_path closed, reads a display-only base from the device (a `write_base` kernel read) when
 * the conversation had read the file unchanged. Nothing streamed reaches the log or the model.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);
/** Pause between the 4-character fragments of a streamed input. */
const FRAGMENT_MS = 25;

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerCookie: () => string;
let orgId: string;
let agentId: string;
let workspace: string | undefined;

/**
 * A hold on the provider stream of the next streamed Write request: the stream is delivered up to
 * `at` input fragments (`Infinity`: all of them) and then waits, so what the kernel does while the
 * model is still streaming is observed deterministically. Armed by a test, consumed by the first
 * request that offers `Write` and ends in a `streamtool:` message; released by the test, or by
 * `beforeEach` when a test failed first.
 */
interface Hold {
  at: number;
  promise: Promise<void>;
  release(): void;
}
let hold: Hold | undefined;
let held: Hold | undefined;
const armHold = (at = Number.POSITIVE_INFINITY): Hold => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  hold = { at, promise, release };
  held = hold;
  return hold;
};
let unwrapResolve: (() => void) | undefined;
function installHold(): void {
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

beforeAll(async () => {
  capture.install();
  installHold();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  root = await mkdtemp(join(tmpdir(), "cap-streaming-tool-input-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "device-fake": { root } },
        runtime: { sseHeartbeatMs: 100, sseRecheckMs: 200 },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  const jar = cookieJar();
  owner = asUser(k.http, jar);
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = () => jar.header() as string;
  orgId = await createOrgWithProviders(k, owner);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Writer",
        instructions: "Write files.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(
          ["Read", "Write", "Agent"].map((name) => ({ kind: "builtin" as const, name })),
        ),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  held?.release();
  unwrapResolve?.();
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  held?.release();
  hold = undefined;
  capture.reset();
});

// ---- helpers ----

interface SseMessage {
  event?: string;
  data?: string;
}

/** A minimal SSE reader: every message of the stream, with a wait on a condition. */
interface Sse {
  messages: SseMessage[];
  /**
   * Seq of the message that started the awaited run: a terminal event after it that the awaited
   * condition did not need fails the wait at once (a missed frame must not hang the test).
   */
  after: number;
  until(pred: (m: SseMessage[]) => boolean, label: string): Promise<void>;
  close(): void;
}

async function openSse(convId: string): Promise<Sse> {
  const ac = new AbortController();
  const url = `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${convId}/stream`;
  const res = await fetch(url, { headers: { cookie: ownerCookie() }, signal: ac.signal });
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

interface ToolDelta {
  runId: string;
  step: number;
  delta: "tool_start" | "tool_input" | "tool_base";
  callId: string;
  name?: string;
  text?: string;
  offset?: number;
  sha256?: string;
}
interface DraftTool {
  id: string;
  name: string;
  input: string;
  inputTruncated?: boolean;
  base?: { text: string; sha256: string };
}
interface DraftFrame {
  runId: string;
  step: number;
  tools: DraftTool[];
}

const toolDeltas = (msgs: SseMessage[]): ToolDelta[] =>
  msgs
    .filter((m) => m.event === "delta")
    .map((m) => JSON.parse(m.data as string) as ToolDelta)
    .filter((d) => d.delta === "tool_start" || d.delta === "tool_input" || d.delta === "tool_base");
const draftFrames = (msgs: SseMessage[]): DraftFrame[] =>
  msgs.filter((m) => m.event === "draft").map((m) => JSON.parse(m.data as string) as DraftFrame);

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The host directory of the owner's device `/workspace` (the first call starts the device). */
async function workspaceDir(): Promise<string> {
  if (workspace !== undefined) return workspace;
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(
    owner,
    orgId,
    conv,
    `tool:Read:${JSON.stringify({ file_path: "/workspace/none.txt" })}`,
  );
  await waitForTerminal(db, conv, 1, 30_000);
  const dirs = await readdir(join(root, "filesystems"));
  expect(dirs).toHaveLength(1);
  workspace = join(root, "filesystems", dirs[0] as string, "workspace");
  return workspace;
}

async function onDevice(name: string, content: string): Promise<string> {
  await writeFile(join(await workspaceDir(), name), content);
  return `/workspace/${name}`;
}

/** A conversation that has read `path` (one run, finished). */
async function conversationThatRead(path: string): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, `tool:Read:${JSON.stringify({ file_path: path })}`);
  await waitForTerminal(db, conv, 1, 30_000);
  const result = ofType(await eventsOf(db, conv), "tool_result").at(-1);
  expect(result?.payload.isError).toBe(false);
  return conv;
}

const NEW_CONTENT = Array.from({ length: 12 }, (_, i) => `print("line ${i}")`).join("\n");
/** `file_path` first: the base read starts as soon as it closes, early in the stream. */
const writeInput = (path: string) => ({ file_path: path, content: NEW_CONTENT });
const streamedWrite = (input: unknown, ms = FRAGMENT_MS) =>
  `streamtool:${ms}:Write:${JSON.stringify(input)}`;

/** The write_base kernel read rows of a conversation's runs (a run row with no tool call). */
const kernelReadRows = (conv: string) =>
  db
    .selectFrom("sandbox_operation_intents")
    .select(["operation_id", "method", "state", "run_id", "call_id", "created_at", "updated_at"])
    .where("conversation_id", "=", conv)
    .where("call_id", "is", null)
    .where("run_id", "is not", null)
    .orderBy("created_at")
    .execute();
const toolRows = (conv: string) =>
  db
    .selectFrom("sandbox_operation_intents")
    .select(["operation_id", "method", "state", "call_id", "created_at"])
    .where("conversation_id", "=", conv)
    .where("call_id", "is not", null)
    .orderBy("created_at")
    .execute();

const finishedAfter = (after: number) => (m: SseMessage[]) =>
  m.some(
    (x) =>
      x.event === "event" &&
      (() => {
        const e = JSON.parse(x.data as string) as { seq: number; type: string };
        return e.seq > after && e.type === "run_finished";
      })(),
  );
const baseSeen = (m: SseMessage[]) => toolDeltas(m).some((d) => d.delta === "tool_base");
/** Every fragment of the call's input has been published (the stream is then at its last event). */
const inputComplete = (input: unknown) => (m: SseMessage[]) => {
  const last = toolDeltas(m)
    .filter((d) => d.delta === "tool_input")
    .at(-1);
  return (
    last !== undefined &&
    (last.offset as number) + (last.text as string).length === JSON.stringify(input).length
  );
};

/**
 * Posts a streamed Write on `conv` with a subscriber open and the provider stream held (see
 * {@link Hold}); `whileHeld` observes the held stream, then the hold is released and the run is
 * waited for. Returns the subscriber and the log.
 */
async function runStreamed(
  conv: string,
  input: unknown,
  opts: { at?: number; whileHeld?: (sse: Sse) => Promise<void> } = {},
) {
  const h = armHold(opts.at);
  const sse = await openSse(conv);
  try {
    sse.after = await postMessage(owner, orgId, conv, streamedWrite(input));
    await opts.whileHeld?.(sse);
  } finally {
    h.release();
  }
  await sse.until(finishedAfter(sse.after), "run_finished");
  return { sse, events: await eventsOf(db, conv) };
}
/** Held after `HELD_AT` fragments: past the closed path, long before the input ends. */
const HELD_AT = 14;
const heldForBase = { at: HELD_AT, whileHeld: (s: Sse) => s.until(baseSeen, "the tool_base") };
const heldAtEnd = (input: unknown) => ({
  whileHeld: (s: Sse) => s.until(inputComplete(input), "the whole input"),
});

// ---- cases ----

describe("a streaming Write", () => {
  it("publishes start, input and a base; the log and the result equal a non-streamed run's", async () => {
    const path = await onDevice("a.py", "print('old')\n");
    const conv = await conversationThatRead(path);
    const input = writeInput(path);
    const { sse, events } = await runStreamed(conv, input, heldForBase);
    sse.close();

    const deltas = toolDeltas(sse.messages);
    const starts = deltas.filter((d) => d.delta === "tool_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.name).toBe("Write");
    const callId = starts[0]?.callId as string;
    const inputs = deltas.filter((d) => d.delta === "tool_input" && d.callId === callId);
    expect(inputs.length).toBeGreaterThan(2);
    // contiguous offsets whose join is the logged input
    let joined = "";
    for (const d of inputs) {
      expect(d.offset).toBe(joined.length);
      joined += d.text;
    }
    const call = ofType(events, "assistant_message")
      .flatMap((e) => e.payload.content)
      .find((b) => b.type === "tool_call" && b.name === "Write");
    // the streamed call id is the logged call's
    expect(call?.type === "tool_call" && call.id).toBe(callId);
    expect(JSON.parse(joined)).toEqual(input);
    expect(call?.type === "tool_call" && call.input).toEqual(input);
    // exactly one base: the content the conversation read
    const bases = deltas.filter((d) => d.delta === "tool_base");
    expect(bases).toHaveLength(1);
    expect(bases[0]).toMatchObject({
      callId,
      text: "print('old')\n",
      sha256: sha("print('old')\n"),
    });
    // it came while the model was still streaming (the hold), after the call started
    expect(deltas[0]?.delta).toBe("tool_start");
    expect(deltas.indexOf(bases[0] as ToolDelta)).toBeLessThan(deltas.length - 1);
    expect(await readFile(join(await workspaceDir(), "a.py"), "utf8")).toBe(NEW_CONTENT);

    // the same call without streaming: the same assistant message and result
    await onDevice("a.py", "print('old')\n");
    const plain = await conversationThatRead(path);
    await postMessage(owner, orgId, plain, `tool:Write:${JSON.stringify(input)}`);
    await waitForTerminal(db, plain, 2, 30_000);
    const plainEvents = await eventsOf(db, plain);
    const norm = (evs: ConversationEvent[]) => {
      const a = ofType(evs, "assistant_message")
        .at(-1)
        ?.payload.content.map((b) =>
          b.type === "tool_call" ? { name: b.name, input: b.input } : b,
        );
      const r = ofType(evs, "tool_result").at(-1);
      return { a, r: { content: r?.payload.content, isError: r?.payload.isError } };
    };
    expect(norm(events)).toEqual(norm(plainEvents));
    expect(norm(events).r.isError).toBe(false);
  });

  it("is zero drift: reconstruct equals the requests the provider received", async () => {
    const path = await onDevice("drift.py", "x = 1\n");
    capture.reset();
    const conv = await conversationThatRead(path);
    const { sse } = await runStreamed(conv, writeInput(path), heldForBase);
    sse.close();
    const runId = (await runsOf(db, conv)).at(-1)?.id as string;
    const snap = await takeSnapshot(db, orgId, conv, runId, 4_194_304);
    const calls = ofType(toEvents(snap) as ConversationEvent[], "model_call");
    const sent: ModelRequest[] = capture.sent;
    expect(calls).toHaveLength(sent.length);
    expect(sent.length).toBeGreaterThan(0);
    const registry = k.app.get(ProviderRegistry);
    for (const [i, c] of calls.entries()) {
      const info = (
        await registry.resolve(orgId, { provider: c.payload.provider, model: c.payload.model })
      ).info;
      const out = reconstructRequest(snap, c.seq, { model: info });
      expect(out.drift).toEqual([]);
      expect(out.request).toEqual(sent[i]);
    }
    // the streamed input never reached the log as its own event
    const types = (await eventsOf(db, conv)).map((e) => String(e.type));
    expect(types.some((t) => t.startsWith("tool_input") || t === "tool_base")).toBe(false);
  });

  it("gives no base for an unread file or a new file; the Write runs as before", async () => {
    const existing = await onDevice("unread.py", "keep me\n");
    // positive control, same app: a conversation that read a file gets its base while held
    const readPath = await onDevice("control.py", "control\n");
    const control = await conversationThatRead(readPath);
    const withBase = await runStreamed(control, writeInput(readPath), heldForBase);
    withBase.sse.close();
    expect(toolDeltas(withBase.sse.messages).filter((d) => d.delta === "tool_base")).toHaveLength(
      1,
    );
    expect((await kernelReadRows(control)).length).toBeGreaterThan(0);

    // an existing file the conversation never read: the held stream completes, no read was made
    const conv = await createConv(owner, orgId, agentId);
    const first = await runStreamed(conv, writeInput(existing), heldAtEnd(writeInput(existing)));
    first.sse.close();
    expect(await kernelReadRows(conv)).toEqual([]);
    expect(toolDeltas(first.sse.messages).some((d) => d.delta === "tool_base")).toBe(false);
    expect(toolDeltas(first.sse.messages).some((d) => d.delta === "tool_start")).toBe(true);
    const refused = ofType(first.events, "tool_result").at(-1);
    expect(refused?.payload.isError).toBe(true);
    expect(await readFile(join(await workspaceDir(), "unread.py"), "utf8")).toBe("keep me\n");

    // a new file: nothing was read, nothing is there
    const fresh = await createConv(owner, orgId, agentId);
    const fresh_in = writeInput("/workspace/brand-new.py");
    const second = await runStreamed(fresh, fresh_in, heldAtEnd(fresh_in));
    second.sse.close();
    expect(await kernelReadRows(fresh)).toEqual([]);
    expect(toolDeltas(second.sse.messages).some((d) => d.delta === "tool_base")).toBe(false);
    expect(ofType(second.events, "tool_result").at(-1)?.payload, "new file result").toMatchObject({
      isError: false,
    });
    expect(await readFile(join(await workspaceDir(), "brand-new.py"), "utf8")).toBe(NEW_CONTENT);
  });

  it("restores tools for a subscriber that joins mid-call, then sends later deltas only", async () => {
    const path = await onDevice("mid.py", "mid = 0\n");
    const conv = await conversationThatRead(path);
    const input = writeInput(path);
    const finalJson = JSON.stringify(input);
    let second: Sse | undefined;
    let t: DraftTool | undefined;
    // held past the base: the second subscriber joins while the call is still streaming
    const { sse: first } = await runStreamed(conv, input, {
      at: HELD_AT,
      whileHeld: async (s) => {
        await s.until(baseSeen, "the tool_base");
        const runId = toolDeltas(s.messages)[0]?.runId as string;
        // the draft route has the call while it still streams; its writes are coalesced (a window
        // of 200 ms), so wait until it holds the base the stream already published
        const draftUrl = `/api/v1/orgs/${orgId}/conversations/${conv}/runs/${runId}/draft`;
        const routeDraft = await waitFor(
          async () => {
            const route = await owner({ method: "GET", url: draftUrl });
            expect(route.statusCode).toBe(200);
            const d = (route.json() as { drafts: DraftFrame[] }).drafts[0];
            return d?.tools[0]?.base !== undefined ? d : null;
          },
          10_000,
          "the draft route to hold the base",
        );
        expect(routeDraft.tools.length).toBeGreaterThan(0);
        expect(routeDraft.tools[0]?.name).toBe("Write");
        expect(finalJson.startsWith(routeDraft.tools[0]?.input as string)).toBe(true);

        second = await openSse(conv);
        second.after = s.after;
        await second.until((m) => draftFrames(m).length > 0, "the draft frame");
        t = (draftFrames(second.messages)[0] as DraftFrame).tools[0];
      },
    });
    first.close();
    const joined = second as Sse;
    await joined.until(finishedAfter(joined.after), "run_finished");
    joined.close();
    const draftTool = t as DraftTool;
    expect(draftTool.name).toBe("Write");
    expect(draftTool.input.length).toBeGreaterThan(0);
    expect(draftTool.input.length).toBeLessThan(finalJson.length);
    expect(finalJson.startsWith(draftTool.input)).toBe(true);
    expect(draftTool.base?.text).toBe("mid = 0\n");
    expect(draftTool.base?.sha256).toBe(sha("mid = 0\n"));
    // later deltas only: no second start or base; each continues the draft and the last one ends
    // the input (a delta published inside a coalescing window may sit past the draft: a client
    // asks the draft route again, so only the text is checked here)
    const later = toolDeltas(joined.messages);
    expect(later.some((d) => d.delta === "tool_start" || d.delta === "tool_base")).toBe(false);
    expect(later.length).toBeGreaterThan(0);
    for (const d of later) {
      const offset = d.offset as number;
      expect(d.text).toBe(finalJson.slice(offset, offset + (d.text as string).length));
    }
    const last = later.at(-1) as ToolDelta;
    expect((last.offset as number) + (last.text as string).length).toBe(finalJson.length);
  });

  it("settles every base read before the step ends: all read intents are terminal, the Write's own comes after", async () => {
    const path = await onDevice("order.py", "order = 1\n");
    const conv = await conversationThatRead(path);
    const { sse, events } = await runStreamed(conv, writeInput(path), heldForBase);
    sse.close();
    const runId = ofType(events, "assistant_message").at(-1)?.runId as string;
    const reads = (await kernelReadRows(conv)).filter((r) => r.run_id === runId);
    // no read outlives its step: every base read exists and is terminal once the run finished
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.state).toBe("completed");
    // the Write's own operation (the tool's intent) was created after the last read ended
    const writes = (await toolRows(conv)).filter((r) => r.method === "writeFile");
    expect(writes).toHaveLength(1);
    const lastReadEnd = Math.max(...reads.map((r) => r.updated_at.getTime()));
    expect((writes[0] as { created_at: Date }).created_at.getTime()).toBeGreaterThanOrEqual(
      lastReadEnd,
    );
  });
});

// The step-level behaviors that need a stream end or a failure at a chosen moment (the read is
// awaited by its step with its signal aborted, a reset cancels it, an eval conversation never gets
// a reader, a sub-agent does) are covered in model-call.test.ts ("streaming Write base reads"):
// a conversation of kind eval has no route to send a message to, and model-fake can neither fail a
// tool call mid-stream nor script a sub-agent's second turn.
