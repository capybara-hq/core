import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * Stores tool definitions by fingerprint in `capybara.tool_specs` (content-addressed: one row per
 * fingerprint, never changed, except that a row written before `spec_text` existed gets it on the
 * next write). `model_call` records only `{key, specHash}`; the definition lives here, so after a
 * connector refresh or a plugin upgrade the definitions an earlier request used can still be read
 * back and the request rebuilt from the log. `spec_text` keeps the JSON text as sent: `spec` is
 * jsonb, which reorders keys, and a rebuilt request must serialize byte for byte like the original
 * (a provider renders its tools from that JSON; a reordered schema misses the prompt cache).
 */
export async function recordToolSpecs(
  /** The pool or a transaction (a transaction is a Kysely handle too). */
  db: KernelSchemaDb,
  specs: readonly { specHash: string; spec: ToolSpec }[],
): Promise<void> {
  const unique = new Map<string, ToolSpec>();
  for (const s of specs) if (!unique.has(s.specHash)) unique.set(s.specHash, s.spec);
  if (unique.size === 0) return;
  // 按指纹排序插入：并发事务插入同一批指纹时加锁顺序一致，不会互相死锁
  const rows = [...unique]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hash, spec]) => {
      const text = JSON.stringify(spec);
      return { spec_hash: hash, spec: text, spec_text: text };
    });
  await db
    .insertInto("tool_specs")
    .values(rows)
    .onConflict((oc) =>
      oc
        .column("spec_hash")
        .doUpdateSet((eb) => ({ spec_text: eb.ref("excluded.spec_text") }))
        .where("tool_specs.spec_text", "is", null),
    )
    .execute();
}

/** A stored definition: its JSON text as sent when recorded, else the jsonb value. */
export function storedToolSpec(row: { spec: unknown; spec_text: string | null }): ToolSpec {
  return (row.spec_text !== null ? JSON.parse(row.spec_text) : row.spec) as ToolSpec;
}

/** The tool definition stored under a fingerprint ({@link storedToolSpec}); null when none. */
export async function loadToolSpec(db: KernelSchemaDb, specHash: string): Promise<ToolSpec | null> {
  const row = await db
    .selectFrom("tool_specs")
    .select(["spec", "spec_text"])
    .where("spec_hash", "=", specHash)
    .executeTakeFirst();
  return row ? storedToolSpec(row) : null;
}
