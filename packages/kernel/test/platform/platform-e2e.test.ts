import type { ModelInfo } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
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
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * The `Platform` tool end to end (Platform tool spec §3–§6): model-fake scripts the calls, the real
 * pipeline decides (policy, approval bound to the input, availability on fresh facts), the real
 * operations run, and the log replays with zero drift.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let owner: Req;
let member: Req;
let memberId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
        },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  memberId = (await accountsFor(db).createLocal({ login: "mem", password: PW, displayName: "M" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${memberId}, 'member')`.execute(db);
  member = await session(k, "mem");
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "Platform" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  capture.restore();
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);

const call = (operation: string, params: Record<string, unknown> = {}) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation, params })}`;
const platform = (input: Record<string, unknown>) => `tool:Platform:${JSON.stringify(input)}`;

const skillsOf = async (req: Req): Promise<string[]> => {
  const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/skills` });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { skills: { name: string }[] };
  return body.skills.map((s) => s.name);
};

/** A conversation as `who`; each `turn` posts a message and waits for the next terminal event. */
async function conversation(who: Req = owner) {
  const id = await createConv(who, orgId, agentId);
  let terminals = 0;
  return {
    id,
    async turn(text: string) {
      await postMessage(who, orgId, id, text);
      await waitForTerminal(db, id, ++terminals, 30_000);
      return eventsOf(db, id);
    },
    /** Posts a message and waits for the next approval request (the run waits for it). */
    async ask(text: string) {
      const before = ofType(await eventsOf(db, id), "approval_requested").length;
      await postMessage(who, orgId, id, text);
      const ev = await waitFor(
        async () => ofType(await eventsOf(db, id), "approval_requested")[before],
        20_000,
        "approval_requested",
      );
      return ev;
    },
    async finish() {
      await waitForTerminal(db, id, ++terminals, 30_000);
      return eventsOf(db, id);
    },
  };
}

const approvalOf = async (who: Req, id: string) => {
  const res = await who({ method: "GET", url: `/api/v1/orgs/${orgId}/approvals/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { approval: Record<string, unknown> }).approval;
};

const decide = (who: Req, id: string, body: Record<string, unknown>) =>
  who({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload: body });

const resultsOf = (evs: ConversationEvent[]) => ofType(evs, "tool_result").map((e) => e.payload);
const lastResult = (evs: ConversationEvent[]) =>
  resultsOf(evs).at(-1) as Ev<"tool_result">["payload"];

const setSetting = async (platformTool: "on" | "read-only" | "off") => {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { platformTool },
  });
  expect(res.statusCode, res.body).toBe(200);
};

