import type { Logger } from "@capybara-hq/plugin-sdk";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { type Selectable, sql } from "kysely";
import { paramIssues } from "../agents/agents.service.js";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type {
  EvalResultStatus,
  EvalResultsTable,
  EvalRunStatus,
  JudgeStatus,
  KernelDb,
} from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { SettingsService } from "../identity/settings.js";
import { costOf, type PricesService, priceKey } from "../models/prices.js";
import type { ModelPurposesService } from "../models/purposes.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { ProviderListError, type ProviderRegistry } from "../runtime/providers.js";
import { bullConnection } from "../runtime/run-queue.js";
import {
  ACTIVE_EVAL_STATUSES,
  type CasePlan,
  casePlan,
  recountCases,
  skipPendingJudges,
  usageTokens,
} from "./budget.js";
import type { CaseSnapshot } from "./snapshot.js";
import { type EvalCandidate, resolveCandidate } from "./step-replay.js";

export type { EvalCandidate, EvalResultStatus, EvalRunStatus };

/** 评测队列的 BullMQ 队列名（不含 `:`，C7）。 */
export const EVAL_QUEUE_NAME = "cap-kernel-evals";

/** 每个用例一个任务（C7；不含 `:`）。 */
export const evalJobId = (runId: string, caseId: string): string => `eval-${runId}-${caseId}`;

/** 评测任务的数据。 */
export interface EvalJobData {
  runId: string;
  caseId: string;
  orgId: string;
}

/** 运行前的估算（D5：运行前显示预计请求数）。 */
export interface EvalEstimate {
  cases: number;
  modelRequests: number;
  judgeRequests: number;
  estimatedTokens: number;
  /** 按候选模型的价格；有用例的候选模型没有价格 → null。 */
  estimatedCost: number | null;
  currency: string;
}

/**
 * 运行的汇总（F-C2：字段按 T6 的完整定义；比率无数据时为 null）。T4 只填计数，
 * `toolCallsMatchRate` / `meanTextSimilarity` / `judgePassRate` / `humanPassRate` 由 T6 填。
 */
/** 估算响应里的 token 上限（D5）：部署默认、部署上限与本次生效的上限。 */
export interface EvalTokenCaps {
  defaultTokenCap: number;
  maxTokenCap: number;
  effectiveTokenCap: number;
}

export interface EvalSummary {
  done: number;
  errors: number;
  skipped: number;
  toolCallsMatchRate: number | null;
  meanTextSimilarity: number | null;
  judgePassRate: number | null;
  /** 评委失败（解析失败 / 请求失败）的结果数。 */
  judgeErrors: number;
  humanPassRate: number | null;
  labeled: number;
  drifted: number;
}

export interface EvalRunView {
  id: string;
  setId: string;
  mode: "step" | "run";
  candidate: EvalCandidate;
  judge: boolean;
  status: EvalRunStatus;
  tokenCap: number;
  tokensUsed: number;
  casesTotal: number;
  casesDone: number;
  estimate: EvalEstimate;
  /** 运行结束后才有（queued / running 时为 null）。 */
  summary: EvalSummary | null;
  /** 运行 failed 的原因（如连续出错熔断 `eval.too_many_errors`；英文，界面按 code 走 i18n）。 */
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 一条结果（F-C1：与 `eval_results` 行一一对应，camelCase）。 */
export interface EvalResultView {
  id: string;
  caseId: string;
  step: number | null;
  modelCallSeq: number | null;
  status: EvalResultStatus;
  baseline: unknown | null;
  candidate: unknown | null;
  diff: unknown | null;
  judge: unknown | null;
  /** 评委状态：none（不评）/ pending / done / error / skipped。 */
  judgeStatus: JudgeStatus;
  drift: string[];
  error: unknown | null;
  evalConversationId: string | null;
  label: "pass" | "fail" | null;
  labelNote: string | null;
  labeledBy: string | null;
  labeledAt: string | null;
}

/** 评测队列（生产方）：懒建连接；`close()` 关闭。 */
export class EvalQueue {
  private queue: Queue<EvalJobData> | undefined;
  private conn: Redis | undefined;
  private closed = false;

