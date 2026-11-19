import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { ModelError, type ModelInfo, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentsService } from "../../../src/conversations/attachments.service.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { ConversationDevices } from "../../../src/devices/conversation-devices.js";
import { reconstructRequest, snapshotMediaRefs } from "../../../src/evals/reconstruct.js";
import type { RunReplayResult } from "../../../src/evals/run-replay.js";
import type { EvalResultView, EvalRunView } from "../../../src/evals/runs.service.js";
import type { EvalSetView } from "../../../src/evals/sets.service.js";
import { type CaseSnapshot, takeSnapshot, toEvents } from "../../../src/evals/snapshot.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import { SandboxService } from "../../../src/sandbox/sandbox.service.js";
import { StorageService } from "../../../src/storage/storage.service.js";
import { BuiltinTools } from "../../../src/tools/builtins/builtin-tools.js";
import {
  pdfText,
  READ_DESCRIPTION,
  READ_NO_DEVICE_TEXT,
  READ_ONE_SOURCE_TEXT,
  tooLargeText,
} from "../../../src/tools/builtins/sandbox/read.js";
import {
  NO_VISION_MODEL_TEXT,
  VISION_SYSTEM_PROMPT,
} from "../../../src/tools/builtins/vision/read-image.js";
import type { BuiltinTool } from "../../../src/tools/registry.js";
import { truncateTables } from "../../helpers/db.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import { captureProviderRequests } from "../../helpers/provider-capture.js";
import {
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * Vision-read design §1.1, §1.2, §1.5: the builtin `Read` on a real kernel. model-fake declares
 * `fake-v` (vision), `fake-1` (no vision), `fake-eye` (vision, the `vision` purpose's model) and an
 * image model; `mem-store` is the object store, `sandbox-fake` the device (real files in a
 * temporary directory), `hooks-probe` observes `model.request`. Runs are scripted through
 * model-fake (`tool:Read:<json>`); the provider requests are captured for the zero-drift checks,
 * and one case replays a run in full (an eval run).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MEM_STORE = fixture("mem-store");
const SANDBOX_FAKE = fixture("sandbox-fake");
const HOOKS_PROBE = fixture("hooks-probe");

const VISION = { provider: "model-fake", model: "fake-v" };
const BLIND = { provider: "model-fake", model: "fake-1" };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** A valid PNG of `width`×`height` (black pixels), padded with a `tEXt` chunk of `pad` bytes. */
function png(width: number, height: number, pad = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(pad > 0
      ? [chunk("tEXt", Buffer.concat([Buffer.from("pad\0"), Buffer.alloc(pad, 0x61)]))]
      : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const IMAGE = png(3, 2);
const readText = (name: string, size: number, dims: string, id: string) =>
  `Read image ${name} (image/png, ${size} bytes${dims}; file_id ${id}).`;

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let orgId: string;
/** Read (+ Agent) on the vision model. */
let viewerId: string;
/** Read on the model without vision. */
let blindId: string;
/** The vision model with the non-vision model as its fallback. */
let switcherId: string;
/** GenerateImage + Read on the vision model. */
let painterId: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  root = await mkdtemp(join(tmpdir(), "cap-read-images-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MEM_STORE, SANDBOX_FAKE, HOOKS_PROBE],
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1" },
              { id: "fake-v", vision: true },
              { id: "fake-eye", vision: true },
              { id: "fake-image", kind: "image_generation" },
            ],
          },
          "sandbox-fake": { root },
        },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const agent = async (name: string, definition: Record<string, unknown>, tools: string[]) => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name,
          instructions: "Look at files.",
          ...definition,
          disabledTools: onlyBuiltins(tools.map((n) => ({ kind: "builtin" as const, name: n }))),
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { agent: { id: string } }).agent.id;
  };
  viewerId = await agent("Viewer", { model: VISION }, ["Read", "Agent"]);
  blindId = await agent("Blind", { model: BLIND }, ["Read"]);
  switcherId = await agent("Switcher", { model: VISION, fallback: BLIND }, ["Read"]);
  painterId = await agent("Painter", { model: VISION }, ["GenerateImage", "Read"]);
  // image models start disabled in an org
  const enable = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
    payload: { enable: ["fake-image"] },
  });
  expect(enable.statusCode, enable.body).toBe(200);
  await mapPurpose("image", "fake-image");
});

