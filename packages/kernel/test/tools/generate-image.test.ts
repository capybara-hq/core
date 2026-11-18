import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImageGenerateRequest, ToolError } from "@capybara-hq/plugin-sdk";
import {
  FAKE_PNG_BASE64,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { ApiError } from "../../src/errors.js";
import { RecordedToolPipeline, recordedCalls } from "../../src/evals/recorded-tools.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { NO_STORAGE_REASON } from "../../src/tools/builtins/artifacts.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import {
  GENERATE_IMAGE_DENIED_TEXT,
  NO_DEVICE_LINE,
  NO_IMAGE_MODEL_REASON,
  NO_IMAGE_MODEL_TEXT,
  suffixedPath,
} from "../../src/tools/builtins/image/index.js";
import type { BuiltinCallContext, BuiltinTool } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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

/**
 * Image generation spec §5.3, §5.6, §6, §7: the builtin `GenerateImage` on a real kernel.
 * model-fake's image models answer (`refuse` / `stall` prompts script a refusal and a hang),
 * `mem-store` is the object store, `sandbox-fake` the device (real files in a temporary
 * directory; its devices run in auto mode, so the command review applies), and `hooks-probe`
 * denies `model.request` per purpose through the real hook registry. A run's model is model-fake
 * (`tool:GenerateImage:<json>` calls the tool); other cases call the builtin directly.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MEM_STORE = fixture("mem-store");
const SANDBOX_FAKE = fixture("sandbox-fake");
const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/src/index.ts", import.meta.url),
);

const IMAGE_TIMEOUT_MS = 1500;
/** The kernel cap on n (below model-fake's own maxImages of 4). */
const MAX_PER_CALL = 2;
const PNG = Buffer.from(FAKE_PNG_BASE64, "base64");
const ARTIFACT_LINE = /^- (\S+) \(artifact ([0-9a-f-]{36}), image\/png, (\d+) B\)$/;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  root = await mkdtemp(join(tmpdir(), "cap-generate-image-"));
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
              { id: "fake-image", kind: "image_generation" },
              { id: "fake-image-b", kind: "image_generation" },
            ],
          },
          "sandbox-fake": { root },
        },
        models: { imageTimeoutMs: IMAGE_TIMEOUT_MS, imageMaxPerCall: MAX_PER_CALL },
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
  const created = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Painter",
        instructions: "Draw what is asked.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "GenerateImage" }]),
      },
      visibility: "org",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  agentId = (created.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(raw, "capybara.model_purpose_mappings");
  // through the API: the write evicts the cached disabled list
  await setDisabled({ enable: ["fake-image"] });
  await map("fake-image");
  await probe({});
});

async function map(model: string): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/image`,
    payload: { target: { model: { provider: "model-fake", model }, params: {} } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function setDisabled(body: { disable?: string[]; enable?: string[] }): Promise<void> {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function probe(cfg: Record<string, unknown>): Promise<void> {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const imageUsage = (events: ConversationEvent[]) =>
  ofType(events, "usage").filter((e) => e.payload.purpose === "image");

/** The builtin as the kernel built it. */
const tool = (): BuiltinTool => {
  const t = k.app
    .get(BuiltinTools)
    .list()
    .find((x) => x.spec.name === "GenerateImage");
  if (!t) throw new Error("GenerateImage is not built");
  return t;
};

/** Calls the builtin directly in `conversationId` (no pipeline: no review, no hooks). */
function direct(
  conversationId: string,
  input: Record<string, unknown>,
  over: Partial<BuiltinCallContext> = {},
) {
  return tool().run(input, {
    orgId,
    accountId: ownerId,
    agentId,
    conversationId,
    callId: `call-${randomUUID().slice(0, 8)}`,
    signal: new AbortController().signal,
    ...over,
  });
}

const textOf = (r: Awaited<ReturnType<BuiltinTool["run"]>>): string => {
  if (!("content" in r)) throw new Error("not a result");
  const b = r.content[0];
  return b?.type === "text" ? b.text : "";
};

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

/** Records the provider's generateImage requests (made through the registry), with a hook after. */
function providerCalls(after?: () => void): ImageGenerateRequest[] {
  const registry = k.app.get(ProviderRegistry);
  const original = registry.resolve.bind(registry);
  const seen: ImageGenerateRequest[] = [];
  vi.spyOn(registry, "resolve").mockImplementation(async (...args) => {
    const r = await original(...args);
    const gen = r.provider.generateImage;
    if (!gen) return r;
    return {
      ...r,
      provider: {
        ...r.provider,
        generateImage: async (req, opts) => {
          seen.push(structuredClone(req));
          const out = await gen(req, opts);
          after?.();
          return out;
        },
      },
    };
  });
  return seen;
}

/** Wraps the kernel's object store: records puts and deletes, and can fail the `failPut`th put. */
function trackStore(failPut?: number) {
  const storage = k.app.get(StorageService);
  const original = storage.kernel.bind(storage);
  const puts: string[] = [];
  const deletes: string[] = [];
  vi.spyOn(storage, "kernel").mockImplementation((org) => {
    const s = original(org);
    return {
      ...s,
      put: async (key, body, opts) => {
        if (puts.length + 1 === failPut) {
          puts.push(key);
          throw new Error("store down");
        }
        puts.push(key);
        return s.put(key, body, opts);
      },
      delete: async (key) => {
        deletes.push(key);
        return s.delete(key);
      },
    };
  });
  return { puts, deletes };
}

type ToolResultEvent = Ev<"tool_result">;

/** Posts one `GenerateImage` call through a run and waits for its `n`th terminal event. */
async function call(conv: string, input: Record<string, unknown>, n = 1) {
  await postMessage(owner, orgId, conv, `tool:GenerateImage:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
  const r = ofType(await eventsOf(db, conv), "tool_result").at(-1) as ToolResultEvent;
  expect(r.payload.toolKey).toBe("GenerateImage");
  return r;
}

