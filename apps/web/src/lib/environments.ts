import { apiFetch } from "./api";

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
  /** null for the person's default environment (shown as 个人环境 / "Personal"). */
  name: string | null;
  isDefault: boolean;
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
