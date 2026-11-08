import { apiFetch } from "./api";
import type { LocalizedName } from "./catalog";
import { extensionLabel } from "./extension-label";

/**
 * The kernel's environments API (`packages/kernel/src/environments/environments.service.ts`; only the
 * fields the UI uses). Web code never imports kernel code.
 */

export interface EnvironmentLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  egress: "none" | "allowlist" | "open";
  allowHosts: string[];
}

export interface Environment {
  id: string;
  /**
   * null for the person's default environment (shown as 个人环境 / "Personal") and for a former
   * default (shown from `demotedFrom`); see {@link environmentName}.
   */
  name: string | null;
  isDefault: boolean;
  /**
   * A former default demoted by a sandbox provider switch: the provider it was demoted from, its
   * display name (null: show the id) and its place among the unnamed ones of that provider (1, 2,
   * …). It becomes the default again when the platform switches back to that provider.
   */
  demotedFrom: { provider: string; displayName: LocalizedName | null; ordinal: number } | null;
  ownerKind: "personal";
  source: "cloud";
  provider: string | null;
  /** Its provider is the deployment's current sandbox provider. */
  available: boolean;
  sessionIsolation: boolean;
  /** Its file system is gone at the provider; resetting the files makes it usable again. */
  filesLost: boolean;
  instance: { status: "running" | "suspended"; lastUsedAt: string } | null;
  limits: EnvironmentLimits;
  createdAt: string;
}

export interface EnvironmentList {
  items: Environment[];
  defaultId: string | null;
  lastUsedId: string | null;
  /** The platform has a sandbox provider: new cloud environments can be made. */
  cloudAvailable: boolean;
}

/** What an environment is doing, in the order the page decides: a missing provider wins. */
export type EnvironmentState = "unavailable" | "filesLost" | "running" | "suspended" | "notStarted";

export function environmentState(e: Environment): EnvironmentState {
  if (!e.available) return "unavailable";
  if (e.filesLost) return "filesLost";
  return e.instance?.status ?? "notStarted";
}

/**
 * An environment's name for people: its own name, else 个人环境 / "Personal" for the default, else
 * for a former default 个人环境（Docker 沙箱） / "Personal (Docker sandbox)" (the provider's display
 * name, its id when it has none), with " 2", " 3", … after the first of the same provider.
 */
export function environmentName(
  e: Pick<Environment, "name" | "demotedFrom">,
  text: { personal: string; demoted(provider: string): string },
  locale: "zh" | "en",
): string {
  if (e.name !== null) return e.name;
  const d = e.demotedFrom;
  if (!d) return text.personal;
  const provider = extensionLabel({ name: d.provider, displayName: d.displayName }, locale);
  return text.demoted(provider) + (d.ordinal > 1 ? ` ${d.ordinal}` : "");
}

/** An environment name as the kernel limits it (trimmed, 1-64 characters). */
export const isEnvironmentName = (s: string): boolean => {
  const n = s.trim().length;
  return n >= 1 && n <= 64;
};

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/environments`;
const enc = encodeURIComponent;

export const listEnvironments = (orgId: string) => apiFetch<EnvironmentList>(org(orgId));

export const getEnvironment = (orgId: string, id: string) =>
  apiFetch<{ environment: Environment }>(`${org(orgId)}/${enc(id)}`);

export const createEnvironment = (orgId: string, name: string) =>
  apiFetch<{ environment: Environment }>(org(orgId), {
    method: "POST",
    body: JSON.stringify({ name: name.trim() }),
  });

export const renameEnvironment = (orgId: string, id: string, name: string) =>
  apiFetch<{ environment: Environment }>(`${org(orgId)}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: name.trim() }),
  });

export const deleteEnvironment = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}`, { method: "DELETE" });

export const resetEnvironmentFiles = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/${enc(id)}/files/reset`, { method: "POST" });
