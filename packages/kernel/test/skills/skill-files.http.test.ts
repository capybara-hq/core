import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { StorageService } from "../../src/storage/storage.service.js";
import type { PreviewProbeState } from "../fixtures/plugins/preview-fake/index.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Skill file browser spec, "Kernel": `GET /skills/:id/files` lists a version's files and
 * `GET /skills/:id/files/content` serves one file's bytes, with the visibility of `GET /skills/:id`
 * (the org's own skill, or a platform skill on in the org), only manifest paths, the sha256
 * checked, and headers that never let a skill file run on the app origin. And `file-preview@1` for
 * skill files: the previewers that take one (the fake provider `preview-fake` previews `.docx` as a
 * view and as an embed page), a view render through a read grant for that one object, and embed
 * tokens naming the file.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const PREVIEW_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/preview-fake/index.ts", import.meta.url),
);

const probe = (): PreviewProbeState => {
  const g = globalThis as { __previewProbe?: PreviewProbeState };
  g.__previewProbe ??= { aborted: 0 };
  return g.__previewProbe;
};

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [OBJECT_STORE, MODEL_FAKE, PREVIEW_FAKE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
});
afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let owner: Req;
let member: Req;
let guest: Req;
let ownerId: string;
let memberId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.file_previewers, capybara.extension_org_configs, capybara.catalog_item_org_switches, capybara.component_org_switches, capybara.component_scope_orgs, capybara.platform_skill_versions, capybara.platform_skills, capybara.plugin_installs, capybara.skill_versions, capybara.skills, capybara.catalog_items, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  const guestId = (await accounts.createLocal({ login: "gst", password: PW, displayName: "G" })).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  await testMembers(db).add(orgId, guestId, "guest", ownerId);
  member = await session(k, "mem");
  guest = await session(k, "gst");
  delete probe().last;
  delete probe().read;
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytesOf = (v: string | Uint8Array) => (typeof v === "string" ? Buffer.from(v) : v);
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n---\n${body}`;
/** The 8-byte PNG signature plus a little; enough for a type by extension. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Store = ReturnType<StorageService["kernel"]>;

/** Writes `files` under `prefix` of `store`; returns their manifest entries. */
async function putFiles(store: Store, prefix: string, files: Record<string, string | Uint8Array>) {
  const out: { path: string; size: number; sha256: string }[] = [];
  for (const [path, v] of Object.entries(files)) {
    const data = bytesOf(v);
    await store.put(`${prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    out.push({ path, size: data.byteLength, sha256: sha(data) });
  }
  return out;
}

/** An org skill of `org` with one version per entry of `versions` (version 1 first). */
async function seedOrgSkill(
  name: string,
  versions: Record<string, string | Uint8Array>[],
  org = orgId,
): Promise<{ id: string; prefixes: string[] }> {
  const id = randomUUID();
  await db
    .insertInto("skills")
    .values({
      id,
      org_id: org,
      scope: "org",
      agent_id: null,
      name,
      description: `Use for ${name} work.`,
      current_version: versions.length,
      created_by: ownerId,
    })
    .execute();
  const prefixes: string[] = [];
  for (const [i, files] of versions.entries()) {
    const prefix = `skills/${randomUUID()}/`;
    prefixes.push(prefix);
    const manifest = {
      name,
      description: `Use for ${name} work.`,
      files: await putFiles(k.app.get(StorageService).kernel(org), prefix, files),
    };
    await db
      .insertInto("skill_versions")
      .values({
        skill_id: id,
        version: i + 1,
        manifest: JSON.stringify(manifest),
        object_prefix: prefix,
        created_by: ownerId,
      })
      .execute();
  }
  return { id, prefixes };
}

