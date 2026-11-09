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

/** The longest `?draft=` the new conversation reads into its composer; the rest is dropped. */
export const MAX_DRAFT_PARAM = 4000;

/**
 * The new conversation with `draft` in its composer (`/?draft=<text>`): prefilled, never sent; the
 * person reads it and sends it themselves. A draft carries no secret (the callers build it from
 * names and ids only).
 */
export const draftConversationPath = (draft: string): string =>
  `${HOME_PATH}?${new URLSearchParams({ draft: draft.slice(0, MAX_DRAFT_PARAM) })}`;
