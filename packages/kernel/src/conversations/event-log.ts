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

/** 总线消息：会话日志已推进到 `toSeq`（订阅方据此 `readAfter` 补读，消息本身不携带事件）。 */
export interface ConversationBusMessage {
  kind: "events";
  toSeq: number;
}

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
