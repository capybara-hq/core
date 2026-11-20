import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import {
  deleteExpiredSealedInputs,
  SealedInputs,
  SealedInputsExpiredError,
} from "../../src/platform/sealed-inputs.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * The sealed person inputs store (platform web parity spec §4.3): values a person typed on an
 * approval card, sealed in PG for the resumed call to consume once.
 */

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    {
      overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: () => true }],
      env: {},
      logger: createLogger("error", { write: () => {} }),
    },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});

const store = () => k.app.get(SealedInputs);
const inTx = <T>(fn: () => Promise<T>) => k.app.get(TransactionHost).run(fn);
const read = (values: Readonly<Record<string, string>>) => Promise.resolve({ ...values });

/** An approval with its org, account, conversation and run; nothing sealed yet. */
async function approval() {
  const seed = await seedConversation(raw);
  const db = kernelDb(raw);
  const runId = randomUUID();
  const callId = randomUUID();
  const approvalId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: seed.conversationId,
      trigger_account_id: seed.accountId,
      status: "waiting",
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  await db
    .insertInto("approvals")
    .values({
      id: approvalId,
      org_id: seed.orgId,
      conversation_id: seed.conversationId,
      run_id: runId,
      call_id: callId,
      attempt: 1,
      tool_key: "Platform",
      spec_hash: "spec",
      connector_id: null,
      requested_for: seed.accountId,
      approver_role: null,
      scope: null,
      decided_by: null,
      expires_at: new Date(Date.now() + 3600000),
    })
    .execute();
  const row = {
    approvalId,
    recipientAccountId: seed.accountId,
    conversationId: seed.conversationId,
    runId,
    callId,
  };
  return { ...seed, db, approvalId, row };
}

/** An approval whose values are sealed. */
async function sealed(values: Record<string, string> = { apiKey: "k-123456789" }) {
  const a = await approval();
  await inTx(() => store().sealIn(a.row, values));
  return a;
}

const rowCount = async (approvalId: string) =>
  (
    await kernelDb(raw)
      .selectFrom("platform_sealed_inputs")
      .select("approval_id")
      .where("approval_id", "=", approvalId)
      .execute()
  ).length;

it("seals and consumes once", async () => {
  const s = await sealed();
  await expect(store().consume(s.approvalId, s.accountId, read)).resolves.toEqual({
    apiKey: "k-123456789",
  });
  await expect(store().consume(s.approvalId, s.accountId, read)).rejects.toBeInstanceOf(
    SealedInputsExpiredError,
  );
});

it("stores no plaintext", async () => {
  const s = await sealed();
  const r = await sql<{ c: string; paths: string[] }>`
    SELECT ciphertext::text AS c, paths FROM capybara.platform_sealed_inputs
    WHERE approval_id = ${s.approvalId}`.execute(raw);
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]?.c).not.toContain("k-123456789");
  expect(Buffer.from(r.rows[0]?.c ?? "").toString()).not.toContain("k-123456789");
  expect(r.rows[0]?.paths).toEqual(["apiKey"]);
});

it("refuses another recipient as expired", async () => {
  const s = await sealed();
  const other = await seedConversation(raw);
  await expect(store().consume(s.approvalId, other.accountId, read)).rejects.toBeInstanceOf(
    SealedInputsExpiredError,
  );
  expect(await rowCount(s.approvalId)).toBe(1);
});

it("refuses expired rows and the cleanup deletes them", async () => {
  const s = await sealed();
  await s.db
    .updateTable("platform_sealed_inputs")
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where("approval_id", "=", s.approvalId)
    .execute();
  await expect(store().consume(s.approvalId, s.accountId, read)).rejects.toBeInstanceOf(
    SealedInputsExpiredError,
  );
  await expect(deleteExpiredSealedInputs(s.db)).resolves.toBe(1);
  expect(await rowCount(s.approvalId)).toBe(0);
});

it("keeps the row when apply fails (rolled back)", async () => {
  const s = await sealed();
  await expect(
    store().consume(s.approvalId, s.accountId, async () => {
      throw new Error("write failed");
    }),
  ).rejects.toThrow("write failed");
  expect(await rowCount(s.approvalId)).toBe(1);
  await expect(store().consume(s.approvalId, s.accountId, read)).resolves.toEqual({
    apiKey: "k-123456789",
  });
});

it("binds the paths into the AAD: altered paths fail to unwrap and count as expired", async () => {
  const s = await sealed({ apiKey: "k-123456789", token: "t-abcdefghij" });
  await s.db
    .updateTable("platform_sealed_inputs")
    .set({ paths: ["apiKey"] })
    .where("approval_id", "=", s.approvalId)
    .execute();
  await expect(store().consume(s.approvalId, s.accountId, read)).rejects.toBeInstanceOf(
    SealedInputsExpiredError,
  );
});

it("sealIn needs the caller's transaction", async () => {
  // valid FK targets: only the missing transaction can fail the call
  const a = await approval();
  await expect(store().sealIn(a.row, { apiKey: "k-123456789" })).rejects.toThrow(
    'propagation "mandatory": no transaction in context',
  );
  expect(await rowCount(a.approvalId)).toBe(0);
});
