import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { ApiError } from "../../src/errors.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { AgentSkillsService } from "../../src/skills/agent-skills.service.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
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
import { makeZip, SKILL_MD } from "../skills/zip.js";

/**
 * Platform operation `agents.register-skill`: the agent registers a zip package from its own
 * sandbox as one of its own skills. Real kernel, model-fake scripts the `Platform` calls, the fake
 * sandbox holds the package, SeaweedFS holds the skill files.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const MODEL = { provider: "model-fake", model: "fake-1" };
const OP = "agents.register-skill";

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let ops: PlatformOperations;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-ops-register-skill-"));
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE, SANDBOX_FAKE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
          "sandbox-fake": { root },
        },
      },
    ),
  );
  ops = k.app.get(PlatformOperations);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let mem: Req;
let memberId: string;
let orgId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.skill_change_requests, capybara.devices, capybara.sandboxes, capybara.skill_versions, capybara.skills, capybara.attachments, capybara.tool_grants, capybara.approvals, capybara.runs, capybara.conversation_events, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  mem = await session(k, "mem");
});

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], t: T) =>
  evs.filter((e): e is Ev<T> => e.type === t);
const lastResult = (evs: ConversationEvent[]) =>
  ofType(evs, "tool_result").at(-1)?.payload as Ev<"tool_result">["payload"];
const call = (params: Record<string, unknown>) =>
  `tool:Platform:${JSON.stringify({ action: "call", operation: OP, params })}`;

async function agentOf(
  accountId: string,
  visibility: "private" | "org",
  writePolicy?: "allow" | "ask",
): Promise<string> {
  const r = await k.app.get(AgentsService).create(orgId, accountId, {
    definition: {
      name: "Writer",
      instructions: "Write skills.",
      model: MODEL,
      disabledTools: builtinsOff("Platform", "Skill"),
      toolPolicies: {},
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      avatarUrl: null,
      ...(writePolicy !== undefined && { skills: { orgSkills: [], writePolicy } }),
    },
    visibility,
  });
  return r.agent.id;
}

const zipOf = (name: string, extra: { name: string; data: string }[] = []) =>
  new Uint8Array(makeZip([{ name: "SKILL.md", data: SKILL_MD(name) }, ...extra]));

/** Writes `data` at `rel` in the conversation's workspace; returns the absolute path. */
async function putFile(
  convId: string,
  accountId: string,
  rel: string,
  data: Uint8Array,
): Promise<string> {
  const deviceId = await k.app.get(ConversationDevices).forTool(orgId, convId);
  return k.app.get(SandboxService).withSandbox(
    { orgId, deviceId, holderConversationId: convId, actor: { accountId, conversationId: convId } },
    async (h, p, info, s) => {
      const path = `${info.roots.workspace}/${rel}`;
      await p.writeFile(h, path, data, s);
      return path;
    },
    new AbortController().signal,
  );
}

const op = () => {
  const o = ops.get(OP);
  if (o === null) throw new Error(`no operation ${OP}`);
  return o;
};
const ctxOf = (accountId: string, agentId: string, conversationId: string): OperationContext => ({
  orgId,
  actorAccountId: accountId,
  agentId,
  conversationId,
  runId: null,
  signal: new AbortController().signal,
});
const classOf = (input: unknown, ctx: OperationContext) => {
  const o = op();
  if (o.confirmFor === undefined) throw new Error("no confirmFor");
  return o.confirmFor(o.input.parse(input), ctx);
};
const precheck = (input: unknown, ctx: OperationContext) => {
  const o = op();
  if (o.precheck === undefined) throw new Error("no precheck");
  return o.precheck(o.input.parse(input), ctx);
};