  constructor(
    private readonly redisUrl: string,
    private readonly log: Pick<Logger, "error">,
  ) {}

  private get(): Queue<EvalJobData> {
    if (this.closed) throw new Error("eval queue is closed");
    if (!this.queue) {
      this.conn = bullConnection(this.redisUrl, this.log);
      this.queue = new Queue<EvalJobData>(EVAL_QUEUE_NAME, { connection: this.conn });
      this.queue.on("error", (err) => this.log.error("eval queue error", { err }));
    }
    return this.queue;
  }

  async enqueue(jobs: EvalJobData[]): Promise<void> {
    await this.get().addBulk(
      jobs.map((data) => ({
        name: "case",
        data,
        opts: {
          jobId: evalJobId(data.runId, data.caseId),
          // 处理函数外的暂时故障（PG / Redis）：指数退避重试，不让整个用例一次失败。
          // 结果按认领号写入，重做不会重复写结果
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 1000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      })),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue?.close().catch(() => {});
    this.conn?.disconnect();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const setNotFound = () => new ApiError("eval.set_not_found", "Eval set not found");
const runNotFound = () => new ApiError("eval.run_not_found", "Eval run not found");
const candidateInvalid = (message: string, details: { path: string; message: string }[]) =>
  new ApiError("eval.candidate_invalid", message, details);

/** 预建结果时每条 INSERT 的行数。 */
const INSERT_CHUNK = 500;

/** 用例的原版本与定义：快照里的；快照缺（较早的快照）时查 `agent_versions`。 */
export async function caseBase(
  db: KernelDb,
  s: CaseSnapshot,
): Promise<{ definition: AgentDefinition; agentVersion: number } | null> {
  const fromSnap = s.definitions[String(s.agentVersion)];
  if (fromSnap) return { definition: fromSnap, agentVersion: s.agentVersion };
  const row = await db
    .selectFrom("agent_versions")
    .select("definition")
    .where("agent_id", "=", s.agentId)
    .where("version", "=", s.agentVersion)
    .executeTakeFirst();
  return row
    ? { definition: row.definition as unknown as AgentDefinition, agentVersion: s.agentVersion }
    : null;
}

/** 候选 agent 版本的定义（没给版本 → undefined）。 */
export async function versionDefinition(
  db: KernelDb,
  agentId: string,
  version: number | undefined,
): Promise<AgentDefinition | undefined> {
  if (version === undefined) return undefined;
  const row = await db
    .selectFrom("agent_versions")
    .select("definition")
    .where("agent_id", "=", agentId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row ? (row.definition as unknown as AgentDefinition) : undefined;
}

type RunRow = {
  id: string;
  set_id: string;
  mode: "step" | "run";
  candidate: unknown;
  judge: boolean;
  status: EvalRunStatus;
  token_cap: string | number | bigint;
  tokens_used: string | number | bigint;
  cases_total: number;
  cases_done: number;
  estimate: unknown;
  error: unknown;
  created_at: Date;
  finished_at: Date | null;
};

const RUN_COLUMNS = [
  "id",
  "set_id",
  "mode",
  "candidate",
  "judge",
  "status",
  "token_cap",
  "tokens_used",
  "cases_total",
  "cases_done",
  "estimate",
  "error",
  "created_at",
  "finished_at",
] as const;

const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());

/** 聚合出的比率（PG numeric / float 读出为字符串）；没有数据为 null。 */
const rate = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

type ResultRow = Selectable<EvalResultsTable>;

/** 一行 `eval_results` 的视图。 */
function resultView(r: ResultRow): EvalResultView {
  return {
    id: r.id,
    caseId: r.case_id,
    step: r.step,
    modelCallSeq: r.model_call_seq === null ? null : Number(r.model_call_seq),
    status: r.status,
    baseline: r.baseline,
    candidate: r.candidate,
    diff: r.diff,
    judge: r.judge,
    judgeStatus: r.judge_status,
    drift: r.drift,
    error: r.error,
    evalConversationId: r.eval_conversation_id,
    label: r.label,
    labelNote: r.label_note,
    labeledBy: r.labeled_by,
    labeledAt: iso(r.labeled_at),
  };
}

const resultNotFound = () => new ApiError("eval.result_not_found", "Eval result not found");

/** 一个用例的计划（含用例 id 与成本）。 */
interface PlannedCase extends CasePlan {
  caseId: string;
  cost: number | null;
  /** 候选落到该用例上不合法（参数不符该用例所用模型的声明等）：不入队，结果直接记为这个错误。 */
  problem: CaseProblem | null;
}

interface CaseProblem {
  code: string;
  message: string;
  details?: { path: string; message: string }[];
}

export interface EvalRunsDeps {
  db: KernelDb;
  config: () => KernelConfig;
  registry: Pick<ProviderRegistry, "resolve">;
  prices: Pick<PricesService, "table">;
  settings: Pick<SettingsService, "get">;
  queue: Pick<EvalQueue, "enqueue">;
  /** 模型用途映射：开评委时 `eval` 用途必须已映射（否则 `model.unconfigured`）。 */
  purposes: Pick<ModelPurposesService, "resolve">;
}

/**
 * 评测运行（D5、C7）：估算、启动（校验候选、预建结果、每个用例入队一个任务）、查看、结果分页、取消。
 * 执行在 `evals/worker.ts`。写操作在事务里锁组织行并复核角色（`evals.manage`）。
 */
export class EvalRunsService {
  constructor(private readonly d: EvalRunsDeps) {}

  private async liveSet(orgId: string, setId: string): Promise<{ agent_id: string }> {
    if (!UUID.test(setId)) throw setNotFound();
    const set = await this.d.db
      .selectFrom("eval_sets")
      .select("agent_id")
      .where("id", "=", setId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!set) throw setNotFound();
    return set;
  }

  /**
   * 解析模型；不存在 / 不可用 → `eval.candidate_invalid`（供应商列表暂时失败照常抛出）。
   * 按部署范围解析，与运行时一致；组织级模型准入若在第二段落地，须同样覆盖评测候选。
   */
  private async resolveModel(ref: ModelRef) {
    try {
      return await this.d.registry.resolve(ref);
    } catch (e) {
      if (e instanceof ProviderListError) throw e;
      if (e instanceof ApiError && e.code === "agent.model_unavailable") {
        throw candidateInvalid(`Model ${ref.provider}/${ref.model} is not available`, [
          { path: "candidate.model", message: "model is not available" },
        ]);
      }
      throw e;
    }
  }

  /**
   * 校验候选：版本存在（该集合的 agent）、模型可解析、参数按所用模型的声明严格通过（`paramIssues`）。
   * 所用模型 = 候选模型，否则候选版本的模型，否则 agent 当前版本的模型。返回候选版本的定义。
   */
  private async checkCandidate(
    agentId: string,
    c: EvalCandidate,
  ): Promise<AgentDefinition | undefined> {
    const versionDef = await versionDefinition(this.d.db, agentId, c.agentVersion);
    if (c.agentVersion !== undefined && versionDef === undefined) {
      throw candidateInvalid(`Agent version ${c.agentVersion} does not exist`, [
        { path: "candidate.agentVersion", message: "version does not exist" },
      ]);
    }
    let model = c.model ?? versionDef?.model;
    if (model === undefined && c.modelParams !== undefined) {
      const current = await this.d.db
        .selectFrom("agents as a")
        .innerJoin("agent_versions as v", (j) =>
          j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
        )
        .select("v.definition")
        .where("a.id", "=", agentId)
        .executeTakeFirst();
      model = (current?.definition as unknown as AgentDefinition | undefined)?.model;
    }
    if (model === undefined) return versionDef;
    const { info } = await this.resolveModel(model);
    if (c.modelParams !== undefined) {
      const issues = paramIssues("candidate.modelParams", info.parameters, c.modelParams);
      if (issues.length > 0) throw candidateInvalid("Invalid candidate model parameters", issues);
    }
    return versionDef;
  }

  /** 逐个用例（一次只读一份快照）算回放计划与成本。 */
  private async plan(
    setId: string,
    mode: "step" | "run",
    c: EvalCandidate,
    versionDef: AgentDefinition | undefined,
  ): Promise<PlannedCase[]> {
    const table = await this.d.prices.table();
    const ids = await this.d.db
      .selectFrom("eval_cases")
      .select("id")
      .where("set_id", "=", setId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const out: PlannedCase[] = [];
    const infos = new Map<
      string,
      Awaited<ReturnType<ProviderRegistry["resolve"]>>["info"] | null
    >();
    for (const { id } of ids) {
      const row = await this.d.db
        .selectFrom("eval_cases")
        .select("snapshot")
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) continue;
      const s = row.snapshot as CaseSnapshot;
      const p = casePlan(s, mode);
      if (p.results.length === 0) continue;
      const base = await caseBase(this.d.db, s);
      const model = base ? resolveCandidate(base, c, versionDef).model : (c.model ?? null);
      const price = model ? table.get(priceKey(model.provider, model.model)) : undefined;
      // 候选参数按每个用例实际所用的模型严格校验（没给候选模型 / 版本时，所用模型是该用例自己的）
      let problem: CaseProblem | null = null;
      if (c.modelParams !== undefined && model) {
        const key = priceKey(model.provider, model.model);
        if (!infos.has(key)) {
          try {
            infos.set(key, (await this.d.registry.resolve(model)).info);
          } catch (e) {
            if (e instanceof ProviderListError) throw e;
            if (!(e instanceof ApiError && e.code === "agent.model_unavailable")) throw e;
            infos.set(key, null);
          }
        }
        const info = infos.get(key);
        if (!info) {
          problem = {
            code: "run.model_unavailable",
            message: `Model ${model.provider}/${model.model} is not available`,
          };
        } else {
          const issues = paramIssues("candidate.modelParams", info.parameters, c.modelParams);
          if (issues.length > 0) {
            problem = {
              code: "eval.candidate_invalid",
              message: `Invalid candidate model parameters for ${model.provider}/${model.model}`,
              details: issues,
            };
          }
        }
      }
      out.push({ ...p, caseId: id, cost: problem ? 0 : costOf(p.usage, price), problem });
    }
    return out;
  }

  /** 估算只算会发请求的用例（候选不合法的用例不发请求）。 */
  private async summarize(all: PlannedCase[], judge: boolean): Promise<EvalEstimate> {
    const plans = all.filter((p) => p.problem === null);
    const { priceCurrency } = await this.d.settings.get();
    let cost: number | null = 0;
    for (const p of plans) cost = cost === null || p.cost === null ? null : cost + p.cost;
    return {
      cases: plans.length,
      modelRequests: plans.reduce((n, p) => n + p.modelRequests, 0),
      judgeRequests: judge ? plans.reduce((n, p) => n + p.results.length, 0) : 0,
      estimatedTokens: plans.reduce((n, p) => n + usageTokens(p.usage), 0),
      estimatedCost: plans.length === 0 ? 0 : cost,
      currency: priceCurrency,
    };
  }

  async estimate(
    orgId: string,
    setId: string,
    input: { mode: "step" | "run"; candidate: EvalCandidate; judge: boolean; tokenCap?: number },
  ): Promise<{ estimate: EvalEstimate } & EvalTokenCaps> {
    const set = await this.liveSet(orgId, setId);
    const caps = this.tokenCaps(input.tokenCap);
    const versionDef = await this.checkCandidate(set.agent_id, input.candidate);
    const plans = await this.plan(setId, input.mode, input.candidate, versionDef);
    return { estimate: await this.summarize(plans, input.judge), ...caps };
  }

  /** token 上限：给了就校验 [1, `evals.maxTokenCap`]，缺省 `evals.defaultTokenCap`（D5）。 */
  private tokenCaps(tokenCap: number | undefined): EvalTokenCaps {
    const { defaultTokenCap, maxTokenCap } = this.d.config().evals;
    const effectiveTokenCap = tokenCap ?? defaultTokenCap;
    if (
      !Number.isInteger(effectiveTokenCap) ||
      effectiveTokenCap < 1 ||
      effectiveTokenCap > maxTokenCap
    ) {
      throw new ApiError("eval.token_cap_invalid", `tokenCap must be between 1 and ${maxTokenCap}`);
    }
    return { defaultTokenCap, maxTokenCap, effectiveTokenCap };
  }

  /**
   * 启动：校验 token 上限（[1, `evals.maxTokenCap`]，缺省 `evals.defaultTokenCap`）、候选、评委用途；
   * 没有可回放的 → `eval.nothing_to_replay`。事务内建运行行、预建 pending 结果，提交后每个用例入队一个任务；
   * 入队失败 → 运行标 failed、结果 skipped，错误照常抛出。
   */
  async start(
    orgId: string,
    actor: string,
    setId: string,
    input: { mode: "step" | "run"; candidate: EvalCandidate; judge: boolean; tokenCap?: number },
    actorTokenId?: string,
  ): Promise<EvalRunView> {
    const set = await this.liveSet(orgId, setId);
    const tokenCap = this.tokenCaps(input.tokenCap).effectiveTokenCap;
    const versionDef = await this.checkCandidate(set.agent_id, input.candidate);
    if (input.judge) await this.d.purposes.resolve(orgId, "eval");
    const planned = await this.plan(setId, input.mode, input.candidate, versionDef);
    if (planned.length === 0) {
      throw new ApiError("eval.nothing_to_replay", "The eval set has nothing to replay");
    }
    // 候选对每个用例都不合法：不建运行，直接报第一个问题
    const firstProblem = planned.every((p) => p.problem !== null) ? planned[0]?.problem : null;
    if (firstProblem) {
      throw candidateInvalid(firstProblem.message, firstProblem.details ?? []);
    }

    const { runId, plans } = await this.d.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      // 与删除用例（锁集合行 FOR UPDATE）互斥：之后读到的用例在提交前不会被删
      const locked = await trx
        .selectFrom("eval_sets")
        .select("id")
        .where("id", "=", setId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!locked) throw setNotFound();
      const alive = new Set(
        (
          await trx
            .selectFrom("eval_cases")
            .select("id")
            .where("set_id", "=", setId)
            .where(
              "id",
              "in",
              planned.map((p) => p.caseId),
            )
            .execute()
        ).map((r) => r.id),
      );
      const plans = planned.filter((p) => alive.has(p.caseId));
      if (plans.length === 0) {
        throw new ApiError("eval.nothing_to_replay", "The eval set has nothing to replay");
      }
      const estimate = await this.summarize(plans, input.judge);
      const run = await trx
        .insertInto("eval_runs")
        .values({
          org_id: orgId,
          set_id: setId,
          mode: input.mode,
          candidate: JSON.stringify(input.candidate),
          judge: input.judge,
          token_cap: String(tokenCap),
          cases_total: plans.length,
          estimate: JSON.stringify(estimate),
          created_by: actor,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      // 候选不合法的用例：结果直接记错误（计入进度，不入队）
      const rows = plans.flatMap((p) =>
        p.results.map((r) => ({
          run_id: run.id,
          case_id: p.caseId,
          org_id: orgId,
          step: r.step,
          model_call_seq: r.modelCallSeq,
          ...(p.problem !== null && {
            status: "error" as const,
            error: JSON.stringify(p.problem),
          }),
        })),
      );
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await trx
          .insertInto("eval_results")
          .values(rows.slice(i, i + INSERT_CHUNK))
          .execute();
      }
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.run_started",
        target: run.id,
        detail: { setId, mode: input.mode, judge: input.judge, tokenCap, cases: plans.length },
      });
      await recountCases(trx, run.id);
      return { runId: run.id, plans: plans.filter((p) => p.problem === null) };
    });

    try {
      await this.d.queue.enqueue(plans.map((p) => ({ runId, caseId: p.caseId, orgId })));
    } catch (e) {
      await this.d.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("eval_runs")
          .set({ status: "failed", finished_at: sql`now()` })
          .where("id", "=", runId)
          .execute();
        await trx
          .updateTable("eval_results")
          .set({ status: "skipped", updated_at: sql`now()` })
          .where("run_id", "=", runId)
          .where("status", "=", "pending")
          .execute();
        await recountCases(trx, runId);
      });
      throw e;
    }
    return this.get(orgId, runId);
  }

