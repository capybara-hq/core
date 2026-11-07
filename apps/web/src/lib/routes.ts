/** Pages reachable without signing in. */
export const PUBLIC_PREFIXES = ["/login", "/setup", "/invite", "/bind"] as const;

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Whether a page path (no query) is public: one of {@link PUBLIC_PREFIXES} or below it. */
export const isPublicPath = (path: string): boolean => PUBLIC_PREFIXES.some((p) => under(path, p));

/** Whether a page path (no query) is in the admin console. */
export const isAdminPath = (path: string): boolean => under(path, "/admin");

/**
 * The workspace's home: the new conversation at `/` (maintainer decision 2026-11-07, acceptance;
 * there is no separate home page). The old `/chat` redirects here permanently (`next.config.mjs`),
 * and every "go home" (sign-in, setup, an org switch, the not-found page, the path's org scope)
 * goes here directly.
 */
export const HOME_PATH = "/";

/** The new conversation, with `agentId` picked when given (`/?agent=<id>`). */
export const newConversationPath = (agentId?: string): string =>
  agentId === undefined ? HOME_PATH : `${HOME_PATH}?agent=${encodeURIComponent(agentId)}`;
