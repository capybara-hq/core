import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import protobuf from "protobufjs";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

/**
 * 可编程的假 Lark（Lark 渠道插件测试用），扮演开放平台的三块能力：
 *
 * - **OpenAPI**：`tenant_access_token/internal`（App ID 不符 → `10014`，Secret 不符 → `10015`，HTTP 200）、
 *   `bot/v3/info`、`tenant/v2/tenant/query`、发送消息 `POST /open-apis/im/v1/messages?receive_id_type=chat_id`、
 *   回复消息 `POST …/messages/:id/reply`（`reply_in_thread`）、更新卡片 `PATCH …/messages/:id`、用户资料
 *   `GET /open-apis/contact/v3/users/:id`。带 tenant token 的接口校验 `Authorization: Bearer`（未签发或已吊销 →
 *   HTTP 400 `99991663`）。发送 / 回复按 `uuid` 去重（与 Lark 一致，同一 uuid 只发一条）；请求体超过 30 KB →
 *   `230025`；卡片须是 JSON 2.0（`schema: "2.0"`，`config.update_multi` 不为 false），否则 `230099`。
 *   {@link FakeLarkServer.failNext} 让某个接口返回错误码 / HTTP 状态（429 带 `x-ogw-ratelimit-reset`）。
 * - **长连接**：`POST /callback/ws/endpoint`（官方 SDK `WSClient` 取接入点；凭据不符时与真实 Lark 一样回
 *   `1000040343 internal error`）返回 `ws://…/ws?…&service_id=1`；WebSocket 上按 SDK 的 protobuf 帧格式
 *   `pbbp2.Frame`（字段号与 `@larksuiteoapi/node-sdk` 内置的定义一致）收发：测试用 {@link FakeLarkServer.pushEvent}
 *   推事件帧（`method = 1`，头 `type = event`、`message_id`、`sum = 1`、`seq = 0`），记下客户端回的响应帧
 *   （`acks`：`code` 200 / 500 与解码后的 `data`）；客户端的 ping 回 pong。
 *
 * - **网页登录（OAuth 2.0 授权码 + PKCE）**：授权页 `GET /open-apis/authen/v1/authorize`（真实 Lark 在
 *   `accounts.larksuite.com`；测试在授权地址后加 `&as=<open_id>` 表示以该用户同意授权，302 回
 *   `redirect_uri?code=…&state=…`；`client_id` 不符或用户不存在 → `error=access_denied`）、换 token
 *   `POST /open-apis/authen/v2/oauth/token`（授权码单次有效：未知 → `20003`、用过 → `20065`；`client_secret` 不符 →
 *   `20002`；`redirect_uri` 必须与授权时完全相同，否则 `20071`；带了 `code_challenge` 的授权码必须给对
 *   `code_verifier`，否则 `20049`；错误均为 HTTP 400 + `{code, error, error_description}`）、用户信息
 *   `GET /open-apis/authen/v1/user_info`（Bearer user_access_token；`open_id`、`union_id`、`tenant_key`、`name`、
 *   `en_name`、`avatar_*`、`email`、`enterprise_email`）。
 * - **通讯录**：`GET /open-apis/contact/v3/departments/:id/children`（`fetch_child=true` 时递归；`page_size` 最大 50，
 *   `page_token` / `has_more`）、`GET /open-apis/contact/v3/users/find_by_department`（部门直属用户，根部门为 `0`；
 *   `page_size` 最大 50；`status` 为 `is_frozen` / `is_resigned` / `is_activated` / `is_exited` / `is_unjoin`，
 *   {@link FakeLarkServer.hideUserStatus} 模拟没有开通状态字段所需的权限）。
 *
 * 记录：`messages`（发出的消息，卡片已解析）、`updates`（对已发消息的更新）、`calls`（每次 OpenAPI 调用）。
 */

export interface FakeLarkUser {
  openId: string;
  name: string;
  avatar72?: string;
  enName?: string;
  /** 用户所在租户（默认本服务的 `tenantKey`；`user_info` 的 `tenant_key`）。 */
  tenantKey?: string;
  email?: string;
  enterpriseEmail?: string;
  /** 直属部门（`open_department_id`，根部门为 `"0"`）；不给则不出现在通讯录列表里。 */
  departments?: string[];
  /** 通讯录 `status`（缺省：已激活，其他均为 false）。 */
  status?: {
    isFrozen?: boolean;
    isResigned?: boolean;
    isActivated?: boolean;
    isExited?: boolean;
    isUnjoin?: boolean;
  };
}

/** 通讯录部门。 */
export interface FakeLarkDepartment {
  openDepartmentId: string;
  name: string;
  /** 上级部门（根部门为 `"0"`）。 */
  parent: string;
}

/** 机器人发出（或更新后）的一条消息。 */
export interface FakeLarkMessage {
  messageId: string;
  chatId: string;
  /** 回复时：话题根消息 id。 */
  rootId?: string;
  /** 回复时：被回复的消息 id。 */
  parentId?: string;
  replyInThread: boolean;
  msgType: string;
  /** 解析后的 `content`（卡片 JSON）。 */
  card: unknown;
  uuid?: string;
  at: number;
}

