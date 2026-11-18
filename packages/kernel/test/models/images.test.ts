import {
  type HookPayloads,
  type ImageRequestHookPayload,
  type ImageResponseHookPayload,
  ModelError,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { HookOutcome } from "../../src/extensions/hooks.js";
import {
  ImageCallDenied,
  type ImageCallInput,
  type ImageHookIdentity,
  ModelImages,
} from "../../src/models/images.js";
import type { HookRunner } from "../../src/runtime/hook-calls.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * `ModelImages` (image generation spec §5.1, §5.2, §5.6, §6): prepares a call for the org's `image`
 * purpose (size, count, references, prompt, params) and runs it (hooks, timeout, result check),
 * against model-fake's scripted image models.
 */

const IMAGE_TIMEOUT_MS = 1500;
/** Below model-fake's default maxImages (4), so the kernel cap is the binding one there. */
const MAX_PER_CALL = 3;
const target = (model: string) => ({ model: { provider: "model-fake", model }, params: {} });
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let orgId: string;
let images: ModelImages;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [MODEL_FAKE],
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1" },
              { id: "fake-image", kind: "image_generation" },
              { id: "fake-image-2", kind: "image_generation", maxImages: 2 },
              { id: "fake-image-noref", kind: "image_generation", maxReferenceImages: 0 },
            ],
          },
        },
        models: { imageTimeoutMs: IMAGE_TIMEOUT_MS, imageMaxPerCall: MAX_PER_CALL },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  images = k.app.get(ModelImages);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(raw, "capybara.model_purpose_mappings");
  await enableExtensions(raw, orgId, "model-fake");
  await map("fake-image");
});