/** Files under the fake sandbox's root whose name is `name`, with their bytes. */
async function deviceFiles(name: string): Promise<Buffer[]> {
  const all = (await readdir(root, { recursive: true })) as string[];
  const hits = all.filter((p) => p.endsWith(`/${name}`));
  return Promise.all(hits.map((p) => readFile(join(root, p))));
}

/** A ready `chat` attachment of `conv` holding `bytes`. */
async function attachment(conv: string, bytes: Uint8Array, contentType = "image/png") {
  const id = randomUUID();
  const objectKey = `attachments/${id}`;
  await k.app.get(StorageService).kernel(orgId).put(objectKey, bytes, {
    contentType,
    size: bytes.byteLength,
  });
  await db
    .insertInto("attachments")
    .values({
      id,
      org_id: orgId,
      conversation_id: conv,
      account_id: ownerId,
      name: "ref.png",
      content_type: contentType,
      size: bytes.byteLength,
      object_key: objectKey,
      status: "ready",
      etag: null,
      purpose: "chat",
    })
    .execute();
  return id;
}

describe("GenerateImage availability", () => {
  it("hidden while the image purpose is unmapped", async () => {
    await truncateTables(raw, "capybara.model_purpose_mappings");
    expect(await tool().unavailable?.({ orgId })).toBe(NO_IMAGE_MODEL_REASON);
  });

  it("hidden when the mapped model is disabled in the org", async () => {
    await setDisabled({ disable: ["fake-image"] });
    expect(await tool().unavailable?.({ orgId })).toBe(NO_IMAGE_MODEL_REASON);
  });

  it("hidden without object storage", async () => {
    vi.spyOn(k.app.get(StorageService), "available", "get").mockReturnValue(false);
    expect(await tool().unavailable?.({ orgId })).toBe(NO_STORAGE_REASON);
  });

  it("listed once mapped", async () => {
    expect(await tool().unavailable?.({ orgId })).toBeNull();
    expect(tool().defaultPolicy).toBe("allow");
    expect(tool().timeoutMs?.({})).toBe(IMAGE_TIMEOUT_MS + 60_000);
  });
});