  /** 各运行的汇总（只算已结束的）。 */
  private async summaries(rows: RunRow[]): Promise<Map<string, EvalSummary>> {
    const finished = rows
      .filter((r) => !(ACTIVE_EVAL_STATUSES as readonly string[]).includes(r.status))
      .map((r) => r.id);
    const out = new Map<string, EvalSummary>();
    if (finished.length === 0) return out;
    const agg = await this.d.db
      .selectFrom("eval_results")
      .select([
        "run_id",
        sql<string>`count(*) FILTER (WHERE status = 'done')`.as("done"),
        sql<string>`count(*) FILTER (WHERE status = 'error')`.as("errors"),
        sql<string>`count(*) FILTER (WHERE status = 'skipped')`.as("skipped"),
        sql<string>`count(*) FILTER (WHERE label IS NOT NULL)`.as("labeled"),
        sql<string>`count(*) FILTER (WHERE judge_status = 'error')`.as("judge_errors"),
        sql<string>`count(*) FILTER (WHERE cardinality(drift) > 0)`.as("drifted"),
        // 结构差异只在 done 的结果上有；评委比率只算给出了结论的（解析失败 / 请求失败不计）
        sql<string | null>`avg(CASE WHEN (diff->>'toolCallsMatch')::boolean THEN 1.0 ELSE 0.0 END)
          FILTER (WHERE status = 'done' AND diff IS NOT NULL)`.as("tool_rate"),
        sql<string | null>`avg((diff->>'textSimilarity')::float8)
          FILTER (WHERE status = 'done' AND diff IS NOT NULL)`.as("text_sim"),
        sql<string | null>`avg(CASE WHEN judge->>'verdict' = 'pass' THEN 1.0 ELSE 0.0 END)
          FILTER (WHERE judge->>'verdict' IS NOT NULL)`.as("judge_rate"),
        sql<string | null>`avg(CASE WHEN label = 'pass' THEN 1.0 ELSE 0.0 END)
          FILTER (WHERE label IS NOT NULL)`.as("human_rate"),
      ])
      .where("run_id", "in", finished)
      .groupBy("run_id")
      .execute();
    for (const id of finished) {
      const a = agg.find((x) => x.run_id === id);
      out.set(id, {
        done: Number(a?.done ?? 0),
        errors: Number(a?.errors ?? 0),
        skipped: Number(a?.skipped ?? 0),
        toolCallsMatchRate: rate(a?.tool_rate),
        meanTextSimilarity: rate(a?.text_sim),
        judgePassRate: rate(a?.judge_rate),
        judgeErrors: Number(a?.judge_errors ?? 0),
        humanPassRate: rate(a?.human_rate),
        labeled: Number(a?.labeled ?? 0),
        drifted: Number(a?.drifted ?? 0),
      });
    }
    return out;
  }

