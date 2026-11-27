import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { FileDeliveries } from "../../src/files/deliveries.js";
import { LibraryFilesService } from "../../src/files/library-files.service.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { FileCardDetail, ResolvedFile } from "../../src/platform/file-ref.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { storeArtifacts } from "../../src/tools/builtins/artifacts.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { skillPlugin } from "../catalog/packages.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { migrateLegacyFiles, seedLibraryFile } from "../helpers/library-files.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { greeterPkg } from "../helpers/plugin-packages.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { makeZip, SKILL_MD } from "../skills/zip.js";

/**
 * Task 15 of the platform web parity plan (spec §5): the routes the web uploads files to get
 * `Platform` operations that take a conversation file (`{ fileId }`) instead of bytes. The two
 * acceptance cases go through the tool (the card, the approval, the run): an avatar from a
 * `GenerateImage` image, and a skill archive delivered from the sandbox. The delivered file is
 * seeded with `storeArtifacts`, the function `Deliver` stores with (driving `Deliver` needs a
 * device with the archive on it). The other operations run on a fixture package with the
 * verified bytes as `ctx.file`, as the tool hands them over.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MEM_STORE = fixture("mem-store");

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: Req;
let rootId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MEM_STORE],
        extensionConfig: {
          "model-fake": {
            models: [{ id: "fake-1" }, { id: "fake-image", kind: "image_generation" }],
          },
        },
      },
    ),
  );
  rootId = (
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      superAdmin: true,
    })
  ).id;
  root = await session(k, "root");
  orgId = await createOrgWithProviders(k, root);
  const mapped = await root({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/image`,
    payload: { target: { model: { provider: "model-fake", model: "fake-image" }, params: {} } },
  });
  expect(mapped.statusCode, mapped.body).toBe(200);
  const res = await root({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Builder",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([
          { kind: "builtin", name: "Platform" },
          { kind: "builtin", name: "GenerateImage" },
        ]),
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const callText = (operation: string, params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation, params })}`;
const lastResult = async (conv: string) =>
  ofType(await eventsOf(db, conv), "tool_result").at(-1)?.payload;

const op = (id: string) => {
  const o = k.app.get(PlatformOperations).get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};

/** The file as the tool hands it to `run` (resolved and hashed at the policy step). */
const fileOf = (name: string, contentType: string, bytes: Uint8Array): ResolvedFile => ({
  name,
  contentType,
  size: bytes.byteLength,
  sha256: sha256(bytes),
  bytes,
});

const ctxOf = (file: ResolvedFile): OperationContext => ({
  orgId,
  actorAccountId: rootId,
  agentId,
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
  file,
});

/** Runs an operation the way the tool does after the person approved its card. */
const run = (id: string, input: unknown, file: ResolvedFile) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctxOf(file));
};

const skillZip = (name: string, description = "Writes reports.") =>
  new Uint8Array(
    makeZip([
      { name: "SKILL.md", data: SKILL_MD(name, description) },
      { name: "scripts/run.py", data: "print(1)\n" },
    ]),
  );

const viaAgent = async (action: string, operation: string) => {
  const rows = await db
    .selectFrom("audit_events")
    .select("detail")
    .where("action", "=", action)
    .execute();
  expect(rows.map((r) => r.detail)).toContainEqual(
    expect.objectContaining({ via: "agent", operation }),
  );
};

