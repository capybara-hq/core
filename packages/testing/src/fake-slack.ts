import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * 可编程的假 Slack（Slack 渠道插件测试用），扮演两块能力：
 *
 * - **Web API**：`POST /api/<method>`（表单或 JSON 请求体，令牌取 `Authorization: Bearer`），实现插件用到的
 *   `auth.test`、`chat.postMessage`、`chat.update`、`users.info`、`apps.connections.open`。机器人令牌 / 应用令牌
 *   与构造时给的不符 → `invalid_auth`；`chat.postMessage` 文本超过 40000 字符、`chat.update` 超过 4000 字符 →
 *   `msg_too_long`（与 Slack 文档一致）；{@link FakeSlackServer.failNext} 可让某个方法返回平台错误或 HTTP 状态码
 *   （429 带 `Retry-After`）。WebClient 用 `slackApiUrl: server.apiUrl` 指过来。
 * - **Socket Mode**：`apps.connections.open` 返回 `ws://…/link?ticket=<n>`；连上后先发 `hello`，测试用
 *   {@link FakeSlackServer.push}（或 `pushEvent` / `pushInteractive`）推信封，记下客户端回的确认（`acks`）。
 *
 * 记录：`messages`（发出的消息）、`updates`（对已发消息的更新）、`calls`（每次 Web API 调用）。
 */

export interface FakeSlackUser {
  id: string;
  teamId: string;
  name: string;
  realName?: string;
  displayName?: string;
  image72?: string;
  isBot?: boolean;
}

/** 机器人发出（或更新）的一条消息。 */
export interface FakeSlackMessage {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  at: number;
}

/** 一次 Web API 调用（请求体已解析；`blocks` 等 JSON 字段已解码）。 */
export interface FakeSlackCall {
  method: string;
  token: string;
  body: Record<string, unknown>;
}

/** 客户端对信封的确认。 */
export interface FakeSlackAck {
  envelopeId: string;
  payload: unknown;
  at: number;
}

/**
 * 让接下来的调用失败：`error` 为平台错误（HTTP 200 + `ok: false`），`status` 为 HTTP 状态码；`body` 给了就以
 * HTTP 200 原样返回它（模拟成功但字段缺失的响应）。
 */
export interface FakeSlackFailure {
  error?: string;
  body?: Record<string, unknown>;
  status?: number;
  /** 429 时的 `Retry-After`（秒）。 */
  retryAfter?: number;
}

export interface FakeSlackOptions {
  teamId?: string;
  botUserId?: string;
  botId?: string;
  botName?: string;
  botToken?: string;
  appToken?: string;
}

export interface FakeSlackServer {
  /** HTTP 根地址。 */
  url: string;
  /** WebClient 的 `slackApiUrl`（`<url>/api/`）。 */
  apiUrl: string;
  teamId: string;
  botUserId: string;
  botId: string;
  botToken: string;
  appToken: string;
  messages: FakeSlackMessage[];
  updates: FakeSlackMessage[];
  calls: FakeSlackCall[];
  acks: FakeSlackAck[];
  users: Map<string, FakeSlackUser>;
  /** `apps.connections.open` 成功的次数。 */
  connectionsOpened(): number;
  /** 当前打开的 WebSocket 数。 */
  openSockets(): number;
  /** 同时打开的 WebSocket 数峰值。 */
  maxConcurrentSockets(): number;
  failNext(method: string, failure: FakeSlackFailure, count?: number): void;
  /** 之后该方法的每次调用先等 `ms` 毫秒再响应（0 取消）。 */
  delay(method: string, ms: number): void;
  /** 接下来 `count` 条 Socket Mode 连接在发出 hello 后立即被关闭（不发 disconnect 消息）。 */
  dropNextConnections(count: number): void;
  /** 推一个原始信封给最近打开的一条连接，返回 envelope_id；没有打开的连接时抛错。 */
  push(envelope: { type: string; payload: unknown; envelope_id?: string }): string;
  /** 推一个 Events API 事件（`events_api` 信封，外层 `event_callback` 带 team_id / event_id）。 */
  pushEvent(event: Record<string, unknown>, opts?: { eventId?: string; teamId?: string }): string;
  /** 推一个交互负载（`interactive` 信封，如 block_actions）。 */
  pushInteractive(payload: Record<string, unknown>): string;
  /** 等到该信封被确认（超时抛错）。 */
  waitForAck(envelopeId: string, timeoutMs?: number): Promise<FakeSlackAck>;
  /** 是否已确认该信封。 */
  acked(envelopeId: string): boolean;
  /** 发 `disconnect` 并关闭所有连接（模拟 Slack 回收连接）。 */
  disconnectAll(reason?: string): void;
  /** 消息最终显示的文本（有更新取最后一次）。 */
  finalText(m: FakeSlackMessage): string;
  /** 消息最终的 blocks（有更新取最后一次）。 */
  finalBlocks(m: FakeSlackMessage): unknown[] | undefined;
  stop(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => resolve(body));
  });

