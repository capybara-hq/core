import type { z } from "zod";

/**
 * The wrappers a config field's marks are read through: the same set the kernel's `configFields`
 * strips and `configJsonSchema` inherits meta across.
 */
export const META_WRAPPERS: ReadonlySet<string> = new Set([
  "default",
  "prefault",
  "optional",
  "nullable",
  "readonly",
  "catch",
]);

type Meta = Record<string, unknown>;

/** The schema and every node under it reached through {@link META_WRAPPERS}, outermost first. */
export function wrapperChain(schema: z.ZodTypeAny): z.ZodTypeAny[] {
  const out: z.ZodTypeAny[] = [];
  let node: z.ZodTypeAny | undefined = schema;
  while (node) {
    out.push(node);
    const def = node._zod.def as { type: string; innerType?: z.ZodTypeAny };
    node = META_WRAPPERS.has(def.type) ? def.innerType : undefined;
  }
  return out;
}

/**
 * The meta of a config field merged across its wrapper chain: an outer key wins over an inner one,
 * except `secret` and `platformOnly`, which are true when any node of the chain carries them
 * (fail-safe: a wrapper's meta never hides a secret or clears a platform-only mark). Zod's `id` is
 * left out: it names one schema instance.
 */
export function chainMeta(schema: z.ZodTypeAny): Meta {
  const out: Meta = {};
  let secret = false;
  let platformOnly = false;
  for (const node of wrapperChain(schema).reverse()) {
    const m = node.meta() as Meta | undefined;
    if (!m) continue;
    if (m.secret === true) secret = true;
    if (m.platformOnly === true) platformOnly = true;
    Object.assign(out, m);
  }
  delete out.id;
  if (secret) out.secret = true;
  if (platformOnly) out.platformOnly = true;
  return out;
}

/** Sets `key: value` on the schema's meta, keeping every mark found through its wrappers. */
export function withMeta<T extends z.ZodTypeAny>(schema: T, key: string, value: unknown): T {
  return schema.meta({ ...(schema.meta() ?? {}), ...chainMeta(schema), [key]: value }) as T;
}