export interface FakeLarkCall {
  api: string;
  token: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
}

/** 客户端对事件帧的响应。 */
export interface FakeLarkAck {
  id: string;
  code: number;
  /** 响应的 `data`（base64 JSON 解码后）；处理函数没有返回值时为 undefined。 */
  data?: unknown;
  at: number;
}

export interface FakeLarkFailure {
  /** HTTP 状态（默认 400）。 */
  status?: number;
  /** 响应体的 `code`（不给时只回 HTTP 状态与空体）。 */
  code?: number;
  msg?: string;
  /** 429 时的 `x-ogw-ratelimit-reset`（秒）。 */
  retryAfter?: number;
}

export interface FakeLarkOptions {
  appId?: string;
  appSecret?: string;
  tenantKey?: string;
  botOpenId?: string;
  botName?: string;
  /** 同一租户里的其他自建应用（只能取 tenant token、查企业信息；测试「登录 / 机器人不是同一个应用」）。 */
  extraApps?: { appId: string; appSecret: string }[];
}

/**
 * 接口名：`token`、`bot`、`tenant`、`create`、`reply`、`patch`、`user`、`endpoint`、`oauth_token`、`user_info`、
 * `departments`、`find_by_department`。
 */
export type FakeLarkApi =
  | "token"
  | "bot"
  | "tenant"
  | "create"
  | "reply"
  | "patch"
  | "user"
  | "endpoint"
  | "oauth_token"
  | "user_info"
  | "departments"
  | "find_by_department";

export interface FakeLarkServer {
  /** 开放平台根地址（插件的 `apiUrl` / SDK 的 `domain`）。 */
  url: string;
  appId: string;
  appSecret: string;
  tenantKey: string;
  botOpenId: string;
  botName: string;
  messages: FakeLarkMessage[];
  updates: FakeLarkMessage[];
  calls: FakeLarkCall[];
  acks: FakeLarkAck[];
  users: Map<string, FakeLarkUser>;
  /** 通讯录部门（按插入顺序列出）。 */
  departments: FakeLarkDepartment[];
  /** 已签发的 user_access_token 数。 */
  userTokensIssued(): number;
  /** 通讯录列表里不带 `status`（模拟没有开通状态字段所需的权限）。 */
  hideUserStatus(hide: boolean): void;
  /** 已签发的 tenant token 数。 */
  tokensIssued(): number;
  /** 吊销所有已签发的 token（之后的调用回 99991663）。 */
  revokeTokens(): void;
  /** 长连接接入点被调用的次数。 */
  endpointCalls(): number;
  /** 成功建立的 WebSocket 连接数。 */
  connectionsOpened(): number;
  openSockets(): number;
  maxConcurrentSockets(): number;
  /**
   * 当前打开的长连接各自的对端（客户端）TCP 端口，按打开顺序。双副本测试据此（经操作系统查端口属于哪个进程）
   * 找出持有长连接的副本——真实插件不带 `x-pid` 之类的标记。
   */
  socketPeerPorts(): number[];
  /** 接下来 `count` 次（先放过 `skip` 次正常调用）该接口返回 `failure`。 */
  failNext(api: FakeLarkApi, failure: FakeLarkFailure, count?: number, skip?: number): void;
  /**
   * 模拟应用的通讯录权限范围不是「全部成员」：对根部门（`0`）的子部门列表与直属用户列表回 HTTP 400
   * `40004`（无部门权限）。
   */
  rejectRootDepartment(reject: boolean): void;
  /** 之后该接口的每次调用先等 `ms` 毫秒再响应（0 取消）。 */
  delay(api: FakeLarkApi, ms: number): void;
  /** 接下来 `count` 条 WebSocket 连接在建立后立即被关闭。 */
  dropNextConnections(count: number): void;
  /** 登记一条（用户发的）消息，使之可以被回复。`pushEvent` 推的消息事件会自动登记。 */
  registerMessage(messageId: string, chatId: string): void;
  /**
   * 推一个事件（schema 2.0 负载，如 {@link larkMessageEvent} / {@link larkCardAction} 的结果）给最近打开的连接，
   * 返回帧的 message_id。缺省的 `header.tenant_key` / `app_id` 与 `event.sender.tenant_key` 用本服务的值补上。
   * 该连接还没收到客户端的第一个 ping 时先暂存、收到后再发：SDK 在 `open` 之后（微任务里）才挂上 message 监听，
   * 与握手响应一起到达的帧会被它丢掉（服务端此时已算连接打开）。
   */
  pushEvent(payload: Record<string, unknown>): string;
  waitForAck(id: string, timeoutMs?: number): Promise<FakeLarkAck>;
  acked(id: string): boolean;
  /** 关闭所有长连接（模拟服务端断开）。 */
  disconnectAll(): void;
  /** 消息最终的卡片（有更新取最后一次）。 */
  finalCard(m: FakeLarkMessage): unknown;
  /** 卡片里全部 markdown 组件的内容（按顺序，换行连接）。 */
  cardText(card: unknown): string;
  stop(): Promise<void>;
}

