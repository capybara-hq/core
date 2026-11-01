import { safeReturnTo } from "./auth-sources";

/**
 * What the channel form is opened with from an agent page: `?agentId=<id>` presets the agent,
 * `?returnTo=<path>` is where saving or cancelling goes back to. `returnTo` is kept only when it is
 * a same-origin relative path (a single leading `/`, see {@link safeReturnTo}); anything else is
 * dropped. Read from the page's `searchParams` on the server.
 */
export function channelFormPreset(query: {
  agentId?: string | string[];
  returnTo?: string | string[];
}): { agentId: string; returnTo: string | undefined } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const raw = one(query.returnTo);
  const returnTo = raw !== undefined && safeReturnTo(raw) === raw ? raw : undefined;
  return { agentId: one(query.agentId) ?? "", returnTo };
}

/** The channel form link from an agent page. */
export function newChannelHref(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return `/channels/new?agentId=${id}&returnTo=${encodeURIComponent(`/agents/${agentId}`)}`;
}