afterAll(async () => {
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  capture.reset();
  await truncateTables(raw, "capybara.model_purpose_mappings");
  await mapPurpose("image", "fake-image");
  await mapPurpose("vision", "fake-eye");
});

async function mapPurpose(purpose: string, model: string): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/${purpose}`,
    payload: { target: { model: { provider: "model-fake", model }, params: {} } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function unmapVision(): Promise<void> {
  await truncateTables(raw, "capybara.model_purpose_mappings");
  await mapPurpose("image", "fake-image");
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
type ToolResultEvent = Ev<"tool_result">;

/** The conversation requests the provider received (vision calls left out). */
const chatRequests = () =>
  capture.sent.filter((r) => !r.system.some((s) => s.text === VISION_SYSTEM_PROMPT));
const visionRequests = () =>
  capture.sent.filter((r) => r.system.some((s) => s.text === VISION_SYSTEM_PROMPT));

/** Posts one `Read` call through a run and waits for its `n`th terminal event. */
async function read(conv: string, input: Record<string, unknown>, n = 1) {
  await postMessage(owner, orgId, conv, `tool:Read:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
  const r = ofType(await eventsOf(db, conv), "tool_result").at(-1) as ToolResultEvent;
  expect(r.payload.toolKey).toBe("Read");
  return r;
}

/** A ready `chat` attachment of `conv`. */
async function attachment(conv: string, bytes: Uint8Array, name = "pasted.png") {
  const id = randomUUID();
  const objectKey = `attachments/${id}`;
  await k.app.get(StorageService).kernel(orgId).put(objectKey, bytes, {
    contentType: "image/png",
    size: bytes.byteLength,
  });
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: ownerId,
      name,
      content_type: "image/png",
      size: bytes.byteLength,
      object_key: objectKey,
      status: "ready",
      etag: null,
      purpose: "chat",
    })
    .execute();
  return id;
}

const readRows = (conv?: string) => {
  let q = db
    .selectFrom("attachments")
    .select(["id", "conversation_id", "name", "content_type", "size", "object_key", "status"])
    .where("purpose", "=", "read");
  if (conv !== undefined) q = q.where("conversation_id", "=", conv);
  return q.execute();
};

let workspace: string | undefined;
/**
 * The host directory of the owner's device's `/workspace` (every conversation of the owner shares
 * the default device); the first call starts the device with a Read of a missing file.
 */
async function workspaceDir(): Promise<string> {
  if (workspace !== undefined) return workspace;
  const conv = await createConv(owner, orgId, viewerId);
  await read(conv, { file_path: "/workspace/none.txt" });
  const dirs = await readdir(join(root, "filesystems"));
  expect(dirs).toHaveLength(1);
  workspace = join(root, "filesystems", dirs[0] as string, "workspace");
  return workspace;
}

async function onDevice(name: string, bytes: Uint8Array | string): Promise<string> {
  await writeFile(join(await workspaceDir(), name), bytes);
  return `/workspace/${name}`;
}

/** The last user message of a request: the tool results and what follows them. */
const lastUser = (r: ModelRequest | undefined) =>
  (r?.messages.filter((m) => m.role === "user").at(-1)?.content ?? []) as unknown[];

