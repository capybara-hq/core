import { fileURLToPath } from "node:url";
import { type ModelRequest, ToolError, type UsageReportPayload } from "@capybara-hq/plugin-sdk";
import {
  FAKE_PNG_BASE64,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import { StepLog } from "../../src/runtime/step-log.js";
import {
  NO_VISION_MODEL_TEXT,
  readImageWithVisionModel,
  VISION_DEFAULT_PROMPT,
  VISION_DENIED_TEXT,
  VISION_READ_FAILED_TEXT,
  VISION_SYSTEM_PROMPT,
  type VisionReadDeps,
} from "../../src/tools/builtins/vision/read-image.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
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
 * Vision read spec §2.3: one call on the `vision` purpose with the image bytes, on a real kernel.
 * model-fake declares `fake-vision` (vision) and `fake-1` (no vision) and answers from the prompt
 * text (`media:` echoes the media it received, `stall` waits for the abort, `fail:<kind>` fails);
 * `hooks-probe` observes and denies.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);
const VISION = { provider: "model-fake", model: "fake-vision" };
const BLIND = { provider: "model-fake", model: "fake-1" };
const PNG = Uint8Array.from(Buffer.from(FAKE_PNG_BASE64, "base64"));

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let deps: VisionReadDeps;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, HOOKS_PROBE],
        extensionConfig: {
          "model-fake": { models: [{ id: "fake-1" }, { id: "fake-vision", vision: true }] },
        },
        // the smallest timeout the config allows: the stall test waits for it
        models: { visionTimeoutMs: 5000 },
      },
    ),
  );
  const log = { warn: () => {} };
  deps = {
    purposes: k.app.get(ModelPurposesService),
    eventLog: k.app.get(EventLog),
    stepLog: k.app.get(StepLog),
    config: k.app.get(KernelConfigService),
    log,
    hooks: k.app.get(ExtensionHost).hooks,
  };
});

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.audit_events, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts, capybara.model_purpose_mappings",
  );
  capture.reset();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(res.statusCode, res.body).toBe(200);
  const agent = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: { name: "Looker", instructions: "Look.", model: BLIND },
      visibility: "org",
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  agentId = (agent.json() as { agent: { id: string } }).agent.id;
});

const mapVision = (ref: { provider: string; model: string }) =>
  db
    .insertInto("model_purpose_mappings")
    .values({
      org_id: null,
      purpose: "vision",
      provider: ref.provider,
      model: ref.model,
      params: "{}",
    })
    .execute();

const probeConfig = async (cfg: Record<string, unknown>) => {
  const res = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(res.statusCode, res.body).toBe(200);
};