/** A conversation as `who`; `turn` posts and waits for the run to end, `ask` for an approval. */
async function conversation(who: Req, agentId: string) {
  const id = await createConv(who, orgId, agentId);
  let terminals = 0;
  return {
    id,
    async turn(text: string) {
      await postMessage(who, orgId, id, text);
      await waitForTerminal(db, id, ++terminals, 30_000);
      return eventsOf(db, id);
    },
    async ask(text: string) {
      const before = ofType(await eventsOf(db, id), "approval_requested").length;
      await postMessage(who, orgId, id, text);
      return waitFor(
        async () => ofType(await eventsOf(db, id), "approval_requested")[before],
        20_000,
        "approval_requested",
      );
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

describe("agents.register-skill", { timeout: 120_000 }, () => {
  it("is registered with its parity bookkeeping", () => {
    expect(op()).toMatchObject({
      id: OP,
      mirrors: ["POST /api/v1/orgs/:orgId/agents/:agentId/skills"],
      authz: { orgAction: "agents.create" },
      omits: ["agentId", "uploadId"],
      extras: ["filePath"],
      confirm: "personal",
    });
  });

  it("end to end: the package in the sandbox becomes a skill the agent loads with Skill", async () => {
    const agentId = await agentOf(ownerId, "private");
    const conv = await conversation(owner, agentId);
    const path = await putFile(
      conv.id,
      ownerId,
      "out/weekly.zip",
      zipOf("weekly", [{ name: "scripts/run.sh", data: "echo run\n" }]),
    );

    const asked = await conv.ask(call({ filePath: path }));
    expect(asked.payload.toolKey).toBe(`Platform:${OP}`);
    const view = await approvalOf(owner, asked.payload.approvalId);
    expect(view.scopes).toEqual(["once", "session", "always"]);
    expect(view.summary).toEqual({
      zh: `从 ${path} 为智能体登记技能`,
      en: `Register a skill on this agent from ${path}`,
    });
    await decide(owner, asked.payload.approvalId, { decision: "approve", scope: "once" });
    const evs = await conv.finish();
    const r = lastResult(evs);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("Created");
    expect(r.content).toContain("version 1");
    expect(r.content).toContain("2 files");
    expect(r.content).toContain("Skill");

    // the same run gets the skill in a catalog snapshot: its next model request sees it
    const result = ofType(evs, "tool_result").at(-1);
    const snap = ofType(evs, "skills_catalog").at(-1);
    expect(snap?.runId).toBe(result?.runId);
    expect(snap?.payload.skills.map((s) => s.name)).toEqual(["weekly"]);
    const after = ofType(evs, "model_call").filter(
      (c) => c.seq > Math.max(snap?.seq ?? 0, result?.seq ?? 0),
    );
    expect(after[0]?.runId).toBe(result?.runId);

    const skill = await db
      .selectFrom("skills")
      .selectAll()
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    expect(skill).toMatchObject({ scope: "agent", name: "weekly", current_version: 1 });
    const audit = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "skill.created")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      via: "agent",
      operation: OP,
      agentConversationId: conv.id,
      conversationId: conv.id,
    });

    const loaded = lastResult(await conv.turn('tool:Skill:{"skill":"weekly"}'));
    expect(loaded.isError, loaded.content).toBe(false);
    expect(loaded.content).toContain("Steps.");
  });

  it("a remembered grant applies on the own private agent; never on a shared one", async () => {
    const mine = await agentOf(ownerId, "private");
    const conv = await conversation(owner, mine);
    const p1 = await putFile(conv.id, ownerId, "out/a.zip", zipOf("weekly"));
    const first = await conv.ask(call({ filePath: p1 }));
    await decide(owner, first.payload.approvalId, { decision: "approve", scope: "session" });
    expect(lastResult(await conv.finish()).isError).toBe(false);
    // version 2 runs without a card
    const evs = await conv.turn(call({ filePath: p1 }));
    expect(ofType(evs, "approval_requested")).toHaveLength(1);
    const r = lastResult(evs);
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain("version 2");
    expect(r.content).toContain("Updated");

    const shared = await agentOf(ownerId, "org");
    const sconv = await conversation(owner, shared);
    const p2 = await putFile(sconv.id, ownerId, "out/b.zip", zipOf("weekly"));
    const asked = await sconv.ask(call({ filePath: p2 }));
    expect((await approvalOf(owner, asked.payload.approvalId)).scopes).toEqual(["once"]);
    await decide(owner, asked.payload.approvalId, { decision: "approve", scope: "once" });
    expect(lastResult(await sconv.finish()).isError).toBe(false);
    const again = await sconv.ask(call({ filePath: p2 }));
    expect(again.payload.approvalId).not.toBe(asked.payload.approvalId);
    await decide(owner, again.payload.approvalId, { decision: "deny" });
    expect(lastResult(await sconv.finish()).isError).toBe(true);
  });

  it("confirmFor: personal on the own private agent, org with writePolicy ask or a shared agent", async () => {
    const conv = randomUUID();
    const mine = await agentOf(ownerId, "private");
    expect(await classOf({ filePath: "/w/a.zip" }, ctxOf(ownerId, mine, conv))).toBe("personal");
    const ask = await agentOf(ownerId, "private", "ask");
    expect(await classOf({ filePath: "/w/a.zip" }, ctxOf(ownerId, ask, conv))).toBe("org");
    const shared = await agentOf(ownerId, "org");
    expect(await classOf({ filePath: "/w/a.zip" }, ctxOf(ownerId, shared, conv))).toBe("org");
  });

  it("refuses a sub-agent conversation before reading the sandbox, in precheck and in run", async () => {
    const agentId = await agentOf(ownerId, "private");
    const parent = await createConv(owner, orgId, agentId);
    const child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: ownerId,
        kind: "subagent",
        parent_conversation_id: parent,
        subagent_depth: 1,
        title: "Child",
      })
      .execute();
    const ctx = ctxOf(ownerId, agentId, child);
    // a path that would fail the read: the refusal comes first
    const input = { filePath: "/nowhere/a.zip" };
    expect(await precheck(input, ctx)).toMatchObject({
      ok: false,
      code: "skill.subagent_register",
    });
    const o = op();
    await expect(o.run(o.input.parse(input), ctx)).rejects.toMatchObject({
      code: "skill.subagent_register",
    });
    expect(o.errors?.find((e) => e.code === "skill.subagent_register")?.next).toBe(
      "Hand the skill files back to your parent agent; only the agent the person talks with registers skills.",
    );
  });

  it("refuses a non-owner before reading the sandbox, in precheck and in run", async () => {
    const agentId = await agentOf(ownerId, "org");
    const conv = await createConv(mem, orgId, agentId);
    const ctx = ctxOf(memberId, agentId, conv);
    const input = { filePath: "/nowhere/a.zip" };
    expect(await precheck(input, ctx)).toMatchObject({ ok: false, code: "forbidden" });
    const o = op();
    await expect(o.run(o.input.parse(input), ctx)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("unavailable when the Platform tool is read-only or no person is present", () => {
    const facts: ActorFacts = {
      role: "owner",
      isSuperAdmin: false,
      personPresent: true,
      agentPrivateToActor: true,
      setting: "on",
    };
    expect(availability(op(), facts)).toEqual({ ok: true });
    expect(availability(op(), { ...facts, setting: "read-only" })).toMatchObject({ ok: false });
    expect(availability(op(), { ...facts, personPresent: false })).toMatchObject({ ok: false });
  });

  it("every Task 3 / 4 / 8 code has a next step", () => {
    const codes = op().errors?.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "sandbox.file_invalid_path",
        "sandbox.file_not_found",
        "sandbox.file_is_directory",
        "sandbox.file_too_large",
        "forbidden",
        "agent.not_found",
        "skill.invalid_package",
        "skill.agent_cap",
        "storage.unavailable",
        "skill.subagent_register",
        "skill.proposal_pending_elsewhere",
      ]),
    );
  });
});

describe("AgentSkillsService.register conversation guard", () => {
  it("refuses a conversation of another agent or another org", async () => {
    const a = await agentOf(ownerId, "private");
    const b = await agentOf(ownerId, "private");
    const convOfB = await createConv(owner, orgId, b);
    const svc = k.app.get(AgentSkillsService);
    const code = async (conversationId: string) => {
      try {
        await svc.register(
          { orgId, agentId: a, accountId: ownerId, conversationId },
          zipOf("guarded"),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        return (e as ApiError).code;
      }
      throw new Error("expected a refusal");
    };
    expect(await code(convOfB)).toBe("conversation.not_found");
    expect(await code(randomUUID())).toBe("conversation.not_found");
    expect(await db.selectFrom("skills").select("id").execute()).toEqual([]);
  });
});
