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
 * Writes a forked skill's files (SKILL.md plus `files`) to object storage under a new prefix and
 * returns its manifest (manual-only, `context: fork`, optional `agent`).
 */
export async function writeForkedSkillFiles(
  d: { storage: StorageService; orgId: string },
  name: string,
  body: string,
  agent?: string,
  files: Record<string, string> = {},
): Promise<{ prefix: string; manifest: SkillManifest }> {
  const prefix = `skills/${randomUUID()}/`;
  const entries: SkillManifest["files"] = [];
  for (const [path, text] of Object.entries({
    "SKILL.md": `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`,
    ...files,
  })) {
    const data = new TextEncoder().encode(text);
    await d.storage.kernel(d.orgId).put(`${prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    entries.push({ path, size: data.byteLength, sha256: sha(data) });
  }
  const manifest: SkillManifest = {
    name,
    description: `Use for ${name} work.`,
    files: entries,
    invocation: { model: false, user: true, fork: agent === undefined ? {} : { agent } },
  };
  return { prefix, manifest };
}

/**
 * A manual-only forked skill (`context: fork`, optional `agent`) of the plugin `acme`, version 1:
 * its SKILL.md (and `files`) in object storage and its rows written directly.
 */
export async function seedForkedSkill(
  d: { db: KernelDb; storage: StorageService; orgId: string; ownerId: string },
  name: string,
  body: string,
  agent?: string,
  files: Record<string, string> = {},
): Promise<{ id: string; prefix: string }> {
  const { prefix, manifest } = await writeForkedSkillFiles(d, name, body, agent, files);
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
