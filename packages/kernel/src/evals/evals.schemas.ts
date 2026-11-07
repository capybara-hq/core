import { z } from "zod";
import { ModelRef } from "../agents/definition.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

const NAME = z.string().trim().min(1).max(200);
const DESCRIPTION = z.string().max(2000);
const RUBRIC = z.string().min(1).max(20_000);

export const EvalSetCreateBody = z
  .object({
    agentId: z.string().min(1).max(100),
    name: NAME,
    description: DESCRIPTION.optional(),
    rubric: RUBRIC.optional(),
  })
  .strict();

export const EvalSetPatchBody = z
  .object({
    name: NAME.optional(),
    description: DESCRIPTION.optional(),
    rubric: RUBRIC.nullable().optional(),
  })
  .strict();

export const EvalAddCaseBody = z
  .object({ conversationId: z.string().min(1).max(100), runId: z.string().min(1).max(100) })
  .strict();

export const EvalSampleBody = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    count: z.number().int().min(1).max(50),
    status: z.enum(["completed", "failed", "any"]).optional(),
    minToolCalls: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const EvalCandidateSchema = z
  .object({
    agentVersion: z.number().int().min(1).optional(),
    model: ModelRef.strict().optional(),
    modelParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    instructions: z.string().max(100_000).optional(),
  })
  .strict();

/** `tokenCap` is only type-checked here; the service judges the range (`eval.token_cap_invalid`). */
export const EvalRunEstimateBody = z
  .object({
    mode: z.enum(["step", "run"]),
    candidate: EvalCandidateSchema,
    judge: z.boolean().default(false),
    tokenCap: z.number().int().optional(),
  })
  .strict();

export const EvalRunStartBody = EvalRunEstimateBody;

/**
 * `view=light`: no content blocks (result tables and polling; the response carries `asOf`);
 * default `full`. `updatedSince` (ISO time) takes only what changed after it.
 */
export const EvalRunResultsQuery = z
  .object({
    after: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    view: z.enum(["full", "light"]).default("full"),
    updatedSince: z
      .string()
      .max(64)
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO timestamp" })
      .optional(),
  })
  .strict();

export const EvalLabelBody = z
  .object({
    label: z.enum(["pass", "fail"]).nullable(),
    note: z.string().max(2000).optional(),
  })
  .strict();

/** The path params the eval routes read (`@Param`), bounded as the operations take them. */
const Id = z.string().min(1).max(100);
export const EvalSetParams = z.object({ setId: Id });
export const EvalCaseParams = z.object({ setId: Id, caseId: Id });
export const EvalRunParams = z.object({ runId: Id });
export const EvalResultParams = z.object({ runId: Id, resultId: Id });
export const EvalLabelParams = z.object({ resultId: Id });

const O = "/api/v1/orgs/:orgId";

export const EVAL_ROUTES: readonly RouteSchemas[] = [
  { route: `POST ${O}/eval-sets`, body: EvalSetCreateBody },
  { route: `GET ${O}/eval-sets` },
  { route: `GET ${O}/eval-sets/:setId`, params: EvalSetParams },
  { route: `PATCH ${O}/eval-sets/:setId`, params: EvalSetParams, body: EvalSetPatchBody },
  { route: `DELETE ${O}/eval-sets/:setId`, params: EvalSetParams },
  { route: `POST ${O}/eval-sets/:setId/cases`, params: EvalSetParams, body: EvalAddCaseBody },
  {
    route: `POST ${O}/eval-sets/:setId/cases/sample`,
    params: EvalSetParams,
    body: EvalSampleBody,
  },
  { route: `GET ${O}/eval-sets/:setId/cases/:caseId`, params: EvalCaseParams },
  { route: `DELETE ${O}/eval-sets/:setId/cases/:caseId`, params: EvalCaseParams },
  {
    route: `POST ${O}/eval-sets/:setId/runs/estimate`,
    params: EvalSetParams,
    body: EvalRunEstimateBody,
  },
  { route: `POST ${O}/eval-sets/:setId/runs`, params: EvalSetParams, body: EvalRunStartBody },
  { route: `GET ${O}/eval-sets/:setId/runs`, params: EvalSetParams },
  { route: `GET ${O}/eval-runs/:runId`, params: EvalRunParams },
  { route: `GET ${O}/eval-runs/:runId/results`, params: EvalRunParams, query: EvalRunResultsQuery },
  { route: `GET ${O}/eval-runs/:runId/results/:resultId`, params: EvalResultParams },
  { route: `POST ${O}/eval-runs/:runId/cancel`, params: EvalRunParams },
  { route: `PUT ${O}/eval-results/:resultId/label`, params: EvalLabelParams, body: EvalLabelBody },
];
