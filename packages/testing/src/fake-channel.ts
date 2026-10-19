import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  CardAction,
  ChannelTarget,
  DirectoryMember,
  InboundEvent,
  OutboundMessage,
} from "@capybara-hq/plugin-sdk";

/**
 * 可编程的假 IM 平台（渠道插件测试用）：一个 HTTP 服务同时扮演 IM 平台的几块能力——
 *
 * - **机器人**：`POST /bot/verify` 校验应用凭据；`GET /connect?connection=<id>` 建一条 NDJSON 长连接，
 *   测试用 {@link FakeChannelServer.push} 向某个渠道连接当前在线的长连接推入站事件；`POST /send`、`POST /update`
 *   记下机器人发出 / 更新的消息（含卡片），`/send` 按 `idempotencyKey` 去重（同一应用、同一键只发一次，
 *   重复的请求原样返回第一次的 messageId，并记进 `duplicateSends`）。
 * - **登录（OAuth）**：`GET /oauth/authorize` 以 `as=<externalId>` 指定「在平台上登录的人」，签发一次性授权码并
 *   302 回 `redirect_uri`；`POST /oauth/token` 用授权码换该用户资料与发起时的 nonce。授权时带了 PKCE
 *   `code_challenge`（S256）的，换 token 必须带对应的 `codeVerifier`，否则 `invalid_grant`。
 * - **通讯录**：`GET /d/<key>/members?cursor=<n>` 按页返回 {@link FakeChannelServer.book} 的成员，可让某页失败、让第一页挂起。
 * - **其他写操作**：`POST /posts` 记下插件工具发的「公告」（`posts`），供断言工具确实执行（且只执行一次）。
 *
 * 所有请求读 `x-pid` 头记下发起进程，双副本测试据此判断是哪个副本连上 / 发出的。
 * 统计每个渠道连接同时在线的长连接数峰值（任一时刻只能有一条）。配套的测试插件见内核测试的 `fixtures/plugins/fake-im`。
 */

/** 一条长连接。 */
export interface FakeChannelStream {
  connectionId: string;
  /** 请求头 `x-app-id`。 */
  appId: string;
  /** 发起连接的进程 pid（请求头 `x-pid`）。 */
  pid: number;
  openedAt: number;
  closedAt: number | undefined;
}

/** 机器人发出（或更新）的一条消息。 */
export interface FakeChannelSent {
  appId: string;
  target: ChannelTarget;
  message: OutboundMessage;
  messageId: string;
  /** 发出请求的进程 pid（请求头 `x-pid`）。 */
  pid: number;
  /** 内核给的幂等键（`ChannelSendArgs.idempotencyKey`）。 */
  idempotencyKey?: string;
  at: number;
}

/** 平台上的一个用户（OAuth 登录时可用 `as=<externalId>` 选中）。 */
export interface FakeChannelUser {
  externalId: string;
  tenantId: string;
  email?: string;
  emailVerified?: boolean;
  displayName: string;
}

/** 一份假通讯录（按路径前缀 `/d/<key>` 区分）。 */
export interface FakeDirectoryBook {
  /** 通讯录插件的组织级配置 `url`。 */
  url: string;
  members: DirectoryMember[];
  /** 每页条数（默认 100）。 */
  pageSize: number;
  /** 第几页（从 0 计）返回 500；null 不失败。 */
  failOnPage: number | null;
  /** 给了就让第一页（不带游标的请求）等它 resolve 再返回。 */
  hold: Promise<void> | null;
  /** 每次请求的页号与发起进程 pid。 */
  requests: { page: number; pid: number }[];
  /** 整轮同步开始的次数（不带游标的请求数）。 */
  starts(): number;
}

/** 插件工具经 `POST /posts` 发出的一条记录。 */
export interface FakeChannelPost {
  body: Record<string, unknown>;
  pid: number;
  at: number;
}

