import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  type ConversationEvent,
  type ConversationEventBody,
  ConversationEventSchema,
  type ConversationEventType,
} from "./events.js";

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

/**
 * The JSON stored for an event payload, with every NUL (U+0000) in a string or an object key
 * replaced by U+FFFD: PostgreSQL jsonb rejects `\u0000`, so a NUL from a tool result (a file read,
 * command output) used to fail the append and the run. No stored log can contain NUL, so replay
 * reads the same text the runtime wrote.
 */
export function payloadJson(payload: unknown): string {
  return JSON.stringify(payload, (_key, v: unknown) => {
    if (typeof v === "string") return v.includes("\0") ? v.replaceAll("\0", "\uFFFD") : v;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.some((k) => k.includes("\0"))) {
        return Object.fromEntries(
          keys.map((k) => [k.replaceAll("\0", "\uFFFD"), (v as Record<string, unknown>)[k]]),
        );
      }
    }
    return v;
  });
}

/** 新事件提交后发布到的总线主题。 */
export const conversationTopic = (conversationId: string): string => `conv.${conversationId}`;

/**
 * 会话频道上的总线消息：
 * - `events`：会话日志已推进到 `toSeq`（订阅方据此 `readAfter` 补读，消息本身不携带事件）；
 * - `delta`：运行的流式增量（文本 / 思考 / `step_reset`：丢弃该步此前推出的增量），只是草稿，
 *   最终内容以日志中的 assistant_message 为准。`offset` (text and thinking): the characters of
 *   that channel this attempt of the step streamed before the delta; a subscriber that joined midway
 *   tells by it whether it has the step's text from the start (the channel outbound only drafts
 *   complete text) and drops what a live draft already covers (spec 2026-11-07 §3.2);
 * - `ui`：插件经 `ctx.ui.invalidate` 告知这个会话的某个界面贡献变了（不进日志、不是模型可见内容），
 *   SSE 转发为 `event: ui`，网页据此重新取视图。
 * - `subagent_progress`: after each step of a sub-agent run, on the topic of **every ancestor**
 *   (sub-agents spec §14.2, agent map spec §8), `subagentId` the progressing agent: its step and
 *   tool call count so far, and its last tool's key. Not in any log; the SSE forwards it as
 *   `event: subagent_progress` (data without `kind`).
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
  | { kind: "ui"; plugin: string; contribution: string }
  | { kind: "changed"; what: ConversationChange }
  | {
      kind: "subagent_progress";
      subagentId: string;
      step: number;
      toolCalls: number;
      lastToolKey?: string;
    };

/**
 * What changed about a conversation outside its event log (UI refresh B): the SSE stream sends it as
 * `event: changed` with `{ what }`, and the web refetches that part. Never model-visible.
 */
export const CONVERSATION_CHANGES = [
  "title",
  "queue",
  "selection",
  "files",
  "archived",
  "deleted",
  // the conversation's background tasks (or its sub-agents')
  "background",
] as const;
export type ConversationChange = (typeof CONVERSATION_CHANGES)[number];

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
 *
 * Every published advance (`notify`) is also announced in-process as `conversation.event-appended`
 * on {@link KernelEvents} (the channel outbound delivery enqueues from it), on this replica, right
 * after the bus publish, in append order.
 */