  private static toView(r: RunRow, summary: EvalSummary | null): EvalRunView {
    return {
      id: r.id,
      setId: r.set_id,
      mode: r.mode,
      candidate: r.candidate as EvalCandidate,
      judge: r.judge,
      status: r.status,
      tokenCap: Number(r.token_cap),
      tokensUsed: Number(r.tokens_used),
      casesTotal: r.cases_total,
      casesDone: r.cases_done,
      estimate: r.estimate as EvalEstimate,
      summary,
      error: (r.error ?? null) as EvalRunView["error"],
      createdAt: new Date(r.created_at).toISOString(),
      finishedAt: iso(r.finished_at),
    };
  }

  async get(orgId: string, runId: string): Promise<EvalRunView> {
    if (!UUID.test(runId)) throw runNotFound();
    const r = await this.d.db
      .selectFrom("eval_runs as r")
      .innerJoin("eval_sets as s", "s.id", "r.set_id")
      .select(RUN_COLUMNS.map((c) => `r.${c}` as const))
      .where("r.id", "=", runId)
      .where("r.org_id", "=", orgId)
      .where("s.deleted_at", "is", null)
      .executeTakeFirst();
    if (!r) throw runNotFound();
    const sums = await this.summaries([r]);
    return EvalRunsService.toView(r, sums.get(r.id) ?? null);
  }

