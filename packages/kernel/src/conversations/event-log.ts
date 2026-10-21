import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import {
  type ConversationEvent,
  type ConversationEventBody,
  ConversationEventSchema,
  type ConversationEventType,
} from "./events.js";

type Trx = Transaction<KernelDatabase>;

/** 事件日志依赖的总线：内核 bus（命名空间 `kernel`）。 */
export interface EventBus {
  publish(topic: string, payload: unknown): Promise<void>;
}

/** 待追加的事件；`payload` 写入前按 `ConversationEventSchema` 校验。 */
export interface AppendEvent {
  type: ConversationEventType;
  runId?: string;
  /** 幂等键：同一会话内已有同键事件时返回已有事件，不分配新 seq。 */
  idemKey?: string;
  payload: unknown;
}

/** 新事件提交后发布到的总线主题。 */
export const conversationTopic = (conversationId: string): string => `conv.${conversationId}`;

/**
 * 会话频道上的总线消息：
 * - `events`：会话日志已推进到 `toSeq`（订阅方据此 `readAfter` 补读，消息本身不携带事件）；
 * - `delta`：运行的流式增量（文本 / 思考 / `step_reset`：丢弃该步此前推出的增量），只是草稿，
 *   最终内容以日志中的 assistant_message 为准。`offset`（仅 text）：本步本次尝试中此前已推出的文本字符数，
 *   中途才订阅的一方据此判断自己是否从头收到了该步的文本（渠道出站投递只在完整时发草稿）；
 * - `ui`：插件经 `ctx.ui.invalidate` 告知这个会话的某个界面贡献变了（不进日志、不是模型可见内容），
 *   SSE 转发为 `event: ui`，网页据此重新取视图。
 */
export type ConversationBusMessage =
  | { kind: "events"; toSeq: number }
  | {
      kind: "delta";
      runId: string;
      step: number;
      delta: "text" | "thinking" | "step_reset";
      text?: string;
      offset?: number;
    }
  | { kind: "ui"; plugin: string; contribution: string };

const notFound = () => new ApiError("conversation.not_found", "Conversation not found");

interface EventRow {
  conversation_id: string;
  seq: string;
  type: string;
  run_id: string | null;
  payload: unknown;
  created_at: Date;
}

function toEvent(r: EventRow): ConversationEvent {
  return {
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    type: r.type,
    runId: r.run_id,
    payload: r.payload,
    createdAt: r.created_at,
  } as ConversationEvent;
}

const EVENT_COLUMNS = [
  "conversation_id",
  "seq",
  "type",
  "run_id",
  "payload",
  "created_at",
] as const;

/**
 * 会话事件日志：只追加，是 agent 运行的唯一事实来源。
 * seq 由 `conversations.last_seq` 在会话行锁内连续分配（多副本并发写同一会话时串行化）；
 * 幂等键的「先查后写」也在同一把行锁内完成。
 */
export class EventLog {
  constructor(
    private readonly db: KernelDb,
    private readonly bus: EventBus,
    private readonly log?: Pick<Logger, "warn">,
    /**
     * 每次发布「日志已推进」之后调用（同步、不等待）：内核用它给有 IM 投递目标的会话排出站任务。
     * 钩子自己负责吞掉错误。
     */
    private readonly onNotify?: (conversationId: string, toSeq: number) => void,
  ) {}

  /**
   * 追加事件，返回与输入一一对应的事件（幂等命中的为已有事件）。
   * 不传 `trx` 时自开事务，提交后发布 `conv.<id>`；传入外部 `trx` 时由调用方在提交后调用 `notify`。
   */
  async append(
    conversationId: string,
    events: AppendEvent[],
    trx?: Trx,
  ): Promise<ConversationEvent[]> {
    const bodies = events.map((e) => this.validate(e));
    if (trx) return (await this.appendIn(trx, conversationId, events, bodies)).events;
    const { events: out, toSeq } = await this.db
      .transaction()
      .execute((t) => this.appendIn(t, conversationId, events, bodies));
    if (toSeq !== null) await this.notify(conversationId, toSeq);
    return out;
  }

  /** 发布「日志已推进到 toSeq」；发布失败只记日志（事件已提交，订阅方可按 seq 补读）。 */
  async notify(conversationId: string, toSeq: number): Promise<void> {
    const msg: ConversationBusMessage = { kind: "events", toSeq };
    try {
      await this.bus.publish(conversationTopic(conversationId), msg);
    } catch (err) {
      this.log?.warn("conversation event notify failed", { conversationId, toSeq, err });
    }
    try {
      this.onNotify?.(conversationId, toSeq);
    } catch (err) {
      this.log?.warn("conversation event notify hook failed", { conversationId, err });
    }
  }

