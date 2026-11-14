import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ModelRef } from "../../agents/definition.js";
import { ApiError } from "../../errors.js";
import {
  EvalAddCaseBody,
  EvalCandidateSchema,
  EvalCaseParams,
  EvalLabelBody,
  EvalResultParams,
  EvalRunEstimateBody,
  EvalRunParams,
  EvalRunResultsQuery,
  EvalSampleBody,
  EvalSetCreateBody,
  EvalSetParams,
  EvalSetPatchBody,
} from "../../evals/evals.schemas.js";
import { EvalRunsService, type EvalRunView } from "../../evals/runs.service.js";
import { type EvalCaseView, EvalSetsService, type EvalSetView } from "../../evals/sets.service.js";
import type { EvalCandidate } from "../../evals/step-replay.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;
const SetId = EvalSetParams.shape.setId;
const CaseId = EvalCaseParams.shape.caseId;
const RunId = EvalRunParams.shape.runId;
const ResultId = EvalResultParams.shape.resultId;

/** The candidate with every string bounded (the route's model and params strings are not). */
const Candidate = EvalCandidateSchema.extend({
  model: ModelRef.strict()
    .extend({ provider: z.string().min(1).max(200), model: z.string().min(1).max(200) })
    .optional(),
  modelParams: z
    .record(z.string().min(1).max(100), z.union([z.string().max(1000), z.number(), z.boolean()]))
    .optional(),
}).strict();

/** The body of `evals.estimate-run` and `evals.start-run`: the route's, with the bounded candidate. */
const RunBody = EvalRunEstimateBody.extend({
  setId: SetId,
  candidate: Candidate,
  tokenCap: z.number().int().min(1).max(1_000_000_000).optional(),
}).strict();

const setRow = (s: EvalSetView) => ({
  id: s.id,
  name: s.name,
  state: s.caseCount === 0 ? "empty" : "ready",
  ...(s.caseCount === 0 && { next: "Add cases with evals.add-case or evals.sample-cases." }),
  agentId: s.agentId,
  caseCount: s.caseCount,
  createdAt: s.createdAt,
});

/**
 * A case as a result shows it: a neutral label ("case 3"), never its title, which is an excerpt of
 * the person's message and so conversation content.
 */
const caseRow = (c: EvalCaseView, n: number) => ({
  id: c.id,
  name: `case ${n}`,
  sourceConversationId: c.sourceConversationId,
  sourceRunId: c.sourceRunId,
  agentVersion: c.agentVersion,
  replayableSteps: c.replayableSteps,
});

const runRow = (r: EvalRunView) => ({
  id: r.id,
  name: `${r.mode} run`,
  state: r.status,
  ...(r.error !== null && { reason: r.error.code }),
  mode: r.mode,
  progress: `${r.casesDone}/${r.casesTotal}`,
  createdAt: r.createdAt,
});

/** What a run summary line says about the candidate. */
const candidateText = (c: EvalCandidate): string => {
  const bits: string[] = [];
  if (c.model !== undefined) bits.push(`${c.model.provider}/${c.model.model}`);
  if (c.agentVersion !== undefined) bits.push(`agent version ${c.agentVersion}`);
  if (c.instructions !== undefined) bits.push("new instructions");
  if (c.modelParams !== undefined) bits.push("model params");
  return bits.length === 0 ? "the unchanged agent" : bits.join(", ");
};

/** The candidate without the keys zod left undefined (exactOptionalPropertyTypes). */
const candidateOf = (c: z.infer<typeof Candidate>): EvalCandidate => ({
  ...(c.agentVersion !== undefined && { agentVersion: c.agentVersion }),
  ...(c.model !== undefined && { model: c.model }),
  ...(c.modelParams !== undefined && { modelParams: c.modelParams }),
  ...(c.instructions !== undefined && { instructions: c.instructions }),
});

