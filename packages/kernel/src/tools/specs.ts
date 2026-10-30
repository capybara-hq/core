import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * 把工具定义按指纹存进 `capybara.tool_specs`（内容寻址：同一指纹只存一次，已存在不改）。
 * `model_call` 只记 `{key, specHash}`，定义本身存这里——连接器刷新 / 插件升级改了定义之后，早先请求用过的定义
 * 仍可按指纹取回，模型请求可由日志还原。
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
    .map(([hash, spec]) => ({ spec_hash: hash, spec: JSON.stringify(spec) }));
  await db
    .insertInto("tool_specs")
    .values(rows)
    .onConflict((oc) => oc.column("spec_hash").doNothing())
    .execute();
}

/** 按指纹取回工具定义；没有记录 → null。 */
export async function loadToolSpec(db: KernelSchemaDb, specHash: string): Promise<ToolSpec | null> {
  const row = await db
    .selectFrom("tool_specs")
    .select("spec")
    .where("spec_hash", "=", specHash)
    .executeTakeFirst();
  return row ? (row.spec as ToolSpec) : null;
}
