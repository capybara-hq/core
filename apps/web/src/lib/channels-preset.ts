import { safeReturnTo } from "./auth-sources";

/**
 * What the channel form is opened with from an agent page: `?agentId=<id>` presets the agent,
 * `?returnTo=<path>` is where saving or cancelling goes back to. `returnTo` is kept only when it is
 * a same-origin relative path (a single leading `/`, see {@link safeReturnTo}); anything else is
 * dropped. Read in the browser only (the query string is not available while rendering on the
 * server; the page renders after the session loads).
 */
export function channelFormPreset(): { agentId: string; returnTo: string | undefined } {
  if (typeof window === "undefined") return { agentId: "", returnTo: undefined };
  const q = new URLSearchParams(window.location.search);
  const raw = q.get("returnTo");
  const returnTo = raw !== null && safeReturnTo(raw) === raw ? raw : undefined;
  return { agentId: q.get("agentId") ?? "", returnTo };
}

/** The channel form link from an agent page. */
export function newChannelHref(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return `/channels/new?agentId=${id}&returnTo=${encodeURIComponent(`/agents/${agentId}`)}`;
}