  async listForSet(orgId: string, setId: string): Promise<EvalRunView[]> {
    await this.liveSet(orgId, setId);
    const rows = await this.d.db
      .selectFrom("eval_runs")
      .select(RUN_COLUMNS)
      .where("set_id", "=", setId)
      .where("org_id", "=", orgId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const sums = await this.summaries(rows);
    return rows.map((r) => EvalRunsService.toView(r, sums.get(r.id) ?? null));
  }

  /** 结果分页：按 id 升序，`after` 为上一页最后一条的 id。 */
  async results(
    orgId: string,
    runId: string,
    q: { after?: string; limit: number },
  ): Promise<{ results: EvalResultView[]; next: string | null }> {
    await this.get(orgId, runId);
    let query = this.d.db
      .selectFrom("eval_results")
      .selectAll()
      .where("run_id", "=", runId)
      .where("org_id", "=", orgId)
      .orderBy("id")
      .limit(q.limit + 1);
    if (q.after !== undefined) {
      if (!UUID.test(q.after)) throw new ApiError("validation_failed", "Invalid cursor");
      query = query.where("id", ">", q.after);
    }
    const rows = await query.execute();
    const page = rows.slice(0, q.limit);
    return {
      results: page.map(resultView),
      next: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * 取消：queued / running → cancelled，尚未开始的结果立即 skipped；在途请求做完照常写入（C7 在途可超出），
   * 之后的请求不再发。已结束 → `eval.run_finished`。
   */
  async cancel(
    orgId: string,
    actor: string,
    runId: string,
    actorTokenId?: string,
  ): Promise<EvalRunView> {
    if (!UUID.test(runId)) throw runNotFound();
    await this.get(orgId, runId);
    await this.d.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      const r = await trx
        .updateTable("eval_runs")
        .set({ status: "cancelled", finished_at: sql`now()` })
        .where("id", "=", runId)
        .where("org_id", "=", orgId)
        .where("status", "in", [...ACTIVE_EVAL_STATUSES])
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) {
        throw new ApiError("eval.run_finished", "The eval run has already finished");
      }
      await trx
        .updateTable("eval_results")
        .set({ status: "skipped", updated_at: sql`now()` })
        .where("run_id", "=", runId)
        .where("status", "=", "pending")
        .execute();
      await skipPendingJudges(trx, runId);
      // 尚未开始的用例此刻已全部结束：进度立即反映（在途的用例做完后由 worker 再重算）
      await recountCases(trx, runId);
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.run_cancelled",
        target: runId,
      });
    });
    return this.get(orgId, runId);
  }

  /**
   * 人工标注（D3）：标通过 / 不通过（附可选备注），`label: null` 清除标注与备注。评测集已删除、结果不属于本组织 →
   * `eval.result_not_found`。事务内锁组织并复核 `evals.manage`，写审计 `eval.result_labeled`（不含备注全文）。
   */
  async label(
    orgId: string,
    actor: string,
    resultId: string,
    input: { label: "pass" | "fail" | null; note?: string },
    actorTokenId?: string,
  ): Promise<EvalResultView> {
    if (!UUID.test(resultId)) throw resultNotFound();
    const row = await this.d.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actor, "evals.manage");
      // 先锁住这条结果、读出原标注（写进审计）
      const before = await trx
        .selectFrom("eval_results")
        .select("label")
        .where("id", "=", resultId)
        .where("org_id", "=", orgId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw resultNotFound();
      const cleared = input.label === null;
      const r = await trx
        .updateTable("eval_results")
        .set({
          label: input.label,
          label_note: cleared ? null : (input.note ?? null),
          labeled_by: cleared ? null : actor,
          labeled_at: cleared ? null : sql`now()`,
          updated_at: sql`now()`,
        })
        .where("id", "=", resultId)
        .where("org_id", "=", orgId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("eval_runs as er")
              .innerJoin("eval_sets as es", "es.id", "er.set_id")
              .select("er.id")
              .whereRef("er.id", "=", "eval_results.run_id")
              .where("es.deleted_at", "is", null),
          ),
        )
        .returningAll()
        .executeTakeFirst();
      if (!r) throw resultNotFound();
      await audit(trx, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "eval.result_labeled",
        target: resultId,
        detail: { runId: r.run_id, label: input.label, previousLabel: before.label },
      });
      return r;
    });
    return resultView(row);
  }
}
