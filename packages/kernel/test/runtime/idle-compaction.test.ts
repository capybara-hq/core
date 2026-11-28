import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { CompactionService } from "../../src/runtime/compaction.service.js";
import { CompactionSettingsService } from "../../src/runtime/compaction-settings.service.js";
import { IdleCompactionJob } from "../../src/runtime/idle-compaction.js";
import {
  IDLE_COMPACTION_JOB,
  type IdleCompactionJobData,
} from "../../src/runtime/idle-compaction-jobs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { RunQueue } from "../../src/runtime/run-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createAgent,
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
 * The idle compaction job (idle compaction spec §4.3, §5.1): one delivery of `idle-compact-<runId>`
 * re-reads the conversation, decides through `idleFireDecision` and starts an idle compact run
 * through `RunQueue.startIdleCompaction`. Each case arms a job the way Task 9 does (the maintenance
 * queue's adds fail, so the owed row stays in the outbox), reads the row's data, then fires it:
 * through the outbox and the maintenance processor (the happy path) or `IdleCompactionJob.fire`
 * directly (every refusal, which writes no event).
 *
 * model-fake declares `[300, 3600]` and passes the in-context gate; the org turns the long cache
 * tier on (1 h) and the size floor down to the settings' lowest (50,000 tokens, decision D6), and
 * keeps one recent turn so the seeded long turn is what the compaction plan summarizes.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let ownerId: string;

/** While true, the maintenance queue's adds fail (the armed rows stay owed). */
let holdMaintenance = true;
/** Org names are unique per account: one per setup. */
let orgCount = 0;

/** About 220k characters: with the reply, the last call is over 50,000 tokens. */
const LONG_TEXT = "lorem ipsum dolor sit amet ".repeat(8_200);

const IDLE_SETTINGS = {
  idleMinTokensFloor: 50_000,
  idleMinWindowRatio: 0.1,
  keepRecentTurns: 1,
};

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
              { id: "fake-nc", contextWindow: 400_000, cache: "none" },
            ],
          },
        },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (q: string) => holdMaintenance && q === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  holdMaintenance = true;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.deployment_settings",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
});

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

/** The last `model.request` payload of `purpose` in the org (hooks-probe), or undefined. */
async function lastModelRequest(orgId: string, purpose: string): Promise<unknown> {
  const res = await owner({
    method: "GET",
    url: `/plugins/hooks-probe/counts?orgId=${orgId}&purpose=${purpose}`,
  });
  return (res.json() as { last: Record<string, unknown> }).last["model.request"];
}

interface Armed {
  orgId: string;
  agentId: string;
  conv: string;
  data: IdleCompactionJobData;
}

/** Posts `text` and waits for the conversation's `n`-th terminal run. */
async function turn(orgId: string, conv: string, text: string, n: number): Promise<void> {
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, n, 30_000);
}

/** The data of the newest owed idle compaction row of the conversation. */
async function armedData(conv: string): Promise<IdleCompactionJobData> {
  const rows = await db
    .selectFrom("outbox")
    .select("data")
    .where("job_name", "=", IDLE_COMPACTION_JOB)
    .orderBy("id", "desc")
    .execute();
  const data = rows
    .map((r) => r.data as unknown as IdleCompactionJobData)
    .find((d) => d.conversationId === conv);
  if (!data) throw new Error("no idle compaction job owed");
  return data;
}

/**
 * A conversation with a long seeded turn and one answered turn, armed: the run's finish owed an
 * `idle-compaction` job; returns its data.
 */
async function arm(hooks?: Record<string, unknown>): Promise<Armed> {
  const orgId = await createOrgWithProviders(k, owner, `Acme ${++orgCount}`);
  await patchOrg(orgId, { promptCache: { longTtl: true }, compaction: IDLE_SETTINGS });
  if (hooks) await probeHooks(orgId, hooks);
  const agentId = await createAgent(owner, orgId, { provider: "model-fake", model: "fake-1" });
  const conv = await createConv(owner, orgId, agentId);
  const [e] = await withOrgScope(orgId, () =>
    k.app.get(EventLog).append(conv, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: LONG_TEXT }], authorAccountId: ownerId },
      },
    ]),
  );
  await db
    .updateTable("conversations")
    .set({ consumed_seq: String(e?.seq) })
    .where("id", "=", conv)
    .execute();
  await turn(orgId, conv, "echo:ok", 1);
  return { orgId, agentId, conv, data: await armedData(conv) };
}

const fire = (data: IdleCompactionJobData, now?: number) =>
  withOrgScope(data.orgId, () => k.app.get(IdleCompactionJob).fire(data, now));

