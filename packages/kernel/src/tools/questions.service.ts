import { randomUUID } from "node:crypto";
import { type FormAnswer, type InputForm, validateAnswer } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import type { QuestionsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { legacyCurrentTrx } from "../infra/database/legacy-view.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";

export type QuestionStatus = "pending" | "answered" | "expired" | "cancelled";

/**
 * `questions.spec` 的内容：表单、插件 state（续跑时原样带回 `ctx.resume.state`），
 * 以及写取消结果时要用的工具 key 与步号。
 */
interface QuestionSpec {
  form: InputForm;
  state: unknown;
  toolKey: string;
  step: number;
}

/** 一条输入请求（`ask_user`、插件工具的 `input_required`、MCP elicitation 共用）。 */
export interface QuestionRecord {
  id: string;
  orgId: string;
  conversationId: string;
  runId: string;
  callId: string;
  /** 同一调用的第几轮（从 1 起，最多 3 轮）。 */
  attempt: number;
  toolKey: string;
  step: number;
  form: InputForm;
  state: unknown;
  status: QuestionStatus;
  answer: FormAnswer | null;
  answeredBy: string | null;
  answeredAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** 新建输入请求（tools 节点在处理函数返回 `input_required` 时调用）。 */
export interface QuestionAskInput {
  orgId: string;
  conversationId: string;
  runId: string;
  step: number;
  callId: string;
  attempt: number;
  toolKey: string;
  form: InputForm;
  state: unknown;
}

const notFound = () => new ApiError("question.not_found", "Question not found");
const notInitiator = () =>
  new ApiError("forbidden", "Only the user who started the run can answer this question");

/** 网页读取输入请求的视图（不含插件 state：那是工具内部的续跑数据）。 */
export type QuestionView = Omit<QuestionRecord, "state">;

const toView = ({ state: _state, ...rest }: QuestionRecord): QuestionView => rest;
const iso = (v: Date | string): string => new Date(v).toISOString();

function toRecord(r: Selectable<QuestionsTable>): QuestionRecord {
  const spec = r.spec as QuestionSpec;
  return {
    id: r.id,
    orgId: r.org_id,
    conversationId: r.conversation_id,
    runId: r.run_id,
    callId: r.call_id,
    attempt: r.attempt,
    toolKey: spec.toolKey,
    step: spec.step,
    form: spec.form,
    state: spec.state ?? null,
    status: r.status,
    answer: (r.answer ?? null) as FormAnswer | null,
    answeredBy: r.answered_by,
    answeredAt: r.answered_at === null ? null : iso(r.answered_at),
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 输入请求：新建（tools 节点）、回答（只有对话发起人）、超时与取消（等待机制）。
 * 状态全部在 PG：回答 / 超时 / 取消都在事务里 `SELECT … FOR UPDATE` 该行，多副本并发时恰好一个生效，
 * 只有生效的那次写 `question_answered`。HTTP 接口见 questions.controller.ts。
 *
 * An answer is announced after the commit as the domain event `question.answered` (exactly once),
 * which the run's waits follow to resume it (spec §3b; the wait sweep resumes a run whose resume was
 * lost). The event log (Task 3.6) is read through `LegacyPorts` (R7, R8).
 */
@Injectable()
export class QuestionsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(LegacyPorts) private readonly ports: Pick<LegacyPorts, "eventLog">,
    @Inject(KernelEvents) private readonly events: Pick<KernelEvents, "emit">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * 新建 pending 输入请求（`expires_at` = 现在 + `tools.approvalTimeoutHours`）并写 `question_asked`，同一事务。
   * 按 (run_id, call_id, attempt) 幂等：已存在则返回已有记录，事件按 `question_asked:<id>` 幂等。
   */
  async ask(input: QuestionAskInput): Promise<QuestionRecord> {
    const { record, toSeq } = await this.askIn(input);
    await this.ports.eventLog.notify(record.conversationId, toSeq);
    return record;
  }

  @Transactional()
  private async askIn(input: QuestionAskInput): Promise<{ record: QuestionRecord; toSeq: number }> {
    const hours = this.config.get().tools.approvalTimeoutHours;
    const spec: QuestionSpec = {
      form: input.form,
      state: input.state ?? null,
      toolKey: input.toolKey,
      step: input.step,
    };
    const t = this.db.db;
    await t
      .insertInto("questions")
      .values({
        id: randomUUID(),
        org_id: input.orgId,
        conversation_id: input.conversationId,
        run_id: input.runId,
        call_id: input.callId,
        attempt: input.attempt,
        spec: JSON.stringify(spec),
        answer: null,
        answered_by: null,
        expires_at: sql<Date>`now() + ${hours}::integer * interval '1 hour'`,
      })
      .onConflict((oc) => oc.columns(["run_id", "call_id", "attempt"]).doNothing())
      .execute();
    const row = await t
      .selectFrom("questions")
      .selectAll()
      .where("run_id", "=", input.runId)
      .where("call_id", "=", input.callId)
      .where("attempt", "=", input.attempt)
      .executeTakeFirstOrThrow();
    const rec = toRecord(row);
    const written = await this.ports.eventLog.append(
      rec.conversationId,
      [
        {
          type: "question_asked",
          runId: rec.runId,
          idemKey: `question_asked:${rec.id}`,
          payload: {
            step: rec.step,
            callId: rec.callId,
            questionId: rec.id,
            form: rec.form,
            expiresAt: rec.expiresAt,
          },
        },
      ],
      legacyCurrentTrx(),
    );
    return { record: rec, toSeq: Math.max(...written.map((e) => e.seq)) };
  }

  /**
   * 读一条输入请求（网页展示表单用）：只有该运行的发起人（其他人 → 403 `forbidden`）；
   * 不属于该组织 / 不存在 → `question.not_found`。
   */
  async get(orgId: string, questionId: string, accountId: string): Promise<QuestionView> {
    const row = await this.db
      .selectFrom("questions")
      .innerJoin("runs", "runs.id", "questions.run_id")
      .selectAll("questions")
      .select("runs.trigger_account_id")
      .where("questions.id", "=", questionId)
      .where("questions.org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.trigger_account_id !== accountId) throw notInitiator();
    return toView(toRecord(row));
  }

  /** 某个调用的全部输入请求（按轮次升序）。 */
  async forCall(runId: string, callId: string): Promise<QuestionRecord[]> {
    const rows = await this.db
      .selectFrom("questions")
      .selectAll()
      .where("run_id", "=", runId)
      .where("call_id", "=", callId)
      .orderBy("attempt")
      .execute();
    return rows.map(toRecord);
  }

  /**
   * 回答：只有该运行的发起人（其他人 → 403 `forbidden`；传 `orgId` 时别的组织的输入请求 → `question.not_found`）；非 pending 或已到期 →
   * `question.already_answered`；答案不符合表单（`validateAnswer`）→ `validation_failed`。
   * 同一事务写状态与 `question_answered`（幂等键 `question_answered:<id>`）；提交后发布事件并调用 `onAnswered`（续跑）。
   * 传 `orgId` 时还要求输入请求属于该组织（HTTP 接口用）。
   */
  async answer(
    questionId: string,
    accountId: string,
    answer: unknown,
    orgId?: string,
  ): Promise<QuestionRecord> {
    const { record, toSeq } = await this.answerIn(questionId, accountId, answer, orgId);
    await this.ports.eventLog.notify(record.conversationId, toSeq);
    // waits resume the run and its IM delivery is enqueued (handler failures are logged)
    await this.events.emit("question.answered", {
      id: record.id,
      orgId: record.orgId,
      conversationId: record.conversationId,
      runId: record.runId,
    });
    return record;
  }

  // its own transaction (as the legacy one was): `question.answered` is emitted only after the
  // answer committed, even when a caller has a transaction open
  @Transactional({ propagation: "requires_new" })
  private async answerIn(
    questionId: string,
    accountId: string,
    answer: unknown,
    orgId: string | undefined,
  ): Promise<{ record: QuestionRecord; toSeq: number }> {
    const t = this.db.db;
    let q = t
      .selectFrom("questions")
      .selectAll()
      .select(sql<boolean>`expires_at <= now()`.as("expired"))
      .where("id", "=", questionId);
    if (orgId !== undefined) q = q.where("org_id", "=", orgId);
    const locked = await q.forUpdate().executeTakeFirst();
    if (!locked) throw notFound();
    const run = await t
      .selectFrom("runs")
      .select("trigger_account_id")
      .where("id", "=", locked.run_id)
      .executeTakeFirst();
    if (run?.trigger_account_id !== accountId) throw notInitiator();
    const before = toRecord(locked);
    if (before.status !== "pending") {
      throw new ApiError("question.already_answered", "Question has already been answered");
    }
    if (locked.expired) {
      throw new ApiError("question.already_answered", "Question has expired");
    }
    const problems = isPlainObject(answer)
      ? validateAnswer(before.form, answer as FormAnswer)
      : ["answer must be an object"];
    if (problems.length > 0) {
      throw new ApiError(
        "validation_failed",
        "Answer does not match the form",
        problems.map((message) => ({ path: "answer", message })),
      );
    }
    const updated = await t
      .updateTable("questions")
      .set({
        status: "answered",
        answer: JSON.stringify(answer),
        answered_by: accountId,
        answered_at: sql<Date>`now()`,
      })
      .where("id", "=", questionId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const toSeq = await this.answeredEvent(before, answer as FormAnswer, accountId, "answered");
    return { record: toRecord(updated), toSeq };
  }

  /**
   * 超时（等待机制的超时任务调用）：仍 pending 且已到期 → 置 expired、写 `question_answered{expired}`。
   * 返回 `expired`（本次生效）/ `not_due`（尚未到期）/ `settled`（已回答、已取消或不存在）。
   */
  async expire(questionId: string): Promise<{
    outcome: "expired" | "not_due" | "settled";
    record?: QuestionRecord;
  }> {
    const r = await this.expireIn(questionId);
    if ("toSeq" in r && r.toSeq !== undefined && r.record) {
      await this.ports.eventLog.notify(r.record.conversationId, r.toSeq);
    }
    return r.record ? { outcome: r.outcome, record: r.record } : { outcome: r.outcome };
  }

  @Transactional()
  private async expireIn(questionId: string): Promise<{
    outcome: "expired" | "not_due" | "settled";
    record?: QuestionRecord;
    toSeq?: number;
  }> {
    const t = this.db.db;
    const locked = await t
      .selectFrom("questions")
      .selectAll()
      .select(sql<boolean>`expires_at <= now()`.as("expired"))
      .where("id", "=", questionId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) return { outcome: "settled" as const };
    const before = toRecord(locked);
    if (before.status !== "pending") return { outcome: "settled" as const, record: before };
    if (!locked.expired) return { outcome: "not_due" as const, record: before };
    const updated = await t
      .updateTable("questions")
      .set({ status: "expired", answered_at: sql<Date>`now()` })
      .where("id", "=", questionId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const toSeq = await this.answeredEvent(before, null, null, "expired");
    return { outcome: "expired" as const, record: toRecord(updated), toSeq };
  }

  /**
   * 在调用方的事务内（`mandatory`）取消运行的全部 pending 输入请求（运行在等待中被中止），各写
   * `question_answered{cancelled}`。返回被取消的记录；调用方提交后发布事件。
   */
  @Transactional({ propagation: "mandatory" })
  async cancelPendingIn(runId: string): Promise<QuestionRecord[]> {
    const t = this.db.db;
    const rows = await t
      .selectFrom("questions")
      .selectAll()
      .where("run_id", "=", runId)
      .where("status", "=", "pending")
      .orderBy("created_at")
      .forUpdate()
      .execute();
    const out: QuestionRecord[] = [];
    for (const row of rows) {
      const updated = await t
        .updateTable("questions")
        .set({ status: "cancelled", answered_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const rec = toRecord(row);
      await this.answeredEvent(rec, null, null, "cancelled");
      out.push(toRecord(updated));
    }
    return out;
  }

  /**
   * 在调用方的事务内（`mandatory`）取消某组织里由 `accountId` 发起的运行上的全部 pending 输入请求（只有运行发起人能回答，
   * 即「其作为处理人」的提问；成员离职时调用），走与 {@link cancelPendingIn} 相同的取消路径：置 cancelled、
   * 写 `question_answered{cancelled}`。返回被取消的记录与各会话写到的最大 seq；调用方提交后发布事件。
   */
  @Transactional({ propagation: "mandatory" })
  async cancelPendingFor(
    orgId: string,
    accountId: string,
  ): Promise<{ records: QuestionRecord[]; seqs: Map<string, number> }> {
    const t = this.db.db;
    const rows = await t
      .selectFrom("questions")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .where("run_id", "in", (eb) =>
        eb.selectFrom("runs").select("id").where("trigger_account_id", "=", accountId),
      )
      .orderBy("created_at")
      .forUpdate()
      .execute();
    const records: QuestionRecord[] = [];
    const seqs = new Map<string, number>();
    for (const row of rows) {
      const updated = await t
        .updateTable("questions")
        .set({ status: "cancelled", answered_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const seq = await this.answeredEvent(toRecord(row), null, null, "cancelled");
      seqs.set(row.conversation_id, Math.max(seqs.get(row.conversation_id) ?? 0, seq));
      records.push(toRecord(updated));
    }
    return { records, seqs };
  }

  /** `question_answered` in the current transaction; returns its seq. */
  private async answeredEvent(
    q: QuestionRecord,
    answer: FormAnswer | null,
    byAccountId: string | null,
    outcome: "answered" | "expired" | "cancelled",
  ): Promise<number> {
    const written = await this.ports.eventLog.append(
      q.conversationId,
      [
        {
          type: "question_answered",
          runId: q.runId,
          idemKey: `question_answered:${q.id}`,
          payload: { questionId: q.id, callId: q.callId, answer, byAccountId, outcome },
        },
      ],
      legacyCurrentTrx(),
    );
    return Math.max(...written.map((e) => e.seq));
  }
}