async function probeLast(mount: string): Promise<Record<string, unknown> | null> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=vision`,
  });
  const last = (res.json() as { last: Record<string, Record<string, unknown>> }).last;
  return last[mount] ?? null;
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const visionUsage = (events: ConversationEvent[]) =>
  ofType(events, "usage").filter((e) => e.payload.purpose === "vision");
const visionRequests = () =>
  capture.sent.filter((r) => r.system.some((s) => s.text === VISION_SYSTEM_PROMPT));

/** A conversation with one finished run: the tool call's context in that run. */
async function callContext(callId = "vision-call"): Promise<BuiltinCallContext> {
  const conversationId = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conversationId, "echo:hello");
  await waitForTerminal(db, conversationId, 1, 60_000);
  const runId = ofType(await eventsOf(db, conversationId), "run_started")[0]?.runId as string;
  return {
    orgId,
    accountId: ownerId,
    agentId,
    conversationId,
    conversationKind: "chat",
    callId,
    runId,
    step: 1,
    signal: new AbortController().signal,
  };
}

const read = (ctx: BuiltinCallContext, prompt?: string) =>
  readImageWithVisionModel(deps, ctx, {
    name: "cat.png",
    mediaType: "image/png",
    data: PNG,
    ...(prompt !== undefined && { prompt }),
    signal: ctx.signal,
  });

describe("vision read", () => {
  it("the vision model answers; the request holds the fixed system prompt and one image", async () => {
    await mapVision(VISION);
    const ctx = await callContext();
    const out = await read(ctx, "media: what is it?");
    expect(out.provider).toBe("model-fake");
    expect(out.model).toBe("fake-vision");
    expect(out.text).toMatch(/^Media: /);
    expect(out.text).toContain("image/png");

    const [req, ...more] = visionRequests();
    expect(more).toEqual([]);
    expect(req?.model).toBe("fake-vision");
    expect(req?.system).toEqual([{ text: VISION_SYSTEM_PROMPT, cache: false }]);
    expect(req?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "media: what is it?" },
          {
            type: "image",
            mediaType: "image/png",
            source: { kind: "base64", data: FAKE_PNG_BASE64 },
            name: "cat.png",
          },
        ],
      },
    ]);
    expect((req as ModelRequest).tools).toEqual([]);
    expect((req as ModelRequest).toolChoice).toBe("none");
    const cap = k.app.get(KernelConfigService).get().models.visionMaxOutputTokens;
    expect((req as ModelRequest).maxOutputTokens).toBeLessThanOrEqual(cap);

    // usage: purpose vision, the call id, the run, idempotent per call
    const events = await eventsOf(db, ctx.conversationId);
    const [usage, ...moreUsage] = visionUsage(events);
    expect(moreUsage).toEqual([]);
    expect(usage?.runId).toBe(ctx.runId);
    expect(usage?.payload).toMatchObject({
      purpose: "vision",
      callId: "vision-call",
      step: 1,
      provider: "model-fake",
      model: "fake-vision",
    });
    const row = await db
      .selectFrom("conversation_events")
      .select("idem_key")
      .where("conversation_id", "=", ctx.conversationId)
      .where("seq", "=", String(usage?.seq))
      .executeTakeFirstOrThrow();
    expect(row.idem_key).toBe(`usage_vision:${ctx.runId}:vision-call`);

    // hooks: model.request / model.response with purpose vision; usage.report delivered
    expect(await waitFor(() => probeLast("model.request"), 30_000)).toMatchObject({
      purpose: "vision",
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      provider: "model-fake",
      model: "fake-vision",
    });
    expect(await waitFor(() => probeLast("model.response"), 30_000)).toMatchObject({
      purpose: "vision",
      outcome: "ok",
    });
    const eventId = `${ctx.conversationId}/${usage?.seq}`;
    const delivered = await waitFor(
      async () => {
        const res = await owner({
          method: "GET",
          url: `/plugins/hooks-probe/usage?eventIds=${eventId}`,
        });
        return (
          (res.json() as Record<string, { last: UsageReportPayload | null }>)[eventId]?.last ?? null
        );
      },
      30_000,
      "usage.report delivery",
    );
    expect(delivered).toMatchObject({ purpose: "vision", conversationId: ctx.conversationId });
  });

  it("no prompt: the default prompt", async () => {
    await mapVision(VISION);
    const out = await read(await callContext());
    expect(out.text).toBe(`You said: ${VISION_DEFAULT_PROMPT}`);
    const content = visionRequests()[0]?.messages[0]?.content;
    expect(Array.isArray(content) && content[0]).toEqual({
      type: "text",
      text: VISION_DEFAULT_PROMPT,
    });
  });

  it("unmapped: the no-vision-model error, no call", async () => {
    const err = await read(await callContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(NO_VISION_MODEL_TEXT);
    expect(NO_VISION_MODEL_TEXT).toBe(
      "This model cannot view images and the organization has no vision model; an org admin can set one under Models → Purposes → Vision.",
    );
    expect(visionRequests()).toEqual([]);
  });

  it("mapped to a model that cannot view images: the no-vision-model error, no call", async () => {
    await mapVision(BLIND);
    const err = await read(await callContext()).catch((e: unknown) => e);
    expect((err as ToolError).message).toBe(NO_VISION_MODEL_TEXT);
    expect(visionRequests()).toEqual([]);
  });

  it("a model.request policy denial: the policy error, hook_denied and audit, no call", async () => {
    await mapVision(VISION);
    await probeConfig({ denyModelPurposes: ["vision"] });
    const ctx = await callContext();
    const err = await read(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(VISION_DENIED_TEXT);
    expect(visionRequests()).toEqual([]);
    const events = await eventsOf(db, ctx.conversationId);
    expect(visionUsage(events)).toEqual([]);
    const denied = ofType(events, "hook_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      mount: "model.request",
      plugin: "hooks-probe",
      cause: "deny",
      callId: "vision-call",
    });
    const rows = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "hook.denied")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(ctx.conversationId);
    expect(rows[0]?.detail).toMatchObject({ purpose: "vision", mount: "model.request" });
  });

  it("a failure after send: the failure error; the estimated usage is logged", async () => {
    await mapVision(VISION);
    const ctx = await callContext();
    const err = await read(ctx, "fail:server").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toBe(VISION_READ_FAILED_TEXT);
    const usage = visionUsage(await eventsOf(db, ctx.conversationId));
    expect(usage.map((e) => e.payload)).toEqual([
      expect.objectContaining({ purpose: "vision", outputTokens: 0, model: "fake-vision" }),
    ]);
    expect((usage[0]?.payload.inputTokens ?? 0) > 0).toBe(true);
    expect(await waitFor(() => probeLast("model.response"), 30_000)).toMatchObject({
      outcome: "failed",
      errorCode: "model.server",
    });
  });

  it("a stalled call is aborted at models.visionTimeoutMs", async () => {
    await mapVision(VISION);
    const ctx = await callContext();
    // the caller's signal stays open: only the vision timeout can end the stall
    const err = await read(ctx, "stall").catch((e: unknown) => e);
    expect(ctx.signal.aborted).toBe(false);
    expect((err as ToolError).message).toBe(VISION_READ_FAILED_TEXT);
    expect(visionRequests()).toHaveLength(1);
    expect(visionUsage(await eventsOf(db, ctx.conversationId))).toHaveLength(1);
  });
});
