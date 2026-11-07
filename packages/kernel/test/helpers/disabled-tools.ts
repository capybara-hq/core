import type { DisabledToolRef } from "../../src/agents/definition.js";
import { AGENT_BUILTIN_NAMES } from "../../src/tools/builtin-names.js";

/**
 * `disabledTools` turning off every builtin an agent can turn off except `keep` (tools default-on
 * spec): tests that want an agent with only some builtins (extension and connector tools of the
 * org stay on).
 */
export function builtinsOff(...keep: string[]): DisabledToolRef[] {
  return AGENT_BUILTIN_NAMES.filter((n) => !keep.includes(n)).map((name) => ({
    kind: "builtin",
    name,
  }));
}

/**
 * `disabledTools` for an agent that should have only the builtins `refs` names: tests written
 * against the old enabled list (`tools`) keep their builtins this way; extension and connector refs
 * need nothing (on by default).
 */
export function onlyBuiltins(refs: readonly Record<string, unknown>[]): DisabledToolRef[] {
  return builtinsOff(
    ...refs.flatMap((r) => (r.kind === "builtin" && typeof r.name === "string" ? [r.name] : [])),
  );
}

/**
 * A `KernelDb` stand-in for a registry built without a database: every query returns no rows (no
 * connectors, no settings), which is all builtin-only resolution reads.
 */
export function noRowsDb(): never {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["select", "selectAll", "where", "orderBy", "innerJoin", "leftJoin", "limit"]) {
    chain[m] = self;
  }
  chain.execute = async () => [];
  chain.executeTakeFirst = async () => undefined;
  return { selectFrom: self, db: { selectFrom: self } } as never;
}
