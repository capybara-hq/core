import type { ConnectorAuth, Credentials } from "./credentials.js";

/**
 * The org-level input a connector's auth needs (plugin pages spec §5.2.1): `client`, the OAuth
 * client of the client-credentials flow or of an authorization-code flow with a manually
 * registered client; `credential`, a static credential the org owns.
 */
export type SetupNeed = "client" | "credential";

/**
 * A connector's setup state, derived on every read and never stored: `needs_config` while the
 * org input its auth needs is absent, `ready` otherwise. Independent of `status`.
 */
export type ConnectorSetup = "ready" | "needs_config";

/**
 * The org input `auth` needs, undefined when it needs none (no auth, a personal credential, or an
 * authorization-code flow that registers its client itself). The web's `templateNeed`
 * (apps/web/src/lib/catalog.ts) applies the same rule.
 */
export function setupNeed(auth: ConnectorAuth): SetupNeed | undefined {
  if (auth.type === "oauth_client" || (auth.type === "oauth_code" && auth.client === "manual")) {
    return "client";
  }
  if (auth.type !== "none" && auth.type !== "oauth_code" && auth.ownership === "org") {
    return "credential";
  }
  return undefined;
}

/**
 * The setup states of several connectors of `orgId` at once (one query, key presence only), by
 * connector id.
 */
export async function connectorSetups(
  credentials: Pick<Credentials, "orgInputs">,
  orgId: string,
  connectors: readonly { id: string; auth: ConnectorAuth }[],
): Promise<Map<string, ConnectorSetup>> {
  const inputs = await credentials.orgInputs(
    orgId,
    connectors.filter((c) => setupNeed(c.auth) !== undefined).map((c) => c.id),
  );
  return new Map(
    connectors.map((c) => {
      const need = setupNeed(c.auth);
      const ready = need === undefined || inputs.get(c.id)?.[need] === true;
      return [c.id, ready ? "ready" : "needs_config"];
    }),
  );
}

/** The setup state of a connector of `orgId` with `auth`, read from key presence only. */
export async function connectorSetup(
  credentials: Pick<Credentials, "hasOrgInput">,
  orgId: string,
  connectorId: string,
  auth: ConnectorAuth,
): Promise<ConnectorSetup> {
  const need = setupNeed(auth);
  if (need === undefined) return "ready";
  return (await credentials.hasOrgInput(orgId, connectorId, need)) ? "ready" : "needs_config";
}
