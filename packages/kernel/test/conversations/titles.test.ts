import {
  openSse,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import {
  cleanTitle,
  runTitleJob,
  TITLE_MAX_ATTEMPTS,
  TITLE_PROMPT,
  titleAttemptDue,
  titleExcerpt,
} from "../../src/conversations/titles.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import type { ModelPurposesService } from "../../src/models/purposes.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  sleep,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/** UI refresh B Task 7: model-generated titles through `cap-kernel-titles` and the `title` purpose. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let owner: { req: Req; cookie: () => string };
let orgId: string;
let agentId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensionConfig: { "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] } },
      },
    ),
  );
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.model_purpose_mappings");
  ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  const jar = cookieJar();
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  owner = { req, cookie: () => jar.header() as string };
  orgId = await createOrg(owner.req);
  agentId = await createAgent(owner.req, orgId);
});

const convRow = (id: string) =>
  db
    .selectFrom("conversations")
    .select(["title", "title_source", "title_attempts"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const titleUsage = async (id: string) =>
  (await eventsOf(db, id)).filter(
    (e) => e.type === "usage" && (e.payload as { purpose?: string }).purpose === "title",
  );

async function mapTitle(model: string): Promise<void> {
  await db
    .insertInto("model_purpose_mappings")
    .values({ org_id: null, purpose: "title", provider: "model-fake", model, params: "{}" })
    .execute();
}

describe("titleExcerpt / cleanTitle", () => {
  it("cuts each side to 1,000 characters and cleans the reply to one line", () => {
    const x = titleExcerpt("a".repeat(1500), "b".repeat(10));
    expect(x).toContain(`${"a".repeat(1000)}…`);
    expect(x).not.toContain("a".repeat(1001));
    expect(TITLE_PROMPT).toMatch(/^Write a title of at most 8 words/);
    expect(cleanTitle('"Quarterly report."\nmore')).toBe("Quarterly report");
    expect(cleanTitle("\n  Title: 季度报告。 ")).toBe("季度报告");
    expect(cleanTitle("a​b\u0007c")).toBe("abc");
    expect(cleanTitle("x".repeat(200))).toHaveLength(120);
    expect(cleanTitle(' \n"" ')).toBeNull();
  });
});

describe("title job (kernel, fake model)", { timeout: 60_000 }, () => {
  it("after the first completed run: generated title, usage purpose title, SSE changed", async () => {
    const conv = await createConv(owner.req, orgId, agentId);
    const sse = await openSse(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { cookie: owner.cookie() },
    );
    try {
      await postMessage(owner.req, orgId, conv, "echo:Quarterly numbers");
      await waitForTerminal(db, conv, 1, 20_000);
      const row = await waitFor(
        async () => {
          const r = await convRow(conv);
          return r.title !== null ? r : null;
        },
        15_000,
        "title",
      );
      expect(row.title_source).toBe("generated");
      expect(row.title_attempts).toBe(1);
      // the fake model answers "You said: <first line of the excerpt>"
      expect(row.title).toBe("You said: User message");
      const usage = await waitFor(async () => {
        const u = await titleUsage(conv);
        return u.length === 1 ? u : null;
      });
      // unmapped purpose → the conversation's current chat model
      expect(usage[0]).toMatchObject({
        runId: null,
        payload: { step: 0, provider: "model-fake", model: "fake-1", purpose: "title" },
      });
      await sse.until(
        (m) => m.some((x) => x.event === "changed" && x.data === '{"what":"title"}'),
        10_000,
        "changed frame",
      );
      const got = await owner.req({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      });
      expect(got.json()).toMatchObject({
        conversation: { title: "You said: User message", titleSource: "generated" },
      });
    } finally {
      sse.close();
    }
    // a second run does not regenerate
    await postMessage(owner.req, orgId, conv, "echo:again");
    await waitForTerminal(db, conv, 2, 20_000);
    await sleep(500);
    expect((await convRow(conv)).title_attempts).toBe(1);
    expect(await titleUsage(conv)).toHaveLength(1);
  });

  it("a mapped title purpose uses its model", async () => {
    await mapTitle("fake-2");
    const conv = await createConv(owner.req, orgId, agentId);
    await postMessage(owner.req, orgId, conv, "echo:hello");
    const usage = await waitFor(async () => {
      const u = await titleUsage(conv);
      return u.length === 1 ? u : null;
    }, 20_000);
    expect(usage[0]?.payload).toMatchObject({ provider: "model-fake", model: "fake-2" });
  });

  it("the title model failing 3 times leaves the title null and stops", async () => {
    await mapTitle("gone");
    const conv = await createConv(owner.req, orgId, agentId);
    for (let i = 1; i <= TITLE_MAX_ATTEMPTS + 1; i++) {
      await postMessage(owner.req, orgId, conv, `echo:turn ${i}`);
      await waitForTerminal(db, conv, i, 20_000);
      const expected = Math.min(i, TITLE_MAX_ATTEMPTS);
      await waitFor(
        async () => (await convRow(conv)).title_attempts === expected,
        10_000,
        `attempt ${expected}`,
      );
    }
    await sleep(500);
    expect(await convRow(conv)).toEqual({
      title: null,
      title_source: null,
      title_attempts: TITLE_MAX_ATTEMPTS,
    });
    expect(await titleUsage(conv)).toEqual([]);
    expect(await titleAttemptDue(db, conv)).toBeNull();
  });

  it("no assistant text yet → no job due; a renamed conversation is never due", async () => {
    const conv = await createConv(owner.req, orgId, agentId);
    expect(await titleAttemptDue(db, conv)).toBeNull();
    await postMessage(owner.req, orgId, conv, "echo:hi");
    await waitForTerminal(db, conv, 1, 20_000);
    const res = await owner.req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
      payload: { title: "Mine" },
    });
    expect(res.statusCode).toBe(200);
    expect(await titleAttemptDue(db, conv)).toBeNull();
  });
});

describe("runTitleJob (direct)", { timeout: 60_000 }, () => {
  /** A conversation with one finished exchange and no title job run yet. */
  async function seeded(): Promise<{ id: string; log: EventLog; published: unknown[] }> {
    const conv = await createConv(owner.req, orgId, agentId);
    // a conversation whose run has not started a title attempt: write the exchange directly
    const published: unknown[] = [];
    const log = new EventLog(db, {
      publish: async (_t, p) => {
        published.push(p);
      },
    });
    await log.append(conv, [
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: "plan the offsite" }],
          authorAccountId: ownerId,
        },
      },
      {
        type: "assistant_message",
        payload: { step: 0, content: [{ type: "text", text: "Sure." }], stopReason: "end_turn" },
      },
    ]);
    return { id: conv, log, published };
  }

  const usage = { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("a rename between the claim and the model reply keeps the manual title", async () => {
    const { id, log, published } = await seeded();
    const purposes: Pick<ModelPurposesService, "chat"> = {
      chat: async (_org, purpose, req) => {
        expect(purpose).toBe("title");
        expect(req.maxOutputTokens).toBe(32);
        expect(req.system[0]?.text).toBe(TITLE_PROMPT);
        await owner.req({
          method: "PATCH",
          url: `/api/v1/orgs/${orgId}/conversations/${id}`,
          payload: { title: "Manual" },
        });
        return {
          content: [{ type: "text", text: "Generated" }],
          stopReason: "end_turn",
          usage,
          provider: "model-fake",
          model: "fake-1",
        };
      },
    };
    await runTitleJob({ db, eventLog: log, purposes, log: console }, id, 0);
    expect(await convRow(id)).toMatchObject({ title: "Manual", title_source: "manual" });
    // the call happened: its usage is still logged; no `changed` from the job (the rename sent one)
    expect(await titleUsage(id)).toHaveLength(1);
    expect(published.filter((p) => (p as { kind: string }).kind === "changed")).toEqual([]);
  });

  it("an attempt already claimed does nothing", async () => {
    const { id, log } = await seeded();
    let calls = 0;
    const purposes: Pick<ModelPurposesService, "chat"> = {
      chat: async () => {
        calls++;
        return {
          content: [{ type: "text", text: "T" }],
          stopReason: "end_turn",
          usage,
          provider: "model-fake",
          model: "fake-1",
        };
      },
    };
    await runTitleJob({ db, eventLog: log, purposes, log: console }, id, 0);
    await runTitleJob({ db, eventLog: log, purposes, log: console }, id, 0);
    expect(calls).toBe(1);
    expect(await titleUsage(id)).toHaveLength(1);
    expect(await convRow(id)).toMatchObject({ title: "T", title_attempts: 1 });
  });
});