async function probeLast(mount: string): Promise<Record<string, unknown> | null> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=vision`,
  });
  return (res.json() as { last: Record<string, Record<string, unknown>> }).last[mount] ?? null;
}

const tool = (): BuiltinTool => {
  const t = k.app
    .get(BuiltinTools)
    .list()
    .find((x) => x.spec.name === "Read");
  if (!t) throw new Error("Read is not built");
  return t;
};

// ---- zero drift (the replay invariant) ----

type ModelCallEvent = Ev<"model_call">;

async function modelInfo(provider: string, model: string): Promise<ModelInfo> {
  return (await k.app.get(ProviderRegistry).resolve(orgId, { provider, model })).info;
}

async function snapshotOf(conv: string, runId?: string): Promise<CaseSnapshot> {
  const id = runId ?? ((await runsOf(db, conv)).at(-1) as { id: string }).id;
  return takeSnapshot(db, orgId, conv, id, 4_194_304);
}

/**
 * Every `model_call` of the snapshot reconstructs to exactly the request the provider received
 * (`sent`, in order) with no drift; the Read copies are fetched as the runtime fetches them.
 */
async function expectZeroDrift(conv: string, snap: CaseSnapshot, sent: ModelRequest[]) {
  const calls = ofType(toEvents(snap) as ConversationEvent[], "model_call") as ModelCallEvent[];
  expect(calls).toHaveLength(sent.length);
  const attachments = k.app.get(AttachmentsService);
  for (const [i, c] of calls.entries()) {
    const info = await modelInfo(c.payload.provider, c.payload.model);
    const ids = snapshotMediaRefs(snap, c.seq, info);
    const media =
      ids.length === 0
        ? {}
        : await (async () => {
            const mediaInfo = await attachments.mediaInfo(orgId, conv, ids);
            return {
              mediaInfo,
              media: await attachments.fetchMedia(orgId, conv, [...mediaInfo.keys()]),
            };
          })();
    const out = reconstructRequest(snap, c.seq, {
      model: info,
      mediaBudgetBytes: k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
      ...media,
    });
    expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
    expect(out.request, `model_call seq ${c.seq}`).toEqual(sent[i]);
  }
}

describe("Read: listing and spec", () => {
  it("the description is spec §1.5 verbatim, keyArgs name both sources, the timeout covers the vision call", () => {
    const t = tool();
    expect(t.spec.description).toBe(READ_DESCRIPTION);
    expect(t.spec.keyArgs).toEqual(["file_path", "file_id"]);
    const cfg = k.app.get(KernelConfigService).get();
    const sandboxMs = cfg.tools.timeoutMs + cfg.sandbox.lockWaitSeconds * 1000 + 180_000;
    expect(t.timeoutMs?.({})).toBe(Math.max(sandboxMs, cfg.models.visionTimeoutMs + 10_000));
  });

  it("file_path and file_id together, or neither, name both fields", async () => {
    const conv = await createConv(owner, orgId, viewerId);
    const both = await read(conv, { file_path: "/workspace/a.png", file_id: randomUUID() });
    expect(both.payload.isError).toBe(true);
    expect(both.payload.content).toContain(READ_ONE_SOURCE_TEXT);
    expect(READ_ONE_SOURCE_TEXT).toContain("file_path");
    expect(READ_ONE_SOURCE_TEXT).toContain("file_id");
    const neither = await read(conv, {}, 2);
    expect(neither.payload.content).toContain(READ_ONE_SOURCE_TEXT);
  });

  it("an unknown file_id names it", async () => {
    const conv = await createConv(owner, orgId, viewerId);
    const id = randomUUID();
    const r = await read(conv, { file_id: id });
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toContain(
      `file_id ${id} is not an attachment or artifact of this conversation; pass the id of one.`,
    );
  });
});

describe("Read: images on a vision model", () => {
  it("a PNG on the device: the result text, one media entry, a read copy, the image in the next request; zero drift", async () => {
    const path = await onDevice("a.png", IMAGE);
    capture.reset();
    const conv = await createConv(owner, orgId, viewerId);
    const r = await read(conv, { file_path: path });
    expect(r.payload.isError, r.payload.content).toBe(false);
    const id = UUID.exec(r.payload.content)?.[0] as string;
    expect(r.payload.content).toBe(readText("a.png", IMAGE.length, ", 3×2", id));
    expect(r.payload.media).toEqual([
      { attachmentId: id, name: "a.png", mediaType: "image/png", size: IMAGE.length },
    ]);
    expect(await readRows(conv)).toEqual([
      {
        id,
        conversation_id: conv,
        name: "a.png",
        content_type: "image/png",
        // bigint column
        size: String(IMAGE.length),
        object_key: `read-images/${id}`,
        status: "ready",
      },
    ]);
    // no vision call: the chat model views the image itself
    expect(visionRequests()).toEqual([]);
    const sent = chatRequests();
    expect(lastUser(sent.at(-1)).slice(-2)).toEqual([
      { type: "text", text: `Image from Read (file_id ${id}):` },
      {
        type: "image",
        mediaType: "image/png",
        name: "a.png",
        source: { kind: "base64", data: IMAGE.toString("base64") },
      },
    ]);
    await expectZeroDrift(conv, await snapshotOf(conv), sent);
  });

  it("file_id of an attachment: a copy with a new id; zero drift", async () => {
    capture.reset();
    const conv = await createConv(owner, orgId, viewerId);
    const att = await attachment(conv, IMAGE);
    const r = await read(conv, { file_id: att });
    const id = UUID.exec(r.payload.content)?.[0] as string;
    expect(id).not.toBe(att);
    expect(r.payload.content).toBe(readText("pasted.png", IMAGE.length, ", 3×2", id));
    expect((await readRows(conv)).map((x) => x.id)).toEqual([id]);
    await expectZeroDrift(conv, await snapshotOf(conv), chatRequests());
  });

  it("file_id of a GenerateImage artifact: read like an attachment", async () => {
    const conv = await createConv(owner, orgId, painterId);
    await postMessage(owner, orgId, conv, 'tool:GenerateImage:{"prompt":"a cat"}');
    await waitForTerminal(db, conv, 1, 30_000);
    const artifact = ofType(await eventsOf(db, conv), "artifact_created")[0];
    const artifactId = artifact?.payload.artifactId as string;
    expect(artifactId).toMatch(UUID);
    const r = await read(conv, { file_id: artifactId }, 2);
    expect(r.payload.isError, r.payload.content).toBe(false);
    const id = UUID.exec(r.payload.content)?.[0] as string;
    expect(id).not.toBe(artifactId);
    expect(r.payload.content).toMatch(
      new RegExp(
        `^Read image ${artifact?.payload.name} \\(image/png, \\d+ bytes, 1×1; file_id ${id}\\)\\.$`,
      ),
    );
    expect(r.payload.media).toHaveLength(1);
  });

  it("past the per-conversation cap the image is not stored: no media, the result says so", async () => {
    vi.spyOn(k.app.get(AttachmentsService), "storeRead").mockResolvedValue({
      ok: false,
      reason: "cap",
    });
    const conv = await createConv(owner, orgId, viewerId);
    const att = await attachment(conv, IMAGE);
    const r = await read(conv, { file_id: att });
    expect(r.payload.isError).toBe(false);
    expect(r.payload.media).toBeUndefined();
    expect(r.payload.content).toBe(
      `Read image pasted.png (image/png, ${IMAGE.length} bytes, 3×2). This conversation reached its limit for stored images, so the image is not stored: it is not shown and will not stay in the history.`,
    );
  });
});

describe("Read: images for a model without vision", () => {
  it("the vision purpose reads it: the fallback paragraph, model.request with purpose vision through the pipeline, the static text in the next request; zero drift", async () => {
    capture.reset();
    const conv = await createConv(owner, orgId, blindId);
    const att = await attachment(conv, IMAGE);
    const r = await read(conv, { file_id: att, prompt: "media: what is it?" });
    expect(r.payload.isError, r.payload.content).toBe(false);
    const id = UUID.exec(r.payload.content)?.[0] as string;
    const [first, answer] = r.payload.content.split("\n\n");
    expect(first).toBe(readText("pasted.png", IMAGE.length, ", 3×2", id));
    expect(answer).toMatch(
      /^model-fake\/fake-eye read the image for you \(this model cannot view images\):\nMedia: .*image\/png/,
    );
    expect(r.payload.media).toHaveLength(1);
    const [vreq, ...more] = visionRequests();
    expect(more).toEqual([]);
    expect(vreq?.model).toBe("fake-eye");
    // the real pipeline gave the call its hook scope: model.request fired with purpose vision
    expect(await waitFor(() => probeLast("model.request"), 30_000)).toMatchObject({
      purpose: "vision",
      conversationId: conv,
      model: "fake-eye",
    });
    const usage = ofType(await eventsOf(db, conv), "usage").filter(
      (e) => e.payload.purpose === "vision",
    );
    expect(usage).toHaveLength(1);
    const sent = chatRequests();
    expect(lastUser(sent.at(-1)).slice(-2)).toEqual([
      { type: "text", text: `Image from Read (file_id ${id}):` },
      { type: "text", text: "[This model cannot view images.]" },
    ]);
    await expectZeroDrift(conv, await snapshotOf(conv), sent);
  });

  it("without a vision purpose the call fails with the exact text and stores nothing", async () => {
    await unmapVision();
    const conv = await createConv(owner, orgId, blindId);
    const att = await attachment(conv, IMAGE);
    const r = await read(conv, { file_id: att });
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toContain(NO_VISION_MODEL_TEXT);
    expect(r.payload.media).toBeUndefined();
    expect(await readRows(conv)).toEqual([]);
  });

  it("a step that fell back to a model without vision reads with the vision purpose", async () => {
    // the agent's vision model fails every request, so each step runs on its fallback (fake-1)
    const registry = k.app.get(ProviderRegistry);
    const original = registry.resolve.bind(registry);
    vi.spyOn(registry, "resolve").mockImplementation(async (...args) => {
      const r = await original(...args);
      if (args[1].model !== "fake-v") return r;
      return {
        ...r,
        provider: {
          ...r.provider,
          // biome-ignore lint/correctness/useYield: fails before any event
          async *stream() {
            throw new ModelError("server", "scripted outage", { retryAfterMs: 1 });
          },
        },
      };
    });
    const conv = await createConv(owner, orgId, switcherId);
    const att = await attachment(conv, IMAGE);
    const r = await read(conv, { file_id: att, prompt: "media:" });
    const calls = ofType(await eventsOf(db, conv), "model_call").filter(
      (c) => c.seq < r.seq && c.payload.step === r.payload.step,
    );
    // the vision model was tried (and logged) first; the step ran on the fallback
    expect(calls.map((c) => [c.payload.model, c.payload.fallback])).toEqual([
      ["fake-v", false],
      ["fake-v", false],
      ["fake-1", true],
    ]);
    expect(r.payload.isError, r.payload.content).toBe(false);
    expect(r.payload.content).toContain(
      "model-fake/fake-eye read the image for you (this model cannot view images):",
    );
    expect(visionRequests()).toHaveLength(1);
  });
});

describe("Read: limits and other files", () => {
  it("a 6 MiB PNG gives the too-large text and stores nothing", async () => {
    const big = png(3, 2, 6 * 1024 * 1024);
    const path = await onDevice("big.png", big);
    const conv = await createConv(owner, orgId, viewerId);
    const r = await read(conv, { file_path: path });
    expect(r.payload.isError).toBe(false);
    expect(r.payload.content).toContain(tooLargeText("big.png", big.length));
    expect(r.payload.media).toBeUndefined();
    expect(await readRows(conv)).toEqual([]);
  });

  it("a 6 MiB PNG without an image extension is sniffed from its head: the too-large text", async () => {
    const big = png(3, 2, 6 * 1024 * 1024);
    const path = await onDevice("big-image.bin", big);
    const conv = await createConv(owner, orgId, viewerId);
    const r = await read(conv, { file_path: path });
    expect(r.payload.content).toContain(tooLargeText("big-image.bin", big.length));
  });

  it("a PDF gives the PDF text", async () => {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from([0, 1, 2, 3]),
      Buffer.alloc(40),
    ]);
    const path = await onDevice("doc.pdf", pdf);
    const conv = await createConv(owner, orgId, viewerId);
    const r = await read(conv, { file_path: path });
    expect(r.payload.isError).toBe(false);
    expect(r.payload.content).toContain(pdfText(pdf.length));
    expect(r.payload.media).toBeUndefined();
  });

  it("an SVG is read as text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"/>\n';
    const path = await onDevice("icon.svg", svg);
    const conv = await createConv(owner, orgId, viewerId);
    const r = await read(conv, { file_path: path });
    expect(r.payload.content).toContain(`     1\t${svg.trim()}`);
    expect(r.payload.media).toBeUndefined();
  });

  it("a text attachment read by file_id comes back with line numbers", async () => {
    const conv = await createConv(owner, orgId, viewerId);
    const id = await attachment(conv, Buffer.from("alpha\nbeta\n"), "notes.txt");
    const r = await read(conv, { file_id: id });
    expect(r.payload.content).toBe("     1\talpha\n     2\tbeta");
    expect(r.payload.view).toEqual({ kind: "read", path: "notes.txt", fromLine: 1, toLine: 2 });
  });
});

describe("Read without a device", () => {
  it("listed with an object store; file_id works, file_path gives the no-device text", async () => {
    vi.spyOn(k.app.get(SandboxService), "cloudAvailable", "get").mockReturnValue(false);
    vi.spyOn(k.app.get(ConversationDevices), "usableNow").mockResolvedValue(false);
    const conv = await createConv(owner, orgId, viewerId);
    expect(await tool().unavailable?.({ orgId, conversationId: conv })).toBeNull();
    // without an object store either, it is not listed
    const storage = vi.spyOn(k.app.get(StorageService), "available", "get").mockReturnValue(false);
    expect(await tool().unavailable?.({ orgId, conversationId: conv })).not.toBeNull();
    storage.mockRestore();

    const att = await attachment(conv, IMAGE);
    const byId = await read(conv, { file_id: att });
    expect(byId.payload.isError, byId.payload.content).toBe(false);
    expect(byId.payload.media).toHaveLength(1);
    const byPath = await read(conv, { file_path: "/workspace/a.png" }, 2);
    expect(byPath.payload.isError).toBe(true);
    expect(byPath.payload.content).toContain(READ_NO_DEVICE_TEXT);
  });
});

describe("Read in a sub-agent", () => {
  it("the copy belongs to the sub-agent's conversation, only its request has the image; zero drift", async () => {
    capture.reset();
    const conv = await createConv(owner, orgId, viewerId);
    const att = await attachment(conv, IMAGE);
    const prompt = `tool:Read:${JSON.stringify({ file_id: att })}`;
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:Agent:${JSON.stringify({ description: "Look", prompt, subagent_type: "general-purpose" })}`,
    );
    await waitFor(
      async () => {
        const events = await eventsOf(db, conv);
        const delivery = events.find((e) => e.type === "subagent_delivery");
        if (delivery === undefined) return false;
        const busy = (await runsOf(db, conv)).some((r) => r.status !== "completed");
        return !busy && events.some((e) => e.type === "run_finished" && e.seq > delivery.seq);
      },
      30_000,
      "the root's runs to finish after the child's delivery",
    );
    const dispatched = ofType(await eventsOf(db, conv), "subagent_dispatched")[0];
    const child = dispatched?.payload.subagentId as string;
    const rows = await readRows();
    const mine = rows.filter((x) => x.conversation_id === child);
    expect(mine).toHaveLength(1);
    expect(rows.filter((x) => x.conversation_id === conv)).toEqual([]);
    const id = mine[0]?.id as string;
    const label = `Image from Read (file_id ${id}):`;
    const withImage = chatRequests().filter((r) => JSON.stringify(r.messages).includes(label));
    expect(withImage).toHaveLength(1);
    const childEvents = await eventsOf(db, child);
    const call = ofType(childEvents, "model_call").find((c) =>
      (c.payload.request.media ?? []).some((m) => m.attachmentId === id),
    ) as ModelCallEvent;
    const snap = await snapshotOf(child, call.runId as string);
    const info = await modelInfo("model-fake", "fake-v");
    for (const c of ofType(toEvents(snap) as ConversationEvent[], "model_call")) {
      const ids = snapshotMediaRefs(snap, c.seq, info);
      const attachments = k.app.get(AttachmentsService);
      const mediaInfo = await attachments.mediaInfo(orgId, child, ids);
      const media = await attachments.fetchMedia(orgId, child, [...mediaInfo.keys()]);
      const out = reconstructRequest(snap, c.seq, {
        model: info,
        mediaBudgetBytes: k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
        ...(ids.length > 0 && { mediaInfo, media }),
      });
      expect(out.drift, `child model_call seq ${c.seq}`).toEqual([]);
      if (c.seq === call.seq) expect(out.request).toEqual(withImage[0]);
    }
  });
});

