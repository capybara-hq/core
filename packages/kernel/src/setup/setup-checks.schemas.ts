import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `:itemId` / `:guideId` of the check routes. */
export const SetupGuidePathParams = z.object({
  itemId: z.string().min(1).max(100),
  guideId: z.string().min(1).max(64),
});

/** `:itemId` / `:guideId` / `:checkId` of the run route (`capybara:<id>` for a kernel check). */
export const SetupCheckPathParams = SetupGuidePathParams.extend({
  checkId: z.string().min(1).max(64),
});

/**
 * The guide the checks belong to, as the guide route renders it (spec
 * 2026-11-09-setup-guides-v2-design.md §10.3): its mode and audience (checked against the place by
 * the service) and the target (`connectionId` for a channel connection, `connectorId` for a
 * connector made from the template). Checks need a target.
 */
const GuideSelection = {
  mode: z.string().min(1).max(64).optional(),
  audience: z.enum(["admin", "member"]).optional(),
  connectionId: z.string().min(1).max(100).optional(),
  connectorId: z.string().min(1).max(100).optional(),
};

/** `GET …/guides/:guideId/checks`: the cached states, nothing runs. */
export const SetupChecksQuery = z.object(GuideSelection).strict();

/**
 * `POST …/guides/:guideId/checks/:checkId/run`: runs the check unless a fresh cached result exists;
 * `force` reruns it (at most once per 10 seconds per check and target).
 */
export const SetupCheckRunBody = z
  .object({ ...GuideSelection, force: z.boolean().optional() })
  .strict();

export const SETUP_CHECK_ROUTES: readonly RouteSchemas[] = [
  {
    route: "GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks",
    params: SetupGuidePathParams,
    query: SetupChecksQuery,
  },
  {
    route: "POST /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks/:checkId/run",
    params: SetupCheckPathParams,
    body: SetupCheckRunBody,
  },
];