/** Calls an operation in `conv` and approves its card; returns the card and the result. */
async function confirmed(conv: string, runs: number, operation: string, params: object) {
  await postMessage(root, orgId, conv, callText(operation, params as Record<string, unknown>));
  const asked = await waitFor(
    async () => ofType(await eventsOf(db, conv), "approval_requested")[0],
    20_000,
    "approval_requested",
  );
  const card = await db
    .selectFrom("approvals")
    .select(["detail", "summary"])
    .where("id", "=", asked.payload.approvalId)
    .executeTakeFirstOrThrow();
  const ok = await root({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${asked.payload.approvalId}/decision`,
    payload: { decision: "approve", scope: "once" },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  await waitForTerminal(db, conv, runs, 30_000);
  return {
    file: (card.detail as { file?: FileCardDetail } | null)?.file,
    summary: card.summary as { zh: string; en: string } | null,
    result: await lastResult(conv),
  };
}

describe("acceptance: files instead of uploads", () => {
  it("3. an avatar from a GenerateImage image: the card shows its thumbnail, the avatar changes", async () => {
    const conv = await createConv(root, orgId, agentId);
    await postMessage(
      root,
      orgId,
      conv,
      `tool:GenerateImage:${JSON.stringify({ prompt: "a fox" })}`,
    );
    await waitForTerminal(db, conv, 1, 30_000);
    const made = ofType(await eventsOf(db, conv), "artifact_created")[0];
    expect(made, "GenerateImage stored no artifact").toBeDefined();
    const fileId = made?.payload.artifactId as string;

    const { file, summary, result } = await confirmed(conv, 2, "agents.update-profile", {
      agentId,
      avatar: { kind: "file", file: { fileId } },
    });
    expect(result?.isError, result?.content).toBe(false);
    expect(file?.contentType).toBe("image/png");
    expect(file?.thumbnail).toMatch(/^data:image\/webp;base64,/);
    expect(summary?.en).toContain("set the avatar to the image");

    const agent = await root({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    const avatar = (agent.json() as { agent: { profile: { avatar: unknown } } }).agent.profile
      .avatar as { kind: string; uploadId: string };
    expect(avatar.kind).toBe("upload");
    const stored = await k.app
      .get(StorageService)
      .kernel(orgId)
      .get(`agent-avatars/${avatar.uploadId}`);
    const bytes = new Uint8Array(await new Response(stored?.body).arrayBuffer());
    expect(sha256(bytes)).toBe(file?.sha256);
    const img = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}/avatar`,
    });
    expect(img.statusCode).toBe(302);
    await viaAgent("agent.profile_updated", "agents.update-profile");
  });

  it("4. a skill archive packed in the sandbox and delivered: the org has the skill", async () => {
    const conv = await createConv(root, orgId, agentId);
    await postMessage(root, orgId, conv, "hello");
    await waitForTerminal(db, conv, 1, 30_000);
    const runRow = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    // what Deliver stores for /workspace/out/weekly-report.zip (the zip extension's type)
    const [delivered] = await storeArtifacts(
      { deliveries: k.app.get(FileDeliveries), eventLog: k.app.get(EventLog) },
      {
        orgId,
        accountId: rootId,
        agentId,
        conversationId: conv,
        rootConversationId: conv,
        runId: runRow.id,
        callId: `call-${randomUUID().slice(0, 8)}`,
        signal: new AbortController().signal,
      } as unknown as BuiltinCallContext,
      [
        {
          name: "weekly-report.zip",
          contentType: "application/zip",
          data: skillZip("weekly-report"),
          sourcePath: "/workspace/out/weekly-report.zip",
        },
      ],
    );
    const { file, summary, result } = await confirmed(conv, 2, "skills.create-from-file", {
      file: { fileId: delivered?.artifactId },
    });
    expect(result?.isError, result?.content).toBe(false);
    expect(file?.name).toBe("weekly-report.zip");
    // the card names the skill SKILL.md declares and that it is a new one
    expect(summary?.en).toBe(
      'Create org skill "weekly-report" from the package "weekly-report.zip"',
    );
    const list = await root({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
    const skills = (list.json() as { skills: { name: string; currentVersion: number }[] }).skills;
    expect(skills.find((s) => s.name === "weekly-report")).toMatchObject({ currentVersion: 1 });
    await viaAgent("skill.created", "skills.create-from-file");
  });

  it("a 3 MiB avatar is refused before the card", async () => {
    const conv = await createConv(root, orgId, agentId);
    const big = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes.set(big);
    const id = randomUUID();
    await k.app.get(StorageService).kernel(orgId).put(`attachments/${id}`, bytes, {
      contentType: "image/png",
      size: bytes.byteLength,
    });
    await db
      .insertInto("attachments")
      .values({
        id,
        org_id: orgId,
        conversation_id: conv,
        account_id: rootId,
        name: "huge.png",
        content_type: "image/png",
        size: bytes.byteLength,
        object_key: `attachments/${id}`,
        status: "ready",
        etag: null,
        purpose: "chat",
      })
      .execute();
    // written as before the file library, then migrated by 0189
    await migrateLegacyFiles(db);
    await postMessage(
      root,
      orgId,
      conv,
      callText("agents.update-profile", {
        agentId,
        avatar: { kind: "file", file: { fileId: id } },
      }),
    );
    await waitForTerminal(db, conv, 1, 30_000);
    expect(ofType(await eventsOf(db, conv), "approval_requested")).toEqual([]);
    const result = await lastResult(conv);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(
      `The file is ${3 * 1024 * 1024} bytes; this operation takes at most ${2 * 1024 * 1024}.`,
    );
  });
});

