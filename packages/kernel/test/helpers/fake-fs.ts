import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";

/**
 * Reads a file of a conversation's device from the `sandbox-fake` provider's root: `path` is
 * relative to the file system (`workspace/…`, `skills/…`). Null when the file does not exist.
 */
export async function fakeEnvFile(
  db: KernelSchemaDb,
  root: string,
  conversationId: string,
  path: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("device_instances")
    .innerJoin("conversations", "conversations.device_id", "device_instances.device_id")
    .select("device_instances.handle")
    .where("conversations.id", "=", conversationId)
    .executeTakeFirstOrThrow();
  const id = (row.handle as { id: string }).id;
  const meta = JSON.parse(await readFile(join(root, "instances", id, "meta.json"), "utf8")) as {
    fileSystem: string;
  };
  return readFile(join(root, "filesystems", meta.fileSystem, path), "utf8").catch(() => null);
}