@Injectable()
export class EventLog {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KERNEL_BUS) private readonly bus: EventBus,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(KernelEvents) private readonly events: Pick<KernelEvents, "emit">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * 追加事件，返回与输入一一对应的事件（幂等命中的为已有事件）。
   * 自开一个独立事务（`requires_new`，与调用方的事务无关），提交后发布 `conv.<id>`。
   * 要在调用方的事务里追加（与其他写入一起提交），用 {@link appendIn}。
   */
  async append(conversationId: string, events: AppendEvent[]): Promise<ConversationEvent[]> {
    const bodies = events.map((e) => this.validate(e));
    const { events: out, toSeq } = await this.appendOwn(conversationId, events, bodies);
    if (toSeq !== null) await this.notify(conversationId, toSeq);
    return out;
  }

  /**
   * {@link append} inside the caller's transaction (it must hold one: `mandatory`): the events
   * commit or roll back with the caller's writes, and the caller calls {@link notify} after the
   * commit with the highest seq it wrote.
   */
  @Transactional({ propagation: "mandatory" })
  async appendIn(conversationId: string, events: AppendEvent[]): Promise<ConversationEvent[]> {
    return (await this.appendInReport(conversationId, events)).events;
  }

  /**
   * {@link appendIn} that also says, per input, whether this call wrote the event (`fresh[i]`) or
   * returned an earlier one by its idempotency key (a retried message, reply-while-question spec
   * §8.1). Same transaction contract: the caller's, `mandatory`.
   */
  @Transactional({ propagation: "mandatory" })
  async appendInReport(
    conversationId: string,
    events: AppendEvent[],
  ): Promise<{ events: ConversationEvent[]; fresh: boolean[] }> {
    const bodies = events.map((e) => this.validate(e));
    const { events: out, fresh } = await this.write(conversationId, events, bodies);
    return { events: out, fresh };
  }

  @Transactional({ propagation: "requires_new" })
  private async appendOwn(
    conversationId: string,
    events: AppendEvent[],
    bodies: ConversationEventBody[],
  ): Promise<{ events: ConversationEvent[]; toSeq: number | null }> {
    const { events: out, toSeq } = await this.write(conversationId, events, bodies);
    return { events: out, toSeq };
  }

  /**
   * 发布「日志已推进到 toSeq」；发布失败只记日志（事件已提交，订阅方可按 seq 补读）。Then announces
   * it in-process (`conversation.event-appended`); a failing subscriber is logged by KernelEvents.
   */
  async notify(conversationId: string, toSeq: number): Promise<void> {
    const msg: ConversationBusMessage = { kind: "events", toSeq };
    try {
      await this.bus.publish(conversationTopic(conversationId), msg);
    } catch (err) {
      this.log.warn("conversation event notify failed", { conversationId, toSeq, err });
    }
    await this.events.emit("conversation.event-appended", { conversationId, toSeq });
  }

  /**
   * Publishes a `changed` frame on the conversation topic (rename, generated title, selection, ...).
   * A failed publish only logs: the state is in PG and the next read sees it.
   */
  async publishChanged(conversationId: string, what: ConversationChange): Promise<void> {
    const msg: ConversationBusMessage = { kind: "changed", what };
    try {
      await this.bus.publish(conversationTopic(conversationId), msg);
    } catch (err) {
      this.log.warn("conversation change publish failed", { conversationId, what, err });
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

  /**
   * The page of the log that ends right before `beforeSeq` (`null`: the log's end), in ascending
   * seq: the last `limit` events before it, extended back so the first event is the log's first or
   * the first one after a run's end (`run_finished` / `run_failed` / `run_aborted`), at most
   * `extend` events further back (a longer run then starts mid-run). `turnsBefore`: how many runs
   * started (distinct `run_id` of `run_started`) before the page's first event. History paging
   * spec §2.
   */
  async readTurnPageBefore(
    conversationId: string,
    beforeSeq: number | null,
    limit: number,
    extend: number,
  ): Promise<{ events: ConversationEvent[]; turnsBefore: number }> {
    let q = this.db
      .selectFrom("conversation_events")
      .select(EVENT_COLUMNS)
      .where("conversation_id", "=", conversationId);
    if (beforeSeq !== null) q = q.where("seq", "<", String(beforeSeq));
    const rows = (await q.orderBy("seq", "desc").limit(limit).execute()).reverse();
    const first = rows[0] === undefined ? null : Number(rows[0].seq);
    if (first === null) return { events: [], turnsBefore: 0 };
    let start = first;
    if (first > 1) {
      // the latest run end at or before the event just above the page, within the extension
      const end = await this.db
        .selectFrom("conversation_events")
        .select((eb) => eb.fn.max("seq").as("seq"))
        .where("conversation_id", "=", conversationId)
        .where("seq", "<", String(first))
        .where("seq", ">=", String(Math.max(1, first - 1 - extend)))
        .where("type", "in", ["run_finished", "run_failed", "run_aborted"])
        .executeTakeFirst();
      // none within reach: the page starts at the log's start when that is in reach, else mid-run
      if (end?.seq != null) start = Number(end.seq) + 1;
      else if (first - 1 <= extend) start = 1;
    }
    const head =
      start < first
        ? await this.db
            .selectFrom("conversation_events")
            .select(EVENT_COLUMNS)
            .where("conversation_id", "=", conversationId)
            .where("seq", ">=", String(start))
            .where("seq", "<", String(first))
            .orderBy("seq")
            .execute()
        : [];
    const turns =
      start > 1
        ? await this.db
            .selectFrom("conversation_events")
            .select((eb) => eb.fn.count<string>("run_id").distinct().as("n"))
            .where("conversation_id", "=", conversationId)
            .where("type", "=", "run_started")
            .where("seq", "<", String(start))
            .executeTakeFirst()
        : undefined;
    return {
      events: [...head, ...rows].map(toEvent),
      turnsBefore: Number(turns?.n ?? 0),
    };
  }

  /**
   * 读 `afterSeq` 之后、属于 `runIds` 中某次运行的事件，按 seq 升序，最多 `limit` 条（轨迹按运行分页用）。
   * `runIds` 为空时返回空数组。走部分索引 `conversation_events_run_idx (conversation_id, run_id, seq)`（0027）：
   * 往前翻页读较早的运行时不扫更晚运行的事件。
   */
  async readRunsAfter(
    conversationId: string,
    runIds: readonly string[],
    afterSeq: number,
    limit = 500,
  ): Promise<ConversationEvent[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("conversation_events")
      .select(EVENT_COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("run_id", "in", [...runIds])
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
   * The conversation's latest event of `type` (by seq); undefined without one. `skills_catalog`
   * (0025) and `device_paths` (0094) have partial indexes that answer it directly; other
   * types scan the conversation's events backwards on the (conversation_id, seq) key, the whole
   * conversation when it has none.
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

  /**
   * The file state (`tool_result.view.file`) the latest `Read` / `Write` / `Edit` result of this
   * conversation recorded for `path` (a normalized sandbox path); null when none did. One index
   * probe per call: the partial index `conversation_events_file_state_idx` of migration 0063
   * (conversation_id, view.file.path, seq DESC; tool_result rows only) answers it, also for a path
   * never read (the query's predicate must keep matching that index's expression).
   */
  async latestFileState(
    conversationId: string,
    path: string,
  ): Promise<{ size: number; sha256: string } | null> {
    const r = await this.db
      .selectFrom("conversation_events")
      .select(sql<{ size: number; sha256: string }>`payload->'view'->'file'`.as("file"))
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "tool_result")
      .where(sql<boolean>`payload->'view'->'file'->>'path' = ${path}`)
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    return r ? { size: r.file.size, sha256: r.file.sha256 } : null;
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

  /** The append itself, in the context's transaction (both callers open or join one). */
  private async write(
    conversationId: string,
    events: AppendEvent[],
    bodies: ConversationEventBody[],
  ): Promise<{ events: ConversationEvent[]; toSeq: number | null; fresh: boolean[] }> {
    const t = this.db;
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
    // written by this call: the first input of each new event (a repeat in the batch points to it)
    const freshSet = new Set(fresh);
    const isFresh = events.map((_, i) => freshSet.has(i));
    if (fresh.length === 0) {
      return {
        events: plan.map((p) => (p as { kind: "old"; event: ConversationEvent }).event),
        toSeq: null,
        fresh: isFresh,
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
            payload: payloadJson(body.payload),
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
      fresh: isFresh,
    };
  }
}

/** The one {@link EventLog} (infra dependencies only, so every domain can import it). */
@Module({ providers: [EventLog], exports: [EventLog] })
export class EventLogModule {}