/**
 * Fires `data` directly through a job built from the app's providers with a recording logger (the
 * kernel logger is transient: the app's job holds its own); returns the outcome and the job's one
 * `info` line.
 */
async function fireLogged(
  data: IdleCompactionJobData,
  now?: number,
): Promise<{ outcome: string; line: Record<string, unknown> | undefined }> {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const job = new IdleCompactionJob(
    k.app.get(KernelDb),
    k.app.get(CompactionSettingsService),
    k.app.get(AccountsService),
    k.app.get(ProviderRegistry),
    k.app.get(CompactionService),
    k.app.get(RunQueue),
    { info: (msg, fields) => lines.push([msg, fields]), warn: () => {} },
  );
  const outcome = await withOrgScope(data.orgId, () => job.fire(data, now));
  return { outcome, line: lines.find(([msg]) => msg === "idle compaction job")?.[1] };
}

const idleRuns = (conv: string) =>
  db
    .selectFrom("runs")
    .select(["id", "status"])
    .where("conversation_id", "=", conv)
    .where("compact_origin", "=", "idle")
    .execute();

/** Waits until the conversation's idle compact run completed; returns its id. */
async function idleRunCompleted(conv: string): Promise<string> {
  const runs = await waitFor(
    async () => {
      const rows = await idleRuns(conv);
      return rows.length > 0 && rows.every((r) => r.status === "completed") ? rows : null;
    },
    30_000,
    "the idle compact run completed",
  );
  expect(runs).toHaveLength(1);
  return runs[0]?.id as string;
}

const ofRun = (events: ConversationEvent[], runId: string) =>
  events.filter((e) => e.runId === runId);

