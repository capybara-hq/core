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

beforeAll(async () => {
  capture.install();
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
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
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
  return {
    messages,
    until(pred, label) {
      // bounded by the test run itself: the stream ends or the awaited frame arrives
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (pred(messages)) {
            waiters.delete(check);
            resolve();
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

/** Posts a streamed Write on `conv` with a subscriber open; returns it once the run ended. */
async function runStreamed(conv: string, input: unknown, terminals: number) {
  const sse = await openSse(conv);
  await postMessage(owner, orgId, conv, streamedWrite(input));
  await waitForTerminal(db, conv, terminals, 30_000);
  const events = await eventsOf(db, conv);
  const fin = events.filter((e) => e.type === "run_finished").length;
  await sse.until(
    (m) =>
      m.filter((x) => x.event === "event" && JSON.parse(x.data as string).type === "run_finished")
        .length >= fin,
    "run_finished",
  );
  return { sse, events };
}

// ---- cases ----

describe("a streaming Write", () => {
  it("publishes start, input and a base; the log and the result equal a non-streamed run's", async () => {
    const path = await onDevice("a.py", "print('old')\n");
    const conv = await conversationThatRead(path);
    const input = writeInput(path);
    const { sse, events } = await runStreamed(conv, input, 2);
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
    expect(bases, JSON.stringify(await kernelReadRows(conv))).toHaveLength(1);
    expect(bases[0]).toMatchObject({
      callId,
      text: "print('old')\n",
      sha256: sha("print('old')\n"),
    });
    // order: start, then the input, the base somewhere before the run's end
    expect(deltas[0]?.delta).toBe("tool_start");
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
    const { sse } = await runStreamed(conv, writeInput(path), 2);
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
    const types = new Set((await eventsOf(db, conv)).map((e) => e.type));
    expect(
      [...types].some((t) => String(t).startsWith("tool_input") || String(t) === "tool_base"),
    ).toBe(false);
  });

  it("gives no base for an unread file or a new file; the Write runs as before", async () => {
    const existing = await onDevice("unread.py", "keep me\n");
    const conv = await createConv(owner, orgId, agentId);
    const first = await runStreamed(conv, writeInput(existing), 1);
    first.sse.close();
    expect(toolDeltas(first.sse.messages).some((d) => d.delta === "tool_base")).toBe(false);
    expect(toolDeltas(first.sse.messages).some((d) => d.delta === "tool_start")).toBe(true);
    const refused = ofType(first.events, "tool_result").at(-1);
    expect(refused?.payload.isError).toBe(true);
    expect(await readFile(join(await workspaceDir(), "unread.py"), "utf8")).toBe("keep me\n");
    expect(await kernelReadRows(conv)).toEqual([]);

    // a new file: nothing was read, nothing is there
    const fresh = await createConv(owner, orgId, agentId);
    const second = await runStreamed(fresh, writeInput("/workspace/brand-new.py"), 1);
    second.sse.close();
    expect(toolDeltas(second.sse.messages).some((d) => d.delta === "tool_base")).toBe(false);
    expect(ofType(second.events, "tool_result").at(-1)?.payload, "new file result").toMatchObject({
      isError: false,
    });
    expect(await readFile(join(await workspaceDir(), "brand-new.py"), "utf8")).toBe(NEW_CONTENT);
    expect(await kernelReadRows(fresh)).toEqual([]);
  });

  it("restores tools for a subscriber that joins mid-call, then sends later deltas only", async () => {
    const path = await onDevice("mid.py", "mid = 0\n");
    const conv = await conversationThatRead(path);
    const input = writeInput(path);
    const finalJson = JSON.stringify(input);
    const first = await openSse(conv);
    await postMessage(owner, orgId, conv, streamedWrite(input, 60));
    // past the base and into the content
    await first.until((m) => {
      const d = toolDeltas(m);
      return (
        d.some((x) => x.delta === "tool_base") &&
        d.filter((x) => x.delta === "tool_input").length > 12
      );
    }, "the base and some input");
    const runId = toolDeltas(first.messages)[0]?.runId as string;

    // the draft route has the call while it still streams; its writes are coalesced (a window of
    // 200 ms), so wait until it holds the base the stream already published
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

    const second = await openSse(conv);
    await second.until((m) => draftFrames(m).length > 0, "the draft frame");
    const draft = draftFrames(second.messages)[0] as DraftFrame;
    const t = draft.tools[0] as DraftTool;
    expect(t.name).toBe("Write");
    expect(t.input.length).toBeGreaterThan(0);
    expect(finalJson.startsWith(t.input)).toBe(true);
    expect(t.base?.text).toBe("mid = 0\n");
    expect(t.base?.sha256).toBe(sha("mid = 0\n"));

    await waitForTerminal(db, conv, 2, 30_000);
    await second.until(
      (m) =>
        m.some((x) => x.event === "event" && JSON.parse(x.data as string).type === "run_finished"),
      "run_finished",
    );
    first.close();
    second.close();
    // later deltas only: no second start or base; each continues the draft and the last one ends
    // the input (a delta published inside a coalescing window may sit past the draft: a client
    // asks the draft route again, so only the text is checked here)
    const later = toolDeltas(second.messages);
    expect(later.some((d) => d.delta === "tool_start" || d.delta === "tool_base")).toBe(false);
    expect(later.length).toBeGreaterThan(0);
    for (const d of later) {
      const offset = d.offset as number;
      expect(d.text).toBe(finalJson.slice(offset, offset + (d.text as string).length));
    }
    const last = later.at(-1) as ToolDelta;
    expect((last.offset as number) + (last.text as string).length).toBe(finalJson.length);
  });

  it("is awaited by its step: the base read settled before the Write's own operation began", async () => {
    const path = await onDevice("order.py", "order = 1\n");
    const conv = await conversationThatRead(path);
    const { sse, events } = await runStreamed(conv, writeInput(path), 2);
    sse.close();
    expect(toolDeltas(sse.messages).filter((d) => d.delta === "tool_base")).toHaveLength(1);
    const runId = ofType(events, "assistant_message").at(-1)?.runId as string;
    const reads = (await kernelReadRows(conv)).filter((r) => r.run_id === runId);
    // no read outlives its step: every base read row exists and is terminal once the run finished
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.state).toBe("completed");
    // ... and the Write's own operation (the tool's intent) was created after the last read ended
    const writes = (await toolRows(conv)).filter((r) => r.method === "writeFile");
    expect(writes).toHaveLength(1);
    const lastReadEnd = Math.max(...reads.map((r) => r.updated_at.getTime()));
    expect((writes[0] as { created_at: Date }).created_at.getTime()).toBeGreaterThanOrEqual(
      lastReadEnd,
    );
    // the base read also finished before the step's assistant_message was logged
    const logged = ofType(events, "assistant_message").at(-1);
    expect(logged).toBeDefined();
    const loggedAt = (logged as { createdAt?: Date | string }).createdAt;
    if (loggedAt !== undefined)
      expect(new Date(loggedAt).getTime()).toBeGreaterThanOrEqual(lastReadEnd);
  });
});

describe("what could not be covered", () => {
  // step_reset: model-fake cannot fail a tool call mid-stream (`failAfter` exists for text only), so
  // a reset during a streamed Write is covered by the unit tests of the watcher
  // (write-base.test.ts: abort cancels the read) and not end to end. A sub-agent's Read followed by a
  // Write needs a two-turn child script, which model-fake's one-directive-per-message cannot give.
  // An eval-kind conversation is hidden from every conversation route (messages, stream, draft: 404)
  // and has no way to be given a message but a replay run, so no streamed Write can be driven
  // through it here; the gate (`chat` / `subagent` only, model-call `baseWatcher`) is not covered.
  it.todo("an eval-kind run never calls the reader");
  it.todo("step_reset during a streamed Write cancels its base read");
  it.todo("a sub-agent Write after the sub-agent Read gets a base");
});
