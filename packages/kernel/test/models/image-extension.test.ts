import { fileURLToPath } from "node:url";
import type { ExtensionContext, UsageReportPayload } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { ModelImages } from "../../src/models/images.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { modelUsageJobId, USAGE_REPORT_QUEUE } from "../../src/runtime/usage-report.js";
import { imageConsumer } from "../fixtures/plugins/image-consumer/index.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createOrgWithProviders,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * `ctx.models.generateImage` (image generation spec §5.5, §5.6, §8, §9): only a purpose the
 * extension declared with `kind: "image_generation"`, for an org that enabled it; policy hooks
 * through the host's real hook registry (hooks-probe); one `model_usage` row per call with
 * `kind = 'image_generation'` and `output_images`, its `usage.report` delivery owed in the same
 * transaction and reported with purpose `image`.
 */

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const ART = "image-consumer.art";
const MEMORY = "image-consumer.memory";
const FAKE_IMAGE = { model: { provider: "model-fake", model: "fake-image" }, params: {} };
const PROMPT = "a capybara in a hot spring";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let orgId: string;
/** While true, the outbox fast path's adds to the usage report queue fail (the row stays owed). */
let failUsage = false;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fx("image-consumer"), fx("hooks-probe")],
        extensionConfig: {
          "model-fake": {
            models: [{ id: "fake-1" }, { id: "fake-image", kind: "image_generation" }],
          },
        },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failUsage && queue === USAGE_REPORT_QUEUE,
        },
      ],
    },
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  failUsage = false;
  await truncateTables(
    raw,
    "capybara.model_usage, capybara.model_purpose_mappings, capybara.extension_org_configs",
  );
  await db.deleteFrom("audit_events").where("action", "=", "hook.denied").execute();
  await enableExtensions(raw, orgId, "image-consumer", "hooks-probe", "model-fake");
  await probeConfig({});
});

const ctx = (): ExtensionContext => {
  const c = imageConsumer().ctx;
  if (!c) throw new Error("image-consumer is not set up");
  return c;
};

async function map(purpose: string, target: unknown): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/${encodeURIComponent(purpose)}`,
    payload: { target },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function probeConfig(cfg: Record<string, unknown>): Promise<void> {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** hooks-probe's `model.request` calls in the org and the last image one's payload. */
async function probeRequests(): Promise<{ count: number; last: unknown }> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=image`,
  });
  const body = res.json() as { counts: Record<string, number>; last: Record<string, unknown> };
  return { count: body.counts["model.request"] ?? 0, last: body.last["model.request"] };
}

async function probeUsage(id: string): Promise<{ calls: number; last: UsageReportPayload | null }> {
  const res = await owner({ method: "GET", url: `/plugins/hooks-probe/usage?eventIds=${id}` });
  return (res.json() as Record<string, { calls: number; last: UsageReportPayload | null }>)[id] as {
    calls: number;
    last: UsageReportPayload | null;
  };
}

const usageRows = () => db.selectFrom("model_usage").selectAll().execute();

/** Makes model-fake's image answers carry `usage` instead of their own (through the registry). */
function providerUsage(usage: unknown): void {
  const registry = k.app.get(ProviderRegistry);
  const original = registry.resolve.bind(registry);
  vi.spyOn(registry, "resolve").mockImplementation(async (...args) => {
    const r = await original(...args);
    const gen = r.provider.generateImage;
    if (!gen) return r;
    return {
      ...r,
      provider: {
        ...r.provider,
        generateImage: async (req, opts) => ({ ...(await gen(req, opts)), usage }) as never,
      },
    };
  });
}