export interface FakeChannelServerOptions {
  /**
   * `/send` 是否按 `(appId, idempotencyKey)` 去重（默认 true，像飞书的 `uuid`）。
   * 断言「内核自己就不重发」的测试传 false：每次发送都记进 `sent`，重发即可见。
   */
  dedupeSends?: boolean;
}

export interface FakeChannelServer {
  url: string;
  streams: FakeChannelStream[];
  /** 平台上真实出现的消息（去重后）。 */
  sent: FakeChannelSent[];
  /** 机器人对已发消息的更新（`messageId` 为被更新的消息）。 */
  updated: FakeChannelSent[];
  /** 命中幂等键、被平台去重的发送请求（没有产生新消息）。 */
  duplicateSends: FakeChannelSent[];
  /** 插件工具发的公告。 */
  posts: FakeChannelPost[];
  /** 平台用户（OAuth 登录用），按 externalId 索引。 */
  users: Map<string, FakeChannelUser>;
  /**
   * 让接下来 `count` 次 `/send`（或 `/update`）返回该状态码（不记录）；`retryAfterMs` 放进响应体，
   * 测试插件据此抛可重试的 `ChannelSendError`。
   */
  failNext(path: "/send" | "/update", status: number, count?: number, retryAfterMs?: number): void;
  /** 让 /connect 返回该状态码（null 恢复正常）。 */
  failConnect(status: number | null): void;
  /** 该渠道连接当前在线的长连接。 */
  active(connectionId: string): FakeChannelStream[];
  /** 该渠道连接同时在线长连接数的峰值。 */
  maxConcurrent(connectionId: string): number;
  /** 推送给该渠道连接当前所有在线长连接，返回推送到的条数。 */
  push(connectionId: string, event: InboundEvent): number;
  /** 取（没有则新建）一份通讯录。 */
  book(key: string): FakeDirectoryBook;
  /** 消息最终显示的文本：有更新取最后一次更新，否则为发出时的文本。 */
  finalText(s: FakeChannelSent): string;
  stop(): Promise<void>;
}