describe("the idle compaction job", () => {
  it("fires through the outbox and the maintenance processor: an idle compact run summarizes in context from the cache, as the owner", async () => {
    const { orgId, conv, data } = await arm({});
    holdMaintenance = false;
    await db
      .updateTable("outbox")
      .set({ run_at: sql<Date>`now()` })
      .where("job_name", "=", IDLE_COMPACTION_JOB)
      .execute();
    await drainOutbox(k.app, { jobName: IDLE_COMPACTION_JOB });
    const idleRunId = await idleRunCompleted(conv);

    const events = ofRun(await eventsOf(db, conv), idleRunId);
    const started = events.find((e) => e.type === "run_started");
    expect(started?.payload).toMatchObject({
      trigger: "compact",
      compactOrigin: "idle",
      triggerAccountId: ownerId,
    });
    const summary = events.find((e) => e.type === "compaction_summary");
    expect(summary?.payload).toMatchObject({ method: "in_context" });
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.payload).toMatchObject({ purpose: "compaction" });
    expect(usage?.type === "usage" && usage.payload.cacheReadTokens).toBeGreaterThan(0);
    expect(await lastModelRequest(orgId, "compaction")).toMatchObject({
      purpose: "compaction",
      conversationId: conv,
    });

    // a second delivery of the same job finds the first one's run: obsolete, no second run
    expect(await fire(data)).toBe("obsolete");
    expect(await idleRuns(conv)).toHaveLength(1);
  });

  it("is obsolete after a message; a run-less side-call usage does not make it stale (S1)", async () => {
    const first = await arm();
    await withOrgScope(first.orgId, () =>
      k.app.get(EventLog).append(first.conv, [
        {
          type: "usage",
          payload: {
            step: 0,
            provider: "model-fake",
            model: "fake-1",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            purpose: "title",
          },
        },
      ]),
    );
    const { outcome, line } = await fireLogged(first.data);
    expect(outcome).toBe("started");
    const idleRunId = await idleRunCompleted(first.conv);
    // the job's one info line (spec §7)
    expect(line).toMatchObject({
      context: "IdleCompaction",
      outcome: "started",
      orgId: first.orgId,
      conversationId: first.conv,
      runId: first.data.runId,
      idleRunId,
      ttl: 3600,
    });
    expect(line?.estimate).toBeGreaterThan(50_000);
    expect(typeof line?.lateMs).toBe("number");

    const second = await arm();
    await turn(second.orgId, second.conv, "echo:again", 2);
    expect(await fire(second.data)).toBe("obsolete");
    expect(await idleRuns(second.conv)).toEqual([]);
  });

  it("reports the first failing check: a stale job that is also past its expiry is obsolete", async () => {
    const { orgId, conv, data } = await arm();
    await turn(orgId, conv, "echo:again", 2);
    expect(await fire(data, data.expiresAt)).toBe("obsolete");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is busy with an active run", async () => {
    const { conv, data } = await arm();
    await db
      .insertInto("runs")
      .values({
        id: randomUUID(),
        conversation_id: conv,
        execution_id: null,
        trigger_account_id: ownerId,
        status: "waiting",
        agent_version: 1,
        trigger_seq: 0,
      })
      .execute();
    expect(await fire(data)).toBe("busy");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is busy with an unconsumed message below the armed seq (the arm raced the run's end)", async () => {
    const { conv, data } = await arm();
    await db
      .updateTable("conversations")
      .set({ consumed_seq: "0" })
      .where("id", "=", conv)
      .execute();
    expect(await fire(data)).toBe("busy");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is busy with a queue head", async () => {
    const { conv, data } = await arm();
    await db
      .insertInto("conversation_queue")
      .values({
        id: randomUUID(),
        conversation_id: conv,
        account_id: ownerId,
        position: "1",
        text: "later",
        content: JSON.stringify([]),
        client_message_id: randomUUID(),
      })
      .execute();
    expect(await fire(data)).toBe("busy");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is disabled after the org turns idle compaction off", async () => {
    const { orgId, conv, data } = await arm();
    await patchOrg(orgId, { compaction: { ...IDLE_SETTINGS, idleEnabled: false } });
    expect(await fire(data)).toBe("disabled");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is disabled when the owner turns idle compaction off in their preferences", async () => {
    const { conv, data } = await arm();
    const res = await owner({
      method: "PUT",
      url: "/api/v1/me/preferences",
      payload: { idleCompaction: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await fire(data)).toBe("disabled");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is expired once it is 30 s before the cache expires", async () => {
    const { conv, data } = await arm();
    expect(await fire(data, data.expiresAt - 30_000)).toBe("expired");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is gone when the owner's account is disabled (the idle run runs as the owner)", async () => {
    const { conv, data } = await arm();
    await db
      .updateTable("accounts")
      .set({ status: "disabled" })
      .where("id", "=", ownerId)
      .execute();
    expect(await fire(data)).toBe("gone");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is no_model after the agent's version changes the model (no event in the conversation)", async () => {
    const { agentId, conv, data } = await arm();
    await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
      SELECT agent_id, version + 1,
        jsonb_set(definition, '{model}', '{"provider":"model-fake","model":"fake-nc"}'::jsonb),
        created_by
      FROM capybara.agent_versions WHERE agent_id = ${agentId}
      ORDER BY version DESC LIMIT 1`.execute(raw);
    await sql`UPDATE capybara.agents SET current_version = current_version + 1
      WHERE id = ${agentId}`.execute(raw);
    expect(await fire(data)).toBe("no_model");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is no_model after the org disables the armed call's model", async () => {
    const { orgId, conv, data } = await arm();
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
      payload: { disable: ["fake-1"], enable: [] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await fire(data)).toBe("no_model");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is small when a summary already covers all but the latest turn", async () => {
    const { orgId, conv, data } = await arm();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/compact`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv, 2, 30_000);
    const events = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "compaction_summary")).toBe(true);
    // the job as if armed after the manual compaction (the arm decision would not arm it: small)
    const { outcome, line } = await fireLogged({
      ...data,
      armedSeq: events.at(-1)?.seq as number,
    });
    expect(outcome).toBe("small");
    // the dry run answered (an unavailable model or storage would leave no estimate)
    expect(line?.estimate).toEqual(expect.any(Number));
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("is no_prefix when the armed call's request recorded a fit plan", async () => {
    const { conv, data } = await arm();
    await sql`UPDATE capybara.conversation_events
      SET payload = jsonb_set(payload, '{request,fit}',
        '{"droppedMessageIndexes":[1],"truncated":[]}'::jsonb)
      WHERE conversation_id = ${conv} AND seq = ${data.cacheCallSeq}`.execute(raw);
    expect(await fire(data)).toBe("no_prefix");
    expect(await idleRuns(conv)).toEqual([]);
  });

  it("a policy hook denying the summary call fails the compaction, completes the run, and the next armed job is in backoff", async () => {
    const { orgId, conv, data } = await arm({ denyModelPurposes: ["compaction"] });
    expect(await fire(data)).toBe("started");
    const idleRunId = await idleRunCompleted(conv);
    const events = ofRun(await eventsOf(db, conv), idleRunId);
    expect(events.map((e) => e.type)).toContain("compaction_failed");
    expect(events.some((e) => e.type === "compaction_summary")).toBe(false);

    // the next turn arms again (the step calls are allowed); its job meets the failure
    await turn(orgId, conv, "echo:again", 3);
    const next = await armedData(conv);
    expect(next.runId).not.toBe(data.runId);
    expect(await fire(next)).toBe("backoff");
    expect(await idleRuns(conv)).toHaveLength(1);
  });
});
