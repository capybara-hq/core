import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { CONTROL_OR_HIDDEN_RE } from "../text.js";
import { CONVERSATION_TITLE_MAX_CHARS } from "./conversations.service.js";
import { FILES_PAGE_MAX } from "./files.js";

/** Shared by the list and groups queries: title search, run activity and the archived list. */
export const searchFields = {
  q: z.string().min(1).max(100).optional(),
  state: z.enum(["running", "waiting"]).optional(),
  archived: z.enum(["1"]).optional(),
};

export const ListQuery = z.object({
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only this agent's conversations (the sidebar's per-group "More"). */
  agentId: z.string().min(1).max(100).optional(),
  ...searchFields,
});

export const EventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    /** The page before this seq, or the log's last page (`end`); exclusive with `after`. */
    before: z.union([z.literal("end"), z.coerce.number().int().min(1)]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .refine((q) => q.after === undefined || q.before === undefined, {
    message: "after and before are exclusive",
    path: ["before"],
  });

/**
 * A rename: 1–120 characters counted in code points after trimming, with no control or format
 * (bidi, zero-width) characters, the same rule generated and tool titles follow.
 */
export const PatchBody = z
  .object({
    title: z
      .string()
      .max(CONVERSATION_TITLE_MAX_CHARS * 2 + 100)
      .trim()
      .refine((t) => t.length > 0, "title must not be empty")
      .refine(
        (t) => Array.from(t).length <= CONVERSATION_TITLE_MAX_CHARS,
        `title must be at most ${CONVERSATION_TITLE_MAX_CHARS} characters`,
      )
      .refine(
        (t) => !CONTROL_OR_HIDDEN_RE.test(t),
        "title must not contain control or format characters",
      )
      .optional(),
    /** true archives (hidden from the default lists), false unarchives. */
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) => b.title !== undefined || b.archived !== undefined,
    "title or archived is required",
  );

export const IdParams = z.object({ id: z.string().min(1).max(100) });

export const SubagentsQuery = z.object({
  /** The previous page's last sub-agent id (`next`). */
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const FilesQuery = z.object({
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(FILES_PAGE_MAX).default(50),
});

/** The conversation routes a Platform operation mirrors (spec §14, conversations). */
export const CONVERSATION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/conversations", query: ListQuery },
  { route: "GET /api/v1/orgs/:orgId/conversations/:id", params: IdParams },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/events",
    params: IdParams,
    query: EventsQuery,
  },
  { route: "PATCH /api/v1/orgs/:orgId/conversations/:id", params: IdParams, body: PatchBody },
  { route: "DELETE /api/v1/orgs/:orgId/conversations/:id", params: IdParams },
  {
    route: "GET /api/v1/orgs/:orgId/conversations/:id/subagents",
    params: IdParams,
    query: SubagentsQuery,
  },
  { route: "GET /api/v1/orgs/:orgId/conversations/:id/agent-tree", params: IdParams },
  { route: "GET /api/v1/orgs/:orgId/conversations/:id/usage", params: IdParams },
  { route: "GET /api/v1/orgs/:orgId/conversations/:id/files", params: IdParams, query: FilesQuery },
  { route: "GET /api/v1/orgs/:orgId/conversations/:id/environment", params: IdParams },
  { route: "POST /api/v1/orgs/:orgId/conversations/:id/abort", params: IdParams },
];