/** 校验应用凭据时一律拒绝的密钥。 */
export const FAKE_CHANNEL_BAD_SECRET = "bad-secret";

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => resolve(body));
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** 启动假 IM 平台（监听 127.0.0.1 随机端口）。 */
export async function startFakeChannelServer(
  opts: FakeChannelServerOptions = {},
): Promise<FakeChannelServer> {
  const dedupe = opts.dedupeSends ?? true;
  const streams: FakeChannelStream[] = [];
  const sent: FakeChannelSent[] = [];
  const updated: FakeChannelSent[] = [];
  const duplicateSends: FakeChannelSent[] = [];
  const posts: FakeChannelPost[] = [];
  const users = new Map<string, FakeChannelUser>();
  const books = new Map<string, FakeDirectoryBook>();
  const codes = new Map<
    string,
    { user: FakeChannelUser; nonce: string; clientId: string; challenge: string | null }
  >();
  const byKey = new Map<string, string>();
  const failures: { path: string; status: number; left: number; retryAfterMs?: number }[] = [];
  const live = new Map<FakeChannelStream, ServerResponse>();
  const peaks = new Map<string, number>();
  let failStatus: number | null = null;
  let seq = 0;
  let base = "";

  const activeOf = (id: string) => [...live.keys()].filter((s) => s.connectionId === id);
  const pidOf = (req: IncomingMessage) => Number(req.headers["x-pid"]);

  const connect = (req: IncomingMessage, res: ServerResponse, u: URL) => {
    if (failStatus !== null) {
      res.writeHead(failStatus).end();
      return;
    }
    const s: FakeChannelStream = {
      connectionId: u.searchParams.get("connection") ?? "",
      appId: String(req.headers["x-app-id"] ?? ""),
      pid: pidOf(req),
      openedAt: Date.now(),
      closedAt: undefined,
    };
    streams.push(s);
    live.set(s, res);
    peaks.set(
      s.connectionId,
      Math.max(peaks.get(s.connectionId) ?? 0, activeOf(s.connectionId).length),
    );
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write("\n");
    const close = () => {
      if (s.closedAt === undefined) s.closedAt = Date.now();
      live.delete(s);
    };
    req.on("close", close);
    res.on("close", close);
  };

  const sendOrUpdate = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const body = await readBody(req);
    const f = failures.find((x) => x.path === path && x.left > 0);
    if (f) {
      f.left--;
      json(res, f.status, { retryAfterMs: f.retryAfterMs ?? null });
      return;
    }
    const b = JSON.parse(body) as Omit<FakeChannelSent, "messageId" | "pid" | "at"> & {
      messageId?: string;
    };
    const key = b.idempotencyKey ? `${b.appId}\u0000${b.idempotencyKey}` : undefined;
    const seen = path === "/send" && key !== undefined ? byKey.get(key) : undefined;
    const messageId = b.messageId ?? seen ?? `om_${++seq}`;
    const rec: FakeChannelSent = { ...b, messageId, pid: pidOf(req), at: Date.now() };
    if (path === "/update") updated.push(rec);
    else if (seen !== undefined && dedupe) duplicateSends.push(rec);
    else {
      sent.push(rec);
      if (key !== undefined && seen === undefined) byKey.set(key, messageId);
    }
    json(res, 200, { messageId });
  };

  const authorize = (res: ServerResponse, u: URL) => {
    const redirect = u.searchParams.get("redirect_uri");
    const state = u.searchParams.get("state") ?? "";
    if (redirect === null) {
      json(res, 400, { error: "invalid_request" });
      return;
    }
    const back = new URL(redirect);
    back.searchParams.set("state", state);
    const user = users.get(u.searchParams.get("as") ?? "");
    if (user === undefined) {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = `fc_${randomBytes(16).toString("hex")}`;
      codes.set(code, {
        user,
        nonce: u.searchParams.get("nonce") ?? "",
        clientId: u.searchParams.get("client_id") ?? "",
        challenge: u.searchParams.get("code_challenge"),
      });
      back.searchParams.set("code", code);
    }
    res.writeHead(302, { location: back.toString() }).end();
  };

  const token = async (req: IncomingMessage, res: ServerResponse) => {
    const b = JSON.parse((await readBody(req)) || "{}") as {
      code?: string;
      clientId?: string;
      clientSecret?: string;
      codeVerifier?: string;
    };
    const c = b.code === undefined ? undefined : codes.get(b.code);
    if (b.code !== undefined) codes.delete(b.code);
    if (c === undefined || c.clientId !== b.clientId) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    if (
      c.challenge !== null &&
      (b.codeVerifier === undefined ||
        createHash("sha256").update(b.codeVerifier).digest("base64url") !== c.challenge)
    ) {
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    if (b.clientSecret === FAKE_CHANNEL_BAD_SECRET) {
      json(res, 401, { error: "invalid_client" });
      return;
    }
    json(res, 200, { user: c.user, nonce: c.nonce });
  };

  const directory = async (req: IncomingMessage, res: ServerResponse, b: FakeDirectoryBook) => {
    const u = new URL(req.url ?? "/", "http://x");
    const cursor = u.searchParams.get("cursor");
    const page = cursor === null ? 0 : Number(cursor);
    b.requests.push({ page, pid: pidOf(req) });
    if (page === 0 && b.hold) await b.hold;
    if (b.failOnPage === page) {
      res.writeHead(500).end();
      return;
    }
    const start = page * b.pageSize;
    const members = b.members.slice(start, start + b.pageSize);
    const more = start + b.pageSize < b.members.length;
    json(res, 200, { members, ...(more && { next: String(page + 1) }) });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", "http://x");
      const route = `${req.method} ${u.pathname}`;
      if (route === "GET /connect") return connect(req, res, u);
      if (route === "POST /send" || route === "POST /update") {
        return sendOrUpdate(req, res, u.pathname);
      }
      if (route === "POST /bot/verify") {
        const b = JSON.parse((await readBody(req)) || "{}") as {
          appId?: string;
          appSecret?: string;
          tenant?: string;
        };
        if (!b.appId || !b.appSecret || b.appSecret === FAKE_CHANNEL_BAD_SECRET) {
          return json(res, 401, { error: "invalid app credentials" });
        }
        return json(res, 200, {
          botUserId: `bot-${b.appId}`,
          botName: "Fake Bot",
          tenantId: b.tenant ?? "t1",
        });
      }
      if (route === "GET /oauth/authorize") return authorize(res, u);
      if (route === "POST /oauth/token") return token(req, res);
      if (route === "POST /posts") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        posts.push({ body, pid: pidOf(req), at: Date.now() });
        return json(res, 200, { id: `post_${posts.length}` });
      }
      const m = /^\/d\/([^/]+)\/members$/.exec(u.pathname);
      const b = m && req.method === "GET" ? books.get(m[1] as string) : undefined;
      if (b) return directory(req, res, b);
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    streams,
    sent,
    updated,
    duplicateSends,
    posts,
    users,
    failNext(path, status, count = 1, retryAfterMs) {
      failures.push({
        path,
        status,
        left: count,
        ...(retryAfterMs !== undefined && { retryAfterMs }),
      });
    },
    failConnect(status) {
      failStatus = status;
    },
    active: activeOf,
    maxConcurrent: (id) => peaks.get(id) ?? 0,
    push(connectionId, event) {
      const targets = activeOf(connectionId);
      for (const s of targets) live.get(s)?.write(`${JSON.stringify(event)}\n`);
      return targets.length;
    },
    book(key) {
      let b = books.get(key);
      if (!b) {
        const requests: { page: number; pid: number }[] = [];
        b = {
          url: `${base}/d/${key}`,
          members: [],
          pageSize: 100,
          failOnPage: null,
          hold: null,
          requests,
          starts: () => requests.filter((r) => r.page === 0).length,
        };
        books.set(key, b);
      }
      return b;
    },
    finalText(s) {
      return (
        updated.filter((x) => x.messageId === s.messageId).at(-1)?.message.text ?? s.message.text
      );
    },
    async stop() {
      for (const res of live.values()) res.destroy();
      live.clear();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 私聊文本消息（chat id 为 `dm-<externalId>`）。 */
export function fakeDm(
  messageId: string,
  externalId: string,
  text: string,
  tenantId = "t1",
): InboundEvent {
  return {
    type: "message",
    messageId,
    target: { chatId: `dm-${externalId}`, chatType: "dm" },
    sender: { externalId, tenantId },
    text,
    mentionsBot: false,
  };
}

/** 群聊文本消息（默认 chat `grp-1`、@ 了机器人）。 */
export function fakeGroupMessage(
  messageId: string,
  externalId: string,
  text: string,
  opts: { chatId?: string; threadId?: string; mentionsBot?: boolean; tenantId?: string } = {},
): InboundEvent {
  return {
    type: "message",
    messageId,
    target: {
      chatId: opts.chatId ?? "grp-1",
      chatType: "group",
      ...(opts.threadId !== undefined && { threadId: opts.threadId }),
    },
    sender: { externalId, tenantId: opts.tenantId ?? "t1" },
    text,
    mentionsBot: opts.mentionsBot ?? true,
  };
}

/** 卡片按钮操作；`target` 取卡片所在的消息目标（群里带 threadId）。 */
export function fakeCardAction(
  messageId: string,
  externalId: string,
  action: CardAction,
  target: ChannelTarget,
  tenantId = "t1",
): InboundEvent {
  return { type: "card_action", messageId, target, sender: { externalId, tenantId }, action };
}

/** 通讯录成员（租户 t1；邮箱缺省 `<id>@corp.example`、已验证）。 */
export function fakeDirectoryMember(
  externalId: string,
  over: Partial<DirectoryMember> = {},
): DirectoryMember {
  return {
    externalId,
    tenantId: "t1",
    email: `${externalId}@corp.example`,
    emailVerified: true,
    displayName: externalId,
    active: true,
    ...over,
  };
}
