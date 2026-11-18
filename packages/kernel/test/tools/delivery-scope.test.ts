import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { StorageService } from "../../src/storage/storage.service.js";
import {
  type ArtifactStoreDeps,
  REPEAT_TEXT,
  storeArtifacts,
} from "../../src/tools/builtins/artifacts.js";
import type { DeliveryScope } from "../../src/tools/builtins/delivery-scope.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Truthful delivery spec §2: identical bytes reach the user once per delivery scope (the current
 * run after the person last spoke). A real kernel: model-fake scripts the calls (`tools:[…]` runs
 * the calls of one step in order), `sandbox-fake` is the device, `mem-store` the object store.
 * The scope reads and the parallel race also call `storeArtifacts` directly against the real
 * event log and store.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  root = await mkdtemp(join(tmpdir(), "cap-delivery-scope-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fixture("mem-store"), fixture("sandbox-fake")],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Deliverer",
        instructions: "Deliver files.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(
          ["Write", "Read", "Deliver", "AskUserQuestion"].map((name) => ({
            kind: "builtin" as const,
            name,
          })),
        ),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The conversation's objects in the kernel store (`artifacts/<conversationId>/…`). */
async function objectsOf(conv: string): Promise<string[]> {
  const r = await k.app.get(StorageService).kernel(orgId).list(`artifacts/${conv}/`);
  return r.items.map((o) => o.key);
}

const write = (file_path: string, content: string) => ({
  name: "Write",
  input: { file_path, content },
});
const deliver = (file_path: string) => ({ name: "Deliver", input: { file_path } });
const ask = {
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Go on?",
        header: "Go on",
        multiSelect: false,
        options: [
          { label: "Yes", description: "Yes option" },
          { label: "No", description: "No option" },
        ],
      },
    ],
  },
};

/** Runs one step with `calls` (in order) and waits for the conversation's `n`th terminal event. */
async function step(conv: string, calls: unknown[], n: number): Promise<void> {
  await postMessage(owner, orgId, conv, `tools:${JSON.stringify(calls)}`);
  await waitForTerminal(db, conv, n, 30_000);
}

/** A fresh directory on the device: every conversation here shares the owner's device. */
const dir = () => `/workspace/t${randomUUID().slice(0, 8)}`;

/** The `Deliver` results of the conversation, in log order. */
async function deliverResults(conv: string) {
  return ofType(await eventsOf(db, conv), "tool_result")
    .filter((e) => e.payload.toolKey === "Deliver")
    .map((e) => e.payload);
}

/** A conversation whose device holds `files` (written in a first run, terminal 1). */
async function withFiles(files: Record<string, string>): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  await step(
    conv,
    Object.entries(files).map(([p, c]) => write(p, c)),
    1,
  );
  const writes = ofType(await eventsOf(db, conv), "tool_result");
  for (const w of writes) expect(w.payload.isError, w.payload.content).toBe(false);
  return conv;
}

/** Waits until the conversation's run asks its `n`th question and waits; returns the question. */
async function asked(conv: string, n: number): Promise<string> {
  const qs = await waitFor(
    async () => {
      const q = ofType(await eventsOf(db, conv), "question_asked");
      return q.length >= n ? q : null;
    },
    30_000,
    "question asked",
  );
  const last = qs.at(-1) as Ev<"question_asked">;
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", last.runId as string)
          .executeTakeFirst()
      )?.status === "waiting",
    30_000,
    "run waiting",
  );
  return last.payload.questionId;
}