const deniedRows = () =>
  db
    .selectFrom("audit_events")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("action", "=", "hook.denied")
    .execute();

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("ctx.models.generateImage: admission", () => {
  it("refuses an undeclared purpose", async () => {
    await map(ART, FAKE_IMAGE);
    const before = (await probeRequests()).count;
    for (const purpose of ["image-consumer.other", "image", "embed-consumer.memory"]) {
      const e = await rejection(ctx().models.generateImage({ orgId, purpose, prompt: PROMPT }));
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("model.purpose_unknown");
      const d = await rejection(ctx().models.describe({ orgId, purpose }));
      expect((d as ApiError).code).toBe("model.purpose_unknown");
      // an undeclared purpose has no kind: the refusal names none
      expect((d as ApiError).message).toBe(
        `Extension image-consumer declared no model purpose "${purpose}" in permissions.models`,
      );
    }
    expect((await probeRequests()).count).toBe(before);
    expect(await usageRows()).toEqual([]);
  });

  it("refuses an org where the extension is off", async () => {
    await map(ART, FAKE_IMAGE);
    const before = (await probeRequests()).count;
    await raw
      .deleteFrom("capybara.extension_org_configs" as never)
      .where("plugin" as never, "=", "image-consumer" as never)
      .execute();
    const e = await rejection(ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT }));
    expect((e as ApiError).code).toBe("extension.not_enabled");
    const d = await rejection(ctx().models.describe({ orgId, purpose: ART }));
    expect((d as ApiError).code).toBe("extension.not_enabled");
    expect((await probeRequests()).count).toBe(before);
    expect(await usageRows()).toEqual([]);
  });

  it("refuses a declared embedding purpose", async () => {
    const e = await rejection(
      ctx().models.generateImage({ orgId, purpose: MEMORY, prompt: PROMPT }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("model.purpose_unknown");
    // and the broker itself refuses an image purpose declared with another kind
    const broker = k.app.get(ModelImages);
    const b = await rejection(
      broker.generateForExtension(
        "image-consumer",
        [{ purpose: ART, kind: "chat", label: { zh: "x", en: "x" } }],
        { orgId, purpose: ART, prompt: PROMPT },
        new AbortController().signal,
        undefined,
      ),
    );
    expect((b as ApiError).code).toBe("model.purpose_unknown");
    expect(await usageRows()).toEqual([]);
  });

  it("an unmapped purpose is unconfigured", async () => {
    const e = await rejection(ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT }));
    expect((e as ApiError).code).toBe("model.unconfigured");
    expect(await usageRows()).toEqual([]);
  });
});

