import { fileURLToPath } from "node:url";
import { ModelError, type ModelStreamEvent } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
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
 * The compaction model on the chat paths (compaction model spec §4, §5, §7.2, §8): one app, the
 * `compaction` purpose mapped over HTTP, conversations driven through the real run worker.
 *
 * Models (model-fake; every model's output cap is 4,096): `fake-v` (100k window, no prompt cache,
 * so an unmapped compaction is a plain transcript summary) is the conversation model of the
 * trigger cases, whose threshold the org lowers to 0.5; `fake-1` (400k) carries the manual and
 * chunked cases; `fake-r` (64k) is a fallback rung; `fake-c` (200k) and `fake-small` (50k, the
 * smallest eligible window: one chunk is about 35k tokens) are the compaction models.
 *
 * `usage` events are the billing records here: the `usage.report` delivery and the admin usage
 * reads are derived from them, and their `provider` / `model` / `purpose` are what the spec's
 * §7.2 says now name C.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);

const FAKE = "model-fake";
const ref = (model: string) => ({ provider: FAKE, model });
const C = ref("fake-c");

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let ent: Req;
let ownerId: string;

/** About 4 characters per estimated token. */
const WORDS = "lorem ipsum dolor sit amet ";
const text = (tokens: number) => WORDS.repeat(Math.ceil((tokens * 4) / WORDS.length));

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, HOOKS_PROBE],
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1", contextWindow: 400_000 },
              { id: "fake-v", contextWindow: 100_000, cache: "none" },
              { id: "fake-r", contextWindow: 64_000, cache: "none" },
              { id: "fake-c", contextWindow: 200_000 },
              { id: "fake-small", contextWindow: 50_000 },
            ],
          },
        },
      },
    ),
  );
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.model_disabled, capybara.model_purpose_mappings, capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.deployment_settings",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  await accounts.createLocal({
    login: "ent",
    password: PW,
    displayName: "E",
    superAdmin: true,
  });
  owner = await session(k, "owner");
  ent = await session(k, "ent");
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);
const compactionUsage = (events: ConversationEvent[]) =>
  ofType(events, "usage").filter((u) => u.payload.purpose === "compaction");