describe("Read: full-run replay", () => {
  it("a run on a vision model replays from its recorded Read result and fetches the read copy", async () => {
    const conv = await createConv(owner, orgId, viewerId);
    const att = await attachment(conv, IMAGE);
    const original = await read(conv, { file_id: att });
    const id = original.payload.media?.[0]?.attachmentId as string;
    const runId = original.runId as string;
    const set = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets`,
      payload: { agentId: viewerId, name: `Read ${randomUUID().slice(0, 6)}` },
    });
    expect(set.statusCode, set.body).toBe(201);
    const setId = (set.json() as { set: EvalSetView }).set.id;
    const added = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
      payload: { conversationId: conv, runId },
    });
    expect(added.statusCode, added.body).toBe(201);
    const started = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/runs`,
      payload: { mode: "run", candidate: {}, judge: false },
    });
    expect(started.statusCode, started.body).toBe(201);
    const evalRunId = (started.json() as { run: EvalRunView }).run.id;
    const done = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/api/v1/orgs/${orgId}/eval-runs/${evalRunId}`,
        });
        const run = (res.json() as { run: EvalRunView }).run;
        return ["queued", "running"].includes(run.status) ? null : run;
      },
      30_000,
      "eval run finished",
      100,
    );
    expect(done.status).toBe("completed");
    const res = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/eval-runs/${evalRunId}/results?limit=10`,
    });
    const [result] = (res.json() as { results: EvalResultView[] }).results;
    expect(result?.status, JSON.stringify(result?.error)).toBe("done");
    expect(result?.candidate as RunReplayResult).toMatchObject({ unmatched: 0 });
    const evs = await eventsOf(db, result?.evalConversationId as string);
    const replayed = ofType(evs, "tool_result")[0];
    expect(replayed?.payload.media).toEqual(original.payload.media);
    // no new copy: the replay renders the original's read copy, fetched as bytes
    expect((await readRows()).filter((x) => x.id !== id && x.conversation_id === conv)).toEqual([]);
    const next = ofType(evs, "model_call").find((c) => c.seq > (replayed?.seq ?? 0));
    // mem-store reports no etag, so none is recorded
    expect(next?.payload.request.media).toEqual([{ attachmentId: id, outcome: "bytes" }]);
  });
});
