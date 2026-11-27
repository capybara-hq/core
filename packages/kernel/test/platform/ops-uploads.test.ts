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
