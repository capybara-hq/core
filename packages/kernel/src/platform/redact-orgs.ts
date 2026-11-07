/**
 * Keys whose value lists orgs in the platform views (`CatalogItemView.scopeOrgs`, the update
 * preview's `extension.orgs`, `connectorOrgs`, a component's `pinnedOrgs` and `kept`, a scope
 * preview's `affected`, …): replaced with `{ count }`.
 */
const ORG_LISTS: ReadonlySet<string> = new Set([
  "orgs",
  "scopeOrgs",
  "pinnedOrgs",
  "connectorOrgs",
  "kept",
  "usedBy",
  "affected",
]);

/** Keys naming one org, or orgs by id: dropped. */
const ORG_KEYS: ReadonlySet<string> = new Set([
  "orgId",
  "orgIds",
  "orgName",
  "orgNames",
  "ownerOrgId",
]);

/**
 * A super-admin result as it may enter one org's event log (Platform tool spec §6.1): every org
 * list becomes `{ count }`, org ids and names elsewhere are dropped, and an org owner is given as
 * `{ kind: "org" }` only. Shared agents, trajectories and eval snapshots expose the log to other
 * people, so another org is never named or described; the admin console shows which.
 */
export function redactOrgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOrgs);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (ORG_KEYS.has(k)) continue;
    if (ORG_LISTS.has(k) && Array.isArray(v)) {
      out[k] = { count: v.length };
      continue;
    }
    if (k === "owner" && isOrgOwner(v)) {
      out[k] = { kind: "org" };
      continue;
    }
    out[k] = redactOrgs(v);
  }
  return out;
}

const isOrgOwner = (v: unknown): boolean =>
  typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "org";