const JSON_FIELDS = new Set(["blocks", "attachments", "metadata"]);

function parseBody(raw: string, contentType: string | undefined): Record<string, unknown> {
  if (raw === "") return {};
  if (contentType?.includes("application/json")) return JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    if (JSON_FIELDS.has(k)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        // 原样保留，交给方法自己报 invalid_blocks
      }
    }
    out[k] = v;
  }
  return out;
}

/** 启动假 Slack（监听 127.0.0.1 随机端口）。 */
export async function startFakeSlack(opts: FakeSlackOptions = {}): Promise<FakeSlackServer> {
  const teamId = opts.teamId ?? "T0001";
  const botUserId = opts.botUserId ?? "UBOT";
  const botId = opts.botId ?? "B0001";
  const botName = opts.botName ?? "capybara";
  const botToken = opts.botToken ?? "xoxb-fake-bot-token";
  const appToken = opts.appToken ?? "xapp-fake-app-token";
  const messages: FakeSlackMessage[] = [];
  const updates: FakeSlackMessage[] = [];
  const calls: FakeSlackCall[] = [];
  const acks: FakeSlackAck[] = [];
  const users = new Map<string, FakeSlackUser>();
  const failures: { method: string; failure: FakeSlackFailure; left: number }[] = [];
  const sockets: WebSocket[] = [];
  const ackWaiters = new Map<string, ((a: FakeSlackAck) => void)[]>();
  const delays = new Map<string, number>();
  let dropLeft = 0;
  let opened = 0;
  let peak = 0;
  let seq = 0;
  let envSeq = 0;
  let base = "";

  const reply = (res: ServerResponse, body: unknown, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const nextTs = () => {
    seq++;
    return `${1_760_000_000 + seq}.${String(seq).padStart(6, "0")}`;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  const api = async (req: IncomingMessage, res: ServerResponse, method: string) => {
    const body = parseBody(await readBody(req), req.headers["content-type"]);
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : (str(body.token) ?? "");
    calls.push({ method, token, body });
    const wait = delays.get(method) ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const f = failures.find((x) => x.method === method && x.left > 0);
    if (f) {
      f.left--;
      const { status, error, retryAfter } = f.failure;
      if (f.failure.body !== undefined) return reply(res, f.failure.body);
      if (status !== undefined && status !== 200) {
        const headers = retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {};
        return reply(res, { ok: false, error: error ?? "ratelimited" }, status, headers);
      }
      return reply(res, { ok: false, error: error ?? "internal_error" });
    }
    const expected = method === "apps.connections.open" ? appToken : botToken;
    if (token !== expected) return reply(res, { ok: false, error: "invalid_auth" });

    switch (method) {
      case "auth.test":
        return reply(res, {
          ok: true,
          url: "https://fake.slack.com/",
          team: "Fake Team",
          user: botName,
          team_id: teamId,
          user_id: botUserId,
          bot_id: botId,
        });
      case "apps.connections.open":
        opened++;
        return reply(res, {
          ok: true,
          url: `${base.replace(/^http/, "ws")}/link?ticket=${opened}`,
        });
      case "users.info": {
        const u = users.get(str(body.user) ?? "");
        if (!u) return reply(res, { ok: false, error: "user_not_found" });
        return reply(res, {
          ok: true,
          user: {
            id: u.id,
            team_id: u.teamId,
            name: u.name,
            real_name: u.realName ?? u.name,
            is_bot: u.isBot ?? false,
            profile: {
              display_name: u.displayName ?? "",
              real_name: u.realName ?? u.name,
              ...(u.image72 !== undefined && { image_72: u.image72 }),
            },
          },
        });
      }
      case "chat.postMessage": {
        const channel = str(body.channel);
        const text = str(body.text) ?? "";
        if (!channel) return reply(res, { ok: false, error: "channel_not_found" });
        if (text === "" && body.blocks === undefined)
          return reply(res, { ok: false, error: "no_text" });
        if (text.length > 40_000) return reply(res, { ok: false, error: "msg_too_long" });
        if (body.blocks !== undefined && !Array.isArray(body.blocks))
          return reply(res, { ok: false, error: "invalid_blocks_format" });
        const threadTs = str(body.thread_ts);
        const m: FakeSlackMessage = {
          channel,
          ts: nextTs(),
          text,
          ...(Array.isArray(body.blocks) && { blocks: body.blocks }),
          ...(threadTs !== undefined && { threadTs }),
          at: Date.now(),
        };
        messages.push(m);
        return reply(res, { ok: true, channel, ts: m.ts, message: { text, ts: m.ts } });
      }
      case "chat.update": {
        const channel = str(body.channel);
        const ts = str(body.ts);
        const text = str(body.text) ?? "";
        const orig = messages.find((m) => m.channel === channel && m.ts === ts);
        if (!orig || channel === undefined || ts === undefined)
          return reply(res, { ok: false, error: "message_not_found" });
        if (text.length > 4000) return reply(res, { ok: false, error: "msg_too_long" });
        updates.push({
          channel,
          ts,
          text,
          ...(Array.isArray(body.blocks) && { blocks: body.blocks }),
          ...(orig.threadTs !== undefined && { threadTs: orig.threadTs }),
          at: Date.now(),
        });
        return reply(res, { ok: true, channel, ts, text });
      }
      default:
        return reply(res, { ok: false, error: "unknown_method" });
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", "http://x");
      const m = /^\/api\/([A-Za-z.]+)$/.exec(u.pathname);
      if (m && req.method === "POST") return api(req, res, m[1] as string);
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/link") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      peak = Math.max(peak, sockets.length);
      ws.on("close", () => {
        const i = sockets.indexOf(ws);
        if (i >= 0) sockets.splice(i, 1);
      });
      ws.on("message", (data) => {
        let msg: { envelope_id?: unknown; payload?: unknown };
        try {
          msg = JSON.parse(String(data)) as typeof msg;
        } catch {
          return;
        }
        if (typeof msg.envelope_id !== "string") return;
        const a: FakeSlackAck = {
          envelopeId: msg.envelope_id,
          payload: msg.payload,
          at: Date.now(),
        };
        acks.push(a);
        for (const w of ackWaiters.get(a.envelopeId) ?? []) w(a);
        ackWaiters.delete(a.envelopeId);
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          num_connections: sockets.length,
          debug_info: { host: "fake-slack" },
          connection_info: { app_id: "A0001" },
        }),
      );
      if (dropLeft > 0) {
        dropLeft--;
        ws.close(1011);
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const push: FakeSlackServer["push"] = (envelope) => {
    const ws = sockets.at(-1);
    if (!ws) throw new Error("fake slack: no open Socket Mode connection");
    const envelope_id = envelope.envelope_id ?? `env-${++envSeq}`;
    ws.send(JSON.stringify({ ...envelope, envelope_id, accepts_response_payload: false }));
    return envelope_id;
  };

  return {
    url: base,
    apiUrl: `${base}/api/`,
    teamId,
    botUserId,
    botId,
    botToken,
    appToken,
    messages,
    updates,
    calls,
    acks,
    users,
    connectionsOpened: () => opened,
    openSockets: () => sockets.length,
    maxConcurrentSockets: () => peak,
    failNext(method, failure, count = 1) {
      failures.push({ method, failure, left: count });
    },
    delay(method, ms) {
      delays.set(method, ms);
    },
    dropNextConnections(count) {
      dropLeft = count;
    },
    push,
    pushEvent(event, o = {}) {
      return push({
        type: "events_api",
        payload: {
          token: "verification-token",
          team_id: o.teamId ?? teamId,
          api_app_id: "A0001",
          type: "event_callback",
          event_id: o.eventId ?? `Ev${++envSeq}`,
          event_time: Math.floor(Date.now() / 1000),
          event,
        },
      });
    },
    pushInteractive(payload) {
      return push({ type: "interactive", payload });
    },
    waitForAck(envelopeId, timeoutMs = 5000) {
      const done = acks.find((a) => a.envelopeId === envelopeId);
      if (done) return Promise.resolve(done);
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`fake slack: envelope ${envelopeId} not acked`)),
          timeoutMs,
        );
        const list = ackWaiters.get(envelopeId) ?? [];
        list.push((a) => {
          clearTimeout(t);
          resolve(a);
        });
        ackWaiters.set(envelopeId, list);
      });
    },
    acked: (id) => acks.some((a) => a.envelopeId === id),
    disconnectAll(reason = "refresh_requested") {
      for (const ws of [...sockets]) {
        ws.send(JSON.stringify({ type: "disconnect", reason }));
        ws.close(1000);
      }
    },
    finalText(m) {
      return updates.filter((u) => u.channel === m.channel && u.ts === m.ts).at(-1)?.text ?? m.text;
    },
    finalBlocks(m) {
      const u = updates.filter((x) => x.channel === m.channel && x.ts === m.ts).at(-1);
      return u ? u.blocks : m.blocks;
    },
    async stop() {
      for (const ws of [...sockets]) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 私聊消息事件（`message.im`；默认频道 `D<user>`）。 */
export function slackDmEvent(
  user: string,
  text: string,
  opts: { ts?: string; channel?: string; team?: string; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    type: "message",
    channel_type: "im",
    channel: opts.channel ?? `D${user}`,
    user,
    text,
    ts: opts.ts ?? `${1_750_000_000 + Math.floor(Math.random() * 1e6)}.000100`,
    ...(opts.team !== undefined && { team: opts.team }),
    ...opts.extra,
  };
}

/** 频道里 @ 机器人的事件（`app_mention`；`threadTs` 给了表示在话题里）。 */
export function slackMentionEvent(
  user: string,
  botUserId: string,
  text: string,
  opts: { ts?: string; channel?: string; threadTs?: string; team?: string } = {},
): Record<string, unknown> {
  return {
    type: "app_mention",
    channel: opts.channel ?? "C0001",
    user,
    text: `<@${botUserId}> ${text}`,
    ts: opts.ts ?? `${1_750_000_000 + Math.floor(Math.random() * 1e6)}.000200`,
    ...(opts.threadTs !== undefined && { thread_ts: opts.threadTs }),
    ...(opts.team !== undefined && { team: opts.team }),
  };
}

/**
 * 用户点了某条消息上的按钮（`block_actions`）。`message` 为假 Slack 记下的那条消息，`actionId` / `value`
 * 取自其 blocks 里的按钮；`stateValues` 为 `state.values`（多选提交时带上勾选项）。
 */
export function slackBlockAction(
  user: { id: string; teamId: string; name?: string },
  message: FakeSlackMessage,
  action: { actionId: string; value?: string; blockId?: string },
  opts: { actionTs?: string; stateValues?: Record<string, unknown>; triggerId?: string } = {},
): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: user.id, team_id: user.teamId, username: user.name ?? user.id, name: user.name },
    team: { id: user.teamId, domain: "fake" },
    api_app_id: "A0001",
    trigger_id: opts.triggerId ?? `trig-${Math.random().toString(36).slice(2)}`,
    container: {
      type: "message",
      message_ts: message.ts,
      channel_id: message.channel,
      is_ephemeral: false,
      ...(message.threadTs !== undefined && { thread_ts: message.threadTs }),
    },
    channel: { id: message.channel, name: message.channel.startsWith("D") ? "directmessage" : "c" },
    message: {
      type: "message",
      ts: message.ts,
      text: message.text,
      blocks: message.blocks,
      ...(message.threadTs !== undefined && { thread_ts: message.threadTs }),
    },
    state: { values: opts.stateValues ?? {} },
    actions: [
      {
        type: "button",
        action_id: action.actionId,
        block_id: action.blockId ?? "b",
        ...(action.value !== undefined && { value: action.value }),
        action_ts: opts.actionTs ?? `${Date.now() / 1000}`,
      },
    ],
  };
}

/** 在消息的 blocks 里找按钮（按 action_id 前缀或谓词），返回 `{ actionId, value, blockId }`。 */
export function findSlackButton(
  blocks: unknown[] | undefined,
  match: (el: {
    action_id: string;
    value?: string;
    url?: string;
    text?: { text?: string };
  }) => boolean,
): { actionId: string; value?: string; blockId?: string; url?: string } | undefined {
  for (const b of blocks ?? []) {
    const block = b as { type?: string; block_id?: string; elements?: unknown[] };
    if (block.type !== "actions") continue;
    for (const e of block.elements ?? []) {
      const el = e as { type?: string; action_id: string; value?: string; url?: string };
      if (el.type === "button" && match(el)) {
        return {
          actionId: el.action_id,
          ...(el.value !== undefined && { value: el.value }),
          ...(block.block_id !== undefined && { blockId: block.block_id }),
          ...(el.url !== undefined && { url: el.url }),
        };
      }
    }
  }
  return undefined;
}
