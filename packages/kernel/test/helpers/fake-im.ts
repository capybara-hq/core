import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  CardAction,
  ChannelTarget,
  InboundEvent,
  OutboundMessage,
} from "@capybara-hq/plugin-sdk";

/** 一条长连接（测试插件 chan-mini 发起）。 */
export interface FakeImStream {
  connectionId: string;
  /** 发起连接的进程 pid（请求头 `x-pid`）。 */
  pid: number;
  openedAt: number;
  closedAt: number | undefined;
}

/** 机器人发出（或更新）的一条消息。 */
export interface FakeImSent {
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

/**
 * 假 IM 平台：接受测试插件 chan-mini 的 NDJSON 长连接，向当前连上的长连接推送入站事件，记下机器人发出的消息。
 * 统计每个渠道连接同时在线的长连接数峰值（Review Focus 1：任一时刻只能有一条）。
 */
export interface FakeIm {
  url: string;
  streams: FakeImStream[];
  sent: FakeImSent[];
  /** 机器人对已发消息的更新（`messageId` 为被更新的消息）。 */
  updated: FakeImSent[];
  /**
   * 让接下来 `count` 次 `/send`（或 `/update`）返回该状态码（不记录）；`retryAfterMs` 放进响应体，
   * 测试插件据此抛可重试的 `ChannelSendError`。
   */
  failNext(path: "/send" | "/update", status: number, count?: number, retryAfterMs?: number): void;
  /** 该渠道连接当前在线的长连接。 */
  active(connectionId: string): FakeImStream[];
  /** 该渠道连接同时在线长连接数的峰值。 */
  maxConcurrent(connectionId: string): number;
  /** 推送给该渠道连接当前所有在线长连接，返回推送到的条数。 */
  push(connectionId: string, event: InboundEvent): number;
  /** 让 /connect 返回该状态码（null 恢复正常）。 */
  failConnect(status: number | null): void;
  stop(): Promise<void>;
}

export async function startFakeIm(): Promise<FakeIm> {
  const streams: FakeImStream[] = [];
  const sent: FakeImSent[] = [];
  const updated: FakeImSent[] = [];
  const failures: { path: string; status: number; left: number; retryAfterMs?: number }[] = [];
  const live = new Map<FakeImStream, ServerResponse>();
  const peaks = new Map<string, number>();
  let failStatus: number | null = null;
  let seq = 0;

  const activeOf = (id: string) => [...live.keys()].filter((s) => s.connectionId === id);

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && u.pathname === "/connect") {
      if (failStatus !== null) {
        res.writeHead(failStatus).end();
        return;
      }
      const s: FakeImStream = {
        connectionId: u.searchParams.get("connection") ?? "",
        pid: Number(req.headers["x-pid"]),
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
      return;
    }
    if (req.method === "POST" && (u.pathname === "/send" || u.pathname === "/update")) {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString();
      });
      req.on("end", () => {
        const f = failures.find((x) => x.path === u.pathname && x.left > 0);
        if (f) {
          f.left--;
          res.writeHead(f.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ retryAfterMs: f.retryAfterMs ?? null }));
          return;
        }
        const b = JSON.parse(body) as Omit<FakeImSent, "messageId" | "pid" | "at"> & {
          messageId?: string;
        };
        const messageId = b.messageId ?? `om_${++seq}`;
        const rec = { ...b, messageId, pid: Number(req.headers["x-pid"]), at: Date.now() };
        if (u.pathname === "/send") sent.push(rec);
        else updated.push(rec);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    streams,
    sent,
    updated,
    failNext(path, status, count = 1, retryAfterMs) {
      failures.push({
        path,
        status,
        left: count,
        ...(retryAfterMs !== undefined && { retryAfterMs }),
      });
    },
    active: activeOf,
    maxConcurrent: (id) => peaks.get(id) ?? 0,
    push(connectionId, event) {
      const targets = activeOf(connectionId);
      for (const s of targets) live.get(s)?.write(`${JSON.stringify(event)}\n`);
      return targets.length;
    },
    failConnect(status) {
      failStatus = status;
    },
    async stop() {
      for (const res of live.values()) res.destroy();
      live.clear();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** 私聊文本消息。 */
export function dm(
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

/** 卡片按钮操作。 */
export function cardAction(
  messageId: string,
  externalId: string,
  action: CardAction,
  target: ChannelTarget,
  tenantId = "t1",
): InboundEvent {
  return {
    type: "card_action",
    messageId,
    target,
    sender: { externalId, tenantId },
    action,
  };
}

/** 群聊文本消息。 */
export function group(
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