describe("Platform tool end to end", { timeout: 180_000 }, () => {
  it("(a) a member browses, searches and calls a read operation without an approval", async () => {
    const conv = await conversation(member);
    await conv.turn(platform({ action: "browse" }));
    await conv.turn(platform({ action: "search", query: "skill" }));
    const evs = await conv.turn(call("skills.list"));
    expect(ofType(evs, "approval_requested")).toEqual([]);
    const results = resultsOf(evs);
    expect(results.map((r) => r.toolKey)).toEqual(["Platform", "Platform", "Platform"]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results[0]?.content).toContain('"domains"');
    expect(results[1]?.content).toContain("skills.list");
    expect(JSON.parse(results[2]?.content ?? "{}")).toHaveProperty("skills");
  });

  it("(b) an admin's write asks first: kernel summary, once only; approving runs it", async () => {
    capture.reset();
    const conv = await conversation(owner);
    const params = {
      name: "weekly-report",
      description: "Use for weekly reports.",
      body: "# Steps",
    };
    const asked = await conv.ask(call("skills.create", params));
    expect(asked.payload.toolKey).toBe("Platform:skills.create");
    const approval = await approvalOf(owner, asked.payload.approvalId);
    expect(approval.scopes).toEqual(["once"]);
    expect(approval.summary).toEqual({
      zh: "新建组织技能「weekly-report」",
      en: 'Create org skill "weekly-report"',
    });
    expect(await skillsOf(owner)).not.toContain("weekly-report");
    // "always" is not on offer for an org operation
    const refused = await decide(owner, asked.payload.approvalId, {
      decision: "approve",
      scope: "always",
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "approval.scope_not_allowed" } });
    const ok = await decide(owner, asked.payload.approvalId, {
      decision: "approve",
      scope: "once",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const evs = await conv.finish();
    expect(lastResult(evs)).toMatchObject({ toolKey: "Platform", isError: false });
    expect(await skillsOf(owner)).toContain("weekly-report");
    // the audit trail says the agent did it
    const audit = await sql<{ detail: Record<string, unknown> }>`
      SELECT detail FROM capybara.audit_events
      WHERE org_id = ${orgId} AND detail->>'operation' = 'skills.create'`.execute(db);
    expect(audit.rows[0]?.detail).toMatchObject({
      via: "agent",
      conversationId: conv.id,
      operation: "skills.create",
    });

    // (f) the log replays with zero drift
    const runId = (await runsOf(db, conv.id)).at(-1)?.id as string;
    const snap = await takeSnapshot(db, orgId, conv.id, runId, 4_194_304);
    const calls = ofType(toEvents(snap), "model_call");
    expect(calls).toHaveLength(capture.sent.length);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [i, c] of calls.entries()) {
      const info: ModelInfo = (
        await k.app.get(ProviderRegistry).resolve({
          provider: c.payload.provider,
          model: c.payload.model,
        })
      ).info;
      const out = reconstructRequest(snap, c.seq, {
        model: info,
        mediaBudgetBytes: k.app.get(KernelConfigService).get().attachments.requestMediaBytes,
      });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(capture.sent[i]);
    }
  });

  it("(c) a denied write: the model gets the denial and nothing is created", async () => {
    const conv = await conversation(owner);
    const asked = await conv.ask(
      call("skills.create", { name: "denied-skill", description: "d", body: "b" }),
    );
    const res = await decide(owner, asked.payload.approvalId, {
      decision: "deny",
      reason: "not now",
    });
    expect(res.statusCode, res.body).toBe(200);
    const evs = await conv.finish();
    expect(lastResult(evs).isError).toBe(true);
    expect(lastResult(evs).content).toMatch(/denied|not now/i);
    expect(await skillsOf(owner)).not.toContain("denied-skill");
  });

  it("(d) no person present (the org's anonymous guest account): the write is unavailable, no approval", async () => {
    const guest = await accountsFor(db).createLocal({
      login: "anon",
      password: PW,
      displayName: "Anon",
    });
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${orgId}, ${guest.id}, 'guest')`.execute(db);
    await sql`INSERT INTO capybara.org_anonymous_accounts (org_id, account_id)
      VALUES (${orgId}, ${guest.id})`.execute(db);
    const conv = await conversation(await session(k, "anon"));
    const evs = await conv.turn(
      call("skills.create", { name: "anon-skill", description: "d", body: "b" }),
    );
    expect(ofType(evs, "approval_requested")).toEqual([]);
    expect(lastResult(evs).isError).toBe(true);
    expect(await skillsOf(owner)).not.toContain("anon-skill");
  });

  it("(e) read-only refuses writes and still reads; off makes the tool unavailable", async () => {
    try {
      await setSetting("read-only");
      let conv = await conversation(owner);
      let evs = await conv.turn(
        call("skills.create", { name: "ro-skill", description: "d", body: "b" }),
      );
      expect(ofType(evs, "approval_requested")).toEqual([]);
      expect(lastResult(evs).isError).toBe(true);
      expect(lastResult(evs).content).toMatch(/read-only/i);
      evs = await conv.turn(call("skills.list"));
      expect(lastResult(evs).isError).toBe(false);

      await setSetting("off");
      conv = await conversation(owner);
      evs = await conv.turn(platform({ action: "browse" }));
      expect(ofType(evs, "approval_requested")).toEqual([]);
      expect(lastResult(evs).isError).toBe(true);
      expect(lastResult(evs).content).toMatch(/off|unavailable/i);
      expect(await skillsOf(owner)).not.toContain("ro-skill");
    } finally {
      await setSetting("on");
    }
  });

  it("a member's write of an org operation is refused with the reason, no approval", async () => {
    const conv = await conversation(member);
    const evs = await conv.turn(
      call("skills.create", { name: "member-skill", description: "d", body: "b" }),
    );
    expect(ofType(evs, "approval_requested")).toEqual([]);
    expect(lastResult(evs).isError).toBe(true);
    expect(await skillsOf(owner)).not.toContain("member-skill");
  });

  it("params that do not match the schema are refused naming describe, no approval", async () => {
    const conv = await conversation(owner);
    const evs = await conv.turn(call("skills.create", { name: "x" }));
    expect(ofType(evs, "approval_requested")).toEqual([]);
    expect(lastResult(evs).isError).toBe(true);
    expect(lastResult(evs).content).toMatch(/describe/);
  });

  it("(g) two calls with different params: each needs its own approval, none borrows another's", async () => {
    const conv = await conversation(owner);
    const a = { name: "skill-a", description: "d", body: "b" };
    const b = { name: "skill-b", description: "d", body: "b" };
    const msg = `tools:${JSON.stringify(
      [a, b].map((params) => ({
        name: "Platform",
        input: { action: "call", operation: "skills.create", params },
      })),
    )}`;
    const first = await conv.ask(msg);
    const inputOf = async (id: string) =>
      (await approvalOf(owner, id)).input as { params: { name: string } };
    const firstName = (await inputOf(first.payload.approvalId)).params.name;
    expect(
      await decide(owner, first.payload.approvalId, { decision: "approve", scope: "once" }),
    ).toMatchObject({ statusCode: 200 });
    // approving one never runs the other
    const second = await waitFor(
      async () => ofType(await eventsOf(db, conv.id), "approval_requested")[1],
      20_000,
      "second approval_requested",
    );
    expect(second.payload.approvalId).not.toBe(first.payload.approvalId);
    const otherName = firstName === "skill-a" ? "skill-b" : "skill-a";
    expect((await inputOf(second.payload.approvalId)).params.name).toBe(otherName);
    const mid = await skillsOf(owner);
    expect(mid).toContain(firstName);
    expect(mid).not.toContain(otherName);
    await decide(owner, second.payload.approvalId, { decision: "deny" });
    await conv.finish();
    expect(await skillsOf(owner)).not.toContain(otherName);
    await waitForEvent(db, conv.id, (e) => e.type === "run_finished");
  });
});
