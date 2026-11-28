import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { CompactionSettingsService } from "../../src/runtime/compaction-settings.service.js";
import { IdleReturn } from "../../src/runtime/idle-return.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * The `idle_return` log's reader SQL (idle compaction spec S11) against real rows: a finished
 * model-fake run with a long context, a gap from `finished_at`, and a recording logger (the kernel
 * logger is transient: the service is built from the app's providers).
 */

const MIN = 60_000;
/** About 220k characters: with the reply, the last call is over 50,000 tokens. */
const LONG_TEXT = "lorem ipsum dolor sit amet ".repeat(8_200);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let ownerId: string;
let orgCount = 0;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE],
        extensionConfig: {
          "model-fake": { models: [{ id: "fake-1", contextWindow: 400_000 }] },
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

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.deployment_settings",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
});

interface Setup {
  orgId: string;
  conv: string;
  runId: string;
  finishedAt: number;
}

/** A conversation whose one run finished with a long context. */
async function setup(): Promise<Setup> {
  const orgId = await createOrgWithProviders(k, owner, `Acme ${++orgCount}`);
  const patch = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: {
      promptCache: { longTtl: true },
      compaction: { idleMinTokensFloor: 50_000, idleMinWindowRatio: 0.1, keepRecentTurns: 1 },
    },
  });
  expect(patch.statusCode, patch.body).toBe(200);
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
  await postMessage(owner, orgId, conv, "echo:ok");
  await waitForTerminal(db, conv, 1, 30_000);
  const run = await db
    .selectFrom("runs")
    .select(["id", "finished_at"])
    .where("conversation_id", "=", conv)
    .executeTakeFirstOrThrow();
  return { orgId, conv, runId: run.id, finishedAt: (run.finished_at as Date).getTime() };
}

async function record(
  s: Setup,
  now: number,
): Promise<Array<[string, Record<string, unknown> | undefined]>> {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const service = new IdleReturn(
    k.app.get(KernelDb),
    k.app.get(CompactionSettingsService),
    k.app.get(ProviderRegistry),
    { info: (msg, fields) => lines.push([msg, fields]), debug: () => {} },
  );
  await withOrgScope(s.orgId, () =>
    service.record({ id: s.conv, org_id: s.orgId }, randomUUID(), now),
  );
  return lines.filter(([msg]) => msg === "idle_return");
}

describe("IdleReturn.record", () => {
  it("logs the return with the previous run's context, even behind many side-call usages", async () => {
    const s = await setup();
    // more side-call usages than the reader once scanned, all after the step usage
    await withOrgScope(s.orgId, () =>
      k.app.get(EventLog).append(
        s.conv,
        Array.from({ length: 10 }, () => ({
          type: "usage" as const,
          runId: s.runId,
          payload: {
            step: 0,
            provider: "model-fake",
            model: "fake-1",
            inputTokens: 5,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            purpose: "title",
          },
        })),
      ),
    );
    const lines = await record(s, s.finishedAt + 31 * MIN);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatchObject({
      context: "IdleCompaction",
      orgId: s.orgId,
      conversationId: s.conv,
      gapMs: 31 * MIN,
      threshold: 50_000,
      idleSummary: false,
    });
    expect(lines[0]?.[1]?.contextTokens).toBeGreaterThan(50_000);
    expect(lines[0]?.[1]).toHaveProperty("ttl");
  });

  it("reports an idle compact run's summary written after the previous run", async () => {
    const s = await setup();
    const idleRun = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: idleRun,
        conversation_id: s.conv,
        execution_id: null,
        trigger_account_id: ownerId,
        status: "completed",
        agent_version: 1,
        trigger_seq: 0,
        compact: true,
        compact_origin: "idle",
      })
      .execute();
    await withOrgScope(s.orgId, () =>
      k.app.get(EventLog).append(s.conv, [
        {
          type: "compaction_summary",
          runId: idleRun,
          payload: { coversUpToSeq: 1, text: "summary", savedTokens: 900, step: 0 },
        },
      ]),
    );
    await sql`UPDATE capybara.runs SET finished_at = now() WHERE id = ${idleRun}`.execute(raw);
    const lines = await record(s, s.finishedAt + 31 * MIN);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatchObject({ idleSummary: true });
  });

  it("logs nothing within the 30-minute gap", async () => {
    const s = await setup();
    expect(await record(s, s.finishedAt + 29 * MIN)).toEqual([]);
  });
});
