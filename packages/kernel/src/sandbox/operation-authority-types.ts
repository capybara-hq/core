import { type DeviceExecGrants, validateAllowHost } from "@capybara-hq/plugin-sdk";

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