describe("the other upload operations on fixture packages", () => {
  it("agents.upload-skill registers a zip as one of the agent's own skills", async () => {
    const out = (await run(
      "agents.upload-skill",
      { agentId, file: { fileId: randomUUID() } },
      fileOf("triage.zip", "application/zip", skillZip("triage")),
    )) as { skill: { name: string; version: number; state: string } };
    expect(out.skill).toMatchObject({ name: "triage", version: 1, state: "active" });
    const list = await root({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}/skills`,
    });
    expect((list.json() as { skills: { name: string }[] }).skills.map((s) => s.name)).toContain(
      "triage",
    );
    await viaAgent("skill.created", "agents.upload-skill");
    // a second card for the same name says it adds a version
    const o = op("agents.upload-skill");
    const again = await o.summary?.(
      o.input.parse({ agentId, file: { fileId: randomUUID() } }),
      ctxOf(fileOf("triage.zip", "application/zip", skillZip("triage"))),
    );
    expect(again?.en).toBe(
      'Add a new version of skill "triage" of agent "Builder" from the package "triage.zip"',
    );
  });

  it("agents.upload-skill is refused in a sub-agent conversation, as agents.register-skill", async () => {
    const parent = await createConv(root, orgId, agentId);
    const child = await createConv(root, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ parent_conversation_id: parent })
      .where("id", "=", child)
      .execute();
    const o = op("agents.upload-skill");
    const input = o.input.parse({ agentId, file: { fileId: randomUUID() } });
    const ctx = { ...ctxOf(fileOf("x.zip", "application/zip", skillZip("x"))) };
    expect(await o.precheck?.(input, { ...ctx, conversationId: child })).toMatchObject({
      ok: false,
      code: "skill.subagent_register",
    });
    expect(await o.precheck?.(input, { ...ctx, conversationId: parent })).toEqual({ ok: true });
  });

  it("skills.create-from-file gives up the stored package when the write fails", async () => {
    const before = await db
      .selectFrom("attachments")
      .select("id")
      .where("purpose", "=", "skill-package")
      .execute();
    const bad = new Uint8Array(makeZip([{ name: "README.md", data: "no SKILL.md here\n" }]));
    await expect(
      run(
        "skills.create-from-file",
        { file: { fileId: randomUUID() } },
        fileOf("bad.zip", "application/zip", bad),
      ),
    ).rejects.toMatchObject({ code: "skill.invalid_package" });
    const rows = await db
      .selectFrom("attachments")
      .select(["status", sql<boolean>`expires_at <= now()`.as("expired")])
      .where("purpose", "=", "skill-package")
      .where("id", "not in", before.length > 0 ? before.map((r) => r.id) : [randomUUID()])
      .execute();
    // out of the cap (not ready) and due for the cleanup job
    expect(rows).toEqual([{ status: "deleting", expired: true }]);
  });

  it("plugins.upload stages an org upload; confirming it stays with the person", async () => {
    // a .tgz delivered by Deliver is application/octet-stream: the package route takes any type
    const tgz = await skillPlugin("org-kit", { version: "1.0.0" });
    const limits = op("plugins.upload").fileRef?.({ file: { fileId: randomUUID() } })?.limits;
    expect(limits).toEqual({ maxBytes: k.app.get(KernelConfigService).get().packages.maxBytes });
    const out = (await run(
      "plugins.upload",
      { file: { fileId: randomUUID() } },
      fileOf("org-kit.tgz", "application/octet-stream", tgz),
    )) as { stagingId: string; review: { name: string }; next: string };
    expect(out.review.name).toBe("org-kit");
    expect(out.next).toContain("on the web");
    const staged = await db
      .selectFrom("plugin_import_staging")
      .selectAll()
      .where("id", "=", out.stagingId)
      .executeTakeFirstOrThrow();
    expect(staged.org_id).toBe(orgId);
  });

  it("plugins.import-file stages a platform import for the super admin's review", async () => {
    const tgz = await skillPlugin("platform-kit", { version: "1.0.0" });
    const out = (await run(
      "plugins.import-file",
      { file: { fileId: randomUUID() } },
      fileOf("platform-kit.tgz", "application/gzip", tgz),
    )) as { stagingId: string; review: { name: string }; reviewUrl: string };
    expect(out.review.name).toBe("platform-kit");
    expect(out.reviewUrl).toBe(`/admin/plugins/import?staging=${out.stagingId}`);
  });

  it("extensions.upload-package stores a package and returns its review; installing stays with a person (CLI or API)", async () => {
    const pkg = await greeterPkg();
    const out = (await run(
      "extensions.upload-package",
      { file: { fileId: randomUUID() } },
      fileOf("greeter.tgz", "application/octet-stream", pkg),
    )) as { review: { name: string; sha256: string }; next: string };
    expect(out.review).toMatchObject({ name: "greeter", sha256: sha256(pkg) });
    expect(out.next).toContain(
      `POST /api/v1/admin/extensions/greeter/install with { "sha256": "${sha256(pkg)}" }`,
    );
    expect(out.next).toContain("capybara extensions install");
    const row = await db
      .selectFrom("extension_packages")
      .select(["name", "source"])
      .where("sha256", "=", sha256(pkg))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ name: "greeter", source: "file" });
    await viaAgent("extension.package_uploaded", "extensions.upload-package");
  });

  it("plugins.update-skill publishes a platform skill's next version", async () => {
    const tgz = await skillPlugin("notes-kit", { version: "1.0.0", skill: "notes" });
    const prepared = await root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(tgz),
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const confirmedImport = await root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${prepared.json().stagingId}/confirm`,
      payload: { reviewHash: prepared.json().review.reviewHash },
    });
    expect(confirmedImport.statusCode, confirmedImport.body).toBe(201);
    const skill = await db
      .selectFrom("platform_skills")
      .select(["id", "current_version"])
      .where("name", "=", "notes")
      .executeTakeFirstOrThrow();
    const out = await run(
      "plugins.update-skill",
      { skillId: skill.id, file: { fileId: randomUUID() } },
      fileOf("notes.zip", "application/zip", skillZip("notes", "Takes better notes.")),
    );
    expect(out).toMatchObject({ kind: "skill", name: "notes", version: skill.current_version + 1 });
    await viaAgent("component.version_uploaded", "plugins.update-skill");
  });
});