  /** 读 `afterSeq` 之后的事件，按 seq 升序，最多 `limit` 条。 */
  async readAfter(
    conversationId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<ConversationEvent[]> {
    const rows = await this.db
      .selectFrom("conversation_events")
      .select(EVENT_COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("seq", ">", String(afterSeq))
      .orderBy("seq")
      .limit(limit)
      .execute();
    return rows.map(toEvent);
  }

  /** 按幂等键取事件；没有 → undefined。 */
  async findByIdem(
    conversationId: string,
    idemKey: string,
  ): Promise<ConversationEvent | undefined> {
    const r = await this.db
      .selectFrom("conversation_events")
      .select(EVENT_COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("idem_key", "=", idemKey)
      .executeTakeFirst();
    return r && toEvent(r);
  }

  /**
   * 会话里某类事件的最新一条（按 seq）；没有 → undefined。`skills_catalog` 有部分索引
   * （0025，按会话直接取到最新一条）；其他类型按 (conversation_id, seq) 主键倒序扫本会话的事件并按 type 过滤，
   * 没有该类事件时会扫完整个会话。
   */
  async latestOfType<T extends ConversationEventType>(
    conversationId: string,
    type: T,
  ): Promise<Extract<ConversationEvent, { type: T }> | undefined> {
    const r = await this.db
      .selectFrom("conversation_events")
      .select(EVENT_COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("type", "=", type)
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    return r && (toEvent(r) as Extract<ConversationEvent, { type: T }>);
  }

  private validate(e: AppendEvent): ConversationEventBody {
    const r = ConversationEventSchema.safeParse({ type: e.type, payload: e.payload });
    if (!r.success) {
      throw new TypeError(
        `invalid conversation event ${JSON.stringify(e.type)}: ${r.error.message}`,
      );
    }
    return r.data;
  }

  private async appendIn(
    t: Trx,
    conversationId: string,
    events: AppendEvent[],
    bodies: ConversationEventBody[],
  ): Promise<{ events: ConversationEvent[]; toSeq: number | null }> {
    // 先锁会话行：之后的幂等查询与 seq 分配都在这把锁内，并发 append 依次执行。
    const conv = await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (!conv) throw notFound();

    const keys = [...new Set(events.flatMap((e) => (e.idemKey === undefined ? [] : [e.idemKey])))];
    const existing = new Map<string, ConversationEvent>();
    if (keys.length > 0) {
      const rows = await t
        .selectFrom("conversation_events")
        .select([...EVENT_COLUMNS, "idem_key"])
        .where("conversation_id", "=", conversationId)
        .where("idem_key", "in", keys)
        .execute();
      for (const r of rows) if (r.idem_key !== null) existing.set(r.idem_key, toEvent(r));
    }

    // 每个输入：幂等命中 → 已有事件；同批内重复的幂等键 → 指向同批首个；否则为新事件。
    const plan: ({ kind: "old"; event: ConversationEvent } | { kind: "new"; index: number })[] = [];
    const fresh: number[] = [];
    const batchKeys = new Map<string, number>();
    events.forEach((e, i) => {
      const k = e.idemKey;
      const hit = k === undefined ? undefined : existing.get(k);
      const prior = k === undefined ? undefined : batchKeys.get(k);
      if (hit) {
        plan.push({ kind: "old", event: hit });
      } else if (prior !== undefined) {
        plan.push({ kind: "new", index: prior });
      } else {
        if (k !== undefined) batchKeys.set(k, fresh.length);
        plan.push({ kind: "new", index: fresh.length });
        fresh.push(i);
      }
    });
    if (fresh.length === 0) {
      return {
        events: plan.map((p) => (p as { kind: "old"; event: ConversationEvent }).event),
        toSeq: null,
      };
    }

    const n = fresh.length;
    const { last_seq } = await t
      .updateTable("conversations")
      .set({ last_seq: sql`last_seq + ${n}`, updated_at: sql`now()` })
      .where("id", "=", conversationId)
      .returning("last_seq")
      .executeTakeFirstOrThrow();
    const toSeq = Number(last_seq);
    const base = toSeq - n;
    const inserted = await t
      .insertInto("conversation_events")
      .values(
        fresh.map((i, j) => {
          const e = events[i] as AppendEvent;
          const body = bodies[i] as ConversationEventBody;
          return {
            conversation_id: conversationId,
            seq: base + j + 1,
            type: body.type,
            run_id: e.runId ?? null,
            idem_key: e.idemKey ?? null,
            payload: JSON.stringify(body.payload),
          };
        }),
      )
      .returning(EVENT_COLUMNS)
      .execute();
    const bySeq = new Map(inserted.map((r) => [Number(r.seq), toEvent(r)]));
    return {
      events: plan.map((p) =>
        p.kind === "old" ? p.event : (bySeq.get(base + p.index + 1) as ConversationEvent),
      ),
      toSeq,
    };
  }
}