// SDK 内置的帧定义（@larksuiteoapi/node-sdk 的 pbbp2.Frame / pbbp2.Header）
const root = protobuf.Root.fromJSON({
  nested: {
    pbbp2: {
      nested: {
        Header: {
          fields: {
            key: { rule: "required", type: "string", id: 1 },
            value: { rule: "required", type: "string", id: 2 },
          },
        },
        Frame: {
          fields: {
            SeqID: { rule: "required", type: "uint64", id: 1 },
            LogID: { rule: "required", type: "uint64", id: 2 },
            service: { rule: "required", type: "int32", id: 3 },
            method: { rule: "required", type: "int32", id: 4 },
            headers: { rule: "repeated", type: "Header", id: 5 },
            payloadEncoding: { type: "string", id: 6 },
            payloadType: { type: "string", id: 7 },
            payload: { type: "bytes", id: 8 },
            LogIDNew: { type: "string", id: 9 },
          },
        },
      },
    },
  },
});
const Frame = root.lookupType("pbbp2.Frame");

interface FrameData {
  SeqID: number;
  LogID: number;
  service: number;
  method: number;
  headers: { key: string; value: string }[];
  payload?: Uint8Array;
}

const encodeFrame = (f: FrameData) => Buffer.from(Frame.encode(Frame.fromObject(f)).finish());
const decodeFrame = (b: Uint8Array) =>
  Frame.toObject(Frame.decode(b), { longs: Number, bytes: Buffer }) as FrameData;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => resolve(body));
  });

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const hex = (n: number) => randomBytes(n).toString("hex");

/** 卡片里的全部组件（展开 column_set / column / form）。 */
function walk(card: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (els: unknown) => {
    if (!Array.isArray(els)) return;
    for (const e of els) {
      const o = obj(e);
      if (!o) continue;
      out.push(o);
      visit(o.columns);
      visit(o.elements);
    }
  };
  visit(obj(obj(card)?.body)?.elements);
  return out;
}

