import { ToolError } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../../errors.js";
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
 * Ruling R11 (platform web parity plan): the one exception to "the write runs inside
 * `personInputs.apply`". The catalog install runs `requires_new` steps that take the org row lock;
 * inside `apply`, `connectors.create` would take that lock in the consuming transaction and the
 * next step would wait on it for good. Such a write takes the values first and runs outside.
 *
 * The person's card values for a write that cannot run inside the consuming transaction: one made
 * of several transactions of its own (`requires_new` steps under the org row lock, such as the
 * catalog install), which would wait on a lock the consuming transaction holds. The values are
 * consumed in a short transaction of their own and returned with the audit detail
 * ({@link withPersonInputs}'s); the write then runs outside it. A write that fails after this
 * leaves nothing to retry with: the call is made again, with a new card, like any failed call.
 */
export async function takePersonInputs(
  operation: string,
  ctx: OperationContext,
): Promise<{ entered: Readonly<Record<string, string>>; auditDetail: Record<string, unknown> }> {
  return withPersonInputs(operation, ctx, async (entered, auditDetail) => ({
    entered: { ...entered },
    auditDetail,
  }));
}

/** What the model is told after a failed write consumed the person's values. */
export const VALUES_USED_UP_TEXT =
  "The values the person entered were used up: calling the operation again shows a new card where the person enters them again.";

/**
 * The error of a write that failed after {@link takePersonInputs} consumed the values: the same
 * error (an `ApiError` keeps its code and details, a `ToolError` its kind), its message saying the
 * values are gone and the person enters them again on a new card. Any other error becomes a
 * `ToolError` naming only its class (as the pipeline would), with the original as `cause`.
 */
export function afterTaken(e: unknown, entered: Readonly<Record<string, string>>): unknown {
  if (Object.keys(entered).length === 0) return e;
  const told = (message: string) => `${message.trim().replace(/\.?$/, ".")} ${VALUES_USED_UP_TEXT}`;
  if (e instanceof ApiError) return new ApiError(e.code, told(e.message), e.details);
  if (e instanceof ToolError) return new ToolError(told(e.message), { kind: e.kind });
  const name = e instanceof Error ? e.name : "Error";
  const out = new ToolError(told(`The write failed (${name})`));
  Object.defineProperty(out, "cause", { value: e });
  return out;
}

/**
 * The values under `prefix` (`connectors.<templateId>.`), keyed by the rest of their path.
 */
export function enteredUnder(
  entered: Readonly<Record<string, string>>,
  prefix: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entered)
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, v]) => [p.slice(prefix.length), v]),
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
 * The entered secrets are the plan's (`ctx.personAsk`: required secrets the call did not name
 * included), else the call's `askPerson`.
 */
export function configChanges(
  i: {
    values: Readonly<Record<string, unknown>>;
    askPerson: readonly string[];
    clearSecrets: readonly string[];
  },
  ctx: Pick<OperationContext, "personAsk">,
): { zh: string; en: string } {
  const { values, clearSecrets: clear } = i;
  const ask = ctx.personAsk ?? i.askPerson;
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
