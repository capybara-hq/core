/** Shared helpers for the agent page tests: the form's server reads, `/agents/new` and `/agents/<id>`. */
import EditAgentPage from "../../src/app/(app)/agents/[id]/page";
import NewAgentPage from "../../src/app/(app)/agents/new/page";
import { json, lastStubRoutes } from "./api";
import { type Routes, renderRoute } from "./server";

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
    [`GET ${ORG}/agents/${agentId}/skills`]: ok({ skills: [] }),
    [`GET ${ORG}/channels`]: ok({ channels: [] }),
  };
}

type Opts = Parameters<typeof renderRoute>[2] & { routes?: Routes };

/**
 * `/agents/new` as the app renders it: the server reads from the routes of the latest `stubApi`
 * call (the browser's) over {@link agentFormDefaults}.
 */
export function renderNewAgent(opts: Opts = {}) {
  const { routes = lastStubRoutes(), ...rest } = opts;
  return renderRoute(() => NewAgentPage(), { ...agentFormDefaults(), ...routes }, rest);
}

/** `/agents/<id>` as the app renders it (routes as in {@link renderNewAgent}). */
export function renderEditAgent(opts: Opts & { id?: string } = {}) {
  const { id = "ag1", routes = lastStubRoutes(), ...rest } = opts;
  return renderRoute(
    () => EditAgentPage({ params: Promise.resolve({ id }) }),
    { ...agentFormDefaults(id), ...routes },
    rest,
  );
}
