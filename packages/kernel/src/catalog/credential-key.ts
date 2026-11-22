import { canonicalJson } from "../tools/canonical-json.js";
import type { ConnectorAuth } from "../tools/credentials.js";

/**
 * What a credential of `auth` looks like: two auths with the same key take the same stored
 * credential (static: the type family, ownership and header names; OAuth: any other change
 * re-enters), so a template update that changes the key clears the connector's stored credentials
 * (`credentialsReset`). An `oauth_code` preset compares by canonical JSON without
 * `authorizationParams`: they only shape the next authorize request, so
 * existing tokens and the org's OAuth client stay valid (design 2026-11-22 §3.4, D3).
 */
export function credentialKey(auth: ConnectorAuth): string {
  switch (auth.type) {
    case "none":
      return "none";
    case "bearer":
    case "api_key":
      return `token:${auth.ownership}`;
    case "basic":
      return `basic:${auth.ownership}`;
    case "headers":
      return `headers:${auth.ownership}:${[...auth.names].sort().join(",")}`;
    case "oauth_code": {
      const { authorizationParams: _ignored, ...rest } = auth;
      return canonicalJson(rest);
    }
    default:
      return canonicalJson(auth);
  }
}