describe("Deliver within a delivery scope", () => {
  it("a second Deliver of the same bytes in a run is a repeat", async () => {
    const d = dir();
    const conv = await withFiles({ [`${d}/a.txt`]: "same", [`${d}/b.txt`]: "same" });
    await step(conv, [deliver(`${d}/a.txt`), deliver(`${d}/b.txt`)], 2);
    const artifacts = ofType(await eventsOf(db, conv), "artifact_created");
    expect(artifacts).toHaveLength(1);
    const first = artifacts[0] as Ev<"artifact_created">;
    expect(first.payload).toMatchObject({ name: "a.txt", sha256: sha("same") });
    const [r1, r2] = await deliverResults(conv);
    expect(r1?.content).toMatch(/^Delivered a\.txt /);
    expect(r2?.isError).toBe(false);
    expect(r2?.content).toBe(
      REPEAT_TEXT("b.txt", { name: "a.txt", artifactId: first.payload.artifactId }),
    );
    expect(r2?.display?.summary).toEqual({
      zh: "已交付过（内容相同）b.txt",
      en: "Already delivered (same content): b.txt",
    });
    expect(await objectsOf(conv)).toEqual([first.payload.objectKey]);
  });

  it("a new run delivers again", async () => {
    const d = dir();
    const conv = await withFiles({ [`${d}/a.txt`]: "again" });
    await step(conv, [deliver(`${d}/a.txt`)], 2);
    await step(conv, [deliver(`${d}/a.txt`)], 3);
    expect(ofType(await eventsOf(db, conv), "artifact_created")).toHaveLength(2);
    expect(await objectsOf(conv)).toHaveLength(2);
  });

  it("a mid-run user message starts a new scope", async () => {
    const d = dir();
    const conv = await withFiles({ [`${d}/a.txt`]: "mid-run" });
    await postMessage(
      owner,
      orgId,
      conv,
      `tools:${JSON.stringify([deliver(`${d}/a.txt`), ask, deliver(`${d}/a.txt`)])}`,
    );
    await asked(conv, 1);
    // the starter's message skips the question; the run resumes with the next call
    await postMessage(owner, orgId, conv, "echo:send it again");
    await waitForTerminal(db, conv, 2, 30_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "question_answered").map((e) => e.payload.outcome)).toEqual(["skipped"]);
    expect(ofType(events, "artifact_created")).toHaveLength(2);
  });

  it("an answered AskUserQuestion starts a new scope", async () => {
    const d = dir();
    const conv = await withFiles({ [`${d}/a.txt`]: "answered" });
    await postMessage(
      owner,
      orgId,
      conv,
      `tools:${JSON.stringify([deliver(`${d}/a.txt`), ask, deliver(`${d}/a.txt`)])}`,
    );
    const qid = await asked(conv, 1);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/questions/${qid}/answer`,
      payload: { answer: { q0: "Yes" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, conv, 2, 30_000);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "question_answered").map((e) => e.payload.outcome)).toEqual(["answered"]);
    expect(ofType(events, "user_message")).toHaveLength(2);
    expect(ofType(events, "artifact_created")).toHaveLength(2);
  });

  it("v1, v2, v1 of one path delivers three times", async () => {
    const d = dir();
    const conv = await withFiles({ [`${d}/f.txt`]: "v1" });
    await step(
      conv,
      [
        deliver(`${d}/f.txt`),
        write(`${d}/f.txt`, "v2"),
        deliver(`${d}/f.txt`),
        write(`${d}/f.txt`, "v1"),
        deliver(`${d}/f.txt`),
        // v1 again with no later version: a repeat
        deliver(`${d}/f.txt`),
      ],
      2,
    );
    const results = ofType(await eventsOf(db, conv), "tool_result").slice(1);
    for (const r of results) expect(r.payload.isError, r.payload.content).toBe(false);
    const artifacts = ofType(await eventsOf(db, conv), "artifact_created");
    expect(artifacts.map((a) => a.payload.sha256)).toEqual([sha("v1"), sha("v2"), sha("v1")]);
    const last = (await deliverResults(conv)).at(-1);
    expect(last?.content).toBe(
      REPEAT_TEXT("f.txt", {
        name: "f.txt",
        artifactId: (artifacts[2] as Ev<"artifact_created">).payload.artifactId,
      }),
    );
  });

  // the calls of one step run in order; the real race is the direct case below
  it("identical Deliver calls in one step store one artifact", async () => {
    const d = dir();
    const conv = await withFiles({ [`${d}/p.txt`]: "parallel" });
    await step(conv, [deliver(`${d}/p.txt`), deliver(`${d}/p.txt`)], 2);
    const artifacts = ofType(await eventsOf(db, conv), "artifact_created");
    expect(artifacts).toHaveLength(1);
    const id = (artifacts[0] as Ev<"artifact_created">).payload.artifactId;
    const results = await deliverResults(conv);
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.content).toContain(id);
    expect(await objectsOf(conv)).toHaveLength(1);
  });
});

describe("storeArtifacts against the real log", () => {
  const log = () => k.app.get(EventLog);
  const deps = (over: Partial<ArtifactStoreDeps["eventLog"]> = {}): ArtifactStoreDeps => ({
    storage: k.app.get(StorageService),
    eventLog: Object.assign(Object.create(log()), over) as ArtifactStoreDeps["eventLog"],
  });
  const ctx = (conversationId: string, runId?: string): BuiltinCallContext => ({
    orgId,
    accountId: ownerId,
    agentId,
    conversationId,
    callId: `call-${randomUUID().slice(0, 8)}`,
    signal: new AbortController().signal,
    ...(runId !== undefined && { runId }),
  });
  const file = (text: string, sourcePath = "/workspace/x.txt") => ({
    name: "x.txt",
    contentType: "text/plain",
    data: new TextEncoder().encode(text),
    sourcePath,
  });
  /** Appends a `run_started` for a new run id and returns it. */
  async function startRun(conv: string): Promise<string> {
    const runId = randomUUID();
    await log().append(conv, [
      {
        type: "run_started",
        runId,
        idemKey: `run_started:${runId}`,
        payload: {
          agentVersion: 1,
          model: { provider: "model-fake", model: "fake-1" },
          triggerAccountId: ownerId,
        },
      },
    ]);
    return runId;
  }
  const userMessage = (text: string) => ({
    type: "user_message" as const,
    payload: { content: [{ type: "text", text }], authorAccountId: ownerId },
  });
  const answered = (outcome: "answered" | "skipped" | "expired" | "cancelled") => ({
    type: "question_answered" as const,
    payload: {
      questionId: randomUUID(),
      callId: "c",
      answer: null,
      byAccountId: null,
      outcome,
    },
  });

  it("the scope starts at the run's start or the person's latest message or answer", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const earlier = await startRun(conv);
    await storeArtifacts(deps(), ctx(conv, earlier), [file("old")]);
    const runId = await startRun(conv);
    const [start] = ofType(await eventsOf(db, conv), "run_started").filter(
      (e) => e.runId === runId,
    );
    const s = (start as Ev<"run_started">).seq;
    // the earlier run's artifact is outside the scope
    expect(await log().readDeliveryScope(conv, runId)).toEqual({ boundary: s, artifacts: [] });
    const [a] = await storeArtifacts(deps(), ctx(conv, runId), [file("one")]);
    const scope = await log().readDeliveryScope(conv, runId);
    expect(scope.boundary).toBe(s);
    expect(scope.artifacts).toEqual([
      {
        seq: s + 1,
        artifactId: a?.artifactId,
        name: "x.txt",
        sha256: sha("one"),
        sourcePath: "/workspace/x.txt",
      },
    ]);
    // an expired or cancelled question is not the person speaking
    await log().append(conv, [answered("expired"), answered("cancelled")]);
    expect((await log().readDeliveryScope(conv, runId)).boundary).toBe(s);
    const [msg] = await log().append(conv, [userMessage("again")]);
    expect(await log().readDeliveryScope(conv, runId)).toEqual({
      boundary: msg?.seq,
      artifacts: [],
    });
    const [skip] = await log().append(conv, [answered("skipped")]);
    expect((await log().readDeliveryScope(conv, runId)).boundary).toBe(skip?.seq);
    // a run without run_started reads from the log's start
    expect((await log().readDeliveryScope(conv, randomUUID())).boundary).toBe(skip?.seq);
  });

  it("a mid-run user message starts a new scope", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const runId = await startRun(conv);
    const [a] = await storeArtifacts(deps(), ctx(conv, runId), [file("m")]);
    const [b] = await storeArtifacts(deps(), ctx(conv, runId), [file("m")]);
    expect(b?.repeatOf).toEqual({ artifactId: a?.artifactId, name: "x.txt" });
    await log().append(conv, [userMessage("send it again")]);
    const [c] = await storeArtifacts(deps(), ctx(conv, runId), [file("m")]);
    expect(c?.repeatOf).toBeUndefined();
    expect(ofType(await eventsOf(db, conv), "artifact_created")).toHaveLength(2);
  });

  it("two equal files of one call: one artifact, the second a repeat of the first", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const runId = await startRun(conv);
    const out = await storeArtifacts(deps(), ctx(conv, runId), [
      file("twin", "generated/c/image-1.png"),
      { ...file("twin", "generated/c/image-2.png"), name: "y.txt" },
    ]);
    expect(out[1]).toEqual({
      artifactId: out[0]?.artifactId,
      name: "y.txt",
      size: 4,
      repeatOf: { artifactId: out[0]?.artifactId, name: "x.txt" },
    });
    expect(await objectsOf(conv)).toHaveLength(1);
  });

  it("parallel identical calls that both read an empty scope store one artifact", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const runId = await startRun(conv);
    // both calls read the scope before either appends: the race the idempotency key closes
    let release!: () => void;
    const bothRead = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    const racing = deps({
      readDeliveryScope: async (c: string, r: string): Promise<DeliveryScope> => {
        const scope = await log().readDeliveryScope(c, r);
        reads += 1;
        if (reads === 2) release();
        await bothRead;
        return scope;
      },
    });
    const [x, y] = await Promise.all([
      storeArtifacts(racing, ctx(conv, runId), [file("race", "/workspace/a.txt")]),
      storeArtifacts(racing, ctx(conv, runId), [file("race", "/workspace/b.txt")]),
    ]);
    const artifacts = ofType(await eventsOf(db, conv), "artifact_created");
    expect(artifacts).toHaveLength(1);
    const winner = (artifacts[0] as Ev<"artifact_created">).payload;
    const results = [x?.[0], y?.[0]];
    expect(results.map((r) => r?.artifactId)).toEqual([winner.artifactId, winner.artifactId]);
    expect(results.filter((r) => r?.repeatOf !== undefined)).toEqual([
      expect.objectContaining({
        repeatOf: { artifactId: winner.artifactId, name: winner.name },
      }),
    ]);
    // the loser's upload was removed
    expect(await objectsOf(conv)).toEqual([winner.objectKey]);
  });

  it("without a run nothing is deduped", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const [a] = await storeArtifacts(deps(), ctx(conv), [file("norun")]);
    const [b] = await storeArtifacts(deps(), ctx(conv), [file("norun")]);
    expect(a?.repeatOf).toBeUndefined();
    expect(b?.repeatOf).toBeUndefined();
    const artifacts = ofType(await eventsOf(db, conv), "artifact_created");
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every((e) => e.payload.sha256 === sha("norun"))).toBe(true);
    expect(await objectsOf(conv)).toHaveLength(2);
  });
});
