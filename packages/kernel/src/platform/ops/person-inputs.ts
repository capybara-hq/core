import { setDeep } from "../../extensions/deployment-config-store.js";
import type { OperationContext } from "../operation.js";
import { viaAgent } from "./errors.js";
import { named } from "./summary.js";

/**
 * Runs a write that may carry the person's card values (platform web parity spec §4.3): inside
 * `ctx.personInputs.apply` when the approved call asked for person fields, so the sealed values
 * are consumed in the write's own transaction, else directly with none. `write` gets the values
 * by dot path and the audit detail: `viaAgent(operation)` plus `inputsProvided` (the entered
 * paths, never the values) when the person entered any (spec §10).
 */
export function withPersonInputs<T>(
  operation: string,
  ctx: OperationContext,
  write: (
    entered: Readonly<Record<string, string>>,
    auditDetail: Record<string, unknown>,
  ) => Promise<T>,
): Promise<T> {
  const base = viaAgent(operation, ctx);
  if (ctx.personInputs === undefined) return write({}, base);
  return ctx.personInputs.apply((values) =>
    write(values, { ...base, inputsProvided: Object.keys(values).sort() }),
  );
}

/**
 * The `values` of a config route keyed by field dot path (deployment config, the org's copy): the
 * model's non-secret values, the person's entered secrets, and `null` (clear) for each path in
 * `clear`. A secret left out keeps its stored value, as on the web form.
 */
export function flatValues(
  values: Readonly<Record<string, unknown>>,
  entered: Readonly<Record<string, string>>,
  clear: readonly string[],
): Record<string, unknown> {
  return {
    ...values,
    ...entered,
    ...Object.fromEntries(clear.map((p) => [p, null])),
  };
}

/**
 * The whole org config (`config` of `PUT /orgs/:orgId/extensions/:extension`, a nested object): the
 * model's non-secret config with the person's entered secrets set at their dot paths and `null`
 * (clear) at each path in `clear`. A secret left out keeps its stored value.
 */
export function nestedConfig(
  values: Readonly<Record<string, unknown>>,
  entered: Readonly<Record<string, string>>,
  clear: readonly string[],
): Record<string, unknown> {
  const config = structuredClone(values) as Record<string, unknown>;
  for (const [path, v] of Object.entries(entered)) setDeep(config, path, v);
  for (const path of clear) setDeep(config, path, null);
  return config;
}

/** Leaf `path=value` pairs of a values object (dot paths), each clipped for a card. */
function pairsOf(values: Readonly<Record<string, unknown>>, prefix = ""): string[] {
  return Object.entries(values).flatMap(([k, v]) => {
    const path = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return pairsOf(v as Record<string, unknown>, path);
    }
    return [named(`${path}=${JSON.stringify(v)}`)];
  });
}

/**
 * The card text of a config write: the non-secret values it sets, the secrets the person enters
 * and the secrets it clears (paths only), e.g. `baseUrl="https://…"; the person enters apiKey`.
 */
export function configChanges(
  values: Readonly<Record<string, unknown>>,
  ask: readonly string[],
  clear: readonly string[],
): { zh: string; en: string } {
  const set = pairsOf(values);
  const zh: string[] = [];
  const en: string[] = [];
  if (set.length > 0) {
    zh.push(`设置 ${set.join("，")}`);
    en.push(`sets ${set.join(", ")}`);
  }
  if (ask.length > 0) {
    zh.push(`由本人填写 ${ask.map(named).join("、")}`);
    en.push(`the person enters ${ask.map(named).join(", ")}`);
  }
  if (clear.length > 0) {
    zh.push(`清除 ${clear.map(named).join("、")}`);
    en.push(`clears ${clear.map(named).join(", ")}`);
  }
  if (zh.length === 0) return { zh: "不改动任何字段", en: "changes no field" };
  return { zh: zh.join("；"), en: en.join("; ") };
}
