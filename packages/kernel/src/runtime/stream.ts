import type { Logger } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import {
  CONVERSATION_CHANGES,
  type ConversationBusMessage,
  conversationTopic,
  type EventLog,
} from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { ApiError, type ErrorCode } from "../errors.js";
import type { CredentialCheck } from "../identity/credential-check.js";
import { isUiBusMessage, uiFrame } from "../ui/registry.js";

/** 一次 SSE 连接的输出端（由 HTTP 层包装原始响应）。 */
export interface SseOutput {
  write(chunk: string): void;
  /** 已写入但尚未发出的字节数（慢客户端积压）。 */
  backlog(): number;
  /** 正常结束（发完已缓冲的数据后 FIN）。 */
  end(): void;
  /** 立即销毁连接并释放已缓冲的数据（慢客户端、内部故障）。 */
  abort(): void;
}

/** 流用到的总线：内核 bus（命名空间 `kernel`）。 */
export interface StreamBus {
  subscribe(topic: string, handler: (payload: unknown) => unknown): Promise<() => Promise<void>>;
}

export interface ConversationStreamsDeps {
  eventLog: Pick<EventLog, "readAfter">;
  bus: StreamBus;
  /** 轻量可见性判定：连接建立时与每 `sseRecheckMs` 复核一次。 */
  access(orgId: string, conversationId: string, viewerAccountId: string): Promise<boolean>;
  config: () => KernelConfig;
  log: Pick<Logger, "warn">;
}

export interface StreamParams {
  orgId: string;
  conversationId: string;
  viewerAccountId: string;
  /** 只发送 seq 大于它的事件。 */
  afterSeq: number;
  /** 复核建立连接时使用的凭据（会话未吊销 / 令牌仍有效），与可见性一起在建立时与每次复核时检查。 */
  credential: CredentialCheck;
}

/** 一条已订阅、尚未开始输出的流：HTTP 层写完响应头后调用 `begin`。 */
export interface StreamHandle {
  begin(): void;
  /**
   * 关闭流：`end` 正常结束响应，`abort` 销毁连接。`begin()` 之前不碰输出端
   * （响应还没开始，由 HTTP 层按普通错误返回）。
   */
  close(mode?: "end" | "abort"): void;
}

/** 补读事件的分页大小。 */
const PAGE = 500;
/** 慢客户端的积压上限：超过即关闭流，客户端带 Last-Event-ID 重连补读。 */
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;

/** 授权失败时随错误返回的英文说明（建立连接时作为普通错误响应）。 */
const DENIAL_MESSAGES: Partial<Record<ErrorCode, string>> = {
  "conversation.not_found": "Conversation not found",
  "auth.session_revoked": "Session has been revoked",
  "auth.required": "Authentication required",
};

/** 凭据仍有效且会话仍可见返回 null，否则返回错误码（凭据优先）。 */
async function authorize(d: ConversationStreamsDeps, p: StreamParams): Promise<ErrorCode | null> {
  const denied = await p.credential();
  if (denied !== null) return denied;
  const ok = await d.access(p.orgId, p.conversationId, p.viewerAccountId);
  return ok ? null : "conversation.not_found";
}

const errorFrame = (code: ErrorCode): string =>
  `event: error\ndata: ${JSON.stringify({ code })}\n\n`;

function isBusMessage(m: unknown): m is ConversationBusMessage {
  if (typeof m !== "object" || m === null) return false;
  const k = (m as { kind?: unknown }).kind;
  if (k === "events") return typeof (m as { toSeq?: unknown }).toSeq === "number";
  if (k === "ui") return isUiBusMessage(m);
  if (k === "changed") {
    const what = (m as { what?: unknown }).what;
    return (CONVERSATION_CHANGES as readonly unknown[]).includes(what);
  }
  if (k === "subagent_progress") {
    const x = m as { subagentId?: unknown; step?: unknown; toolCalls?: unknown };
    return (
      typeof x.subagentId === "string" &&
      typeof x.step === "number" &&
      typeof x.toolCalls === "number"
    );
  }
  return k === "delta" && typeof (m as { runId?: unknown }).runId === "string";
}

