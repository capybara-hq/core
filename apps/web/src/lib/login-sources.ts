import { apiFetch } from "./api";

/** What a sign-in calls a tenant (an identity source's `tenant` declaration, login extensions spec §2). */
export interface LoginSourceTenant {
  /** The tenant's name in the admin console ("Slack 工作区 ID"). */
  label: { zh: string; en: string };
  /** Where to find it. */
  help?: { zh: string; en: string };
  /** A regular expression a tenant id matches (an invalid one counts as none). */
  pattern?: string;
  placeholder?: string;
  /** Tenants that may never be trusted (google `consumer`). */
  neverTrusted?: string[];
}

/** One login method of the platform (`GET /api/v1/admin/login-sources`). */
export interface LoginSource {
  plugin: string;
  /** The sign-in's label; the plugin name while its extension is not loaded. */
  label: { zh: string; en: string };
  tenant?: LoginSourceTenant;
  /** The login page offers it. */
  enabled: boolean;
  /** An external account nobody has linked: the link page, or a new account. */
  signUp: "link" | "create";
  /** Tenant ids whose verified emails link to the existing account with that email. */
  trustedTenants: string[];
  /** Its extension is loaded and provides `identity-source@1`. */
  available: boolean;
  /** Its deployment config is invalid: turning it on is refused. */
  needsConfig: boolean;
  /** The redirect URI to register at the identity provider; null while the public URL is unset. */
  callbackUrl: string | null;
}

/** The fields one write changes (a field left out keeps its value). */
export type LoginSourcePatch = Partial<Pick<LoginSource, "enabled" | "signUp" | "trustedTenants">>;

const BASE = "/api/v1/admin/login-sources";

/** Every login method: the enabled ones first in login page order, then the rest by name. */
export const listLoginSources = () => apiFetch<{ items: LoginSource[] }>(BASE);

/** `PUT /api/v1/admin/login-sources/:plugin`: the answer is the method as it is now. */
export const updateLoginSource = (plugin: string, patch: LoginSourcePatch) =>
  apiFetch<LoginSource>(`${BASE}/${encodeURIComponent(plugin)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });

/** `PUT /api/v1/admin/login-sources/order`: every enabled method once, in login page order. */
export const reorderLoginSources = (plugins: string[]) =>
  apiFetch<{ items: LoginSource[] }>(`${BASE}/order`, {
    method: "PUT",
    body: JSON.stringify({ plugins }),
  });

/**
 * Checks a trusted tenant id against the source's declaration: the same rule as the SDK's
 * `validateTenantId` (packages/plugin-sdk/src/identity.ts), copied here because the web does not
 * import the SDK; the kernel checks again on save (`login_sources.invalid_tenant`).
 */
export function validateTenantId(
  decl: LoginSourceTenant | undefined,
  id: string,
): "ok" | "pattern" | "never_trusted" | "empty" {
  const value = id.trim();
  if (value === "") return "empty";
  if (decl?.pattern) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(decl.pattern);
    } catch {
      re = undefined;
    }
    if (re && !re.test(value)) return "pattern";
  }
  if (decl?.neverTrusted?.includes(value)) return "never_trusted";
  return "ok";
}

/** The tenant ids of the trusted tenants text: one per line, trimmed, blanks and repeats dropped. */
export const tenantsOf = (text: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  ),
];

/** The first tenant of a list the declaration refuses, with the reason; null when all pass. */
export function firstInvalidTenant(
  decl: LoginSourceTenant | undefined,
  tenants: string[],
): { tenant: string; reason: "pattern" | "never_trusted" } | null {
  for (const tenant of tenants) {
    const r = validateTenantId(decl, tenant);
    if (r === "pattern" || r === "never_trusted") return { tenant, reason: r };
  }
  return null;
}