/** 启动假 Lark（监听 127.0.0.1 随机端口）。 */
export async function startFakeLark(opts: FakeLarkOptions = {}): Promise<FakeLarkServer> {
  const appId = opts.appId ?? "cli_a1b2c3d4e5f60718";
  const appSecret = opts.appSecret ?? "fake-lark-app-secret";
  const tenantKey = opts.tenantKey ?? "tenant_fake";
  const botOpenId = opts.botOpenId ?? "ou_bot";
  const botName = opts.botName ?? "Capybara";
  const messages: FakeLarkMessage[] = [];
  const updates: FakeLarkMessage[] = [];
  const calls: FakeLarkCall[] = [];
  const acks: FakeLarkAck[] = [];
  const users = new Map<string, FakeLarkUser>();
  const departments: FakeLarkDepartment[] = [];
  const codes = new Map<
    string,
    {
      openId: string;
      redirectUri: string;
      challenge?: string;
      method: string;
      used: boolean;
    }
  >();
  const userTokens = new Map<string, string>();
  let userIssued = 0;
  let statusHidden = false;
  const known = new Map<string, { chatId: string; rootId?: string }>();
  const byUuid = new Map<string, string>();
  const tokens = new Set<string>();
  const failures: {
    api: FakeLarkApi;
    failure: FakeLarkFailure;
    left: number;
    skip: number;
  }[] = [];
  let rootRejected = false;
  const delays = new Map<FakeLarkApi, number>();
  const sockets: WebSocket[] = [];
  const peerPorts = new WeakMap<WebSocket, number>();
  const ackWaiters = new Map<string, ((a: FakeLarkAck) => void)[]>();
  let issued = 0;
  let endpoint = 0;
  let opened = 0;
  let peak = 0;
  let dropLeft = 0;
  let seq = 0;
  let base = "";

  const reply = (res: ServerResponse, body: unknown, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, code: number, msg = "error", status = 400) =>
    reply(res, { code, msg, data: {} }, status);

  /** 发送 / 回复 / 更新的内容校验；通过返回解析后的卡片。 */
  const checkContent = (res: ServerResponse, raw: string, body: Record<string, unknown>) => {
    if (Buffer.byteLength(raw) > 30_000) {
      fail(res, 230025, "The length of the message content reaches its limit.");
      return undefined;
    }
    const msgType = str(body.msg_type) ?? "interactive";
    let card: unknown;
    try {
      card = JSON.parse(str(body.content) ?? "");
    } catch {
      fail(res, 230001, "invalid content");
      return undefined;
    }
    if (msgType === "interactive") {
      const c = obj(card);
      if (c?.schema !== "2.0" || obj(c.config)?.update_multi === false || !obj(c.body)) {
        fail(res, 230099, "Failed to create card content.");
        return undefined;
      }
    }
    return { msgType, card };
  };

  const api = async (req: IncomingMessage, res: ServerResponse, u: URL) => {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try {
      body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return fail(res, 9499, "bad request");
    }
    const path = u.pathname;
    const method = req.method ?? "GET";
    const reply$ = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path);
    const msg$ = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path);
    const user$ =
      path === "/open-apis/contact/v3/users/find_by_department"
        ? null
        : /^\/open-apis\/contact\/v3\/users\/([^/]+)$/.exec(path);
    const dept$ = /^\/open-apis\/contact\/v3\/departments\/([^/]+)\/children$/.exec(path);
    let name: FakeLarkApi | undefined;
    if (path === "/open-apis/auth/v3/tenant_access_token/internal" && method === "POST")
      name = "token";
    else if (path === "/open-apis/bot/v3/info" && method === "GET") name = "bot";
    else if (path === "/open-apis/tenant/v2/tenant/query" && method === "GET") name = "tenant";
    else if (path === "/open-apis/im/v1/messages" && method === "POST") name = "create";
    else if (reply$ && method === "POST") name = "reply";
    else if (msg$ && method === "PATCH") name = "patch";
    else if (user$ && method === "GET") name = "user";
    else if (path === "/callback/ws/endpoint" && method === "POST") name = "endpoint";
    else if (path === "/open-apis/authen/v2/oauth/token" && method === "POST") name = "oauth_token";
    else if (path === "/open-apis/authen/v1/user_info" && method === "GET") name = "user_info";
    else if (dept$ && method === "GET") name = "departments";
    else if (path === "/open-apis/contact/v3/users/find_by_department" && method === "GET")
      name = "find_by_department";
    if (name === undefined) return fail(res, 404, "not found", 404);

    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    calls.push({ api: name, token, query: Object.fromEntries(u.searchParams), body });
    if (name === "endpoint") endpoint++;
    const wait = delays.get(name) ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let f = failures.find((x) => x.api === name && x.left > 0);
    if (f && f.skip > 0) {
      f.skip--;
      f = undefined;
    }
    if (f) {
      f.left--;
      const { status = name === "endpoint" ? 200 : 400, code, msg, retryAfter } = f.failure;
      const headers =
        retryAfter !== undefined ? { "x-ogw-ratelimit-reset": String(retryAfter) } : {};
      if (code === undefined) return reply(res, {}, status, headers);
      return reply(
        res,
        { code, msg: msg ?? "error", data: name === "endpoint" ? { URL: "" } : {} },
        status,
        headers,
      );
    }

    if (name === "token") {
      const app = [{ appId, appSecret }, ...(opts.extraApps ?? [])].find(
        (a) => a.appId === str(body.app_id),
      );
      if (!app) return reply(res, { code: 10014, msg: "app id not exists" });
      if (str(body.app_secret) !== app.appSecret)
        return reply(res, { code: 10015, msg: "wrong app secret" });
      const t = `t-fake-${++issued}-${hex(4)}`;
      tokens.add(t);
      return reply(res, { code: 0, msg: "ok", tenant_access_token: t, expire: 7200 });
    }
    if (name === "oauth_token") return oauthToken(res, body);
    if (name === "user_info") {
      const openId = userTokens.get(token);
      const usr = openId !== undefined ? users.get(openId) : undefined;
      if (!usr) return fail(res, 20005, "The user access token passed is invalid", 401);
      return reply(res, {
        code: 0,
        msg: "success",
        data: {
          name: usr.name,
          ...(usr.enName !== undefined && { en_name: usr.enName }),
          ...(usr.avatar72 !== undefined && {
            avatar_url: usr.avatar72,
            avatar_thumb: usr.avatar72,
          }),
          open_id: usr.openId,
          union_id: `on_${usr.openId}`,
          ...(usr.email !== undefined && { email: usr.email }),
          ...(usr.enterpriseEmail !== undefined && { enterprise_email: usr.enterpriseEmail }),
          tenant_key: usr.tenantKey ?? tenantKey,
        },
      });
    }
    if (name === "endpoint") {
      if (str(body.AppID) !== appId || str(body.AppSecret) !== appSecret) {
        return reply(res, { code: 1000040343, msg: "internal error", data: { URL: "" } });
      }
      const wsUrl = `${base.replace(/^http/, "ws")}/ws?fake=1&device_id=dev_1&service_id=1&ticket=${hex(4)}`;
      return reply(res, {
        code: 0,
        msg: "ok",
        data: {
          URL: wsUrl,
          ClientConfig: {
            PingInterval: 120,
            ReconnectCount: -1,
            ReconnectInterval: 120,
            ReconnectNonce: 30,
          },
        },
      });
    }
    if (!tokens.has(token)) return fail(res, 99991663, "tenant token invalid");

    switch (name) {
      case "bot":
        return reply(res, {
          code: 0,
          msg: "ok",
          bot: {
            activate_status: 2,
            app_name: botName,
            avatar_url: "",
            ip_white_list: [],
            open_id: botOpenId,
          },
        });
      case "tenant":
        return reply(res, {
          code: 0,
          msg: "ok",
          data: {
            tenant: {
              name: "Fake Tenant",
              display_id: "F001",
              tenant_tag: 0,
              tenant_key: tenantKey,
              avatar: {},
            },
          },
        });
      case "user": {
        const id = decodeURIComponent(user$?.[1] ?? "");
        const usr = users.get(id);
        if (!usr) return fail(res, 41050, "no user authority");
        return reply(res, {
          code: 0,
          msg: "ok",
          data: {
            user: {
              open_id: usr.openId,
              name: usr.name,
              ...(usr.avatar72 !== undefined && { avatar: { avatar_72: usr.avatar72 } }),
            },
          },
        });
      }
      case "create":
      case "reply": {
        const uuid = str(body.uuid);
        if (uuid !== undefined && uuid.length > 50) return fail(res, 230001, "uuid too long");
        const dupId = uuid !== undefined ? byUuid.get(uuid) : undefined;
        if (dupId !== undefined) {
          const m = messages.find((x) => x.messageId === dupId);
          return reply(res, {
            code: 0,
            msg: "ok",
            data: { message_id: dupId, chat_id: m?.chatId },
          });
        }
        const content = checkContent(res, raw, body);
        if (!content) return;
        let chatId: string;
        let rootId: string | undefined;
        let parentId: string | undefined;
        if (name === "create") {
          if (u.searchParams.get("receive_id_type") !== "chat_id")
            return fail(res, 230001, "receive_id_type");
          const rid = str(body.receive_id);
          if (!rid) return fail(res, 230001, "receive_id");
          chatId = rid;
        } else {
          parentId = decodeURIComponent(reply$?.[1] ?? "");
          const parent = known.get(parentId);
          if (!parent) return fail(res, 230001, "message not found");
          chatId = parent.chatId;
          rootId = parent.rootId ?? parentId;
        }
        const m: FakeLarkMessage = {
          messageId: `om_${hex(12)}`,
          chatId,
          ...(rootId !== undefined && { rootId }),
          ...(parentId !== undefined && { parentId }),
          replyInThread: name === "reply" && body.reply_in_thread === true,
          msgType: content.msgType,
          card: content.card,
          ...(uuid !== undefined && { uuid }),
          at: Date.now(),
        };
        messages.push(m);
        known.set(m.messageId, { chatId, ...(rootId !== undefined && { rootId }) });
        if (uuid !== undefined) byUuid.set(uuid, m.messageId);
        return reply(res, {
          code: 0,
          msg: "ok",
          data: {
            message_id: m.messageId,
            chat_id: chatId,
            ...(rootId !== undefined && { root_id: rootId }),
          },
        });
      }
      case "patch": {
        const id = decodeURIComponent(msg$?.[1] ?? "");
        const orig = messages.find((x) => x.messageId === id);
        if (!orig) return fail(res, 230001, "message not found");
        if (orig.msgType !== "interactive")
          return fail(res, 230001, "only interactive messages can be patched");
        const content = checkContent(res, raw, { ...body, msg_type: "interactive" });
        if (!content) return;
        updates.push({ ...orig, card: content.card, at: Date.now() });
        return reply(res, { code: 0, msg: "ok", data: {} });
      }
      case "departments": {
        const id = decodeURIComponent(dept$?.[1] ?? "");
        if (rootRejected && id === "0") return fail(res, 40004, "no dept authority");
        const deep = u.searchParams.get("fetch_child") === "true";
        const under = (p: string): FakeLarkDepartment[] =>
          departments
            .filter((d) => d.parent === p)
            .flatMap((d) => (deep ? [d, ...under(d.openDepartmentId)] : [d]));
        return page(res, u, under(id), (d) => ({
          name: d.name,
          parent_department_id: d.parent,
          open_department_id: d.openDepartmentId,
        }));
      }
      case "find_by_department": {
        const id = u.searchParams.get("department_id");
        if (id === null || id === "") return fail(res, 99992402, "department_id is required");
        if (rootRejected && id === "0") return fail(res, 40004, "no dept authority");
        const all = [...users.values()].filter((x) => x.departments?.includes(id));
        return page(res, u, all, (x) => ({
          open_id: x.openId,
          union_id: `on_${x.openId}`,
          name: x.name,
          ...(x.enName !== undefined && { en_name: x.enName }),
          ...(x.email !== undefined && { email: x.email }),
          ...(x.enterpriseEmail !== undefined && { enterprise_email: x.enterpriseEmail }),
          ...(!statusHidden && {
            status: {
              is_frozen: x.status?.isFrozen === true,
              is_resigned: x.status?.isResigned === true,
              is_activated: x.status?.isActivated !== false,
              is_exited: x.status?.isExited === true,
              is_unjoin: x.status?.isUnjoin === true,
            },
          }),
          department_ids: x.departments ?? [],
        }));
      }
      default:
        return fail(res, 404, "not found", 404);
    }
  };

  /** 通讯录分页：`page_size`（默认 10，最大 50）+ 不透明的 `page_token`（偏移量的 base64url）。 */
  function page<T>(res: ServerResponse, u: URL, all: T[], map: (x: T) => Record<string, unknown>) {
    const size = Number(u.searchParams.get("page_size") ?? "10");
    if (!Number.isInteger(size) || size < 1 || size > 50) return fail(res, 99992402, "page_size");
    const tok = u.searchParams.get("page_token");
    const offset = tok ? Number(Buffer.from(tok, "base64url").toString()) : 0;
    if (!Number.isInteger(offset) || offset < 0) return fail(res, 99992402, "page_token");
    const more = offset + size < all.length;
    return reply(res, {
      code: 0,
      msg: "success",
      data: {
        has_more: more,
        ...(more && { page_token: Buffer.from(String(offset + size)).toString("base64url") }),
        items: all.slice(offset, offset + size).map(map),
      },
    });
  }

  /** OAuth 错误：HTTP 400 + `{code, error, error_description}`（与 Lark v2 token 接口一致）。 */
  const oauthFail = (res: ServerResponse, code: number, error: string, description: string) =>
    reply(res, { code, error, error_description: description }, 400);

  function oauthToken(res: ServerResponse, body: Record<string, unknown>) {
    if (body.grant_type !== "authorization_code")
      return oauthFail(res, 20036, "unsupported_grant_type", "grant_type");
    if (str(body.client_id) !== appId || str(body.client_secret) !== appSecret)
      return oauthFail(res, 20002, "invalid_client", "The client secret is invalid.");
    const rec = codes.get(str(body.code) ?? "");
    if (!rec) return oauthFail(res, 20003, "invalid_grant", "The authorization code is not found.");
    if (rec.used)
      return oauthFail(res, 20065, "invalid_grant", "The authorization code has been used.");
    rec.used = true;
    if (str(body.redirect_uri) !== rec.redirectUri)
      return oauthFail(res, 20071, "invalid_grant", "The provided redirect URI does not match.");
    if (rec.challenge !== undefined) {
      const verifier = str(body.code_verifier) ?? "";
      const expected =
        rec.method === "S256"
          ? createHash("sha256").update(verifier).digest("base64url")
          : verifier;
      if (verifier === "" || expected !== rec.challenge)
        return oauthFail(res, 20049, "invalid_grant", "PKCE code challenge failed.");
    }
    const t = `u-fake-${++userIssued}-${hex(6)}`;
    userTokens.set(t, rec.openId);
    return reply(res, {
      code: 0,
      access_token: t,
      expires_in: 7200,
      token_type: "Bearer",
      scope: "",
    });
  }

  /** 授权页：`&as=<open_id>` 表示该用户同意授权。 */
  function authorize(res: ServerResponse, u: URL) {
    const redirect = u.searchParams.get("redirect_uri");
    if (!redirect) return fail(res, 20001, "redirect_uri is required");
    const back = new URL(redirect);
    const state = u.searchParams.get("state");
    if (state !== null) back.searchParams.set("state", state);
    const as = u.searchParams.get("as") ?? "";
    if (u.searchParams.get("client_id") !== appId || !users.has(as)) {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = hex(24);
      const challenge = u.searchParams.get("code_challenge");
      codes.set(code, {
        openId: as,
        redirectUri: redirect,
        ...(challenge !== null && { challenge }),
        method: u.searchParams.get("code_challenge_method") ?? "plain",
        used: false,
      });
      back.searchParams.set("code", code);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/open-apis/authen/v1/authorize" && req.method === "GET")
        return authorize(res, u);
      return api(req, res, u);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const recordAck = (f: FrameData) => {
    const id = f.headers.find((h) => h.key === "message_id")?.value;
    if (id === undefined || !f.payload) return;
    let resp: { code?: unknown; data?: unknown };
    try {
      resp = JSON.parse(Buffer.from(f.payload).toString("utf8")) as typeof resp;
    } catch {
      return;
    }
    let data: unknown;
    if (typeof resp.data === "string") {
      try {
        data = JSON.parse(Buffer.from(resp.data, "base64").toString("utf8"));
      } catch {
        data = resp.data;
      }
    }
    const a: FakeLarkAck = {
      id,
      code: typeof resp.code === "number" ? resp.code : 0,
      ...(data !== undefined && { data }),
      at: Date.now(),
    };
    acks.push(a);
    for (const w of ackWaiters.get(id) ?? []) w(a);
    ackWaiters.delete(id);
  };

  /** 已收到第一个 ping 的连接（客户端已挂上 message 监听）；之前推的帧暂存在 `held`。 */
  const listening = new WeakSet<WebSocket>();
  const held = new Map<WebSocket, Buffer[]>();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      opened++;
      sockets.push(ws);
      if (req.socket.remotePort !== undefined) peerPorts.set(ws, req.socket.remotePort);
      peak = Math.max(peak, sockets.length);
      ws.on("close", () => {
        const i = sockets.indexOf(ws);
        if (i >= 0) sockets.splice(i, 1);
        held.delete(ws);
      });
      ws.on("message", (data: RawData) => {
        let f: FrameData;
        try {
          f = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        } catch {
          return;
        }
        const type = f.headers.find((h) => h.key === "type")?.value;
        if (f.method === 0 && type === "ping") {
          if (!listening.has(ws)) {
            listening.add(ws);
            for (const b of held.get(ws) ?? []) ws.send(b);
            held.delete(ws);
          }
          ws.send(
            encodeFrame({
              SeqID: 0,
              LogID: 0,
              service: f.service,
              method: 0,
              headers: [{ key: "type", value: "pong" }],
              payload: Buffer.from(
                JSON.stringify({
                  PingInterval: 120,
                  ReconnectCount: -1,
                  ReconnectInterval: 120,
                  ReconnectNonce: 30,
                }),
              ),
            }),
          );
          return;
        }
        if (f.method === 1) recordAck(f);
      });
      if (dropLeft > 0) {
        dropLeft--;
        setImmediate(() => ws.close(1011));
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const pushEvent: FakeLarkServer["pushEvent"] = (payload) => {
    const ws = sockets.at(-1);
    if (!ws) throw new Error("fake lark: no open long connection");
    const header = { ...obj(payload.header) };
    header.tenant_key ??= tenantKey;
    header.app_id ??= appId;
    const event = { ...obj(payload.event) };
    const sender = obj(event.sender);
    if (sender) event.sender = { ...sender, tenant_key: sender.tenant_key ?? tenantKey };
    const message = obj(event.message);
    const mid = str(message?.message_id);
    const cid = str(message?.chat_id);
    if (mid && cid) {
      const rid = str(message?.root_id);
      known.set(mid, { chatId: cid, ...(rid !== undefined && { rootId: rid }) });
    }
    const full = { ...payload, header, event };
    const id = `frame_${++seq}_${hex(3)}`;
    const frame = encodeFrame({
      SeqID: seq,
      LogID: seq,
      service: 1,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: id },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
        { key: "trace_id", value: `trace_${seq}` },
      ],
      payload: Buffer.from(JSON.stringify(full)),
    });
    if (listening.has(ws)) ws.send(frame);
    else held.set(ws, [...(held.get(ws) ?? []), frame]);
    return id;
  };

  return {
    url: base,
    appId,
    appSecret,
    tenantKey,
    botOpenId,
    botName,
    messages,
    updates,
    calls,
    acks,
    users,
    departments,
    userTokensIssued: () => userIssued,
    hideUserStatus(hide) {
      statusHidden = hide;
    },
    tokensIssued: () => issued,
    revokeTokens: () => tokens.clear(),
    endpointCalls: () => endpoint,
    connectionsOpened: () => opened,
    openSockets: () => sockets.length,
    maxConcurrentSockets: () => peak,
    socketPeerPorts: () =>
      sockets.flatMap((ws) => {
        const port = peerPorts.get(ws);
        return port === undefined ? [] : [port];
      }),
    failNext(api, failure, count = 1, skip = 0) {
      failures.push({ api, failure, left: count, skip });
    },
    rejectRootDepartment(reject) {
      rootRejected = reject;
    },
    delay(api, ms) {
      delays.set(api, ms);
    },
    dropNextConnections(count) {
      dropLeft = count;
    },
    registerMessage(messageId, chatId) {
      known.set(messageId, { chatId });
    },
    pushEvent,
    waitForAck(id, timeoutMs = 5000) {
      const done = acks.find((a) => a.id === id);
      if (done) return Promise.resolve(done);
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`fake lark: frame ${id} not acknowledged`)),
          timeoutMs,
        );
        const list = ackWaiters.get(id) ?? [];
        list.push((a) => {
          clearTimeout(t);
          resolve(a);
        });
        ackWaiters.set(id, list);
      });
    },
    acked: (id) => acks.some((a) => a.id === id),
    disconnectAll() {
      for (const ws of [...sockets]) ws.close(1000);
    },
    finalCard(m) {
      return updates.filter((x) => x.messageId === m.messageId).at(-1)?.card ?? m.card;
    },
    cardText(card) {
      return walk(card)
        .filter((e) => e.tag === "markdown")
        .map((e) => String(e.content))
        .join("\n");
    },
    async stop() {
      for (const ws of [...sockets]) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 一条 `im.message.receive_v1` 事件（schema 2.0）。`text` 给的是 text 消息的原文（@ 用 `@_user_N` 占位）。 */
export function larkMessageEvent(o: {
  openId: string;
  chatId: string;
  chatType: "p2p" | "group";
  text?: string;
  messageId?: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions?: { key: string; openId: string; name: string }[];
  tenantKey?: string;
  messageType?: string;
  content?: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: `ev_${hex(8)}`,
      event_type: "im.message.receive_v1",
      create_time: String(Date.now()),
      token: "verification-token",
      ...(o.tenantKey !== undefined && { tenant_key: o.tenantKey }),
    },
    event: {
      sender: {
        sender_id: { open_id: o.openId, union_id: `on_${o.openId}` },
        sender_type: "user",
        ...(o.tenantKey !== undefined && { tenant_key: o.tenantKey }),
      },
      message: {
        message_id: o.messageId ?? `om_${hex(12)}`,
        ...(o.rootId !== undefined && { root_id: o.rootId }),
        ...((o.parentId ?? o.rootId) !== undefined && { parent_id: o.parentId ?? o.rootId }),
        ...(o.threadId !== undefined && { thread_id: o.threadId }),
        create_time: String(Date.now()),
        chat_id: o.chatId,
        chat_type: o.chatType,
        message_type: o.messageType ?? "text",
        content: o.content ?? JSON.stringify({ text: o.text ?? "" }),
        ...(o.mentions !== undefined && {
          mentions: o.mentions.map((m) => ({
            key: m.key,
            id: { open_id: m.openId, union_id: `on_${m.openId}` },
            name: m.name,
            ...(o.tenantKey !== undefined && { tenant_key: o.tenantKey }),
          })),
        }),
      },
    },
  };
}

