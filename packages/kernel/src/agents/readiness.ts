import type { ModelProviderReadiness } from "../runtime/providers.js";

/**
 * The readiness answer (`GET /orgs/:orgId/readiness` and the Platform operation
 * `agents.readiness`): `modelProvider` is `ready`, `not_enabled` (providers are deployed and usable
 * here once the org enables one: `notEnabledProviders`) or `none`; `agents` counts the agents the
 * caller can see.
 */
export interface OrgReadiness {
  modelProvider: ModelProviderReadiness["state"];
  /** The deployed providers the org has not enabled (non-empty only with `not_enabled`). */
  notEnabledProviders: string[];
  agents: number;
}

/** The readiness answer from the registry's provider state and the visible agent count. */
export function orgReadiness(p: ModelProviderReadiness, agents: number): OrgReadiness {
  return { modelProvider: p.state, notEnabledProviders: p.notEnabled, agents };
}
