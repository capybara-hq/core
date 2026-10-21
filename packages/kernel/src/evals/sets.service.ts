import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { SettingsService } from "../identity/settings.js";
import type { PricesService } from "../models/prices.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { type CaseSnapshot, replayableCalls, takeSnapshot, toEvents } from "./snapshot.js";
import { buildTrajectory, type TrajectoryRun } from "./trajectory.js";

export interface EvalSetView {
  id: string;
  agentId: string;
  name: string;
  description: string;
  rubric: string | null;
  caseCount: number;
  createdAt: string;
}

export interface EvalCaseView {
  id: string;
  sourceConversationId: string;
  sourceRunId: string;
  agentVersion: number;
  title: string;
  replayableSteps: number;
  createdAt: string;
}

/** 评测集详情：集合本身与全部用例（按加入顺序；不含快照）。 */
export interface EvalSetDetail extends EvalSetView {
  cases: EvalCaseView[];
}

/** 用例详情：快照还原出的轨迹（快照里的全部运行，含该运行之前的历史）。 */
export interface EvalCaseDetail {
  case: EvalCaseView;
  trajectory: TrajectoryRun[];
  /** 成本的币种（部署设置 `priceCurrency`）。 */
  currency: string;
}

export interface SampleInput {
  from?: string;
  to?: string;
  /** 1–50 */
  count: number;
  /** 缺省 `completed`；`any` = completed / failed / aborted。 */
  status?: "completed" | "failed" | "any";
  /** 该运行至少有多少次工具调用（按 `tool_result` 事件计）。 */
  minToolCalls?: number;
}

/** 用例标题：触发消息文本的前 80 个字符（按码点）。 */
export const CASE_TITLE_CHARS = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const setNotFound = () => new ApiError("eval.set_not_found", "Eval set not found");
const caseNotFound = () => new ApiError("eval.case_not_found", "Eval case not found");
const caseExists = () =>
  new ApiError("eval.case_exists", "This run is already a case in the eval set");
const tooMany = (max: number) =>
  new ApiError("eval.too_many_cases", `An eval set holds at most ${max} cases`);

/** 抽样时跳过（计入 `skipped`）而不中断的错误。 */
const SAMPLE_SKIPPABLE = new Set<string>([
  "eval.case_too_large",
  "eval.run_not_finished",
  "conversation.not_found",
]);

const STATUSES: Record<
  NonNullable<SampleInput["status"]>,
  ("completed" | "failed" | "aborted")[]
> = {
  completed: ["completed"],
  failed: ["failed"],
  any: ["completed", "failed", "aborted"],
};

/**
 * 快照运行的触发消息（该运行 `run_started` 之前最近的一条 `user_message`）的文本，空白折叠后取前 80 个字符。
 */
export function caseTitle(s: CaseSnapshot): string {
  const started = s.events.find((e) => e.type === "run_started" && e.runId === s.runId);
  const limit = started?.seq ?? Number.POSITIVE_INFINITY;
  let text = "";
  for (const e of s.events) {
    if (e.seq >= limit) break;
    if (e.type !== "user_message") continue;
    const content = (e.payload as { content?: { type: string; text?: string }[] }).content ?? [];
    const first = content.find((b) => b.type === "text");
    text = first?.text ?? "";
  }
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, CASE_TITLE_CHARS).join("");
}

type CaseRow = {
  id: string;
  source_conversation_id: string;
  source_run_id: string;
  agent_version: number;
  title: string;
  replayable_steps: number;
  created_at: Date;
};

const CASE_COLUMNS = [
  "id",
  "source_conversation_id",
  "source_run_id",
  "agent_version",
  "title",
  "replayable_steps",
  "created_at",
] as const;