/** 卡片按钮（{@link findLarkButton} 的结果）。 */
export interface FakeLarkButton {
  text: string;
  type?: string;
  name?: string;
  /** 回传值（`behaviors` 里 `callback` 的 `value`）。 */
  value?: unknown;
  /** 打开链接（`behaviors` 里 `open_url` 的 `default_url`）。 */
  url?: string;
}

/** 在卡片里找按钮（展开 column_set / form）。 */
export function findLarkButton(
  card: unknown,
  match: (b: FakeLarkButton) => boolean,
): FakeLarkButton | undefined {
  for (const e of walk(card)) {
    if (e.tag !== "button") continue;
    const behaviors = Array.isArray(e.behaviors) ? (e.behaviors as Record<string, unknown>[]) : [];
    const cb = behaviors.find((b) => b.type === "callback");
    const open = behaviors.find((b) => b.type === "open_url");
    const b: FakeLarkButton = {
      text: String(obj(e.text)?.content ?? ""),
      ...(typeof e.type === "string" && { type: e.type }),
      ...(typeof e.name === "string" && { name: e.name }),
      ...(cb !== undefined && { value: cb.value }),
      ...(typeof open?.default_url === "string" && { url: open.default_url }),
    };
    if (match(b)) return b;
  }
  return undefined;
}