async function mapPlatform(model: string): Promise<void> {
  const res = await ent({
    method: "PUT",
    url: "/api/v1/admin/model-purposes/compaction",
    payload: { target: { model: ref(model), params: {} } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function mapOrg(orgId: string, model: string): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/compaction`,
    payload: { target: { model: ref(model), params: {} } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function patchOrg(orgId: string, payload: Record<string, unknown>): Promise<void> {
  const res = await owner({ method: "PATCH", url: `/api/v1/orgs/${orgId}/settings`, payload });
  expect(res.statusCode, res.body).toBe(200);
}

/** The hooks-probe extension on in the org, with its per-org behaviour. */
async function probeHooks(orgId: string, cfg: Record<string, unknown> = {}): Promise<void> {
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const configured = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, ...cfg },
  });
  expect(configured.statusCode, configured.body).toBe(200);
}

/** The last `model.request` payload of `purpose` in the org (hooks-probe). */
async function lastModelRequest(
  orgId: string,
  purpose: string,
): Promise<{ provider: string; model: string; purpose: string } | undefined> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=${purpose}`,
  });
  return (res.json() as { last: Record<string, never> }).last["model.request"];
}

let orgSeq = 0;
/** An org whose compaction threshold is 0.5 and whose idle compaction is off. */
async function newOrg(): Promise<string> {
  const orgId = await createOrgWithProviders(k, owner, `Acme ${++orgSeq}`);
  await patchOrg(orgId, { compaction: { threshold: 0.5, keepRecentTurns: 1, idleEnabled: false } });
  return orgId;
}

async function newAgent(
  orgId: string,
  model: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: ref(model),
        disabledTools: onlyBuiltins([]),
        ...extra,
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/**
 * A conversation whose history holds `userTokens` of already-consumed user messages (one message
 * per entry): what a compaction plan summarizes once the next turn arrives.
 */
async function seeded(orgId: string, agentId: string, userTokens: number[]): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  const seqs = await withOrgScope(orgId, () =>
    k.app.get(EventLog).append(
      conv,
      userTokens.map((n) => ({
        type: "user_message" as const,
        payload: { content: [{ type: "text" as const, text: text(n) }], authorAccountId: ownerId },
      })),
    ),
  );
  await db
    .updateTable("conversations")
    .set({ consumed_seq: String(seqs.at(-1)?.seq) })
    .where("id", "=", conv)
    .execute();
  return conv;
}

async function turn(orgId: string, conv: string, message: string, n: number): Promise<void> {
  await postMessage(owner, orgId, conv, message);
  await waitForTerminal(db, conv, n, 60_000);
}

/** The `estimatedInputTokens` of the first request sent after the conversation's summary. */
function estimateAfterSummary(events: ConversationEvent[]): number | undefined {
  const summary = ofType(events, "compaction_summary")[0];
  return ofType(events, "model_call").find((e) => e.seq > (summary?.seq ?? 0))?.payload.request
    .estimatedInputTokens;
}

describe("the compaction model on the chat paths", () => {
  it("proactive: the summary is a transcript summary written on C, billed to C, and calibration is untouched", async () => {
    const orgId = await newOrg();
    const agentId = await newAgent(orgId, "fake-v");

    // the control: unmapped, the conversation model writes the same transcript summary
    const control = await seeded(orgId, agentId, [60_000]);
    await turn(orgId, control, "echo:ok", 1);
    const controlEvents = await eventsOf(db, control);
    const [controlSummary] = ofType(controlEvents, "compaction_summary");
    expect(controlSummary?.payload).toMatchObject({ method: "transcript", model: ref("fake-v") });

    await mapPlatform("fake-c");
    const conv = await seeded(orgId, agentId, [60_000]);
    await turn(orgId, conv, "echo:ok", 1);
    const events = await eventsOf(db, conv);
    const summaries = ofType(events, "compaction_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.payload).toMatchObject({ method: "transcript", model: C });
    expect(ofType(events, "compaction_failed")).toEqual([]);

    // billing: every compaction usage names C, with the compaction purpose; none names V
    const usage = compactionUsage(events);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.map((u) => [u.payload.provider, u.payload.model])).toEqual(
      usage.map(() => [FAKE, "fake-c"]),
    );
    // the conversation's own step is still V's, and its usage carries no purpose
    const stepUsage = ofType(events, "usage").filter((u) => u.payload.purpose === undefined);
    expect(stepUsage.map((u) => u.payload.model)).toEqual(["fake-v"]);

    // the next step's request is the control's (same transcript summary, same estimate): C's
    // token counts calibrated nothing
    expect(estimateAfterSummary(events)).toBe(estimateAfterSummary(controlEvents));
  });

  it("the org override wins over the platform default", async () => {
    const orgId = await newOrg();
    const agentId = await newAgent(orgId, "fake-v");
    await mapPlatform("fake-1");
    await mapOrg(orgId, "fake-c");
    const conv = await seeded(orgId, agentId, [60_000]);
    await turn(orgId, conv, "echo:ok", 1);
    const events = await eventsOf(db, conv);
    expect(ofType(events, "compaction_summary").map((e) => e.payload.model)).toEqual([C]);
    expect(new Set(compactionUsage(events).map((u) => u.payload.model))).toEqual(
      new Set(["fake-c"]),
    );
  });

  it("the default's model disabled in the org: the conversation model writes the summary (Q3)", async () => {
    const orgId = await newOrg();
    const agentId = await newAgent(orgId, "fake-v");
    await mapPlatform("fake-c");
    const off = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
      payload: { disable: ["fake-c"] },
    });
    expect(off.statusCode, off.body).toBe(200);
    const conv = await seeded(orgId, agentId, [60_000]);
    await turn(orgId, conv, "echo:ok", 1);
    const events = await eventsOf(db, conv);
    expect(
      ofType(events, "compaction_summary").map((e) => [e.payload.method, e.payload.model]),
    ).toEqual([["transcript", ref("fake-v")]]);
    expect(new Set(compactionUsage(events).map((u) => u.payload.model))).toEqual(
      new Set(["fake-v"]),
    );
  });

  it("a manual compact keeps the #990 plan on C", async () => {
    const orgId = await newOrg();
    const agentId = await newAgent(orgId, "fake-1");

    const run = async (): Promise<ConversationEvent[]> => {
      const conv = await createConv(owner, orgId, agentId);
      for (let i = 0; i < 3; i++) await turn(orgId, conv, `echo:turn ${i} ${text(2_000)}`, i + 1);
      const res = await owner({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}/compact`,
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(202);
      const { runId } = res.json() as { runId: string };
      await waitFor(
        async () => {
          const r = await db
            .selectFrom("runs")
            .select("status")
            .where("id", "=", runId)
            .executeTakeFirst();
          return r?.status === "completed" ? r : null;
        },
        60_000,
        "the manual compact run completed",
      );
      return eventsOf(db, conv);
    };

    const unmapped = await run();
    await mapPlatform("fake-c");
    const mapped = await run();

    const [a] = ofType(unmapped, "compaction_summary");
    const [b] = ofType(mapped, "compaction_summary");
    expect(a?.payload.model).toEqual(ref("fake-1"));
    expect(b?.payload).toMatchObject({ method: "transcript", model: C });
    // the same conversation shape, so the same plan: the same covered range
    expect(b?.payload.coversUpToSeq).toBe(a?.payload.coversUpToSeq);
    expect(b?.payload.openingSeqs).toEqual(a?.payload.openingSeqs);
    expect(new Set(compactionUsage(mapped).map((u) => u.payload.model))).toEqual(
      new Set(["fake-c"]),
    );
  });

  it("a reactive overflow on a fallback rung plans against the rung and summarizes on C", async () => {
    const orgId = await newOrg();
    await mapPlatform("fake-c");
    const agentId = await newAgent(orgId, "fake-v", { fallback: ref("fake-r") });
    const conv = await seeded(orgId, agentId, [30_000]);

    // the primary is down; the fallback rung overflows once, which forces the compaction
    const registry = k.app.get(ProviderRegistry);
    const real = registry.resolve.bind(registry);
    let overflowed = false;
    vi.spyOn(registry, "resolve").mockImplementation(async (orgId, r, opts) => {
      const got = await real(orgId, r, opts);
      return {
        ...got,
        provider: {
          ...got.provider,
          stream(req, o) {
            const failure =
              req.purpose !== undefined
                ? null
                : req.model === "fake-v"
                  ? new ModelError("server", "down", { retryAfterMs: 1 })
                  : req.model === "fake-r" && !overflowed
                    ? new ModelError("context_overflow", "too long")
                    : null;
            if (failure === null) return got.provider.stream(req, o);
            if (failure.kind === "context_overflow") overflowed = true;
            // biome-ignore lint/correctness/useYield: fails before the first event
            return (async function* (): AsyncGenerator<ModelStreamEvent> {
              throw failure;
            })();
          },
        },
      };
    });

    await turn(orgId, conv, "echo:ok", 1);
    const events = await eventsOf(db, conv);
    expect(overflowed).toBe(true);
    expect(
      ofType(events, "compaction_summary").map((e) => [e.payload.method, e.payload.model]),
    ).toEqual([["transcript", C]]);
    expect(new Set(compactionUsage(events).map((u) => u.payload.model))).toEqual(
      new Set(["fake-c"]),
    );
    // the retried request went to the rung, after the summary, within the rung's window
    const call = ofType(events, "model_call").at(-1);
    expect(call?.payload).toMatchObject({ fallback: true, model: "fake-r" });
    expect(call?.payload.request.summarySeq).not.toBeNull();
    expect(call?.payload.request.estimatedInputTokens ?? Number.POSITIVE_INFINITY).toBeLessThan(
      64_000,
    );
  });

  it("a chunked compaction on a 50k window: one usage per chunk, one summary", async () => {
    const orgId = await newOrg();
    await mapPlatform("fake-small");
    const agentId = await newAgent(orgId, "fake-1");
    // six seeded messages of 20k tokens: about 120k tokens of transcript, far over one chunk
    const conv = await seeded(
      orgId,
      agentId,
      Array.from({ length: 6 }, () => 20_000),
    );
    await turn(orgId, conv, "echo:ok", 1);
    // under the conversation model's trigger (200k): nothing compacted yet
    expect(ofType(await eventsOf(db, conv), "compaction_summary")).toEqual([]);

    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/compact`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(202);
    const events = await waitFor(
      async () => {
        const all = await eventsOf(db, conv);
        return ofType(all, "compaction_summary").length > 0 ? all : null;
      },
      60_000,
      "the chunked summary",
    );
    const summaries = ofType(events, "compaction_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.payload).toMatchObject({
      method: "transcript",
      model: ref("fake-small"),
    });
    const usage = compactionUsage(events);
    const chunks = usage[0]?.payload.chunks as number;
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(usage.map((u) => u.payload.chunk)).toEqual(
      Array.from({ length: chunks }, (_, i) => i + 1),
    );
    expect(usage.every((u) => u.payload.chunks === chunks)).toBe(true);
    expect(usage.every((u) => u.payload.model === "fake-small")).toBe(true);
  });

  it("Review Focus 1: a policy denial of C's request never reaches V", async () => {
    const orgId = await newOrg();
    await probeHooks(orgId, { denyModelPurposes: ["compaction"] });
    await mapPlatform("fake-c");
    const agentId = await newAgent(orgId, "fake-v");
    const conv = await seeded(orgId, agentId, [60_000]);
    await turn(orgId, conv, "echo:ok", 1);

    const events = await eventsOf(db, conv);
    expect(ofType(events, "compaction_summary")).toEqual([]);
    const failed = ofType(events, "compaction_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload.model).toEqual(C);
    expect(failed[0]?.payload.reason).toContain("hooks-probe");
    // no compaction request was sent anywhere, so no usage of any model with that purpose
    expect(compactionUsage(events)).toEqual([]);
    // the hooks saw C's request only: the last compaction request is C's (a V request after the
    // denial would have replaced it)
    expect(await lastModelRequest(orgId, "compaction")).toMatchObject({
      purpose: "compaction",
      provider: FAKE,
      model: "fake-c",
    });
    // the step's own request still went out, on V, and the run finished
    expect(await lastModelRequest(orgId, "step")).toMatchObject({ model: "fake-v" });
    expect(ofType(events, "model_call").map((e) => e.payload.model)).toEqual(["fake-v"]);
    expect(ofType(events, "run_finished")).toHaveLength(1);
  });

  it("a sub-agent conversation compacts on C too", async () => {
    const orgId = await newOrg();
    await mapPlatform("fake-c");
    // the sub-agents' fast tier is fake-v (100k window): a child that grows past 50k tokens compacts
    const tier = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/model-purposes/subagent_fast`,
      payload: { target: { model: ref("fake-v"), params: {} } },
    });
    expect(tier.statusCode, tier.body).toBe(200);
    const lead = await newAgent(orgId, "fake-1", {
      disabledTools: onlyBuiltins(
        ["Agent", "SendMessage"].map((name) => ({ kind: "builtin", name })),
      ),
    });
    const conv = await createConv(owner, orgId, lead);
    // the brief is echoed back as the report: about 25k tokens in, 25k out
    const brief = `echo:${text(24_000)}`;
    await turn(
      orgId,
      conv,
      `tools:${JSON.stringify([{ name: "Agent", input: { description: "Work", prompt: brief, model: "fast" } }])}`,
      1,
    );
    const parentEvents = await eventsOf(db, conv);
    const report = ofType(parentEvents, "tool_result").find((e) => e.payload.toolKey === "Agent");
    const agentRef = /agentId: ([^ ]+) [·(]/.exec(report?.payload.content ?? "")?.[1];
    expect(agentRef, report?.payload.content.slice(0, 300)).toBeDefined();
    const child = (
      await db
        .selectFrom("subagent_dispatches")
        .select("child_conversation_id")
        .where("parent_conversation_id", "=", conv)
        .executeTakeFirstOrThrow()
    ).child_conversation_id;
    expect(ofType(await eventsOf(db, child), "compaction_summary")).toEqual([]);

    // a second message makes the child's history 75k tokens at its next run's first step
    await turn(
      orgId,
      conv,
      `tools:${JSON.stringify([{ name: "SendMessage", input: { to: agentRef, message: `echo:${text(24_000)}` } }])}`,
      2,
    );
    const events = await waitFor(
      async () => {
        const all = await eventsOf(db, child);
        return ofType(all, "compaction_summary").length > 0 ? all : null;
      },
      60_000,
      "the sub-agent's summary",
    );
    expect(
      ofType(events, "compaction_summary").map((e) => [e.payload.method, e.payload.model]),
    ).toEqual([["transcript", C]]);
    expect(new Set(compactionUsage(events).map((u) => u.payload.model))).toEqual(
      new Set(["fake-c"]),
    );
  });
});