function toCaseView(r: CaseRow): EvalCaseView {
  return {
    id: r.id,
    sourceConversationId: r.source_conversation_id,
    sourceRunId: r.source_run_id,
    agentVersion: r.agent_version,
    title: r.title,
    replayableSteps: r.replayable_steps,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * 评测集与用例（D4、C3、C4）：组织管理员从某个 agent 的真实对话里挑选或抽样运行，每个用例存一份日志快照
 * （`takeSnapshot`，≤ `evals.maxCaseBytes`），之后与原对话无关。写操作在事务里锁组织行并复核角色
 * （`evals.manage`），再锁集合行，串行化同一集合的容量判定。查看用例内容写审计 `trajectory.viewed`。
 */
export class EvalSetsService {
  constructor(
    private readonly db: KernelDb,
    private readonly config: () => KernelConfig,
    private readonly prices: PricesService,
    private readonly settings: SettingsService,
  ) {}

  private views(orgId: string) {
    return this.db
      .selectFrom("eval_sets as s")
      .select((eb) => [
        "s.id",
        "s.agent_id",
        "s.name",
        "s.description",
        "s.rubric",
        "s.created_at",
        eb
          .selectFrom("eval_cases as c")
          .select(sql<string>`count(*)`.as("n"))
          .whereRef("c.set_id", "=", "s.id")
          .as("case_count"),
      ])
      .where("s.org_id", "=", orgId)
      .where("s.deleted_at", "is", null);
  }

  private static toView(r: {
    id: string;
    agent_id: string;
    name: string;
    description: string;
    rubric: string | null;
    created_at: Date;
    case_count: string | null;
  }): EvalSetView {
    return {
      id: r.id,
      agentId: r.agent_id,
      name: r.name,
      description: r.description,
      rubric: r.rubric,
      caseCount: Number(r.case_count ?? 0),
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private async view(orgId: string, setId: string): Promise<EvalSetView> {
    if (!UUID.test(setId)) throw setNotFound();
    const r = await this.views(orgId).where("s.id", "=", setId).executeTakeFirst();
    if (!r) throw setNotFound();
    return EvalSetsService.toView(r);
  }

  async create(
    orgId: string,
    actor: string,
    input: { agentId: string; name: string; description?: string; rubric?: string },
    actorTokenId?: string,
  ): Promise<EvalSetView> {
    const id = await this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      const agent = await trx
        .selectFrom("agents")
        .select("id")
        .where("id", "=", input.agentId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!agent) throw new ApiError("agent.not_found", "Agent not found");
      const row = await trx
        .insertInto("eval_sets")
        .values({
          org_id: orgId,
          agent_id: input.agentId,
          name: input.name,
          description: input.description ?? "",
          rubric: input.rubric ?? null,
          created_by: actor,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.set_created",
        target: row.id,
        detail: { agentId: input.agentId, name: input.name },
      });
      return row.id;
    });
    return this.view(orgId, id);
  }

  async list(orgId: string): Promise<EvalSetView[]> {
    const rows = await this.views(orgId)
      .orderBy("s.created_at", "desc")
      .orderBy("s.id", "desc")
      .execute();
    return rows.map((r) => EvalSetsService.toView(r));
  }

  async get(orgId: string, setId: string): Promise<EvalSetDetail> {
    const set = await this.view(orgId, setId);
    const cases = await this.db
      .selectFrom("eval_cases")
      .select(CASE_COLUMNS)
      .where("set_id", "=", setId)
      .where("org_id", "=", orgId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return { ...set, cases: cases.map(toCaseView) };
  }

  async update(
    orgId: string,
    actor: string,
    setId: string,
    patch: { name?: string; description?: string; rubric?: string | null },
    actorTokenId?: string,
  ): Promise<EvalSetView> {
    if (!UUID.test(setId)) throw setNotFound();
    await this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      const r = await trx
        .updateTable("eval_sets")
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.rubric !== undefined && { rubric: patch.rubric }),
          updated_at: sql`now()`,
        })
        .where("id", "=", setId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw setNotFound();
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.set_updated",
        target: setId,
        // 只记改了哪些字段（评分标准可能很长，不进审计）
        detail: {
          fields: (["name", "description", "rubric"] as const).filter(
            (f) => patch[f] !== undefined,
          ),
        },
      });
    });
    return this.view(orgId, setId);
  }

  /** 软删除评测集（用例与运行保留在表里，界面与接口不再可见）。 */
  async remove(orgId: string, actor: string, setId: string, actorTokenId?: string): Promise<void> {
    if (!UUID.test(setId)) throw setNotFound();
    await this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      const r = await trx
        .updateTable("eval_sets")
        .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", setId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw setNotFound();
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.set_deleted",
        target: setId,
      });
    });
  }

  /** 未删除的评测集；不存在 → `eval.set_not_found`。 */
  private async liveSet(orgId: string, setId: string): Promise<{ agent_id: string }> {
    if (!UUID.test(setId)) throw setNotFound();
    const set = await this.db
      .selectFrom("eval_sets")
      .select("agent_id")
      .where("id", "=", setId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!set) throw setNotFound();
    return set;
  }

  private async caseCount(db: KernelDb, setId: string): Promise<number> {
    const r = await db
      .selectFrom("eval_cases")
      .select(sql<string>`count(*)`.as("n"))
      .where("set_id", "=", setId)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /**
   * 在事务里写入一个用例：锁组织行并复核角色、锁集合行、按 `evals.maxCasesPerSet` 判容量，
   * `(set_id, source_run_id)` 已存在时返回 null（不写）。成功时写审计 `eval.case_added`。
   */
  private async insertCase(
    orgId: string,
    actor: string,
    setId: string,
    snapshot: CaseSnapshot,
    extra: { sampled: boolean; actorTokenId?: string },
  ): Promise<EvalCaseView | "exists" | "full"> {
    const max = this.config().evals.maxCasesPerSet;
    const json = JSON.stringify(snapshot);
    return this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      const set = await trx
        .selectFrom("eval_sets")
        .select("id")
        .where("id", "=", setId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!set) throw setNotFound();
      if ((await this.caseCount(trx, setId)) >= max) return "full";
      const row = await trx
        .insertInto("eval_cases")
        .values({
          set_id: setId,
          org_id: orgId,
          source_conversation_id: snapshot.conversationId,
          source_run_id: snapshot.runId,
          agent_version: snapshot.agentVersion,
          title: caseTitle(snapshot),
          snapshot: json,
          snapshot_bytes: Buffer.byteLength(json),
          replayable_steps: replayableCalls(snapshot).length,
          added_by: actor,
        })
        .onConflict((oc) => oc.columns(["set_id", "source_run_id"]).doNothing())
        .returning(CASE_COLUMNS)
        .executeTakeFirst();
      if (!row) return "exists";
      await audit(trx, {
        actorAccountId: actor,
        ...(extra.actorTokenId !== undefined && { actorTokenId: extra.actorTokenId }),
        orgId,
        action: "eval.case_added",
        target: setId,
        detail: {
          caseId: row.id,
          conversationId: snapshot.conversationId,
          runId: snapshot.runId,
          ...(extra.sampled && { sampled: true }),
        },
      });
      return toCaseView(row);
    });
  }

  /**
   * 把某次运行加为用例。对话不在本组织（或是 eval 对话）→ `conversation.not_found`；对话的 agent 不是集合的 agent →
   * `eval.agent_mismatch`；已在集合里 → `eval.case_exists`；集合满了 → `eval.too_many_cases`；
   * 运行未终态 / 快照超大 → `eval.run_not_finished` / `eval.case_too_large`（`takeSnapshot`）。
   */
  async addCase(
    orgId: string,
    actor: string,
    setId: string,
    input: { conversationId: string; runId: string },
    actorTokenId?: string,
  ): Promise<EvalCaseView> {
    const set = await this.liveSet(orgId, setId);
    const conv = await this.db
      .selectFrom("conversations")
      .select(["agent_id", "kind"])
      .where("id", "=", input.conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (conv?.kind !== "chat") {
      throw new ApiError("conversation.not_found", "Conversation or run not found");
    }
    if (conv.agent_id !== set.agent_id) {
      throw new ApiError("eval.agent_mismatch", "The run belongs to a different agent");
    }
    const exists = await this.db
      .selectFrom("eval_cases")
      .select("id")
      .where("set_id", "=", setId)
      .where("source_run_id", "=", input.runId)
      .executeTakeFirst();
    if (exists) throw caseExists();
    const { maxCasesPerSet, maxCaseBytes } = this.config().evals;
    // 先判容量再取快照（快照可能很大）；写入时在锁内再判一次
    if ((await this.caseCount(this.db, setId)) >= maxCasesPerSet) throw tooMany(maxCasesPerSet);
    const snapshot = await takeSnapshot(
      this.db,
      orgId,
      input.conversationId,
      input.runId,
      maxCaseBytes,
    );
    const r = await this.insertCase(orgId, actor, setId, snapshot, {
      sampled: false,
      ...(actorTokenId !== undefined && { actorTokenId }),
    });
    if (r === "exists") throw caseExists();
    if (r === "full") throw tooMany(maxCasesPerSet);
    return r;
  }

  /**
   * 抽样：从该 agent 的 chat 对话里随机取（`ORDER BY random()`）已终态、尚不在集合里的运行，至多
   * `min(count, 剩余容量)` 个，逐个取快照写入。快照超大（或其间被删除 / 写入时已满 / 并发加入）的计入 `skipped`。
   * 集合已满 → `eval.too_many_cases`。逐个写入，内存里一次只有一份快照。
   */
  async sample(
    orgId: string,
    actor: string,
    setId: string,
    input: SampleInput,
    actorTokenId?: string,
  ): Promise<{ added: number; skipped: number }> {
    const set = await this.liveSet(orgId, setId);
    const { maxCasesPerSet, maxCaseBytes } = this.config().evals;
    const room = maxCasesPerSet - (await this.caseCount(this.db, setId));
    if (room <= 0) throw tooMany(maxCasesPerSet);

    let q = this.db
      .selectFrom("runs as r")
      .innerJoin("conversations as c", "c.id", "r.conversation_id")
      .select(["r.id", "r.conversation_id"])
      .where("c.org_id", "=", orgId)
      .where("c.agent_id", "=", set.agent_id)
      .where("c.kind", "=", "chat")
      .where("r.status", "in", STATUSES[input.status ?? "completed"])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("eval_cases as e")
              .select(sql`1`.as("one"))
              .where("e.set_id", "=", setId)
              .whereRef("e.source_run_id", "=", "r.id"),
          ),
        ),
      )
      .orderBy(sql`random()`)
      .limit(Math.min(input.count, room));
    if (input.from !== undefined) q = q.where("r.created_at", ">=", new Date(input.from));
    if (input.to !== undefined) q = q.where("r.created_at", "<", new Date(input.to));
    const minToolCalls = input.minToolCalls ?? 0;
    if (minToolCalls > 0) {
      q = q.where(
        (eb) =>
          sql<boolean>`(
            SELECT count(*) FROM capybara.conversation_events ev
            WHERE ev.conversation_id = ${eb.ref("r.conversation_id")}
              AND ev.run_id = ${eb.ref("r.id")} AND ev.type = 'tool_result'
          ) >= ${minToolCalls}`,
      );
    }
    const picks = await q.execute();

    let added = 0;
    let skipped = 0;
    for (const p of picks) {
      let snapshot: CaseSnapshot;
      try {
        snapshot = await takeSnapshot(this.db, orgId, p.conversation_id, p.id, maxCaseBytes);
      } catch (e) {
        if (e instanceof ApiError && SAMPLE_SKIPPABLE.has(e.code)) {
          skipped++;
          continue;
        }
        throw e;
      }
      const r = await this.insertCase(orgId, actor, setId, snapshot, {
        sampled: true,
        ...(actorTokenId !== undefined && { actorTokenId }),
      });
      if (typeof r === "string") skipped++;
      else added++;
    }
    return { added, skipped };
  }

  async removeCase(
    orgId: string,
    actor: string,
    setId: string,
    caseId: string,
    actorTokenId?: string,
  ): Promise<void> {
    if (!UUID.test(setId)) throw setNotFound();
    if (!UUID.test(caseId)) throw caseNotFound();
    await this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      const set = await trx
        .selectFrom("eval_sets")
        .select("id")
        .where("id", "=", setId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!set) throw setNotFound();
      const r = await trx
        .deleteFrom("eval_cases")
        .where("id", "=", caseId)
        .where("set_id", "=", setId)
        .where("org_id", "=", orgId)
        .returning(["source_conversation_id", "source_run_id"])
        .executeTakeFirst();
      if (!r) throw caseNotFound();
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.case_removed",
        target: setId,
        detail: {
          caseId,
          conversationId: r.source_conversation_id,
          runId: r.source_run_id,
        },
      });
    });
  }

  /**
   * 用例详情：由快照还原轨迹（原对话删除后照常可读）。快照即对话内容，每次查看写审计 `trajectory.viewed`
   * （target = 原对话 id，detail 带 `caseId` / `setId`）。
   */
  async getCase(
    orgId: string,
    actor: string,
    setId: string,
    caseId: string,
    actorTokenId?: string,
  ): Promise<EvalCaseDetail> {
    await this.liveSet(orgId, setId);
    if (!UUID.test(caseId)) throw caseNotFound();
    const row = await this.db
      .selectFrom("eval_cases")
      .select([...CASE_COLUMNS, "snapshot"])
      .where("id", "=", caseId)
      .where("set_id", "=", setId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw caseNotFound();
    const snapshot = row.snapshot as CaseSnapshot;
    const [table, settings] = await Promise.all([this.prices.table(), this.settings.get()]);
    await audit(this.db, {
      actorAccountId: actor,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "trajectory.viewed",
      target: row.source_conversation_id,
      detail: { agentId: snapshot.agentId, caseId, setId },
    });
    return {
      case: toCaseView(row),
      trajectory: buildTrajectory(toEvents(snapshot), table),
      currency: settings.priceCurrency,
    };
  }
}