describe("GenerateImage calls", () => {
  it("generates two images: two artifact_created events with the callId, one usage event with outputImages 2, the result text", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, { prompt: "a red fox", n: 2, name: "fox" });
    expect(r.payload.isError).toBe(false);
    const events = await eventsOf(db, conv);
    const artifacts = ofType(events, "artifact_created");
    expect(artifacts).toHaveLength(2);
    for (const a of artifacts) {
      expect(a.payload).toMatchObject({
        contentType: "image/png",
        size: PNG.byteLength,
        callId: r.payload.callId,
      });
      expect(a.payload.objectKey).toBe(`artifacts/${conv}/${a.payload.artifactId}`);
      expect(a.runId).toBe(r.runId);
    }
    expect(artifacts.map((a) => a.payload.name)).toEqual(["fox-1.png", "fox-2.png"]);
    // the objects hold the generated bytes
    const store = k.app.get(StorageService).kernel(orgId);
    const got = await store.get(artifacts[0]?.payload.objectKey as string);
    expect(Buffer.from(await new Response(got?.body).arrayBuffer())).toEqual(PNG);
    const usage = imageUsage(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload).toMatchObject({
      provider: "model-fake",
      model: "fake-image",
      purpose: "image",
      callId: r.payload.callId,
      outputImages: 2,
    });
    expect(usage[0]?.runId).toBe(r.runId);
    const lines = r.payload.content.split("\n");
    expect(lines[0]).toBe(
      "Generated 2 images with model-fake/fake-image at 1024x1024 and delivered them to the user:",
    );
    for (const [i, a] of artifacts.entries()) {
      expect(lines[i + 1]).toBe(
        `- ${a.payload.name} (artifact ${a.payload.artifactId}, image/png, ${PNG.byteLength} B)`,
      );
      expect(lines[i + 1]).toMatch(ARTIFACT_LINE);
    }
    expect(lines[3]).toBe("Revised prompt: revised: a red fox");
    expect(lines).toHaveLength(4);
    // without file_path the call writes nothing into the device and is not reviewed
    expect(r.payload.review).toBeUndefined();
  });

  it("one image has no index in its name", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const text = textOf(await direct(conv, { prompt: "a moon" }));
    expect(text).toMatch(/^Generated 1 image with .* and delivered it to the user:\n- image\.png /);
  });

  it("n above the cap is a validation error", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const err = await rejection(direct(conv, { prompt: "a fox", n: 4 }));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(
      "n must be at most 2 for this model; fix the argument and retry.",
    );
    expect(ofType(await eventsOf(db, conv), "artifact_created")).toEqual([]);
  });

  it("reference images by attachment id and by an earlier artifact id reach the provider as bytes", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const first = await direct(conv, { prompt: "a cat" });
    const artifactId = ARTIFACT_LINE.exec(textOf(first).split("\n")[1] as string)?.[2];
    expect(artifactId).toBeDefined();
    const attBytes = Buffer.concat([PNG, Buffer.from([0])]);
    const att = await attachment(conv, attBytes);
    const seen = providerCalls();
    await direct(conv, { prompt: "the same cat, bluer", reference_images: [att, artifactId] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.referenceImages).toEqual([
      { mediaType: "image/png", data: attBytes.toString("base64") },
      { mediaType: "image/png", data: FAKE_PNG_BASE64 },
    ]);
  });

  it("an unknown reference id names the index", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const att = await attachment(conv, PNG);
    const seen = providerCalls();
    for (const bad of [randomUUID(), "not-an-id"]) {
      const err = await rejection(direct(conv, { prompt: "a cat", reference_images: [att, bad] }));
      expect((err as ToolError).message).toBe(
        "reference_images[1] is not an attachment or generated image of this conversation; pass an attachment id or the artifact id of an image generated earlier in it.",
      );
    }
    // another conversation's attachment is not one of this conversation's
    const other = await createConv(owner, orgId, agentId);
    const err = await rejection(direct(other, { prompt: "a cat", reference_images: [att] }));
    expect((err as ToolError).message).toBe(
      "reference_images[0] is not an attachment or generated image of this conversation; pass an attachment id or the artifact id of an image generated earlier in it.",
    );
    expect(seen).toEqual([]);
  });

  it("stores all images or none", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const store = trackStore(2);
    const err = await rejection(direct(conv, { prompt: "a fox", n: 2 }));
    expect((err as Error).message).toBe("store down");
    expect(store.puts).toHaveLength(2);
    // the first object is removed: no event references it
    expect(store.deletes).toEqual([store.puts[0]]);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "artifact_created")).toEqual([]);
    expect(imageUsage(events)).toEqual([]);
  });

  it("abort after the provider answered stores nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const ac = new AbortController();
    const seen = providerCalls(() => ac.abort(new Error("stopped")));
    const store = trackStore();
    const err = await rejection(direct(conv, { prompt: "a fox", n: 2 }, { signal: ac.signal }));
    expect((err as Error).message).toBe("stopped");
    expect(seen).toHaveLength(1);
    expect(store.puts).toEqual([]);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "artifact_created")).toEqual([]);
    expect(imageUsage(events)).toEqual([]);
  });

  it("a policy denial: hook_denied event, no provider call, no usage, the denial text", async () => {
    await probe({ denyModelPurposes: ["image"] });
    const seen = providerCalls();
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, { prompt: "a fox" });
    expect(r.payload.isError).toBe(true);
    expect(r.payload.content).toBe(GENERATE_IMAGE_DENIED_TEXT);
    expect(seen).toEqual([]);
    const events = await eventsOf(db, conv);
    const denied = ofType(events, "hook_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      mount: "model.request",
      plugin: "hooks-probe",
      callId: r.payload.callId,
    });
    expect(imageUsage(events)).toEqual([]);
    expect(ofType(events, "artifact_created")).toEqual([]);
    const audit = await db
      .selectFrom("audit_events")
      .select(["detail"])
      .where("org_id", "=", orgId)
      .where("action", "=", "hook.denied")
      .execute();
    const mine = audit.filter((a) => (a.detail as { callId?: string }).callId === r.payload.callId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.detail).toMatchObject({ purpose: "image" });
  });

  it("refusal and timeout become their tool errors", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const refused = await rejection(direct(conv, { prompt: "refuse this" }));
    expect((refused as ToolError).message).toBe(
      "The image model refused this prompt: Scripted refusal. Rephrase it or ask the user.",
    );
    const stalled = await rejection(direct(conv, { prompt: "stall forever" }));
    expect((stalled as ToolError).message).toBe(
      `Image generation failed: Model model-fake/fake-image did not finish generating images within ${IMAGE_TIMEOUT_MS} ms. Retry once, or continue without the image.`,
    );
    const failed = await rejection(direct(conv, { prompt: "fail overloaded" }));
    expect((failed as ToolError).message).toBe(
      "Image generation failed: scripted failure: overloaded. Retry once, or continue without the image.",
    );
    const events = await eventsOf(db, conv);
    expect(ofType(events, "artifact_created")).toEqual([]);
    expect(imageUsage(events)).toEqual([]);
  });

  it("a model disabled after listing fails the call with the unavailable text", async () => {
    expect(await tool().unavailable?.({ orgId })).toBeNull();
    await setDisabled({ disable: ["fake-image"] });
    const conv = await createConv(owner, orgId, agentId);
    const err = await rejection(direct(conv, { prompt: "a fox" }));
    expect((err as ToolError).message).toBe(NO_IMAGE_MODEL_TEXT);
  });

  it("an image over the artifact limit fails the call and stores nothing", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const config = k.app.get(
      (await import("../../src/infra/config/kernel-config.service.js")).KernelConfigService,
    );
    const real = config.get();
    vi.spyOn(config, "get").mockReturnValue({
      ...real,
      sandbox: { ...real.sandbox, deliverMaxBytes: PNG.byteLength - 1 },
    });
    const store = trackStore();
    const err = await rejection(direct(conv, { prompt: "a fox" }));
    expect((err as ToolError).message).toBe(
      `Image generation failed: the model returned an image of ${PNG.byteLength} bytes, over the artifact limit of ${PNG.byteLength - 1} bytes. Retry once, or continue without the image.`,
    );
    expect(store.puts).toEqual([]);
  });
});

