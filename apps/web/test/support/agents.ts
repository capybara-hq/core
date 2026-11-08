/** Shared helpers for the agent page tests: the form's server reads, `/agents/new` and `/agents/<id>`. */
import { json, lastStubRoutes } from "./api";
import { renderRouteWithCache } from "./query";
import type { Routes } from "./server";

const ORG = "/api/v1/orgs/o1";

/**
 * What the agent form reads on the server besides the models (and, editing, the agent), answered
 * empty: tests override what they are about.
 */
export function agentFormDefaults(agentId = "ag1"): Routes {
  const ok = (body: unknown) => () => json(200, body);
  return {
    [`GET ${ORG}/connectors`]: ok({ connectors: [] }),
    [`GET ${ORG}/skills`]: ok({ skills: [] }),
    [`GET ${ORG}/agent-templates`]: ok({ templates: [] }),
    [`GET ${ORG}/agents`]: ok({ agents: [] }),
    [`GET ${ORG}/members`]: ok({ members: [] }),
    // the platform components offered to the org (the editor's unavailable ids)
    [`GET ${ORG}/components`]: ok({ components: [] }),
    [`GET ${ORG}/agents/${agentId}/skills`]: ok({ skills: [] }),
    [`GET ${ORG}/channels`]: ok({ channels: [] }),
    [`GET ${ORG}/ui/contributions`]: ok({ items: [] }),
    [`GET ${ORG}/extension-points/available`]: ok({ points: [] }),
    [`GET ${ORG}/tools/extensions`]: ok({ extensions: [] }),
    [`GET ${ORG}/attachments/limits`]: ok({
      types: ["image/png"],
      maxBytes: 1,
      imageMaxBytes: 1,
      maxPerMessage: 1,
      requestMediaBytes: 1,
      available: true,
    }),
  };
}

type Opts = Parameters<typeof renderRouteWithCache>[2] & { routes?: Routes };

/**
 * `/agents/new` as a first load renders it: the layout prefetches from the routes of the latest
 * `stubApi` call (the browser's) over {@link agentFormDefaults}, and the page reads the cache.
 */
export function renderNewAgent(opts: Opts = {}) {
  const { routes = lastStubRoutes(), ...rest } = opts;
  return renderRouteWithCache("/agents/new", { ...agentFormDefaults(), ...routes }, rest);
}

/**
 * `/agents/<id>` (or one of its sections, `?s=<section>`) as a first load renders it (routes as in
 * {@link renderNewAgent}).
 */
export function renderEditAgent(opts: Opts & { id?: string; section?: string } = {}) {
  const { id = "ag1", section, routes = lastStubRoutes(), ...rest } = opts;
  return renderRouteWithCache(
    `/agents/${encodeURIComponent(id)}${section === undefined ? "" : `?s=${section}`}`,
    { ...agentFormDefaults(id), ...routes },
    rest,
  );
}