const eventFrame = (e: ConversationEvent): string =>
  `id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * 会话事件流（SSE）：本进程持有的连接集合，停机时一并关闭。
 * 跨副本的数据只经 PG（事件日志）与内核 bus（`conv.<id>`）流动，进程内只保存连接本身的资源
 * （订阅、心跳与复核定时器）。
 */
export class ConversationStreams {
  private readonly active = new Set<Connection>();
  /** Set by {@link closeAll}: streams opened afterwards end as soon as they begin. */
  private closing = false;

  constructor(private readonly d: ConversationStreamsDeps) {}

  /**
   * 复核凭据与可见性，并先订阅会话频道（之后再回放，避免遗漏两者之间提交的事件）。
   * 凭据失效 → 对应的 `auth.*`；不可见 → `conversation.not_found`；订阅失败照常抛出。此时尚未写任何响应，调用方可以按普通错误返回。
   */
  async open(p: StreamParams, out: SseOutput): Promise<StreamHandle> {
    const denied = await authorize(this.d, p);
    if (denied !== null) throw new ApiError(denied, DENIAL_MESSAGES[denied] ?? "Access denied");
    if (this.closing) return endedStream(out);
    const conn = new Connection(this.d, p, out, () => this.active.delete(conn));
    this.active.add(conn);
    try {
      await conn.subscribe();
    } catch (e) {
      conn.close();
      throw e;
    }
    // closeAll ran while subscribing: the connection is closed, the response must still end
    if (this.closing) {
      conn.close();
      return endedStream(out);
    }
    return conn;
  }

  /**
   * Closes every stream of this process (at shutdown) and latches: a stream opened afterwards ends
   * right after its headers, so a reconnecting client cannot hold the HTTP close open.
   */
  closeAll(): void {
    this.closing = true;
    for (const c of [...this.active]) c.close();
  }

  /** 当前打开的流数（测试用）。 */
  get size(): number {
    return this.active.size;
  }
}

/**
 * The handle of a stream opened after shutdown began: `begin` (the headers are written) ends the
 * response at once; the client reconnects with `Last-Event-ID`, to a replica that is still ready.
 */
export function endedStream(out: SseOutput): StreamHandle {
  return {
    begin: () => {
      try {
        out.end();
      } catch {
        // the connection is already gone
      }
    },
    close: () => {},
  };
}

class Connection implements StreamHandle {
  private lastSeq: number;
  private closed = false;
  private chain: Promise<void>;
  private openGate!: () => void;
  private unsubscribe: (() => Promise<void>) | undefined;
  private timers: NodeJS.Timeout[] = [];
  private rechecking = false;
  private begun = false;

  constructor(
    private readonly d: ConversationStreamsDeps,
    private readonly p: StreamParams,
    private readonly out: SseOutput,
    private readonly onClosed: () => void,
  ) {
    this.lastSeq = p.afterSeq;
    // 所有输出串行：先回放，之后按到达顺序处理频道消息；begin() 之前闸门关着。
    this.chain = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    this.enqueue(() => this.catchUp());
  }

  async subscribe(): Promise<void> {
    const un = await this.d.bus.subscribe(conversationTopic(this.p.conversationId), (m) =>
      this.onMessage(m),
    );
    if (this.closed) await un();
    else this.unsubscribe = un;
  }

  begin(): void {
    if (this.closed) return;
    this.begun = true;
    const { sseHeartbeatMs, sseRecheckMs } = this.d.config().runtime;
    this.timers.push(
      setInterval(() => this.write(": ping\n\n"), sseHeartbeatMs),
      setInterval(() => void this.recheck(), sseRecheckMs),
    );
    this.openGate();
  }

  close(mode: "end" | "abort" = "end"): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.openGate();
    const un = this.unsubscribe;
    this.unsubscribe = undefined;
    un?.().catch((err) =>
      this.d.log.warn("conversation stream unsubscribe failed", {
        conversationId: this.p.conversationId,
        err,
      }),
    );
    if (this.begun) {
      try {
        if (mode === "abort") this.out.abort();
        else this.out.end();
      } catch {
        // 连接已断开
      }
    }
    this.onClosed();
  }

  private onMessage(m: unknown): void {
    if (this.closed || !isBusMessage(m)) return;
    if (m.kind === "events") {
      const toSeq = m.toSeq;
      this.enqueue(async () => {
        if (toSeq > this.lastSeq) await this.catchUp();
      });
      return;
    }
    if (m.kind === "ui") {
      // 界面刷新：只是「去重新取视图」的提示，网页按 plugin + contribution 重新请求（那里再鉴权）
      const frame = uiFrame(m);
      this.enqueue(() => this.write(frame));
      return;
    }
    if (m.kind === "changed") {
      // a hint to refetch that part of the conversation (the HTTP read checks access again)
      const frame = `event: changed\ndata: ${JSON.stringify({ what: m.what })}\n\n`;
      this.enqueue(() => this.write(frame));
      return;
    }
    if (m.kind === "subagent_progress") {
      // a sub-agent's step (spec §14.2): only on its parent's topic, which this viewer may read
      const { kind: _k, ...progress } = m;
      const frame = `event: subagent_progress\ndata: ${JSON.stringify(progress)}\n\n`;
      this.enqueue(() => this.write(frame));
      return;
    }
    const { kind: _kind, ...delta } = m;
    this.enqueue(() => this.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`));
  }

  private enqueue(fn: () => unknown): void {
    this.chain = this.chain
      .then(async () => {
        if (!this.closed) await fn();
      })
      .catch((err) => {
        this.d.log.warn("conversation stream failed; closing", {
          conversationId: this.p.conversationId,
          err,
        });
        this.close("abort");
      });
  }

  /** 读 lastSeq 之后的全部事件并发送（按 seq 去重：只发大于已发送值的）。 */
  private async catchUp(): Promise<void> {
    for (;;) {
      const evs = await this.d.eventLog.readAfter(this.p.conversationId, this.lastSeq, PAGE);
      for (const e of evs) {
        if (this.closed) return;
        if (e.seq <= this.lastSeq) continue;
        this.write(eventFrame(e));
        this.lastSeq = e.seq;
      }
      if (evs.length < PAGE || this.closed) return;
    }
  }

  /** 发最后一帧错误并关闭（未发完的排队输出随关闭丢弃）。 */
  private fail(code: ErrorCode): void {
    if (this.closed) return;
    try {
      this.out.write(errorFrame(code));
    } catch {
      // 连接已断开
    }
    this.close();
  }

  private write(chunk: string): void {
    if (this.closed) return;
    this.out.write(chunk);
    if (this.out.backlog() > MAX_BACKLOG_BYTES) {
      this.d.log.warn("conversation stream client too slow; closing", {
        conversationId: this.p.conversationId,
      });
      // end() 会把 FIN 排在未发出的数据之后，零窗口的客户端会一直占着连接与缓冲区：直接销毁
      this.close("abort");
    }
  }

  /**
   * 复核凭据与可见性；失败时先发最后一帧 `event: error`（`data: {"code"}`）再关闭。
   * 复核本身出错按失败关闭处理（`internal`）。
   */
  private async recheck(): Promise<void> {
    if (this.closed || this.rechecking) return;
    this.rechecking = true;
    try {
      const denied = await authorize(this.d, this.p);
      if (denied !== null) this.fail(denied);
    } catch (err) {
      this.d.log.warn("conversation stream access re-check failed; closing", {
        conversationId: this.p.conversationId,
        err,
      });
      this.fail("internal");
    } finally {
      this.rechecking = false;
    }
  }
}
