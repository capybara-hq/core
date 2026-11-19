import {
  type DeviceExecGrants,
  type SandboxBrowseScope,
  type SandboxOperationScope,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
/**
 * Whether an operation scope needs the Full access ceiling and the runtime's Full support: a Full
 * access operation (its reach is full, or narrowed for a kernel read on a Full-only runtime), or a
 * per-call sandbox escalation under a restricted profile, whose reach is full (`filesystem:
 * device`, `network: environment`) while it keeps its conversation's restricted profile.
 */
export const isFullExecutionScope = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  "profile" in scope &&
  (scope.profile === "full-access" ||
    (scope.filesystem.kind === "device" && scope.network.kind === "environment"));

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