describe("ctx.models.generateImage: calls and usage", () => {
  it("returns images and writes one model_usage row with kind and output_images, delivery owed", async () => {
    await map(ART, FAKE_IMAGE);
    failUsage = true;
    const out = await ctx().models.generateImage({
      orgId,
      purpose: ART,
      prompt: PROMPT,
      aspectRatio: "1:1",
      n: 2,
    });
    expect(out.images).toHaveLength(2);
    expect(out.images.every((i) => i.mediaType === "image/png" && i.data.length > 0)).toBe(true);
    expect(out.model).toEqual({ provider: "model-fake", id: "fake-image" });
    expect(out.size).toEqual({ width: 1024, height: 1024 });
    expect(out.revisedPrompt).toBe(`revised: ${PROMPT}`);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      org_id: orgId,
      extension: "image-consumer",
      purpose: ART,
      kind: "image_generation",
      provider: "model-fake",
      model: "fake-image",
      input_tokens: Math.ceil(PROMPT.length / 4),
      output_images: 2,
      reported_at: null,
    });
    // the delivery was owed in the row's transaction: the outbox row is there (the fast path failed)
    const jobId = modelUsageJobId(row?.id as string);
    const owed = await db
      .selectFrom("outbox")
      .select(["queue", "job_name", "job_id", "data", "org_id"])
      .where("job_id", "=", jobId)
      .execute();
    expect(owed).toEqual([
      {
        queue: USAGE_REPORT_QUEUE,
        job_name: "usage-report",
        job_id: jobId,
        data: { usageId: row?.id },
        org_id: orgId,
      },
    ]);
    failUsage = false;
    await db
      .updateTable("outbox")
      .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
      .where("job_id", "=", jobId)
      .execute();
    await drainOutbox(k.app, { jobId });
    await waitFor(
      async () => (await probeUsage(row?.id as string)).calls === 1,
      15_000,
      "delivery",
    );
  });

  it("usage.report delivers purpose image with outputImages", async () => {
    await map(ART, FAKE_IMAGE);
    await ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT, n: 3 });
    const row = await db.selectFrom("model_usage").selectAll().executeTakeFirstOrThrow();
    const got = await waitFor(
      async () => {
        const d = await probeUsage(row.id);
        return d.calls === 1 && d.last != null ? d.last : null;
      },
      15_000,
      "usage delivered",
    );
    expect(got).toEqual({
      eventId: row.id,
      purpose: "image",
      orgId,
      extension: "image-consumer",
      provider: "model-fake",
      model: "fake-image",
      usage: {
        inputTokens: Math.ceil(PROMPT.length / 4),
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputImages: 3,
      },
      occurredAt: new Date(row.occurred_at).toISOString(),
    });
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("model_usage")
            .select("reported_at")
            .where("id", "=", row.id)
            .executeTakeFirstOrThrow()
        ).reported_at !== null,
      10_000,
      "reported_at",
    );
  });

  it("a policy denial writes hook.denied, rejects model.hook_denied, records no usage", async () => {
    await map(ART, FAKE_IMAGE);
    await probeConfig({ denyModelPurposes: ["image"] });
    const before = (await probeRequests()).count;
    const err = (await rejection(
      ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT }),
    )) as { code?: string; message?: string };
    expect(err.code).toBe("model.hook_denied");
    expect(err.message).toBe('Model request blocked by the "hooks-probe" policy hook: nope');
    expect(await usageRows()).toEqual([]);
    // the real registry ran hooks-probe's policy hook with the extension's identity
    const req = await probeRequests();
    expect(req.count).toBe(before + 1);
    expect(req.last).toMatchObject({
      purpose: "image",
      orgId,
      extension: "image-consumer",
      imagePurpose: ART,
      provider: "model-fake",
      model: "fake-image",
      prompt: PROMPT,
      n: 1,
      referenceImages: [],
    });
    expect(req.last).not.toHaveProperty("conversationId");
    const audit = await deniedRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_account_id).toBeNull();
    expect(audit[0]?.target).toBe("image-consumer");
    expect(audit[0]?.detail).toEqual({
      mount: "model.request",
      plugin: "hooks-probe",
      reason: "nope",
      cause: "deny",
      purpose: "image",
      extension: "image-consumer",
      imagePurpose: ART,
      provider: "model-fake",
      model: "fake-image",
    });
  });

  it("records the answer's output and cache tokens on the row and reports them", async () => {
    await map(ART, FAKE_IMAGE);
    providerUsage({
      inputTokens: 11,
      outputTokens: 30,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputImages: 1,
    });
    await ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT, n: 2 });
    const row = await db.selectFrom("model_usage").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      input_tokens: 11,
      output_tokens: 30,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      // fewer billed images than delivered: the answer's own count
      output_images: 1,
    });
    const got = await waitFor(
      async () => {
        const d = await probeUsage(row.id);
        return d.calls === 1 && d.last != null ? d.last : null;
      },
      15_000,
      "usage delivered",
    );
    expect(got.usage).toEqual({
      inputTokens: 11,
      outputTokens: 30,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputImages: 1,
    });
  });

  it("an image count above the images delivered is capped at the images delivered", async () => {
    await map(ART, FAKE_IMAGE);
    providerUsage({
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputImages: 9,
    });
    await ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT, n: 2 });
    const row = await db.selectFrom("model_usage").selectAll().executeTakeFirstOrThrow();
    expect(row.output_images).toBe(2);
  });

  it.each([
    ["no usage", undefined],
    [
      "a negative token count",
      { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    [
      "a fractional image count",
      {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputImages: 1.5,
      },
    ],
  ])("an answer with %s is a server failure and records no usage", async (_name, usage) => {
    await map(ART, FAKE_IMAGE);
    providerUsage(usage);
    const e = await rejection(ctx().models.generateImage({ orgId, purpose: ART, prompt: PROMPT }));
    expect((e as { kind?: string }).kind).toBe("server");
    expect((e as Error).message).toMatch(/returned an invalid image result: .*usage/);
    expect(await usageRows()).toEqual([]);
  });

  it("a provider failure records no usage and reaches the extension", async () => {
    await map(ART, FAKE_IMAGE);
    const e = await rejection(
      ctx().models.generateImage({ orgId, purpose: ART, prompt: "refuse this" }),
    );
    expect((e as { kind?: string }).kind).toBe("refusal");
    expect(await usageRows()).toEqual([]);
  });
});

describe("ctx.models.describe for an image purpose", () => {
  it("describe returns image facts; null when unmapped", async () => {
    expect(await ctx().models.describe({ orgId, purpose: ART })).toBeNull();
    await map(ART, FAKE_IMAGE);
    const t = await ctx().models.describe({ orgId, purpose: ART });
    expect(t).toMatchObject({
      provider: "model-fake",
      id: "fake-image",
      kind: "image_generation",
      imageGeneration: {
        defaultSize: { width: 1024, height: 1024 },
        maxImages: 4,
        maxReferenceImages: 2,
        outputMediaTypes: ["image/png"],
      },
    });
    expect(t).not.toHaveProperty("embedding");
    // the embedding purpose still describes through the embeddings broker
    expect(await ctx().models.describe({ orgId, purpose: MEMORY })).toBeNull();
  });
});