describe("GenerateImage file_path", () => {
  it("suffixes go before the extension of the file name", () => {
    expect(suffixedPath("out/poster.png", 1)).toBe("out/poster-1.png");
    expect(suffixedPath("/a.b/poster", 2)).toBe("/a.b/poster-2");
    expect(suffixedPath("/w/.hidden", 1)).toBe("/w/.hidden-1");
  });

  it("file_path writes into the device with -1/-2 suffixes", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const name = `poster${randomUUID().slice(0, 6)}`;
    const r = await call(conv, { prompt: "a poster", n: 2, file_path: `out/${name}.png` });
    expect(r.payload.isError, r.payload.content).toBe(false);
    const line = r.payload.content.split("\n").find((l) => l.startsWith("Written to the device:"));
    expect(line).toMatch(
      new RegExp(`^Written to the device: \\S+/out/${name}-1\\.png, \\S+/out/${name}-2\\.png$`),
    );
    for (const i of [1, 2]) expect(await deviceFiles(`${name}-${i}.png`)).toEqual([PNG]);
    // inside the workspace the review allows the write
    expect(r.payload.review).toMatchObject({ decision: "allow", by: "rule" });
    // the images were delivered as well
    expect(ofType(await eventsOf(db, conv), "artifact_created")).toHaveLength(2);
  });

  it("file_path without a device still delivers and says so", async () => {
    vi.spyOn(k.app.get(ConversationDevices), "forTool").mockRejectedValue(
      new ApiError("sandbox.unavailable", "no device"),
    );
    const conv = await createConv(owner, orgId, agentId);
    const text = textOf(await direct(conv, { prompt: "a fox", file_path: "out/fox.png" }));
    expect(text.split("\n").at(-1)).toBe(NO_DEVICE_LINE);
    expect(ofType(await eventsOf(db, conv), "artifact_created")).toHaveLength(1);
  });

  it("file_path outside the workspace in auto mode goes through the command review", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const dir = `/etc/capybara-img-${randomUUID().slice(0, 6)}`;
    const seen = providerCalls();
    await postMessage(
      owner,
      orgId,
      conv,
      `tool:GenerateImage:${JSON.stringify({ prompt: "a fox", file_path: `${dir}/fox.png` })}`,
    );
    const ask = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select(["id", "detail", "tool_key"])
          .where("conversation_id", "=", conv)
          .where("kind", "=", "command")
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "the command ask",
    );
    // a write ask is recorded under Write, whatever tool writes (as for Edit)
    expect(ask.tool_key).toBe("Write");
    expect(ask.detail as Record<string, unknown>).toMatchObject({
      kind: "write",
      command: "GenerateImage",
      path: `${dir}/fox.png`,
      rule: "ask.outside-write",
      mode: "auto",
    });
    // the call waits: no image was generated yet
    expect(seen).toEqual([]);
    expect((await eventsOf(db, conv)).some((e) => e.type === "tool_call_started")).toBe(false);
    const decided = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${ask.id}/decision`,
      payload: { decision: "approve", scope: "once" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const r = ofType(await eventsOf(db, conv), "tool_result").at(-1) as ToolResultEvent;
    expect(r.payload.isError, r.payload.content).toBe(false);
    expect(r.payload.content.split("\n").at(-1)).toBe(`Written to the device: ${dir}/fox.png`);
    expect(r.payload.review).toMatchObject({
      decision: "allow",
      by: "person",
      rule: "ask.outside-write",
    });
    expect(seen).toHaveLength(1);
  });
});

describe("GenerateImage replay", () => {
  it("a recorded GenerateImage call replays from its result without a provider call", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const r = await call(conv, { prompt: "a recorded fox" });
    const events = await eventsOf(db, conv);
    const runId = r.runId as string;
    const snapshot = { runId, events } as unknown as CaseSnapshot;
    const recordings = recordedCalls(snapshot);
    expect(recordings.map((x) => x.toolKey)).toEqual(["GenerateImage"]);

    const seen = providerCalls();
    const assistant = ofType(events, "assistant_message").find((e) =>
      e.payload.content.some((b) => b.type === "tool_call"),
    ) as Ev<"assistant_message">;
    const appended: AppendEvent[] = [];
    const eventLog = {
      findByIdem: async (_conv: string, key: string) =>
        key === assistantIdemKey("replay-run", assistant.payload.step)
          ? { ...assistant, runId: "replay-run" }
          : null,
      latestOfType: async () => null,
      append: async (_conv: string, list: AppendEvent[]) => {
        appended.push(...list);
        return [];
      },
    };
    const pipeline = new RecordedToolPipeline({
      // biome-ignore lint/suspicious/noExplicitAny: findByIdem / latestOfType / append only
      eventLog: eventLog as any,
      recordings,
      beforeStep: async () => "continue",
    });
    await pipeline.runStep({
      conversationId: "replay-conv",
      runId: "replay-run",
      step: assistant.payload.step,
    } as never);
    expect(pipeline.unmatched()).toBe(0);
    const result = appended.find((e) => e.type === "tool_result");
    expect(result?.payload).toMatchObject({
      toolKey: "GenerateImage",
      content: r.payload.content,
      isError: false,
    });
    // no image model call, nothing stored, no usage
    expect(seen).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual(["tool_call_started", "tool_result"]);
  });
});
