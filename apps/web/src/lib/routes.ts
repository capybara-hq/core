/** Pages reachable without signing in. */
export const PUBLIC_PREFIXES = ["/login", "/setup", "/invite", "/bind"] as const;

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Whether a page path (no query) is public: one of {@link PUBLIC_PREFIXES} or below it. */
export const isPublicPath = (path: string): boolean => PUBLIC_PREFIXES.some((p) => under(path, p));

/** Whether a page path (no query) is in the admin console. */
export const isAdminPath = (path: string): boolean => under(path, "/admin");

/**
 * The workspace's home: the new conversation (acceptance 2026-11-07; there is no separate home
 * page). `/` redirects here (`next.config.mjs`), and every "go home" (sign-in, setup, an org
 * switch, the not-found page, the path's org scope) goes here directly.
 */
export const HOME_PATH = "/chat";