/** 用户点了某条消息卡片上的按钮（`card.action.trigger`，schema 2.0）。`formValue` 为表单提交的数据。 */
export function larkCardAction(
  user: { openId: string; tenantKey?: string },
  message: FakeLarkMessage,
  button: FakeLarkButton,
  opts: { eventId?: string; formValue?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: opts.eventId ?? `evt_${hex(8)}`,
      token: "verification-token",
      create_time: String(Date.now() * 1000),
      event_type: "card.action.trigger",
      ...(user.tenantKey !== undefined && { tenant_key: user.tenantKey }),
    },
    event: {
      operator: {
        open_id: user.openId,
        union_id: `on_${user.openId}`,
        ...(user.tenantKey !== undefined && { tenant_key: user.tenantKey }),
      },
      token: `c-${hex(8)}`,
      action: {
        tag: "button",
        ...(button.value !== undefined && { value: button.value }),
        ...(button.name !== undefined && { name: button.name }),
        ...(opts.formValue !== undefined && { form_value: opts.formValue }),
      },
      host: "im_message",
      context: { open_message_id: message.messageId, open_chat_id: message.chatId },
    },
  };
}

/**
 * Encrypts a Lark webhook payload the way Lark does when an Encrypt Key is set
 * (https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case):
 * AES-256-CBC with key = SHA-256(encryptKey), a random 16-byte IV prepended to the ciphertext,
 * base64. Returns the request body `{"encrypt":"<base64>"}`.
 */
export function encryptLarkWebhook(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return JSON.stringify({ encrypt: Buffer.concat([iv, enc]).toString("base64") });
}

/**
 * Signs a Lark webhook request: returns the `x-lark-request-timestamp` (seconds),
 * `x-lark-request-nonce` and `x-lark-signature` headers, where the signature is
 * hex SHA-256(timestamp + nonce + encryptKey + raw body).
 */
export function signLarkWebhook(
  body: string | Uint8Array,
  encryptKey: string,
  opts: { timestamp?: number; nonce?: string } = {},
): Record<string, string> {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? hex(8);
  const sig = createHash("sha256")
    .update(ts + nonce + encryptKey)
    .update(typeof body === "string" ? Buffer.from(body) : Buffer.from(body))
    .digest("hex");
  return {
    "x-lark-request-timestamp": ts,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": sig,
  };
}