/**
 * Eval operations of the `Platform` tool (spec §14): eval sets, their cases, runs and results,
 * all for org admins (`evals.manage`), like the routes. Cases and full results are copies of
 * conversation content: reading one is audited (`trajectory.viewed`, `eval.results_viewed`) with
 * the operation that did it.
 */
@Injectable()
export class EvalsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(EvalSetsService) private readonly sets: EvalSetsService,
    @Inject(EvalRunsService) private readonly runs: EvalRunsService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  /** The position of a case in its set, from 1 (0 when it is not there): the case's label. */
  private async caseNo(ctx: OperationContext, setId: string, caseId: string): Promise<number> {
    const set = await orElse(() => this.sets.get(ctx.orgId, setId), null);
    return (set?.cases.findIndex((c) => c.id === caseId) ?? -1) + 1;
  }

  /** The set's eval-set row of the org, or the refusal the routes give. */
  private setCheck(ctx: OperationContext, setId: string): Promise<PrecheckResult> {
    return precheckBy(() => this.sets.get(ctx.orgId, setId));
  }

  /** Whether the set may take one more case (the configured maximum). */
  private async roomCheck(ctx: OperationContext, setId: string): Promise<PrecheckResult> {
    const found = await this.setCheck(ctx, setId);
    if (!found.ok) return found;
    const max = this.config.get().evals.maxCasesPerSet;
    const set = await this.sets.get(ctx.orgId, setId);
    return set.cases.length >= max
      ? {
          ok: false,
          code: "eval.too_many_cases",
          message: `The eval set already has ${max} cases, the most it can hold`,
        }
      : { ok: true };
  }

  private setName(ctx: OperationContext, setId: string): Promise<string> {
    return orElse(async () => named((await this.sets.get(ctx.orgId, setId)).name), setId);
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "evals.list-sets",
        description:
          "List the org's eval sets (org admins): name, agent, number of cases. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-sets"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const all = (await this.sets.list(ctx.orgId)).map(setRow);
          return pageOf(all, startOf(input.cursor), PAGE);
        },
      }),
      defineOperation({
        id: "evals.get-set",
        description:
          "Read one eval set with its cases, labelled case 1, case 2, ... (source conversation and run ids, agent version, replayable steps). Case titles and content are conversation content and are never returned; an org admin reads them on the web.",
        input: z.object({ setId: SetId }).strict(),
        example: { setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-sets/:setId"],
        confirm: "read",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
        ],
        run: async (input, ctx) => {
          const { cases, ...set } = await this.sets.get(ctx.orgId, input.setId);
          return { set, cases: cases.map((c, i) => caseRow(c, i + 1)) };
        },
      }),
      defineOperation({
        id: "evals.create-set",
        description:
          "Create an eval set for one agent (org admins), optionally with a rubric the judge scores by. Add cases afterwards with evals.add-case or evals.sample-cases.",
        input: EvalSetCreateBody,
        example: {
          agentId: "7c1a5b0e-9a53-4c6b-8d64-2f5a1b0c3e77",
          name: "Refund questions",
          rubric: "The answer states the refund window and does not promise exceptions.",
        },
        authz: { orgAction: "evals.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/eval-sets"],
        confirm: "org",
        errors: [
          {
            code: "agent.not_found",
            next: "Check the agent id with agents.list; an eval set belongs to one agent of this org.",
          },
        ],
        precheck: async (i, ctx) => {
          const a = await this.kdb.db
            .selectFrom("agents")
            .select("id")
            .where("id", "=", i.agentId)
            .where("org_id", "=", ctx.orgId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
          return a === undefined
            ? { ok: false, code: "agent.not_found", message: "Agent not found" }
            : { ok: true };
        },
        summary: (i) => ({
          zh: `新建评测集「${named(i.name)}」（智能体 ${i.agentId}）`,
          en: `Create eval set "${named(i.name)}" for agent ${i.agentId}`,
        }),
        run: async (input, ctx) => ({
          set: setRow(
            await this.sets.create(
              ctx.orgId,
              ctx.actorAccountId,
              {
                agentId: input.agentId,
                name: input.name,
                ...(input.description !== undefined && { description: input.description }),
                ...(input.rubric !== undefined && { rubric: input.rubric }),
              },
              undefined,
              viaAgent("evals.create-set", ctx),
            ),
          ),
        }),
      }),
      defineOperation({
        id: "evals.update-set",
        description:
          "Change an eval set's name, description or rubric (org admins); send only the fields to change. A null rubric clears it.",
        input: EvalSetPatchBody.extend({ setId: SetId })
          .strict()
          .refine(
            (v) => v.name !== undefined || v.description !== undefined || v.rubric !== undefined,
            {
              message: "Send at least one of name, description or rubric",
            },
          ),
        example: { setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10", name: "Refund questions v2" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/eval-sets/:setId"],
        confirm: "org",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
        ],
        precheck: (i, ctx) => this.setCheck(ctx, i.setId),
        summary: async (i, ctx) => {
          const n = await this.setName(ctx, i.setId);
          return {
            zh: `修改评测集「${n}」`,
            en: `Update eval set "${n}"`,
          };
        },
        run: async (input, ctx) => {
          const { setId, ...patch } = input;
          return {
            set: setRow(
              await this.sets.update(
                ctx.orgId,
                ctx.actorAccountId,
                setId,
                {
                  ...(patch.name !== undefined && { name: patch.name }),
                  ...(patch.description !== undefined && { description: patch.description }),
                  ...(patch.rubric !== undefined && { rubric: patch.rubric }),
                },
                undefined,
                viaAgent("evals.update-set", ctx),
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "evals.delete-set",
        description:
          "Delete an eval set (org admins): its cases and their copied conversation content are removed, runs in progress are cancelled, past results disappear with it.",
        input: z.object({ setId: SetId }).strict(),
        example: { setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/eval-sets/:setId"],
        confirm: "org",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
        ],
        precheck: (i, ctx) => precheckBy(() => this.sets.get(ctx.orgId, i.setId)),
        summary: async (i, ctx) => {
          const set = await orElse(() => this.sets.get(ctx.orgId, i.setId), null);
          const n = named(set?.name ?? i.setId);
          const cases = set?.cases.length ?? 0;
          return {
            zh: `删除评测集「${n}」：${cases} 个用例及其复制的对话内容将被删除，进行中的运行将被取消`,
            en: `Delete eval set "${n}": its ${cases} cases and their copied conversation content are removed and runs in progress are cancelled`,
          };
        },
        run: async (input, ctx) => {
          await this.sets.remove(
            ctx.orgId,
            ctx.actorAccountId,
            input.setId,
            undefined,
            viaAgent("evals.delete-set", ctx),
          );
          return { id: input.setId, deleted: true };
        },
      }),
      defineOperation({
        id: "evals.add-case",
        description:
          "Add one finished run of a conversation to an eval set as a case (org admins): a snapshot of that run is stored in the set. The conversation must belong to the set's agent.",
        input: EvalAddCaseBody.extend({ setId: SetId }).strict(),
        example: {
          setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10",
          conversationId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60",
          runId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        },
        authz: { orgAction: "evals.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/eval-sets/:setId/cases"],
        confirm: "org",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
          {
            code: "conversation.not_found",
            next: "The conversation or run is not in this org; check the ids on the conversation's page.",
          },
          {
            code: "eval.agent_mismatch",
            next: "The run belongs to another agent than the set's; add runs of the set's agent.",
          },
          { code: "eval.case_exists", next: "That run is already a case of the set." },
          {
            code: "eval.compact_not_replayable",
            next: "A manual compaction run has no step to replay; pick an ordinary run of the conversation.",
          },
          {
            code: "eval.too_many_cases",
            next: "The set is full; remove a case with evals.remove-case or use another set.",
          },
          {
            code: "eval.run_not_finished",
            next: "The run has not finished; add it after it ends.",
          },
          {
            code: "eval.case_too_large",
            next: "The run's snapshot is too large to store as a case.",
          },
        ],
        precheck: async (i, ctx) => {
          const found = await this.setCheck(ctx, i.setId);
          if (!found.ok) return found;
          const set = await this.sets.get(ctx.orgId, i.setId);
          const conv = await this.kdb.db
            .selectFrom("conversations")
            .select(["agent_id", "kind"])
            .where("id", "=", i.conversationId)
            .where("org_id", "=", ctx.orgId)
            .executeTakeFirst();
          if (conv?.kind !== "chat" && conv?.kind !== "subagent") {
            return {
              ok: false,
              code: "conversation.not_found",
              message: "Conversation or run not found",
            };
          }
          const sets = await this.kdb.db
            .selectFrom("eval_sets")
            .select("agent_id")
            .where("id", "=", i.setId)
            .executeTakeFirstOrThrow();
          if (conv.agent_id !== sets.agent_id) {
            return {
              ok: false,
              code: "eval.agent_mismatch",
              message: "The run belongs to a different agent",
            };
          }
          if (set.cases.some((c) => c.sourceRunId === i.runId)) {
            return {
              ok: false,
              code: "eval.case_exists",
              message: "That run is already a case of the eval set",
            };
          }
          const run = await this.kdb.db
            .selectFrom("runs")
            .select(["status", "compact"])
            .where("id", "=", i.runId)
            .where("conversation_id", "=", i.conversationId)
            .executeTakeFirst();
          if (run === undefined) {
            return {
              ok: false,
              code: "conversation.not_found",
              message: "Conversation or run not found",
            };
          }
          if (run.compact) {
            return {
              ok: false,
              code: "eval.compact_not_replayable",
              message: "A manual compaction run has no model step to replay",
            };
          }
          if (run.status === "running" || run.status === "queued") {
            return {
              ok: false,
              code: "eval.run_not_finished",
              message: "The run has not finished yet",
            };
          }
          return this.roomCheck(ctx, i.setId);
        },
        summary: async (i, ctx) => {
          const n = await this.setName(ctx, i.setId);
          return {
            zh: `把对话 ${i.conversationId} 的一次运行加入评测集「${n}」作为用例`,
            en: `Add a run of conversation ${i.conversationId} to eval set "${n}" as a case`,
          };
        },
        run: async (input, ctx) => {
          const { setId, ...body } = input;
          const added = await this.sets.addCase(
            ctx.orgId,
            ctx.actorAccountId,
            setId,
            body,
            undefined,
            viaAgent("evals.add-case", ctx),
          );
          return { case: caseRow(added, await this.caseNo(ctx, setId, added.id)) };
        },
      }),
      defineOperation({
        id: "evals.sample-cases",
        description:
          "Add random finished runs of the set's agent to an eval set as cases (org admins), up to count, optionally within a time range, by status or with a minimum number of tool calls. Returns how many were added and skipped.",
        input: EvalSampleBody.extend({ setId: SetId }).strict(),
        example: { setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10", count: 10 },
        authz: { orgAction: "evals.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/eval-sets/:setId/cases/sample"],
        confirm: "org",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
          {
            code: "eval.too_many_cases",
            next: "The set is full; remove a case with evals.remove-case or use another set.",
          },
        ],
        precheck: (i, ctx) => this.roomCheck(ctx, i.setId),
        summary: async (i, ctx) => {
          const n = await this.setName(ctx, i.setId);
          return {
            zh: `从评测集「${n}」的智能体的历史运行中随机抽样至多 ${i.count} 个用例`,
            en: `Sample up to ${i.count} cases from the history of the agent of eval set "${n}"`,
          };
        },
        run: async (input, ctx) => {
          const { setId, ...body } = input;
          return this.sets.sample(
            ctx.orgId,
            ctx.actorAccountId,
            setId,
            {
              count: body.count,
              ...(body.from !== undefined && { from: body.from }),
              ...(body.to !== undefined && { to: body.to }),
              ...(body.status !== undefined && { status: body.status }),
              ...(body.minToolCalls !== undefined && { minToolCalls: body.minToolCalls }),
            },
            undefined,
            viaAgent("evals.sample-cases", ctx),
          );
        },
      }),
      defineOperation({
        id: "evals.get-case",
        description:
          "Read one eval case's metadata (org admins): its label in the set, source conversation and run ids, agent version and how many steps can be replayed. The case's messages and trajectory are conversation content and are never returned; an org admin reads them on the web.",
        input: z.object({ setId: SetId, caseId: CaseId }).strict(),
        example: {
          setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10",
          caseId: "6e5d4c3b-2a19-4f08-9e7d-6c5b4a392817",
        },
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-sets/:setId/cases/:caseId"],
        confirm: "read",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
          {
            code: "eval.case_not_found",
            next: "Check the case id with evals.get-set.",
          },
        ],
        run: async (input, ctx) => {
          const set = await this.sets.get(ctx.orgId, input.setId);
          const i = set.cases.findIndex((c) => c.id === input.caseId);
          const found = set.cases[i];
          if (found === undefined) throw new ApiError("eval.case_not_found", "Eval case not found");
          return { case: caseRow(found, i + 1) };
        },
      }),
      defineOperation({
        id: "evals.remove-case",
        description:
          "Remove one case from an eval set (org admins); its copied conversation content and its results are deleted. Use the case id from evals.get-set.",
        input: z.object({ setId: SetId, caseId: CaseId }).strict(),
        example: {
          setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10",
          caseId: "6e5d4c3b-2a19-4f08-9e7d-6c5b4a392817",
        },
        authz: { orgAction: "evals.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/eval-sets/:setId/cases/:caseId"],
        confirm: "org",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
          { code: "eval.case_not_found", next: "Check the case id with evals.get-set." },
        ],
        precheck: async (i, ctx) => {
          const found = await this.setCheck(ctx, i.setId);
          if (!found.ok) return found;
          return (await this.caseNo(ctx, i.setId, i.caseId)) === 0
            ? { ok: false, code: "eval.case_not_found", message: "Eval case not found" }
            : { ok: true };
        },
        summary: async (i, ctx) => {
          const set = await orElse(() => this.sets.get(ctx.orgId, i.setId), null);
          const no = (set?.cases.findIndex((c) => c.id === i.caseId) ?? -1) + 1;
          const label = no === 0 ? i.caseId : `case ${no}`;
          const n = named(set?.name ?? i.setId);
          return {
            zh: `从评测集「${n}」移除用例 ${label}`,
            en: `Remove ${label} from eval set "${n}"`,
          };
        },
        run: async (input, ctx) => {
          await this.sets.removeCase(
            ctx.orgId,
            ctx.actorAccountId,
            input.setId,
            input.caseId,
            undefined,
            viaAgent("evals.remove-case", ctx),
          );
          return { id: input.caseId, removed: true };
        },
      }),
      defineOperation({
        id: "evals.estimate-run",
        description:
          "Estimate an eval run without starting it (org admins): the candidate (another agent version, model, model params or instructions) replayed over the set's cases, in step mode (one model call per case step) or run mode (whole runs). Returns request counts, estimated tokens and cost, and the token cap that would apply.",
        input: RunBody,
        example: {
          setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10",
          mode: "step",
          candidate: {},
          judge: false,
        },
        authz: { orgAction: "evals.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/eval-sets/:setId/runs/estimate"],
        confirm: "read",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
          {
            code: "eval.candidate_invalid",
            next: "The candidate cannot run on the cases; fix it as the message and details say.",
          },
          {
            code: "eval.token_cap_invalid",
            next: "Send a tokenCap within the limits of the estimate, or leave it out for the default.",
          },
        ],
        run: async (input, ctx) =>
          this.runs.estimate(ctx.orgId, input.setId, {
            mode: input.mode,
            candidate: candidateOf(input.candidate),
            judge: input.judge,
            ...(input.tokenCap !== undefined && { tokenCap: input.tokenCap }),
          }),
      }),
      defineOperation({
        id: "evals.start-run",
        description:
          "Start an eval run over a set's cases (org admins): the candidate is replayed on each case, optionally scored by the judge with the set's rubric. It spends model tokens up to the token cap; read evals.estimate-run first and show the estimate to the person.",
        input: RunBody,
        example: {
          setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10",
          mode: "step",
          candidate: {},
          judge: false,
        },
        authz: { orgAction: "evals.manage" },
        // the same body as the estimate, with the setId of the path
        mirrors: ["POST /api/v1/orgs/:orgId/eval-sets/:setId/runs"],
        confirm: "org",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
          {
            code: "eval.candidate_invalid",
            next: "The candidate cannot run on the cases; fix it as the message and details say.",
          },
          {
            code: "eval.nothing_to_replay",
            next: "The set has nothing to replay in this mode; add cases with evals.add-case.",
          },
          {
            code: "eval.token_cap_invalid",
            next: "Send a tokenCap within the limits shown by evals.estimate-run, or leave it out.",
          },
          {
            code: "agent.model_unavailable",
            next: {
              superAdmin:
                "The model cannot be used: configure its provider in the admin console, then start again.",
              orgAdmin:
                "The model cannot be used in this org; choose another or ask the super admin.",
              member: "The model cannot be used in this org; ask an org admin.",
            },
          },
        ],
        // a candidate or set the run cannot start with is denied before the card (read-only)
        precheck: async (i, ctx) => {
          let cases = 0;
          const checked = await precheckBy(async () => {
            const e = await this.runs.estimate(ctx.orgId, i.setId, {
              mode: i.mode,
              candidate: candidateOf(i.candidate),
              judge: i.judge,
              ...(i.tokenCap !== undefined && { tokenCap: i.tokenCap }),
            });
            cases = e.estimate.cases;
          });
          if (checked.ok && cases === 0) {
            return {
              ok: false,
              code: "eval.nothing_to_replay",
              message: "The eval set has nothing to replay",
            };
          }
          return checked;
        },
        summary: async (i, ctx) => {
          const n = await this.setName(ctx, i.setId);
          const est = await orElse(
            () =>
              this.runs.estimate(ctx.orgId, i.setId, {
                mode: i.mode,
                candidate: candidateOf(i.candidate),
                judge: i.judge,
                ...(i.tokenCap !== undefined && { tokenCap: i.tokenCap }),
              }),
            null,
          );
          const cand = candidateText(candidateOf(i.candidate));
          const judge = i.judge;
          const cost =
            est?.estimate.estimatedCost == null
              ? ""
              : ` ${est.estimate.estimatedCost} ${est.estimate.currency}`;
          const tokens = est === null ? "" : `${est.estimate.estimatedTokens}`;
          return {
            zh: `在评测集「${n}」上运行评测（${i.mode === "step" ? "单步" : "整轮"}，候选：${cand}${judge ? "，含评委" : ""}）${tokens ? `：约 ${tokens} tokens${cost}，上限 ${est?.effectiveTokenCap}` : ""}`,
            en: `Run an eval on set "${n}" (${i.mode} mode, candidate: ${cand}${judge ? ", with the judge" : ""})${tokens ? `: about ${tokens} tokens${cost}, capped at ${est?.effectiveTokenCap}` : ""}`,
          };
        },
        run: async (input, ctx) => ({
          run: runRow(
            await this.runs.start(
              ctx.orgId,
              ctx.actorAccountId,
              input.setId,
              {
                mode: input.mode,
                candidate: candidateOf(input.candidate),
                judge: input.judge,
                ...(input.tokenCap !== undefined && { tokenCap: input.tokenCap }),
              },
              undefined,
              viaAgent("evals.start-run", ctx),
            ),
          ),
        }),
      }),
      defineOperation({
        id: "evals.list-runs",
        description:
          "List the runs of one eval set, newest first (org admins): id, mode, state and progress. Read one with evals.get-run. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ setId: SetId, cursor: Cursor.optional() }).strict(),
        example: { setId: "3b1f0c52-8d2a-4a57-9a43-6f1d2c9e7a10" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-sets/:setId/runs"],
        extras: ["cursor"],
        confirm: "read",
        errors: [
          { code: "eval.set_not_found", next: "Check the eval set id with evals.list-sets." },
        ],
        run: async (input, ctx) =>
          pageOf(
            (await this.runs.listForSet(ctx.orgId, input.setId)).map(runRow),
            startOf(input.cursor),
            PAGE,
          ),
      }),
      defineOperation({
        id: "evals.get-run",
        description:
          "Read one eval run: its candidate, state, progress, token use, estimate and, once finished, the summary (match rates, judge and human pass rates).",
        input: z.object({ runId: RunId }).strict(),
        example: { runId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-runs/:runId"],
        confirm: "read",
        errors: [{ code: "eval.run_not_found", next: "Check the run id with evals.list-runs." }],
        run: async (input, ctx) => ({ run: await this.runs.get(ctx.orgId, input.runId) }),
      }),
      defineOperation({
        id: "evals.list-results",
        description:
          "List the results of one eval run without their content (org admins): state, judge verdict, your label, drift and error code per case step. Pages by 50: pass the returned next as params.after. Read one result's scalar fields with evals.get-result.",
        input: EvalRunResultsQuery.pick({ after: true, limit: true })
          .extend({ runId: RunId, limit: z.number().int().min(1).max(50).default(50) })
          .strict(),
        example: { runId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", limit: 50 },
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-runs/:runId/results"],
        // the light view only; polling by `updatedSince` is the web's
        omits: ["view", "updatedSince"],
        confirm: "read",
        errors: [{ code: "eval.run_not_found", next: "Check the run id with evals.list-runs." }],
        run: async (input, ctx) => {
          const out = await this.runs.resultsLight(
            ctx.orgId,
            ctx.actorAccountId,
            input.runId,
            { limit: input.limit, ...(input.after !== undefined && { after: input.after }) },
            undefined,
            viaAgent("evals.list-results", ctx),
          );
          return {
            items: out.results.map((r) => ({
              id: r.id,
              name: r.step === null ? "whole run" : `step ${r.step}`,
              state: r.status,
              ...(r.errorCode !== null && { reason: r.errorCode }),
              caseId: r.caseId,
              verdict: r.label ?? r.verdict,
              toolCallsMatch: r.toolCallsMatch,
            })),
            next: out.next,
          };
        },
      }),
      defineOperation({
        id: "evals.get-result",
        description:
          "Read one eval result without its content (org admins): status, judge status and verdict, your label and note, whether the tool calls matched, text similarity, drift reasons and the error code. The baseline and candidate outputs and the diff are conversation content and are never returned; an org admin reads them on the web.",
        input: z.object({ runId: RunId, resultId: ResultId }).strict(),
        example: {
          runId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
          resultId: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918",
        },
        authz: { orgAction: "evals.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/eval-runs/:runId/results/:resultId"],
        confirm: "read",
        errors: [
          { code: "eval.run_not_found", next: "Check the run id with evals.list-runs." },
          {
            code: "eval.result_not_found",
            next: "Check the result id with evals.list-results.",
          },
        ],
        run: async (input, ctx) => {
          const r = await this.runs.result(
            ctx.orgId,
            ctx.actorAccountId,
            input.runId,
            input.resultId,
            undefined,
            viaAgent("evals.get-result", ctx),
          );
          const diff = (r.diff ?? {}) as { toolCallsMatch?: boolean; textSimilarity?: number };
          const judge = (r.judge ?? {}) as { verdict?: string };
          const error = (r.error ?? {}) as { code?: string };
          return {
            result: {
              id: r.id,
              caseId: r.caseId,
              step: r.step,
              state: r.status,
              judgeStatus: r.judgeStatus,
              verdict: judge.verdict ?? null,
              label: r.label,
              labelNote: r.labelNote,
              toolCallsMatch: diff.toolCallsMatch ?? null,
              textSimilarity: diff.textSimilarity ?? null,
              drift: r.drift,
              errorCode: error.code ?? null,
            },
          };
        },
      }),
      defineOperation({
        id: "evals.cancel-run",
        description:
          "Cancel an eval run that is queued or running (org admins): cases not started are skipped; requests in flight finish and are recorded.",
        input: z.object({ runId: RunId }).strict(),
        example: { runId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/eval-runs/:runId/cancel"],
        confirm: "org",
        errors: [
          { code: "eval.run_not_found", next: "Check the run id with evals.list-runs." },
          { code: "eval.run_finished", next: "The run has already finished; nothing to cancel." },
        ],
        precheck: async (i, ctx) => {
          const found = await precheckBy(() => this.runs.get(ctx.orgId, i.runId));
          if (!found.ok) return found;
          const run = await this.runs.get(ctx.orgId, i.runId);
          return run.status === "queued" || run.status === "running"
            ? { ok: true }
            : {
                ok: false,
                code: "eval.run_finished",
                message: "The eval run has already finished",
              };
        },
        summary: async (i, ctx) => {
          const run = await orElse(() => this.runs.get(ctx.orgId, i.runId), null);
          const progress = run === null ? "" : ` (${run.casesDone}/${run.casesTotal} cases done)`;
          return {
            zh: `取消评测运行 ${i.runId}${progress}`,
            en: `Cancel eval run ${i.runId}${progress}`,
          };
        },
        run: async (input, ctx) => ({
          run: runRow(
            await this.runs.cancel(
              ctx.orgId,
              ctx.actorAccountId,
              input.runId,
              undefined,
              viaAgent("evals.cancel-run", ctx),
            ),
          ),
        }),
      }),
      defineOperation({
        id: "evals.label-result",
        description:
          "Label one eval result pass or fail with an optional note (org admins); a null label clears the label and its note.",
        input: EvalLabelBody.extend({ resultId: ResultId }).strict(),
        example: { resultId: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918", label: "pass" },
        authz: { orgAction: "evals.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/eval-results/:resultId/label"],
        confirm: "org",
        errors: [
          {
            code: "eval.result_not_found",
            next: "Check the result id with evals.list-results.",
          },
        ],
        precheck: async (i, ctx) => {
          const r = await this.kdb.db
            .selectFrom("eval_results as r")
            .innerJoin("eval_runs as er", "er.id", "r.run_id")
            .innerJoin("eval_sets as es", "es.id", "er.set_id")
            .select("r.id")
            .where("r.id", "=", i.resultId)
            .where("r.org_id", "=", ctx.orgId)
            .where("es.deleted_at", "is", null)
            .executeTakeFirst();
          return r === undefined
            ? { ok: false, code: "eval.result_not_found", message: "Eval result not found" }
            : { ok: true };
        },
        summary: (i) => ({
          zh:
            i.label === null
              ? `清除评测结果 ${i.resultId} 的人工标注`
              : `把评测结果 ${i.resultId} 标注为${i.label === "pass" ? "通过" : "不通过"}`,
          en:
            i.label === null
              ? `Clear the label of eval result ${i.resultId}`
              : `Label eval result ${i.resultId} as ${i.label}`,
        }),
        run: async (input, ctx) => {
          const r = await this.runs.label(
            ctx.orgId,
            ctx.actorAccountId,
            input.resultId,
            { label: input.label, ...(input.note !== undefined && { note: input.note }) },
            undefined,
            viaAgent("evals.label-result", ctx),
          );
          return { id: r.id, label: r.label, labelNote: r.labelNote };
        },
      }),
    ]);
  }
}
