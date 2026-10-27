import { createHash, randomUUID } from "node:crypto";
import type { KernelDb, SkillManifest } from "../../src/db/kernel-schema.js";
import type { StorageService } from "../../src/storage/storage.service.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The id of catalog item `name` (created when missing). */
export async function catalogItemNamed(db: KernelDb, name: string): Promise<string> {
  const got = await db
    .selectFrom("catalog_items")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();
  if (got) return got.id;
  const id = randomUUID();
  await db
    .insertInto("catalog_items")
    .values({
      id,
      name,
      package_name: `@acme/plugin-${name}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

/**
 * A manual-only forked skill (`context: fork`, optional `agent`) of the plugin `acme`, version 1:
 * its SKILL.md in object storage and its rows written directly.
 */
export async function seedForkedSkill(
  d: { db: KernelDb; storage: StorageService; orgId: string; ownerId: string },
  name: string,
  body: string,
  agent?: string,
): Promise<{ id: string; prefix: string }> {
  const prefix = `skills/${randomUUID()}/`;
  const text = `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;
  const data = new TextEncoder().encode(text);
  await d.storage.kernel(d.orgId).put(`${prefix}SKILL.md`, data, {
    contentType: "application/octet-stream",
    size: data.byteLength,
  });
  const manifest: SkillManifest = {
    name,
    description: `Use for ${name} work.`,
    files: [{ path: "SKILL.md", size: data.byteLength, sha256: sha(data) }],
    invocation: { model: false, user: true, fork: agent === undefined ? {} : { agent } },
  };
  const id = randomUUID();
  const itemId = await catalogItemNamed(d.db, "acme");
  await d.db
    .insertInto("skills")
    .values({
      id,
      org_id: d.orgId,
      scope: "org",
      agent_id: null,
      name,
      description: manifest.description,
      current_version: 1,
      created_by: d.ownerId,
      catalog_item_id: itemId,
      catalog_version: "1.0.0",
    })
    .execute();
  await d.db
    .insertInto("skill_versions")
    .values({
      skill_id: id,
      version: 1,
      manifest: JSON.stringify(manifest),
      object_prefix: prefix,
      created_by: d.ownerId,
    })
    .execute();
  return { id, prefix };
}
