import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { asUser, cookieJar } from "../helpers/http.js";
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

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
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
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings CASCADE`.execute(
    raw,
  );
  await redis.flushdb();
}

/** 登录，返回请求函数与 SSE 用的 cookie 头。 */
async function login(k: Kernel, name: string): Promise<{ req: Req; cookie: () => string }> {
  const jar = cookieJar();
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: name, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return { req, cookie: () => jar.header() as string };
}

async function account(name: string): Promise<string> {
  return (
    await new AccountsService(db).createLocal({ login: name, password: PW, displayName: name })
  ).id;
}

const streamUrl = (k: Kernel, orgId: string, convId: string, query = "") =>
  `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${convId}/stream${query}`;

describe("会话 SSE（单副本 api+worker）", () => {
  let k: Kernel;
  let owner: { req: Req; cookie: () => string };
  let orgId: string;
  let convId: string;

  beforeAll(async () => {
    k = await startKernel(runConfig(urls(), { roles: ["api", "worker"], runtime: STREAM_RUNTIME }));
  }, 60_000);
  afterAll(async () => {
    await k?.stop();
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

describe("会话 SSE（跨副本：运行在 worker 副本，SSE 连在 api 副本）", () => {
  let worker: Kernel;
  let api: Kernel;

  beforeAll(async () => {
    [worker, api] = await Promise.all([
      startKernel(runConfig(urls(), { roles: ["worker"], runtime: STREAM_RUNTIME })),
      startKernel(runConfig(urls(), { roles: ["api"], runtime: STREAM_RUNTIME })),
    ]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([worker?.stop(), api?.stop()]);
  });

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
      await api.stop();
      await s.ended;
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      s.close();
    }
  });
});