async function map(model: string): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/image`,
    payload: { target: target(model) },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

async function invalid(input: ImageCallInput): Promise<string> {
  const err = await rejection(images.prepare(orgId, "image", input));
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("validation_failed");
  return (err as ApiError).message;
}

/** A hook runner that records every payload and answers `model.request` with `verdict`. */
function fakeHooks(verdict: HookOutcome = { allowed: true }) {
  const seen: { mount: string; payload: unknown }[] = [];
  const runner = {
    has: () => true,
    run: async (mount: keyof HookPayloads, payload: unknown) => {
      seen.push({ mount, payload: structuredClone(payload) });
      return mount === "model.request" ? verdict : { allowed: true };
    },
  } as unknown as HookRunner;
  const of = <T>(mount: string) => seen.filter((s) => s.mount === mount).map((s) => s.payload as T);
  return { runner, seen, of };
}

/** Counts the provider's generateImage calls made through the registry. */
function countProviderCalls(): () => number {
  const registry = k.app.get(ProviderRegistry);
  const original = registry.resolve.bind(registry);
  let calls = 0;
  vi.spyOn(registry, "resolve").mockImplementation(async (...args) => {
    const r = await original(...args);
    const gen = r.provider.generateImage;
    if (!gen) return r;
    return {
      ...r,
      provider: {
        ...r.provider,
        generateImage: (req, opts) => {
          calls++;
          return gen(req, opts);
        },
      },
    };
  });
  return () => calls;
}

const EXT: ImageHookIdentity = { kind: "extension", extension: "img-user", imagePurpose: "image" };

async function generate(prompt: string, who: ImageHookIdentity = EXT, hooks?: HookRunner) {
  const prepared = await images.prepare(orgId, "image", { prompt });
  return images.run(orgId, prepared, who, new AbortController().signal, hooks);
}

describe("ModelImages.prepare", () => {
  it("prepares the default size and n=1", async () => {
    const p = await images.prepare(orgId, "image", { prompt: "a cat" });
    expect(p.ref).toEqual({ provider: "model-fake", model: "fake-image" });
    expect(p.info.defaultSize).toEqual({ width: 1024, height: 1024 });
    expect(p.request).toEqual({
      model: "fake-image",
      prompt: "a cat",
      size: { width: 1024, height: 1024 },
      n: 1,
      params: {},
    });
  });

  it("picks the size from aspect_ratio", async () => {
    const wide = await images.prepare(orgId, "image", { prompt: "a", aspectRatio: "16:9" });
    expect(wide.request.size).toEqual({ width: 1536, height: 1024 });
    const tall = await images.prepare(orgId, "image", { prompt: "a", aspectRatio: "2:3" });
    expect(tall.request.size).toEqual({ width: 1024, height: 1536 });
    expect(await invalid({ prompt: "a", size: { width: 10, height: 10 } })).toContain(
      "Size 10x10 is not offered by this model",
    );
  });

  it("counts prompt length in code points", async () => {
    const ok = await images.prepare(orgId, "image", { prompt: "图".repeat(4000) });
    expect(ok.request.prompt).toHaveLength(4000);
    expect(await invalid({ prompt: "图".repeat(4001) })).toBe(
      "prompt has 4001 characters; the limit is 4000",
    );
    expect(await invalid({ prompt: "  " })).toBe("prompt must not be empty");
  });

  it("refuses n above min(imageMaxPerCall, maxImages)", async () => {
    expect((await images.prepare(orgId, "image", { prompt: "a", n: 3 })).request.n).toBe(3);
    expect(await invalid({ prompt: "a", n: 4 })).toBe("n must be at most 3 for this model");
    await map("fake-image-2");
    expect(await invalid({ prompt: "a", n: 3 })).toBe("n must be at most 2 for this model");
  });

  it("refuses references to a model with maxReferenceImages 0", async () => {
    const ref = { mediaType: "image/png" as const, data: PNG_1X1 };
    const p = await images.prepare(orgId, "image", { prompt: "a", referenceImages: [ref, ref] });
    expect(p.request.referenceImages).toEqual([ref, ref]);
    expect(await invalid({ prompt: "a", referenceImages: [ref, ref, ref] })).toBe(
      "this model takes at most 2 reference images",
    );
    expect(
      await invalid({
        prompt: "a",
        referenceImages: [{ mediaType: "image/bmp" as never, data: PNG_1X1 }],
      }),
    ).toBe("reference image 0 must be PNG, JPEG, GIF or WebP up to 5 MB");
    await map("fake-image-noref");
    expect(await invalid({ prompt: "a", referenceImages: [ref] })).toBe(
      "this model takes no reference images",
    );
  });

  it("an unmapped purpose is model.unconfigured", async () => {
    await truncateTables(raw, "capybara.model_purpose_mappings");
    const err = await rejection(images.prepare(orgId, "image", { prompt: "a" }));
    expect((err as ApiError).code).toBe("model.unconfigured");
  });
});

describe("ModelImages.run", () => {
  it("returns the provider's images with latency", async () => {
    const out = await generate("a cat");
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.mediaType).toBe("image/png");
    expect(out.revisedPrompt).toBe("revised: a cat");
    expect(out.usage.outputImages).toBe(1);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("fires model.request with placeholders and no bytes", async () => {
    const hooks = fakeHooks();
    const ref = { mediaType: "image/png" as const, data: PNG_1X1 };
    const prepared = await images.prepare(orgId, "image", {
      prompt: "a cat",
      n: 2,
      referenceImages: [ref],
    });
    const who: ImageHookIdentity = {
      kind: "conversation",
      scope: {
        orgId,
        accountId: "acc-1",
        agentId: "agent-1",
        agentVersion: 3,
        conversationId: "conv-1",
        runId: "run-1",
      },
      step: 2,
      callId: "call-1",
    };
    await images.run(orgId, prepared, who, new AbortController().signal, hooks.runner);
    const requests = hooks.of<ImageRequestHookPayload>("model.request");
    expect(requests).toEqual([
      {
        purpose: "image",
        orgId,
        provider: "model-fake",
        model: "fake-image",
        prompt: "a cat",
        size: { width: 1024, height: 1024 },
        n: 2,
        referenceImages: [
          { type: "media_omitted", kind: "image", mediaType: "image/png", size: 70 },
        ],
        accountId: "acc-1",
        agentId: "agent-1",
        agentVersion: 3,
        conversationId: "conv-1",
        runId: "run-1",
        step: 2,
        callId: "call-1",
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain(PNG_1X1);
  });

  it("an extension call's hook payloads carry extension and imagePurpose", async () => {
    const hooks = fakeHooks();
    await generate("a cat", EXT, hooks.runner);
    const [req] = hooks.of<ImageRequestHookPayload>("model.request");
    expect(req).toMatchObject({ extension: "img-user", imagePurpose: "image" });
    expect(req).not.toHaveProperty("conversationId");
  });

  it("a policy denial throws ImageCallDenied and calls no provider", async () => {
    const calls = countProviderCalls();
    const verdict: HookOutcome = {
      allowed: false,
      plugin: "dlp",
      reason: "nope",
      cause: "deny",
    };
    const hooks = fakeHooks(verdict);
    const err = await rejection(generate("a cat", EXT, hooks.runner));
    expect(err).toBeInstanceOf(ImageCallDenied);
    expect((err as ImageCallDenied).verdict).toEqual(verdict);
    expect(calls()).toBe(0);
    expect(hooks.of("model.response")).toEqual([]);
  });

  it("fires model.response with image sizes and no bytes", async () => {
    const hooks = fakeHooks();
    const prepared = await images.prepare(orgId, "image", { prompt: "a cat", n: 2 });
    const out = await images.run(orgId, prepared, EXT, new AbortController().signal, hooks.runner);
    await vi.waitFor(() => expect(hooks.of("model.response")).toHaveLength(1));
    const [res] = hooks.of<ImageResponseHookPayload>("model.response");
    const bytes = Buffer.from(out.images[0]?.data ?? "", "base64").length;
    expect(res).toEqual({
      purpose: "image",
      orgId,
      provider: "model-fake",
      model: "fake-image",
      extension: "img-user",
      imagePurpose: "image",
      outcome: "ok",
      images: [
        { mediaType: "image/png", size: bytes },
        { mediaType: "image/png", size: bytes },
      ],
      revisedPrompt: "revised: a cat",
      usage: out.usage,
      latencyMs: out.latencyMs,
    });
    expect(JSON.stringify(res)).not.toContain(out.images[0]?.data);
  });

  it("rejects an invalid provider result and stores nothing", async () => {
    for (const prompt of ["short", "url"]) {
      const hooks = fakeHooks();
      const err = await rejection(generate(prompt, EXT, hooks.runner));
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("server");
      expect((err as ModelError).message).toContain("model-fake/fake-image");
      await vi.waitFor(() => expect(hooks.of("model.response")).toHaveLength(1));
      expect(hooks.of<ImageResponseHookPayload>("model.response")[0]).toMatchObject({
        outcome: "failed",
        images: [],
        usage: null,
        errorCode: "model.server",
      });
    }
  });

  it("a refusal surfaces as ModelError refusal", async () => {
    const err = await rejection(generate("refuse this"));
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("refusal");
  });

  it("times out at models.imageTimeoutMs", async () => {
    const hooks = fakeHooks();
    const started = Date.now();
    const err = await rejection(generate("stall", EXT, hooks.runner));
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("timeout");
    expect((err as ModelError).message).toBe(
      `Model model-fake/fake-image did not finish generating images within ${IMAGE_TIMEOUT_MS} ms`,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(IMAGE_TIMEOUT_MS - 50);
    await vi.waitFor(() => expect(hooks.of("model.response")).toHaveLength(1));
    expect(hooks.of<ImageResponseHookPayload>("model.response")[0]).toMatchObject({
      outcome: "failed",
      errorCode: "model.timeout",
    });
  });

  it("a caller abort rejects with its reason and fires no model.response", async () => {
    const hooks = fakeHooks();
    const prepared = await images.prepare(orgId, "image", { prompt: "stall" });
    const ac = new AbortController();
    const p = images.run(orgId, prepared, EXT, ac.signal, hooks.runner);
    await vi.waitFor(() => expect(hooks.of("model.request")).toHaveLength(1));
    const reason = new Error("stopped");
    ac.abort(reason);
    expect(await rejection(p)).toBe(reason);
    expect(hooks.of("model.response")).toEqual([]);
  });
});
