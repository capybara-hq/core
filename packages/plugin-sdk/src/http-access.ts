import type { UiRole } from "./ui.js";

/**
 * Who may call an extension route (declared per route in `permissions.http`, enforced by the
 * kernel before the handler runs and before the body is read):
 *
 * - `public`: anyone; unsafe methods are rate-limited per client IP. Mounted at
 *   `/plugins/<name><path>`.
 * - `embed`: the holder of an embed token (see `ctx.ui`); path under `/ui/`. Mounted at
 *   `/plugins/<name><path>`.
 * - `member` / `admin`: an org member (admin: org admin and up) with a personal access token.
 *   Mounted at `/plugins/<name>/orgs/:orgId<path>`.
 */
export const HTTP_ACCESS = ["public", "embed", "member", "admin"] as const;
export type HttpAccess = (typeof HTTP_ACCESS)[number];

/** One entry of `permissions.http`. */
export interface HttpPermission {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  access: HttpAccess;
}

/**
 * The caller the kernel resolved for a route, passed to the handler as its second argument.
 * Trust only this (`caller.orgId`, never an org id in the body or query).
 */
export type RouteCaller =
  | { access: "public" }
  | {
      access: "embed";
      scope: "org";
      orgId: string;
      accountId: string;
      role: UiRole;
      contribution: string;
      conversationId?: string;
      /** The token's expiry (Unix seconds): a long-lived response (SSE) ends by then. */
      exp: number;
      config: unknown;
    }
  | {
      access: "embed";
      scope: "platform";
      accountId: string;
      role: "superAdmin";
      contribution: string;
      /** The token's expiry (Unix seconds): a long-lived response (SSE) ends by then. */
      exp: number;
    }
  | {
      access: "member" | "admin";
      orgId: string;
      accountId: string;
      role: UiRole;
      config: unknown;
    };