async function catalogItem(name: string): Promise<string> {
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

/** A live install of plugin `name` in the org (its platform skills are on there). */
async function installPlugin(name: string): Promise<void> {
  const itemId = await catalogItem(name);
  await db
    .insertInto("catalog_item_org_switches")
    .values({ item_id: itemId, org_id: orgId, enabled: true })
    .execute();
  await db
    .insertInto("plugin_installs")
    .values({
      id: randomUUID(),
      org_id: orgId,
      item_id: itemId,
      version: "1.0.0",
      status: "installed",
    })
    .execute();
}

/** An org admin switches platform skill `skillId` off in the org. */
async function switchOff(skillId: string): Promise<void> {
  await db
    .insertInto("component_org_switches")
    .values({
      kind: "skill",
      component_id: skillId,
      org_id: orgId,
      enabled: false,
      updated_by: ownerId,
    })
    .execute();
}

/** A platform skill of plugin `plugin` with one version per entry of `versions`. */
async function seedPlatformSkill(
  name: string,
  plugin: string,
  versions: Record<string, string | Uint8Array>[],
): Promise<{ id: string }> {
  const id = randomUUID();
  await db
    .insertInto("platform_skills")
    .values({
      id,
      catalog_item_id: await catalogItem(plugin),
      plugin_name: plugin,
      name,
      description: `Use for ${name} work.`,
      current_version: versions.length,
      scope_mode: "follow",
      scope: "optional",
      disabled: false,
    })
    .execute();
  for (const [i, files] of versions.entries()) {
    const prefix = `platform/skills/${id}/${i + 1}/`;
    const manifest = {
      name,
      description: `Use for ${name} work.`,
      files: await putFiles(k.app.get(StorageService).deployment(), prefix, files),
    };
    await db
      .insertInto("platform_skill_versions")
      .values({
        skill_id: id,
        version: i + 1,
        manifest: JSON.stringify(manifest),
        object_prefix: prefix,
        catalog_version: "1.0.0",
      })
      .execute();
  }
  return { id };
}

const filesUrl = (id: string, q = "") => `/api/v1/orgs/${orgId}/skills/${id}/files${q}`;
const contentUrl = (id: string, path: string, q = "") =>
  `/api/v1/orgs/${orgId}/skills/${id}/files/content?path=${encodeURIComponent(path)}${q}`;

describe("skill file list", () => {
  it("lists the current version of an org skill by default and an older one with version=", async () => {
    const md2 = skillMd("tools", "v2");
    const s = await seedOrgSkill("tools", [
      { "SKILL.md": skillMd("tools", "v1"), "notes.txt": "old" },
      { "SKILL.md": md2, "scripts/run.sh": "echo hi\n", "img/logo.png": PNG, "a.bin": "x" },
    ]);
    const cur = await member({ method: "GET", url: filesUrl(s.id) });
    expect(cur.statusCode, cur.body).toBe(200);
    expect(cur.headers["cache-control"]).toBe("private, no-store");
    expect(cur.json()).toEqual({
      version: 2,
      files: [
        {
          path: "SKILL.md",
          size: Buffer.byteLength(md2),
          contentType: "text/markdown",
          previewable: "text",
        },
        {
          path: "scripts/run.sh",
          size: 8,
          contentType: "text/x-shellscript",
          previewable: "text",
        },
        {
          path: "img/logo.png",
          size: PNG.byteLength,
          contentType: "image/png",
          previewable: "image",
        },
        { path: "a.bin", size: 1, contentType: "application/octet-stream", previewable: null },
      ],
    });
    const old = await member({ method: "GET", url: filesUrl(s.id, "?version=1") });
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json()).toMatchObject({
      version: 1,
      files: [{ path: "SKILL.md" }, { path: "notes.txt", size: 3, previewable: "text" }],
    });
  });

  it("lists a platform skill on in the org; off in the org it is skill.not_found", async () => {
    const p = await seedPlatformSkill("kit-skill", "kit", [
      { "SKILL.md": skillMd("kit-skill", "one") },
      { "SKILL.md": skillMd("kit-skill", "two"), "ref.md": "# ref" },
    ]);
    const off = await member({ method: "GET", url: filesUrl(p.id) });
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("skill.not_found");
    const offContent = await member({ method: "GET", url: contentUrl(p.id, "SKILL.md") });
    expect(offContent.statusCode).toBe(404);
    expect(offContent.json().error.code).toBe("skill.not_found");

    await installPlugin("kit");
    const on = await member({ method: "GET", url: filesUrl(p.id) });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({
      version: 2,
      files: [{ path: "SKILL.md" }, { path: "ref.md", contentType: "text/markdown" }],
    });
    const v1 = await member({ method: "GET", url: filesUrl(p.id, "?version=1") });
    expect(v1.json()).toMatchObject({ version: 1, files: [{ path: "SKILL.md" }] });
    const body = await member({ method: "GET", url: contentUrl(p.id, "ref.md") });
    expect(body.statusCode, body.body).toBe(200);
    expect(body.body).toBe("# ref");
  });

  it("a platform skill switched off in the org after it was read: list and content 404", async () => {
    const p = await seedPlatformSkill("kit-skill", "kit", [
      { "SKILL.md": skillMd("kit-skill", "one"), "ref.md": "# ref" },
    ]);
    await installPlugin("kit");
    expect((await member({ method: "GET", url: filesUrl(p.id) })).statusCode).toBe(200);
    expect((await member({ method: "GET", url: contentUrl(p.id, "ref.md") })).statusCode).toBe(200);

    await switchOff(p.id);
    for (const url of [filesUrl(p.id), contentUrl(p.id, "ref.md")]) {
      const r = await member({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code, url).toBe("skill.not_found");
    }
  });

  it("an unknown version is skill.file_not_found; another org's skill is skill.not_found", async () => {
    const s = await seedOrgSkill("tools", [{ "SKILL.md": skillMd("tools", "x") }]);
    const v9 = await member({ method: "GET", url: filesUrl(s.id, "?version=9") });
    expect(v9.statusCode).toBe(404);
    expect(v9.json().error.code).toBe("skill.file_not_found");
    const c9 = await member({ method: "GET", url: contentUrl(s.id, "SKILL.md", "&version=9") });
    expect(c9.statusCode).toBe(404);
    expect(c9.json().error.code).toBe("skill.file_not_found");

    const otherOrg = await createOrgWithProviders(k, owner, "Other");
    const theirs = await seedOrgSkill("theirs", [{ "SKILL.md": skillMd("theirs", "x") }], otherOrg);
    for (const url of [filesUrl(theirs.id), contentUrl(theirs.id, "SKILL.md")]) {
      const r = await owner({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code).toBe("skill.not_found");
    }
  });

  it("a member reads; a guest gets the refusal the detail route gives", async () => {
    const s = await seedOrgSkill("tools", [{ "SKILL.md": skillMd("tools", "x") }]);
    const detail = await guest({ method: "GET", url: `/api/v1/orgs/${orgId}/skills/${s.id}` });
    expect(detail.statusCode).toBe(403);
    for (const url of [filesUrl(s.id), contentUrl(s.id, "SKILL.md")]) {
      const r = await guest({ method: "GET", url });
      expect(r.statusCode, url).toBe(detail.statusCode);
      expect(r.json().error.code).toBe(detail.json().error.code);
    }
    expect((await member({ method: "GET", url: contentUrl(s.id, "SKILL.md") })).statusCode).toBe(
      200,
    );
  });
});

describe("skill file content", () => {
  it("returns the bytes as an attachment, never sniffed", async () => {
    const s = await seedOrgSkill("tools", [
      { "SKILL.md": skillMd("tools", "x"), "scripts/run.sh": "echo hi\n" },
    ]);
    const r = await member({ method: "GET", url: contentUrl(s.id, "scripts/run.sh") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toBe("echo hi\n");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="run\.sh"/);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["x-content-original-type"]).toBe("text/x-shellscript");
    expect(r.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["x-content-truncated"]).toBeUndefined();
  });

  it("inline=1 is inline for a png, still an attachment for html and svg", async () => {
    const s = await seedOrgSkill("tools", [
      {
        "SKILL.md": skillMd("tools", "x"),
        "logo.png": PNG,
        "page.html": "<script>alert(1)</script>",
        "pic.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      },
    ]);
    const png = await member({ method: "GET", url: contentUrl(s.id, "logo.png", "&inline=1") });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-disposition"]).toBe("inline");
    expect(png.headers["content-type"]).toBe("image/png");
    expect(new Uint8Array(png.rawPayload)).toEqual(PNG);
    const pngDl = await member({ method: "GET", url: contentUrl(s.id, "logo.png") });
    expect(pngDl.headers["content-disposition"]).toMatch(/^attachment/);
    for (const path of ["page.html", "pic.svg"]) {
      const r = await member({ method: "GET", url: contentUrl(s.id, path, "&inline=1") });
      expect(r.statusCode, path).toBe(200);
      expect(r.headers["content-disposition"], path).toMatch(/^attachment/);
      expect(r.headers["content-type"], path).not.toMatch(/html|svg/);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("limit=4 returns 4 bytes with x-content-truncated", async () => {
    const s = await seedOrgSkill("tools", [
      { "SKILL.md": skillMd("tools", "x"), "notes.txt": "0123456789" },
    ]);
    const r = await member({ method: "GET", url: contentUrl(s.id, "notes.txt", "&limit=4") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toBe("0123");
    expect(r.headers["x-content-truncated"]).toBe("true");
    const whole = await member({ method: "GET", url: contentUrl(s.id, "notes.txt", "&limit=10") });
    expect(whole.body).toBe("0123456789");
    expect(whole.headers["x-content-truncated"]).toBeUndefined();
  });

  it("only a path of that version's manifest: others are skill.file_not_found", async () => {
    const s = await seedOrgSkill("tools", [
      { "SKILL.md": skillMd("tools", "v1"), "old.txt": "old" },
      { "SKILL.md": skillMd("tools", "v2") },
    ]);
    for (const path of ["missing.txt", "../x", "/SKILL.md", "./SKILL.md", "old.txt"]) {
      const r = await member({ method: "GET", url: contentUrl(s.id, path) });
      expect(r.statusCode, path).toBe(404);
      expect(r.json().error.code, path).toBe("skill.file_not_found");
    }
    // old.txt is a path of version 1 only
    const v1 = await member({ method: "GET", url: contentUrl(s.id, "old.txt", "&version=1") });
    expect(v1.statusCode, v1.body).toBe(200);
    expect(v1.body).toBe("old");
  });

  it("an object that no longer matches its manifest is 409 skill.file_changed", async () => {
    const s = await seedOrgSkill("tools", [
      { "SKILL.md": skillMd("tools", "x"), "notes.txt": "original" },
    ]);
    const store = k.app.get(StorageService).kernel(orgId);
    const swapped = Buffer.from("replaced");
    await store.put(`${s.prefixes[0]}notes.txt`, swapped, {
      contentType: "application/octet-stream",
      size: swapped.byteLength,
    });
    const r = await member({ method: "GET", url: contentUrl(s.id, "notes.txt") });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("skill.file_changed");
    const cut = await member({ method: "GET", url: contentUrl(s.id, "notes.txt", "&limit=2") });
    expect(cut.statusCode).toBe(409);

    await store.delete(`${s.prefixes[0]}notes.txt`);
    const gone = await member({ method: "GET", url: contentUrl(s.id, "notes.txt") });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error.code).toBe("skill.file_changed");
  });
});

describe("skill file download URL (as=url)", () => {
  it("answers a presigned attachment URL for that object, never html or svg, after the sha check", async () => {
    const s = await seedOrgSkill("tools", [
      {
        "SKILL.md": skillMd("tools", "x"),
        "scripts/run.sh": "echo hi\n",
        "logo.png": PNG,
        "web/page.html": "<script>alert(1)</script>",
        "pic.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      },
    ]);
    const cases: [string, string, string][] = [
      ["scripts/run.sh", "run.sh", "text/plain"],
      ["logo.png", "logo.png", "application/octet-stream"],
      ["web/page.html", "page.html", "text/plain"],
      ["pic.svg", "pic.svg", "application/octet-stream"],
    ];
    for (const [path, name, type] of cases) {
      // inline=1 is ignored: a download is always an attachment
      const r = await member({ method: "GET", url: contentUrl(s.id, path, "&as=url&inline=1") });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      const { url } = r.json() as { url: string };
      expect(url).not.toContain("/api/");
      const got = await fetch(url);
      expect(got.status, path).toBe(200);
      expect(got.headers.get("content-disposition"), path).toMatch(/^attachment;/);
      expect(got.headers.get("content-disposition"), path).toContain(name);
      expect(got.headers.get("content-type"), path).toContain(type);
      expect(got.headers.get("content-type"), path).not.toMatch(/html|svg/);
    }
    // with limit: 400
    const both = await member({
      method: "GET",
      url: contentUrl(s.id, "logo.png", "&as=url&limit=4"),
    });
    expect(both.statusCode).toBe(400);

    // an object that no longer matches its manifest: 409, no URL
    const store = k.app.get(StorageService).kernel(orgId);
    const swapped = Buffer.from("echo bye\n");
    await store.put(`${s.prefixes[0]}scripts/run.sh`, swapped, {
      contentType: "application/octet-stream",
      size: swapped.byteLength,
    });
    const changed = await member({
      method: "GET",
      url: contentUrl(s.id, "scripts/run.sh", "&as=url"),
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("skill.file_changed");
  });

  it("the visibility of the other file routes: unknown path, another org, a guest, switched off", async () => {
    const s = await seedOrgSkill("tools", [{ "SKILL.md": skillMd("tools", "x") }]);
    const missing = await member({ method: "GET", url: contentUrl(s.id, "nope.txt", "&as=url") });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("skill.file_not_found");
    const g = await guest({ method: "GET", url: contentUrl(s.id, "SKILL.md", "&as=url") });
    const gDetail = await guest({ method: "GET", url: `/api/v1/orgs/${orgId}/skills/${s.id}` });
    expect(g.statusCode).toBe(gDetail.statusCode);

    const otherOrg = await createOrgWithProviders(k, owner, "Other");
    const theirs = await seedOrgSkill("theirs", [{ "SKILL.md": skillMd("theirs", "x") }], otherOrg);
    const r = await member({ method: "GET", url: contentUrl(theirs.id, "SKILL.md", "&as=url") });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("skill.not_found");

    const p = await seedPlatformSkill("kit-skill", "kit", [
      { "SKILL.md": skillMd("kit-skill", "x") },
    ]);
    await installPlugin("kit");
    const on = await member({ method: "GET", url: contentUrl(p.id, "SKILL.md", "&as=url") });
    expect(on.statusCode, on.body).toBe(200);
    await switchOff(p.id);
    const off = await member({ method: "GET", url: contentUrl(p.id, "SKILL.md", "&as=url") });
    expect(off.statusCode).toBe(404);
    expect(off.json().error.code).toBe("skill.not_found");
  });
});

const DOCX_BYTES = "PK docx bytes";
const previewersUrl = (id: string, path: string, q = "") =>
  `/api/v1/orgs/${orgId}/skills/${id}/files/previewers?path=${encodeURIComponent(path)}${q}`;
const previewUrl = (id: string, previewer: string, path: string, q = "") =>
  `/api/v1/orgs/${orgId}/skills/${id}/files/previews/preview-fake/${previewer}?path=${encodeURIComponent(path)}&locale=zh${q}`;
const tokenUrl = () => `/api/v1/orgs/${orgId}/ui/embeds/preview-fake/docx-embed/token`;
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0] as string, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

async function enablePreviewFake(): Promise<void> {
  const r = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/preview-fake`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
}

describe("file-preview@1 for skill files", () => {
  it("lists the previewers that take the file: by extension, within maxBytes, once enabled", async () => {
    const s = await seedOrgSkill("docs", [
      {
        "SKILL.md": skillMd("docs", "x"),
        "doc/Report.docx": DOCX_BYTES,
        "big.docx": new Uint8Array(1024 * 1024 + 1),
      },
    ]);
    const before = await member({ method: "GET", url: previewersUrl(s.id, "doc/Report.docx") });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.headers["cache-control"]).toBe("private, no-store");
    expect(before.json()).toEqual({ previewers: [] });
    await enablePreviewFake();
    const listed = await member({ method: "GET", url: previewersUrl(s.id, "doc/Report.docx") });
    expect(
      (
        listed.json() as { previewers: { plugin: string; id: string; kind: string }[] }
      ).previewers.map((p) => [p.plugin, p.id, p.kind]),
    ).toEqual([
      ["preview-fake", "docx", "view"],
      ["preview-fake", "docx-page", "embed"],
    ]);
    for (const path of ["SKILL.md", "big.docx"]) {
      const r = await member({ method: "GET", url: previewersUrl(s.id, path) });
      expect(r.json(), path).toEqual({ previewers: [] });
    }
    for (const path of ["missing.docx", "../doc/Report.docx", "/doc/Report.docx"]) {
      const r = await member({ method: "GET", url: previewersUrl(s.id, path) });
      expect(r.statusCode, path).toBe(404);
      expect(r.json().error.code, path).toBe("skill.file_not_found");
    }
  });

  it("renders through a read grant for that one object of that version, valid only during the call", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [
      { "SKILL.md": skillMd("docs", "v1"), "doc/Report.docx": "PK version one" },
      { "SKILL.md": skillMd("docs", "v2"), "doc/Report.docx": DOCX_BYTES },
    ]);
    const r = await member({ method: "GET", url: previewUrl(s.id, "docx", "doc/Report.docx") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.json()).toEqual({
      view: { blocks: [{ type: "text", markdown: `13 ${DOCX_BYTES}` }] },
    });
    expect(probe().last).toEqual({
      source: "skill",
      orgId,
      accountId: memberId,
      skillId: s.id,
      version: 2,
      path: "doc/Report.docx",
      locale: "zh",
      config: expect.anything(),
      file: {
        id: `${s.id}@2/doc/Report.docx`,
        name: "Report.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 13,
      },
    });
    await expect(probe().read?.()).rejects.toThrow(/expired/);

    const old = await member({
      method: "GET",
      url: previewUrl(s.id, "docx", "doc/Report.docx", "&version=1"),
    });
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json().view.blocks[0].markdown).toBe("14 PK version one");
    expect(probe().last).toMatchObject({ version: 1, file: { id: `${s.id}@1/doc/Report.docx` } });

    // an embed previewer has no render; a file it does not take is not found
    const embed = await member({
      method: "GET",
      url: previewUrl(s.id, "docx-page", "doc/Report.docx"),
    });
    expect(embed.statusCode).toBe(404);
    expect(embed.json().error.code).toBe("ui.not_found");
    const md = await member({ method: "GET", url: previewUrl(s.id, "docx", "SKILL.md") });
    expect(md.statusCode).toBe(404);
    expect(md.json().error.code).toBe("ui.not_found");
  });

  it("a changed object is 409 skill.file_changed and the previewer is not called", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [
      { "SKILL.md": skillMd("docs", "x"), "a.docx": DOCX_BYTES },
    ]);
    const swapped = Buffer.from("PK docx BYTES");
    await k.app.get(StorageService).kernel(orgId).put(`${s.prefixes[0]}a.docx`, swapped, {
      contentType: "application/octet-stream",
      size: swapped.byteLength,
    });
    const r = await member({ method: "GET", url: previewUrl(s.id, "docx", "a.docx") });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("skill.file_changed");
    expect(probe().last).toBeUndefined();
  });

  it("HTML and SVG files are source only: no previewer list, render or embed token", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [
      {
        "SKILL.md": skillMd("docs", "x"),
        "page.html": "<p>hi</p>",
        "pic.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      },
    ]);
    for (const path of ["page.html", "pic.svg"]) {
      for (const r of [
        await member({ method: "GET", url: previewersUrl(s.id, path) }),
        await member({ method: "GET", url: previewUrl(s.id, "docx", path) }),
        await member({ method: "POST", url: tokenUrl(), payload: { skillId: s.id, path } }),
      ]) {
        expect(r.statusCode, `${path} ${r.body}`).toBe(404);
        expect(r.json().error.code, path).toBe("ui.not_found");
      }
    }
    expect(probe().last).toBeUndefined();
  });

  it("a disabled previewer is neither listed nor rendered nor given an embed token", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [
      { "SKILL.md": skillMd("docs", "x"), "a.docx": DOCX_BYTES },
    ]);
    const put = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/file-previewers`,
      payload: {
        items: [
          { plugin: "preview-fake", id: "docx", disabled: true },
          { plugin: "preview-fake", id: "docx-page", disabled: true },
        ],
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect((await member({ method: "GET", url: previewersUrl(s.id, "a.docx") })).json()).toEqual({
      previewers: [],
    });
    const r = await member({ method: "GET", url: previewUrl(s.id, "docx", "a.docx") });
    expect(r.statusCode).toBe(404);
    const token = await member({
      method: "POST",
      url: tokenUrl(),
      payload: { skillId: s.id, path: "a.docx" },
    });
    expect(token.statusCode).toBe(404);
  });

  it("an embed previewer's token names the skill file it takes, with its resolved version", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [
      { "SKILL.md": skillMd("docs", "v1"), "a.docx": "PK one" },
      { "SKILL.md": skillMd("docs", "v2"), "a.docx": DOCX_BYTES, "notes.txt": "n" },
    ]);
    const ok = await member({
      method: "POST",
      url: tokenUrl(),
      payload: { skillId: s.id, path: "a.docx" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const { token, src } = ok.json() as { token: string; src: string };
    expect(src).toBe("/plugin-ui/preview-fake/docx");
    const claims = claimsOf(token);
    expect(claims).toMatchObject({
      scope: "org",
      orgId,
      accountId: memberId,
      contribution: "docx-embed",
      skillFile: { skillId: s.id, version: 2, path: "a.docx" },
    });
    expect(claims.conversationId).toBeUndefined();
    expect(claims.fileId).toBeUndefined();
    // the extension verifies it as an org token of a file.preview contribution
    const verified = await member({
      method: "GET",
      url: "/plugins/preview-fake/ui/verify",
      headers: { "x-token": token },
    });
    expect(verified.json()).toMatchObject({
      claims: { skillFile: { skillId: s.id, version: 2, path: "a.docx" } },
    });
    const v1 = await member({
      method: "POST",
      url: tokenUrl(),
      payload: { skillId: s.id, version: 1, path: "a.docx" },
    });
    expect(v1.statusCode, v1.body).toBe(200);
    expect(claimsOf((v1.json() as { token: string }).token).skillFile).toEqual({
      skillId: s.id,
      version: 1,
      path: "a.docx",
    });

    // a file no previewer of this embed takes, an unknown path or version: not found
    for (const payload of [
      { skillId: s.id, path: "notes.txt" },
      { skillId: s.id, path: "../a.docx" },
      { skillId: s.id, version: 9, path: "a.docx" },
    ]) {
      const r = await member({ method: "POST", url: tokenUrl(), payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(404);
    }
    // never with a conversation or a file id; skillId and path go together
    const conv = randomUUID();
    for (const payload of [
      { skillId: s.id, path: "a.docx", conversationId: conv },
      { skillId: s.id, path: "a.docx", conversationId: conv, fileId: conv },
      { skillId: s.id, path: "a.docx", fileId: conv },
      { skillId: s.id },
      { path: "a.docx" },
      { version: 2 },
    ]) {
      const r = await member({ method: "POST", url: tokenUrl(), payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // a guest cannot read skills: no token either
    const g = await guest({
      method: "POST",
      url: tokenUrl(),
      payload: { skillId: s.id, path: "a.docx" },
    });
    expect(g.statusCode).toBe(404);
  });

  it("a skill file token reaches the extension's embed routes and stops working once the member is a guest", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [
      { "SKILL.md": skillMd("docs", "x"), "a.docx": DOCX_BYTES },
    ]);
    const minted = await member({
      method: "POST",
      url: tokenUrl(),
      payload: { skillId: s.id, path: "a.docx" },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const { token } = minted.json() as { token: string };
    const skillFile = { skillId: s.id, version: 1, path: "a.docx" };
    const verify = async () =>
      (
        await k.http.inject({
          method: "GET",
          url: "/plugins/preview-fake/ui/verify",
          headers: { "x-token": token },
        })
      ).json().claims;
    const claimsRoute = () =>
      k.http.inject({
        method: "GET",
        url: "/plugins/preview-fake/ui/claims",
        headers: { authorization: `Bearer ${token}` },
      });
    expect(await verify()).toMatchObject({ role: "member", skillFile });
    const caller = await claimsRoute();
    expect(caller.statusCode, caller.body).toBe(200);
    expect(caller.json()).toMatchObject({
      access: "embed",
      scope: "org",
      orgId,
      accountId: memberId,
      role: "member",
      contribution: "docx-embed",
      skillFile,
    });
    expect(caller.json().conversationId).toBeUndefined();

    // a guest may use the file.preview slot but not read skills: the token stops working at once
    await db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("org_id", "=", orgId)
      .where("account_id", "=", memberId)
      .execute();
    expect(await verify()).toBeNull();
    expect((await claimsRoute()).statusCode).toBe(401);
  });

  it("a path is measured in code points, as manifests are", async () => {
    await enablePreviewFake();
    const s = await seedOrgSkill("docs", [{ "SKILL.md": skillMd("docs", "x") }]);
    const routes = (path: string) => [
      () => member({ method: "GET", url: previewersUrl(s.id, path) }),
      () => member({ method: "GET", url: previewUrl(s.id, "docx", path) }),
      () => member({ method: "GET", url: contentUrl(s.id, path) }),
      () => member({ method: "POST", url: tokenUrl(), payload: { skillId: s.id, path } }),
    ];
    // 303 code points (603 UTF-16 code units): a valid path, just not in this manifest (a stored
    // object's key caps real paths below this, so nothing here can be found)
    for (const call of routes(`${"😀".repeat(300)}.md`)) {
      const r = await call();
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().error.code).toBe("skill.file_not_found");
    }
    for (const call of routes("a".repeat(513))) {
      const r = await call();
      expect(r.statusCode, r.body).toBe(400);
    }
  });

  it("a platform skill switched off after it was read, and another org's skill: every route 404", async () => {
    await enablePreviewFake();
    const p = await seedPlatformSkill("kit-skill", "kit", [
      { "SKILL.md": skillMd("kit-skill", "one"), "a.docx": DOCX_BYTES },
    ]);
    await installPlugin("kit");
    const routes = (id: string) => [
      () => member({ method: "GET", url: previewersUrl(id, "a.docx") }),
      () => member({ method: "GET", url: previewUrl(id, "docx", "a.docx") }),
      () => member({ method: "POST", url: tokenUrl(), payload: { skillId: id, path: "a.docx" } }),
    ];
    for (const call of routes(p.id)) {
      const r = await call();
      expect(r.statusCode, r.body).toBe(200);
    }
    await switchOff(p.id);
    for (const call of routes(p.id)) {
      const r = await call();
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().error.code).toBe("skill.not_found");
    }

    const otherOrg = await createOrgWithProviders(k, owner, "Other");
    const theirs = await seedOrgSkill(
      "theirs",
      [{ "SKILL.md": skillMd("theirs", "x"), "a.docx": DOCX_BYTES }],
      otherOrg,
    );
    for (const call of routes(theirs.id)) {
      const r = await call();
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().error.code).toBe("skill.not_found");
    }
  });
});