describe("files.add: a conversation file into the person's files", () => {
  let otherId: string;

  beforeAll(async () => {
    otherId = (
      await accountsFor(db).createLocal({ login: "other", password: PW, displayName: "Other" })
    ).id;
  });

  /** Delivers `bytes` into a new conversation of root's (as `Deliver` stores them). */
  async function delivered(name: string, contentType: string, bytes: Uint8Array) {
    const conv = await createConv(root, orgId, agentId);
    await postMessage(root, orgId, conv, "hello");
    await waitForTerminal(db, conv, 1, 30_000);
    const runRow = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const [out] = await storeArtifacts(
      { deliveries: k.app.get(FileDeliveries), eventLog: k.app.get(EventLog) },
      {
        orgId,
        accountId: rootId,
        agentId,
        conversationId: conv,
        rootConversationId: conv,
        runId: runRow.id,
        callId: `call-${randomUUID().slice(0, 8)}`,
        signal: new AbortController().signal,
      } as unknown as BuiltinCallContext,
      [{ name, contentType, data: bytes, sourcePath: `/workspace/out/${name}` }],
    );
    return { conv, fileId: out?.artifactId as string };
  }

  const fileRow = (id: string) =>
    db
      .selectFrom("files")
      .select(["account_id", "blob_id", "origin", "status", "name", "upload_purpose"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  const blobCount = async () =>
    Number(
      (
        await db
          .selectFrom("blobs")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("org_id", "=", orgId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  /** Calls files.add in `conv` through the tool and expects it refused before any card. */
  async function refusedBeforeCard(conv: string, runs: number, fileId: string) {
    await postMessage(root, orgId, conv, callText("files.add", { file: { fileId } }));
    await waitForTerminal(db, conv, runs, 30_000);
    expect(ofType(await eventsOf(db, conv), "approval_requested")).toEqual([]);
    const result = await lastResult(conv);
    expect(result?.isError).toBe(true);
    return result?.content ?? "";
  }

  /** Runs files.add the way the tool does after the card (the bytes as `ctx.file`). */
  const add = (input: object, file: ResolvedFile, conversationId: string = randomUUID()) => {
    const o = op("files.add");
    return o.run(o.input.parse(input), { ...ctxOf(file), conversationId }) as Promise<{
      id: string;
      name: string;
      added: boolean;
    }>;
  };

  it("the person's own file of this conversation: the card says it is already there, and it is returned", async () => {
    const bytes = new TextEncoder().encode(`report ${randomUUID()}\n`);
    const { conv, fileId } = await delivered("report.txt", "text/plain", bytes);
    const before = (await db.selectFrom("files").select("id").execute()).length;
    const { file, summary, result } = await confirmed(conv, 2, "files.add", {
      file: { fileId },
    });
    expect(result?.isError, result?.content).toBe(false);
    expect(file).toMatchObject({ name: "report.txt", sha256: sha256(bytes) });
    expect(summary?.en).toBe('The file "report.txt" is already in your files; nothing is added');
    expect(JSON.parse(result?.content ?? "{}")).toEqual({
      id: fileId,
      name: "report.txt",
      size: bytes.byteLength,
      contentType: "text/plain",
      added: false,
      // the link card's target, also in the result text
      reviewUrl: `/files#item=${fileId}`,
    });
    expect((await db.selectFrom("files").select("id").execute()).length).toBe(before);
  });

  it("the person's own file under another name: a renamed entry on the same blob", async () => {
    const bytes = new TextEncoder().encode(`draft ${randomUUID()}\n`);
    const { conv, fileId } = await delivered("draft.txt", "text/plain", bytes);
    const blobs = await blobCount();
    const o = op("files.add");
    const input = o.input.parse({ file: { fileId }, name: "final.txt" });
    const file = fileOf("draft.txt", "text/plain", bytes);
    const ctx = { ...ctxOf(file), conversationId: conv };
    expect((await o.summary?.(input, ctx))?.en).toBe(
      'Add the file "draft.txt" to your files as "final.txt"',
    );
    const out = await add({ file: { fileId }, name: "final.txt" }, file, conv);
    expect(out).toMatchObject({ name: "final.txt", added: true });
    expect(out.id).not.toBe(fileId);
    expect((await fileRow(out.id)).blob_id).toBe((await fileRow(fileId)).blob_id);
    expect(await blobCount()).toBe(blobs);
  });

  it("bytes the org already stores: a new upload of the person on that blob, added once", async () => {
    const bytes = new TextEncoder().encode(`shared notes ${randomUUID()}\n`);
    const { fileId } = await delivered("notes.txt", "text/plain", bytes);
    const blobs = await blobCount();
    // the same bytes reached by another id (an image a tool showed the agent, say)
    const out = await add(
      { file: { fileId: randomUUID() } },
      fileOf("copy.txt", "text/plain", bytes),
    );
    expect(out).toMatchObject({ name: "copy.txt", added: true });
    expect(await fileRow(out.id)).toEqual({
      account_id: rootId,
      blob_id: (await fileRow(fileId)).blob_id,
      origin: "upload",
      status: "ready",
      name: "copy.txt",
      upload_purpose: "library",
    });
    expect(await blobCount()).toBe(blobs);
    // the same bytes and name again add nothing
    const again = await add(
      { file: { fileId: randomUUID() } },
      fileOf("copy.txt", "text/plain", bytes),
    );
    expect(again).toMatchObject({ id: out.id, added: false });
  });

  it("bytes new to the org: written to a new blob, settled with their sha256", async () => {
    const bytes = new TextEncoder().encode(`fresh ${randomUUID()}\n`);
    const blobs = await blobCount();
    const out = await add(
      { file: { fileId: randomUUID() } },
      fileOf("fresh.txt", "text/plain", bytes),
    );
    expect(out).toMatchObject({ name: "fresh.txt", added: true });
    expect(await blobCount()).toBe(blobs + 1);
    const blob = await db
      .selectFrom("blobs")
      .select(["status", "sha256", "size", "object_key"])
      .where("id", "=", (await fileRow(out.id)).blob_id)
      .executeTakeFirstOrThrow();
    expect(blob).toMatchObject({
      status: "ready",
      sha256: sha256(bytes),
      size: String(bytes.byteLength),
    });
    const stored = await k.app.get(StorageService).kernel(orgId).get(blob.object_key);
    expect(new Uint8Array(await new Response(stored?.body).arrayBuffer())).toEqual(bytes);
  });

  it("another person's file of this conversation is refused before the card", async () => {
    const { conv, fileId } = await delivered(
      "theirs.txt",
      "text/plain",
      new TextEncoder().encode("t"),
    );
    // the file in this conversation belongs to someone else: a file has one owner
    await db.updateTable("files").set({ account_id: otherId }).where("id", "=", fileId).execute();
    expect(await refusedBeforeCard(conv, 2, fileId)).toContain(
      "This file belongs to another person; ask them to add it to their files.",
    );
  });

  it("a file outside this conversation (another account's file, another conversation's file) is refused before the card", async () => {
    const theirs = await seedLibraryFile(
      k.app,
      orgId,
      otherId,
      { name: "secret.txt", contentType: "text/plain", bytes: new TextEncoder().encode("x") },
      { status: "ready" },
    );
    const elsewhere = await delivered("elsewhere.txt", "text/plain", new TextEncoder().encode("y"));
    const conv = await createConv(root, orgId, agentId);
    for (const [i, fileId] of [theirs, elsewhere.fileId].entries()) {
      expect(await refusedBeforeCard(conv, i + 1, fileId)).toContain(
        `File ${fileId} is not a file of this conversation.`,
      );
    }
  });

  it("a type the uploads do not accept is refused before the card", async () => {
    const { conv, fileId } = await delivered(
      "tool.exe",
      "application/octet-stream",
      new Uint8Array([0x4d, 0x5a, 0, 1]),
    );
    expect(await refusedBeforeCard(conv, 2, fileId)).toContain(
      "The file is application/octet-stream; this operation takes",
    );
  });

  it("an image over the image limit is refused before the card, though documents may be larger", async () => {
    const limits = k.app.get(LibraryFilesService).limits();
    const wanted = op("files.add").fileRef?.({ file: { fileId: randomUUID() } })?.limits;
    expect(wanted?.typeMaxBytes?.["image/png"]).toBe(limits.imageMaxBytes);
    expect(wanted?.typeMaxBytes?.["application/pdf"]).toBe(limits.maxBytes);
    expect(wanted?.contentTypes).toEqual(limits.types);
    expect(wanted?.ownFilesOnly).toBe(true);
    // a PNG one byte over the image limit, well under the document limit
    const png = new Uint8Array(limits.imageMaxBytes + 1);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { conv, fileId } = await delivered("big.png", "image/png", png);
    expect(await refusedBeforeCard(conv, 2, fileId)).toContain(
      `The file is ${png.byteLength} bytes; this operation takes at most ${limits.imageMaxBytes}.`,
    );
  });
});
