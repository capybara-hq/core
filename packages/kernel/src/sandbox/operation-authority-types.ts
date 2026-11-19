import {
  type DeviceExecGrants,
  type SandboxBrowseScope,
  type SandboxOperationScope,
  SandboxScopeDeniedError,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
/**
 * A call that asked to run outside the sandbox (`sandbox: "escalated"`) whose escalation grant no
 * longer matches at admission: the device, its Full access ceiling or the permission scope
 * changed after the approval. A typed pre-effect scope refusal (nothing ran), never a silent
 * downgrade to the restricted scope; the tool tells the model to ask again.
 */
export class EscalationGrantMissingError extends SandboxScopeDeniedError {
  readonly escalationGrantMissing = true as const;
}
export const isEscalationGrantMissing = (e: unknown): boolean =>
  e instanceof Error && (e as { escalationGrantMissing?: unknown }).escalationGrantMissing === true;
/**
 * Whether an operation scope runs outside the sandbox and so needs the outside-sandbox ceiling and
 * the runtime's support for it: only an escalated call (`filesystem: device`, `network:
 * environment`), under any profile. A Full access call is sandboxed like any other.
 */
export const isFullExecutionScope = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  "profile" in scope && scope.filesystem.kind === "device" && scope.network.kind === "environment";

/** Whether an operation scope uses the open public network (what an allowlist narrowing takes). */
export const usesOpenNetwork = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  "profile" in scope && scope.network.kind === "open-public";

export const isExecutionMethod = (method: string): method is "exec" | "backgroundStart" =>
  method === "exec" || method === "backgroundStart";

/** Null column means absent historical/native provenance; grants:null records an explicit absence. */
export interface StartingExecutionGrants {
  version: 1;
  grants: DeviceExecGrants | null;
}
export function parseStartingExecutionGrants(value: unknown): StartingExecutionGrants {
  const record = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => !keys.includes(k))
    )
      throw new Error(
        "Missing or invalid starting execution provenance; check the original admission before retrying",
      );
    return v as Record<string, unknown>;
  };
  const o = record(value, ["version", "grants"]);
  if (o.version !== 1)
    throw new Error("Unknown starting execution provenance; check the original admission");
  if (o.grants === null) return { version: 1, grants: null };
  const g = record(o.grants, ["hosts", "source"]),
    source = record(g.source, ["kind", "id", "accountId"]);
  if (
    !Array.isArray(g.hosts) ||
    g.hosts.length > 100 ||
    g.hosts.some(
      (h) => typeof h !== "string" || h.startsWith("*.") || validateAllowHost(h).length,
    ) ||
    new Set(g.hosts).size !== g.hosts.length ||
    !["run", "task"].includes(String(source.kind)) ||
    [source.id, source.accountId].some((v) => typeof v !== "string" || !v.length || v.length > 128)
  )
    throw new Error("Invalid starting grant source or hosts; check the original admission");
  return {
    version: 1,
    grants: {
      hosts: [...g.hosts] as string[],
      source: source as unknown as DeviceExecGrants["source"],
    },
  };
}
