import { connect } from "node:net";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import { conversationTopic } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RunDrafts } from "../../src/runtime/run-drafts.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, type CookieJar, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor, sessionsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  sleep,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/** 解析出的一条 SSE 消息；`comment` 为 `:` 开头的注释行（心跳）。 */
interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** 用 fetch 读 SSE 流：逐块解析消息，`until` 等到满足条件的消息。 */
interface SseClient {
  status: number;
  headers: Headers;
  messages: SseMessage[];
  /** 流已结束（服务端关闭）。 */
  ended: Promise<void>;
  isEnded(): boolean;
  until(pred: (msgs: SseMessage[]) => boolean, timeoutMs?: number, label?: string): Promise<void>;
  close(): void;
}

async function openSse(url: string, headers: Record<string, string>): Promise<SseClient> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const messages: SseMessage[] = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  let ended = false;
  const endedP = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
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
            if (line.startsWith(":")) m.comment = line.slice(1).trim();
            else {
              const c = line.indexOf(":");
              const k = line.slice(0, c);
              const v = line.slice(c + 1).replace(/^ /, "");
              if (k === "id" || k === "event") m[k] = v;
              else if (k === "data") m.data = m.data === undefined ? v : `${m.data}\n${v}`;
            }
          }
          messages.push(m);
        }
        notify();
      }
    } catch {
      // 客户端主动中止
    } finally {
      ended = true;
      notify();
    }
  })();
  return {
    status: res.status,
    headers: res.headers,
    messages,
    ended: endedP,
    isEnded: () => ended,
    until(pred, timeoutMs = 10_000, label = "sse condition") {
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (pred(messages)) {
            cleanup();
            resolve();
          } else if (ended) {
            cleanup();
            reject(new Error(`stream ended before ${label}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    close: () => ac.abort(),
  };
}

const eventsIn = (msgs: SseMessage[]): ConversationEvent[] =>
  msgs.filter((m) => m.event === "event").map((m) => JSON.parse(m.data as string));
const deltasIn = (msgs: SseMessage[]) =>
  msgs
    .filter((m) => m.event === "delta")
    .map(
      (m) =>
        JSON.parse(m.data as string) as {
          runId: string;
          step: number;
          delta: string;
          text?: string;
        },
    );
const finishedCount = (msgs: SseMessage[]) =>
  eventsIn(msgs).filter((e) => e.type === "run_finished").length;
const textOf = (e: ConversationEvent | undefined) =>
  e?.type === "assistant_message"
    ? e.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    : "";

/** The `event: draft` frames of a stream. */
const draftsIn = (msgs: SseMessage[]) =>
  msgs
    .filter((m) => m.event === "draft")
    .map(
      (m) =>
        JSON.parse(m.data as string) as {
          runId: string;
          step: number;
          text: string;
          thinking: string;
        },
    );

/**
 * What a client that (re)connected shows for a step's text, followed live as `s` receives it: the
 * draft, then each text delta whose `offset` continues it (one already in the draft is dropped).
 * A delta past the draft is a gap (it was published before the stream subscribed, inside a
 * coalescing window): the client asks `refetch` (the draft route) again until the draft reaches it,
 * which the writer guarantees within a window. Returns at the run's `run_finished`; the step's
 * `assistant_message` replaces a draft the route no longer has (the step finalized meanwhile).
 */
async function resumeLive(
  s: SseClient,
  refetch: () => Promise<string | undefined>,
  runId: string,
  step: number,
): Promise<{ text: string; refetches: number }> {
  let text = "";
  let refetches = 0;
  let i = 0;
  for (;;) {
    while (i < s.messages.length) {
      const m = s.messages[i++] as SseMessage;
      if (m.event === "draft") {
        const d = JSON.parse(m.data as string) as { runId: string; step: number; text: string };
        if (d.runId === runId && d.step === step) text = d.text;
        continue;
      }
      if (m.event === "event") {
        const e = JSON.parse(m.data as string) as ConversationEvent;
        if (e.type === "run_finished") return { text, refetches };
        continue;
      }
      if (m.event !== "delta") continue;
      const d = JSON.parse(m.data as string) as {
        runId: string;
        step: number;
        delta: string;
        text?: string;
        offset?: number;
      };
      if (d.runId !== runId || d.step !== step || d.delta !== "text") continue;
      const t = d.text ?? "";
      const offset = d.offset ?? 0;
      if (offset > text.length) {
        const deadline = Date.now() + 2_000;
        for (;;) {
          refetches++;
          const fresh = await refetch();
          if (fresh !== undefined && fresh.length >= offset) {
            if (fresh.length > text.length) text = fresh;
            break;
          }
          const final = eventsIn(s.messages).find(
            (e) => e.type === "assistant_message" && e.runId === runId,
          );
          if (fresh === undefined && final) return { text: textOf(final), refetches };
          if (Date.now() > deadline) throw new Error(`gap: offset ${offset} beyond ${text.length}`);
          await sleep(25);
        }
      }
      if (offset + t.length <= text.length) continue;
      text = text.slice(0, offset) + t;
    }
    if (s.isEnded()) throw new Error("stream ended before run_finished");
    await sleep(10);
  }
}

/** The draft route's text for one step (undefined when it has none). */
const routeText = (req: Req, url: string, step: number) => async () => {
  const r = await req({ method: "GET", url });
  expect(r.statusCode).toBe(200);
  return (r.json() as { drafts: { step: number; text: string }[] }).drafts.find(
    (d) => d.step === step,
  )?.text;
};

/** A reply the fake model streams in 4-character chunks, one every `delayMs`. */
const SLOW_REPLY = "The quick brown fox jumps over the lazy dog, twice over.";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;

const urls = () => ({ pg: pgc.url, redis: rd.url });
const STREAM_RUNTIME: Partial<KernelConfig["runtime"]> = {
  sseHeartbeatMs: 100,
  sseRecheckMs: 200,
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function resetDb(): Promise<void> {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
  );
  await redis.flushdb();
}

/** 登录，返回请求函数与 SSE 用的 cookie 头。 */
async function login(
  k: TestKernel,
  name: string,
): Promise<{ req: Req; cookie: () => string; jar: CookieJar }> {
  const jar = cookieJar();
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: name, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return { req, cookie: () => jar.header() as string, jar };
}

async function account(name: string): Promise<string> {
  return (await accountsFor(db).createLocal({ login: name, password: PW, displayName: name })).id;
}

const streamUrl = (k: TestKernel, orgId: string, convId: string, query = "") =>
  `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${convId}/stream${query}`;
const draftUrl = (orgId: string, convId: string, runId: string) =>
  `/api/v1/orgs/${orgId}/conversations/${convId}/runs/${runId}/draft`;
const draftKeys = () => redis.keys("capk:run-draft*");

/** Waits for the run's first model call, then for `n` text deltas on `s`; returns the run id. */
async function streaming(s: SseClient, convId: string, n: number): Promise<string> {
  const call = await waitFor(
    async () =>
      (await eventsOf(db, convId)).find((e) => e.type === "model_call" && e.runId !== null),
    10_000,
    "model_call",
  );
  await s.until(
    (m) => deltasIn(m).filter((d) => d.delta === "text").length >= n,
    10_000,
    `${n} text deltas`,
  );
  return call.runId as string;
}

describe("会话 SSE（单副本 api+worker）", () => {
  let k: TestKernel;
  let owner: { req: Req; cookie: () => string };
  let orgId: string;
  let convId: string;

  beforeAll(async () => {
    k = await startKernel(runConfig(urls(), { roles: ["api", "worker"], runtime: STREAM_RUNTIME }));
  }, 60_000);
  afterAll(async () => {
    await k?.close();
  });
  beforeEach(async () => {
    await resetDb();
    await account("owner");
    owner = await login(k, "owner");
    orgId = await createOrg(owner.req);
    const agentId = await createAgent(owner.req, orgId);
    convId = await createConv(owner.req, orgId, agentId);
  });

  it("连接后发 echo → user_message、多个 delta、assistant_message、run_finished，delta 拼起来等于回复", async () => {
    const s = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
    try {
      expect(s.status).toBe(200);
      expect(s.headers.get("content-type")).toMatch(/^text\/event-stream/);
      expect(s.headers.get("cache-control")).toBe("no-cache");
      expect(s.headers.get("x-accel-buffering")).toBe("no");
      await postMessage(owner.req, orgId, convId, "echo:hello world");
      await s.until((m) => finishedCount(m) === 1, 15_000, "run_finished");

      const evs = eventsIn(s.messages);
      const types = evs.map((e) => e.type);
      expect(types[0]).toBe("user_message");
      const iUser = types.indexOf("user_message");
      const iAssistant = types.indexOf("assistant_message");
      const iFinished = types.indexOf("run_finished");
      expect(iUser).toBeLessThan(iAssistant);
      expect(iAssistant).toBeLessThan(iFinished);
      // 事件消息带 id = seq，seq 连续且与日志一致
      const ids = s.messages.filter((m) => m.event === "event").map((m) => Number(m.id));
      expect(ids).toEqual(evs.map((e) => e.seq));
      expect(evs.map((e) => e.seq)).toEqual((await eventsOf(db, convId)).map((e) => e.seq));

      const deltas = deltasIn(s.messages).filter((d) => d.delta === "text");
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.map((d) => d.text).join("")).toBe("hello world");
      expect(textOf(evs[iAssistant])).toBe("hello world");
      // delta 出现在 assistant_message 之前
      const firstDelta = s.messages.findIndex((m) => m.event === "delta");
      const assistantMsg = s.messages.findIndex(
        (m) => m.event === "event" && JSON.parse(m.data as string).type === "assistant_message",
      );
      expect(firstDelta).toBeLessThan(assistantMsg);
    } finally {
      s.close();
    }
  });

  it("a compaction progress bus message reaches the stream as `event: compaction`", async () => {
    const s = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
    try {
      await redis.publish(
        `cap:kernel:${conversationTopic(convId)}`,
        JSON.stringify({
          kind: "compaction_progress",
          runId: "run-x",
          conversationId: convId,
          agentId: "agent-x",
          phase: "summarizing",
          step: 1,
          chunk: 2,
          chunks: 3,
          chars: 40,
          startedAt: 1000,
        }),
      );
      await s.until((m) => m.some((x) => x.event === "compaction"), 10_000, "compaction frame");
      const frame = JSON.parse(
        s.messages.find((x) => x.event === "compaction")?.data as string,
      ) as Record<string, unknown>;
      expect(frame).toEqual({
        runId: "run-x",
        conversationId: convId,
        agentId: "agent-x",
        phase: "summarizing",
        step: 1,
        chunk: 2,
        chunks: 3,
        chars: 40,
        startedAt: 1000,
      });
    } finally {
      s.close();
    }
  });

  it("after=<seq> 只回放其后的事件；Last-Event-ID 优先于 after，重连不重复不遗漏", async () => {
    await postMessage(owner.req, orgId, convId, "echo:one");
    await waitForTerminal(db, convId, 1);
    const all = await eventsOf(db, convId);
    const mid = all[2]?.seq as number;

    const a = await openSse(streamUrl(k, orgId, convId, `?after=${mid}`), {
      cookie: owner.cookie(),
    });
    try {
      await a.until((m) => finishedCount(m) === 1, 10_000, "replay");
      expect(eventsIn(a.messages).map((e) => e.seq)).toEqual(
        all.filter((e) => e.seq > mid).map((e) => e.seq),
      );
    } finally {
      a.close();
    }

    // 断线：期间又有一轮运行
    const lastSeen = all.at(-1)?.seq as number;
    await postMessage(owner.req, orgId, convId, "echo:two");
    await waitForTerminal(db, convId, 2);
    const b = await openSse(streamUrl(k, orgId, convId, "?after=0"), {
      cookie: owner.cookie(),
      "last-event-id": String(lastSeen),
    });
    try {
      await b.until((m) => finishedCount(m) === 1, 10_000, "reconnect replay");
      const now = await eventsOf(db, convId);
      expect(eventsIn(b.messages).map((e) => e.seq)).toEqual(
        now.filter((e) => e.seq > lastSeen).map((e) => e.seq),
      );
      // 继续实时推送，且不重复
      await postMessage(owner.req, orgId, convId, "echo:three");
      await b.until((m) => finishedCount(m) === 2, 15_000, "live after replay");
      const seqs = eventsIn(b.messages).map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      const final = await eventsOf(db, convId);
      expect(seqs).toEqual(final.filter((e) => e.seq > lastSeen).map((e) => e.seq));
    } finally {
      b.close();
    }
  });

  it("每 sseHeartbeatMs 发一次 `: ping`", async () => {
    const s = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
    try {
      await s.until(
        (m) => m.filter((x) => x.comment === "ping").length >= 3,
        3_000,
        "3 heartbeats",
      );
    } finally {
      s.close();
    }
  });

  it("会话所有者被移出组织后，复核时关闭流", async () => {
    const bobId = await account("bob");
    await db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: bobId, role: "member" })
      .execute();
    const bob = await login(k, "bob");
    const agentId = await createAgent(owner.req, orgId);
    const bobConv = await createConv(bob.req, orgId, agentId);
    const s = await openSse(streamUrl(k, orgId, bobConv), { cookie: bob.cookie() });
    try {
      expect(s.status).toBe(200);
      await sleep(400);
      expect(s.isEnded()).toBe(false);
      await db
        .deleteFrom("memberships")
        .where("org_id", "=", orgId)
        .where("account_id", "=", bobId)
        .execute();
      await Promise.race([
        s.ended,
        sleep(3_000).then(() => {
          throw new Error("stream not closed after recheck");
        }),
      ]);
      expect(s.isEnded()).toBe(true);
    } finally {
      s.close();
    }
  });

  it("未登录 → 401；别人的会话 → 404；非法 Last-Event-ID → 400", async () => {
    const anon = await fetch(streamUrl(k, orgId, convId));
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("auth.required");

    const bobId = await account("bob");
    await db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: bobId, role: "member" })
      .execute();
    const bob = await login(k, "bob");
    const other = await fetch(streamUrl(k, orgId, convId), { headers: { cookie: bob.cookie() } });
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
      "conversation.not_found",
    );

    const bad = await fetch(streamUrl(k, orgId, convId), {
      headers: { cookie: owner.cookie(), "last-event-id": "abc" },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );
  });
});

describe("会话 SSE：live drafts (spec 2026-11-07 §3.2)", () => {
  let k: TestKernel;
  let owner: { req: Req; cookie: () => string };
  let orgId: string;
  let convId: string;

  beforeAll(async () => {
    k = await startKernel(runConfig(urls(), { roles: ["api", "worker"], runtime: STREAM_RUNTIME }));
  }, 60_000);
  afterAll(async () => {
    await k?.close();
  });
  beforeEach(async () => {
    await resetDb();
    await account("owner");
    owner = await login(k, "owner");
    orgId = await createOrg(owner.req);
    const agentId = await createAgent(owner.req, orgId);
    convId = await createConv(owner.req, orgId, agentId);
  });

  it("a stream opened mid-reply gets the draft after its catch-up, then the deltas; a gap is closed by the route", async () => {
    const a = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
    let b: SseClient | undefined;
    try {
      await postMessage(owner.req, orgId, convId, `slow:120:${SLOW_REPLY}`);
      const runId = await streaming(a, convId, 3);
      b = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
      const resumed = resumeLive(
        b,
        routeText(owner.req, draftUrl(orgId, convId, runId), 1),
        runId,
        1,
      );
      await b.until((m) => draftsIn(m).length === 1, 5_000, "draft frame");
      await b.until((m) => finishedCount(m) === 1, 15_000, "run_finished");

      const [draft] = draftsIn(b.messages);
      expect(draft).toMatchObject({ runId, step: 1, thinking: "" });
      expect(draft?.text.length).toBeGreaterThan(0);
      expect(SLOW_REPLY.startsWith(draft?.text ?? "x")).toBe(true);
      // the draft follows the catch-up (the run's model_call is logged) and precedes every delta
      const iDraft = b.messages.findIndex((m) => m.event === "draft");
      const iCall = b.messages.findIndex(
        (m) => m.event === "event" && JSON.parse(m.data as string).type === "model_call",
      );
      expect(iCall).toBeGreaterThanOrEqual(0);
      expect(iCall).toBeLessThan(iDraft);
      const iDelta = b.messages.findIndex((m) => m.event === "delta");
      if (iDelta >= 0) expect(iDraft).toBeLessThan(iDelta);
      expect((await resumed).text).toBe(SLOW_REPLY);
      expect(textOf(eventsIn(b.messages).find((e) => e.type === "assistant_message"))).toBe(
        SLOW_REPLY,
      );
      // the step's assistant_message is logged: its draft is gone
      await waitFor(
        async () => ((await draftKeys()).length === 0 ? true : undefined),
        5_000,
        "draft cleared",
      );

      // a stream opened after the run sends no draft
      const c = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
      try {
        await c.until((m) => finishedCount(m) === 1, 5_000, "catch-up");
        await sleep(300);
        expect(draftsIn(c.messages)).toEqual([]);
      } finally {
        c.close();
      }
    } finally {
      a.close();
      b?.close();
    }
  }, 30_000);

  it("text deltas carry offsets that add up to the reply", async () => {
    const s = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
    try {
      await postMessage(owner.req, orgId, convId, "echo:offsets add up");
      await s.until((m) => finishedCount(m) === 1, 15_000, "run_finished");
      const deltas = deltasIn(s.messages).filter((d) => d.delta === "text") as {
        text?: string;
        offset?: number;
      }[];
      let at = 0;
      for (const d of deltas) {
        expect(d.offset).toBe(at);
        at += d.text?.length ?? 0;
      }
      expect(at).toBe("offsets add up".length);
    } finally {
      s.close();
    }
  });

  it("GET …/runs/:runId/draft: the draft while the step streams, none after; 404 / 401 / 4xx", async () => {
    await postMessage(owner.req, orgId, convId, `slow:120:${SLOW_REPLY}`);
    const call = await waitFor(
      async () => (await eventsOf(db, convId)).find((e) => e.type === "model_call"),
      10_000,
      "model_call",
    );
    const runId = call.runId as string;
    const live = await waitFor(
      async () => {
        const r = await owner.req({ method: "GET", url: draftUrl(orgId, convId, runId) });
        expect(r.statusCode).toBe(200);
        const body = r.json() as { drafts: { step: number; text: string; thinking: string }[] };
        return body.drafts.length > 0 ? body : undefined;
      },
      5_000,
      "a draft",
    );
    expect(live.drafts).toHaveLength(1);
    expect(live.drafts[0]).toMatchObject({ step: 1, thinking: "" });
    expect(SLOW_REPLY.startsWith(live.drafts[0]?.text ?? "x")).toBe(true);
    expect(Object.keys(live.drafts[0] ?? {}).sort()).toEqual(["step", "text", "thinking"]);

    await waitForTerminal(db, convId);
    const after = await owner.req({ method: "GET", url: draftUrl(orgId, convId, runId) });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ drafts: [] });

    const unknown = await owner.req({ method: "GET", url: draftUrl(orgId, convId, "run-nope") });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe("run.not_found");

    // a run of another conversation of the same owner is unknown here
    const agentId = await createAgent(owner.req, orgId);
    const conv2 = await createConv(owner.req, orgId, agentId);
    const cross = await owner.req({ method: "GET", url: draftUrl(orgId, conv2, runId) });
    expect(cross.statusCode).toBe(404);
    expect((cross.json() as { error: { code: string } }).error.code).toBe("run.not_found");

    const anon = await k.http.inject({ method: "GET", url: draftUrl(orgId, convId, runId) });
    expect(anon.statusCode).toBe(401);

    const bobId = await account("bob");
    await db
      .insertInto("memberships")
      .values({ org_id: orgId, account_id: bobId, role: "member" })
      .execute();
    const bob = await login(k, "bob");
    const other = await bob.req({ method: "GET", url: draftUrl(orgId, convId, runId) });
    expect(other.statusCode).toBe(404);
    expect((other.json() as { error: { code: string } }).error.code).toBe("conversation.not_found");

    // a run id past the parameter bound never reaches the handler (Fastify's maxParamLength)
    const bad = await owner.req({ method: "GET", url: draftUrl(orgId, convId, "x".repeat(101)) });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
  }, 30_000);

  it("GET …/draft answers no drafts (and warns) when the drafts cannot be read", async () => {
    await postMessage(owner.req, orgId, convId, "echo:done");
    await waitForTerminal(db, convId);
    const runId = (await eventsOf(db, convId)).find((e) => e.type === "model_call")
      ?.runId as string;
    const read = vi.spyOn(k.app.get(RunDrafts), "read").mockRejectedValue(new Error("redis down"));
    // a running run, so live() reaches Redis
    await db.updateTable("runs").set({ status: "running" }).where("id", "=", runId).execute();
    try {
      const r = await owner.req({ method: "GET", url: draftUrl(orgId, convId, runId) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ drafts: [] });
      expect(read).toHaveBeenCalled();
    } finally {
      read.mockRestore();
      await db.updateTable("runs").set({ status: "completed" }).where("id", "=", runId).execute();
    }
  });

  it("a run stopped mid-step leaves no draft: none in Redis, none on a new stream", async () => {
    const a = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
    try {
      await postMessage(owner.req, orgId, convId, `slow:150:${SLOW_REPLY}`);
      await streaming(a, convId, 2);
      const stop = await owner.req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
      });
      expect(stop.statusCode).toBe(202);
      await waitForTerminal(db, convId);
      await waitFor(
        async () => ((await draftKeys()).length === 0 ? true : undefined),
        5_000,
        "draft cleared",
      );
      const b = await openSse(streamUrl(k, orgId, convId), { cookie: owner.cookie() });
      try {
        await b.until((m) => eventsIn(m).some((e) => e.type === "run_aborted"), 5_000, "catch-up");
        await sleep(300);
        expect(draftsIn(b.messages)).toEqual([]);
      } finally {
        b.close();
      }
    } finally {
      a.close();
    }
  }, 30_000);
});

describe("会话 SSE（跨副本：运行在 worker 副本，SSE 连在 api 副本）", () => {
  let worker: TestKernel;
  let api: TestKernel;

  beforeAll(async () => {
    [worker, api] = await Promise.all([
      startKernel(runConfig(urls(), { roles: ["worker"], runtime: STREAM_RUNTIME })),
      startKernel(runConfig(urls(), { roles: ["api"], runtime: STREAM_RUNTIME })),
    ]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([worker?.close(), api?.close()]);
  });

  it("a viewer on the api replica gets the draft of a run streaming on the worker replica", async () => {
    await resetDb();
    await account("owner");
    const owner = await login(api, "owner");
    const orgId = await createOrg(owner.req);
    const agentId = await createAgent(owner.req, orgId);
    const convId = await createConv(owner.req, orgId, agentId);

    const a = await openSse(streamUrl(api, orgId, convId), { cookie: owner.cookie() });
    let b: SseClient | undefined;
    try {
      await postMessage(owner.req, orgId, convId, `slow:120:${SLOW_REPLY}`);
      const runId = await streaming(a, convId, 3);
      b = await openSse(streamUrl(api, orgId, convId), { cookie: owner.cookie() });
      const resumed = resumeLive(
        b,
        routeText(owner.req, draftUrl(orgId, convId, runId), 1),
        runId,
        1,
      );
      await b.until((m) => draftsIn(m).length === 1, 5_000, "draft frame");
      const r = await owner.req({ method: "GET", url: draftUrl(orgId, convId, runId) });
      expect(r.statusCode).toBe(200);
      const route = (r.json() as { drafts: { text: string }[] }).drafts;
      await b.until((m) => finishedCount(m) === 1, 15_000, "run_finished");
      const [draft] = draftsIn(b.messages);
      expect(draft?.text.length).toBeGreaterThan(0);
      expect(SLOW_REPLY.startsWith(draft?.text ?? "x")).toBe(true);
      // the route on the api replica read the same draft, at least as far
      expect(route[0]?.text.startsWith(draft?.text ?? "x")).toBe(true);
      expect((await resumed).text).toBe(SLOW_REPLY);
    } finally {
      a.close();
      b?.close();
    }
  }, 30_000);

  it("api 副本收到 worker 副本运行的全部增量与事件；停机时关闭进行中的流", async () => {
    await resetDb();
    await account("owner");
    const owner = await login(api, "owner");
    const orgId = await createOrg(owner.req);
    const agentId = await createAgent(owner.req, orgId);
    const convId = await createConv(owner.req, orgId, agentId);

    const s = await openSse(streamUrl(api, orgId, convId), { cookie: owner.cookie() });
    try {
      await postMessage(owner.req, orgId, convId, "echo:across replicas");
      await s.until((m) => finishedCount(m) === 1, 15_000, "run_finished");
      const evs = eventsIn(s.messages);
      expect(evs.map((e) => e.seq)).toEqual((await eventsOf(db, convId)).map((e) => e.seq));
      const text = deltasIn(s.messages)
        .filter((d) => d.delta === "text")
        .map((d) => d.text)
        .join("");
      expect(text).toBe("across replicas");
      expect(textOf(evs.find((e) => e.type === "assistant_message"))).toBe("across replicas");

      // 停机：进行中的 SSE 连接被关闭，不拖满 HTTP 停机预算
      const t0 = Date.now();
      await api.close();
      await s.ended;
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      s.close();
    }
  });
});

describe("会话 SSE：凭据复核（R35）", () => {
  let a: TestKernel;
  let b: TestKernel;

  beforeAll(async () => {
    [a, b] = await Promise.all([
      startKernel(runConfig(urls(), { roles: ["api", "worker"], runtime: STREAM_RUNTIME })),
      startKernel(runConfig(urls(), { roles: ["api"], runtime: STREAM_RUNTIME })),
    ]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
  });

  async function setup() {
    await resetDb();
    const ownerId = await account("owner");
    const owner = await login(a, "owner");
    const orgId = await createOrg(owner.req);
    const agentId = await createAgent(owner.req, orgId);
    const convId = await createConv(owner.req, orgId, agentId);
    return { ownerId, owner, orgId, convId };
  }

  const errorsIn = (msgs: SseMessage[]) =>
    msgs
      .filter((m) => m.event === "error")
      .map((m) => JSON.parse(m.data as string) as { code: string });

  async function endsWithin(s: SseClient, ms: number): Promise<void> {
    await Promise.race([
      s.ended,
      sleep(ms).then(() => {
        throw new Error("stream not closed");
      }),
    ]);
  }

  it("在另一副本登出 → 一个复核周期内收到 event: error（auth.session_revoked），流结束", async () => {
    const { owner, orgId, convId } = await setup();
    const s = await openSse(streamUrl(a, orgId, convId), { cookie: owner.cookie() });
    try {
      expect(s.status).toBe(200);
      await sleep(300);
      expect(s.isEnded()).toBe(false);
      const out = await asUser(b.http, owner.jar)({ method: "POST", url: "/api/v1/auth/logout" });
      expect(out.statusCode).toBe(204);
      await endsWithin(s, 2_000);
      expect(errorsIn(s.messages)).toEqual([{ code: "auth.session_revoked" }]);
      expect(s.messages.at(-1)?.event).toBe("error");
    } finally {
      s.close();
    }
  });

  it("个人令牌被吊销 → 流以 error 帧结束；吊销后的令牌不能再建立流", async () => {
    const { ownerId, orgId, convId } = await setup();
    const tokens = apiTokensFor(db);
    const { token, record } = await tokens.createPersonal(ownerId, { name: "cli" });
    const url = streamUrl(b, orgId, convId);
    const s = await openSse(url, { authorization: `Bearer ${token}` });
    try {
      expect(s.status).toBe(200);
      await sleep(300);
      expect(s.isEnded()).toBe(false);
      await tokens.revoke(record.id, { accountId: ownerId });
      await endsWithin(s, 2_000);
      expect(errorsIn(s.messages)).toEqual([{ code: "auth.required" }]);
    } finally {
      s.close();
    }
    const again = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(again.status).toBe(401);
  });

  it("access token 到期但会话仍有效 → 流不结束，继续推送", async () => {
    const { ownerId, owner, orgId, convId } = await setup();
    // 与内核相同的密钥，签发 access token 只有 2 秒寿命的会话（配置下限是 60 秒，测试直接构造服务）
    const shortLived = sessionsFor(db, redis, createKeyring(Buffer.alloc(32, 7), []), {
      accessTtlSeconds: 2,
      refreshTtlDays: 1,
    });
    const issued = await shortLived.create(ownerId, {});
    const cookie = `cap_at=${encodeURIComponent(issued.accessToken)}`;
    const s = await openSse(streamUrl(a, orgId, convId), { cookie });
    try {
      expect(s.status).toBe(200);
      await sleep(2_600);
      // 令牌已过期：新请求被拒，但已建立的流仍在
      const expired = await fetch(streamUrl(a, orgId, convId), { headers: { cookie } });
      expect(expired.status).toBe(401);
      expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
        "auth.token_expired",
      );
      expect(s.isEnded()).toBe(false);
      expect(errorsIn(s.messages)).toEqual([]);
      await postMessage(owner.req, orgId, convId, "echo:still here");
      await s.until((m) => finishedCount(m) === 1, 15_000, "run_finished after expiry");
      // 会话本身被吊销后照样关闭
      await shortLived.revoke(issued.sessionId);
      await endsWithin(s, 2_000);
      expect(errorsIn(s.messages)).toEqual([{ code: "auth.session_revoked" }]);
    } finally {
      s.close();
    }
  });

  it("慢客户端（不读数据）积压超限 → 服务端销毁连接，不等客户端", async () => {
    const { owner, orgId, convId } = await setup();
    // 独立的 api 副本：除了这条慢连接没有别的连接（其他测试留下的 keep-alive 空闲连接会干扰计数）
    const c = await startKernel(runConfig(urls(), { roles: ["api"], runtime: STREAM_RUNTIME }));
    const port = c.port as number;
    expect(await c.http.connections()).toBe(0);
    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => {});
    try {
      await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
      sock.write(
        `GET /api/v1/orgs/${orgId}/conversations/${convId}/stream HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\nCookie: ${owner.cookie()}\r\n\r\n`,
      );
      const head = await new Promise<string>((resolve) =>
        sock.once("data", (d: Buffer) => resolve(d.toString())),
      );
      expect(head).toMatch(/^HTTP\/1\.1 200/);
      sock.pause(); // 之后不再读：TCP 窗口填满后服务端的写入只能积压在进程内
      expect(await c.http.connections()).toBe(1);

      const channel = `cap:kernel:${conversationTopic(convId)}`;
      const text = "x".repeat(64 * 1024);
      const msg = JSON.stringify({ kind: "delta", runId: "r", step: 1, delta: "text", text });
      for (let i = 0; i < 480; i++) await redis.publish(channel, msg); // ≈30 MiB

      await waitFor(
        async () => (await c.http.connections()) === 0,
        10_000,
        "server to destroy the slow connection",
      );
      await waitFor(
        async () => Number((await redis.pubsub("NUMSUB", channel))[1]) === 0,
        5_000,
        "unsubscribe",
      );
    } finally {
      sock.destroy();
      await c.close();
    }
  }, 30_000);
});
