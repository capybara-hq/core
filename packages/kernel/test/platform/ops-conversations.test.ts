import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { builtinsOff } from "../helpers/disabled-tools.js";

/**
 * Platform operations of the conversations domain against PG with the real services: reads, the
 * personal writes (rememberable), delete (asked every time), owner-only visibility and a role
 * that may not call.
 */

let env: OrgEnv;
let ops: PlatformOperations;
let conversations: ConversationsService;

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
  conversations = env.k.app.get(ConversationsService);
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("conversations").execute();
  await env.db.deleteFrom("agents").execute();
});

const op = (id: string) => {
  const o = ops.get(id);
  if (o === null) throw new Error(`no operation ${id}`);
  return o;
};
const facts = (role: ActorFacts["role"]): ActorFacts => ({
  role,
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
});
const run = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.run(o.input.parse(input), ctx).catch((e: unknown) => {
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "member"));
  });
};
const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};
const summarize = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.summary?.(o.input.parse(input), ctx);
};
const classOf = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.confirmFor === undefined ? o.confirm : o.confirmFor(o.input.parse(input), ctx);
};

async function agentOf(owner: string) {
  const r = await env.k.app.get(AgentsService).create(env.orgId, owner, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      disabledSkills: [],
      disabledTools: builtinsOff("Bash"),
      toolPolicies: {},
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      avatarUrl: null,
    },
    visibility: "private",
  });
  return r.agent.id;
}

const ctxOf = (accountId: string, agentId: string, conversationId: string = randomUUID()) =>
  ({
    orgId: env.orgId,
    actorAccountId: accountId,
    agentId,
    conversationId,
    runId: randomUUID(),
    signal: new AbortController().signal,
  }) satisfies OperationContext;

describe("registration", () => {
  it("registers the conversation operations", () => {
    expect(
      ops
        .all()
        .map((o) => o.id)
        .filter((id) => id.startsWith("conversations.")),
    ).toEqual([
      "conversations.abort",
      "conversations.agent-tree",
      "conversations.archive",
      "conversations.background-tasks",
      "conversations.delete",
      "conversations.device",
      "conversations.events",
      "conversations.files",
      "conversations.get",
      "conversations.list",
      "conversations.rename",
      "conversations.stop-background-task",
      "conversations.subagents",
      "conversations.unarchive",
      "conversations.usage",
    ]);
  });
});

describe("reads", () => {
  it("lists only my conversations as compact rows, and gets one", async () => {
    const agent = await agentOf(env.memId);
    const mine = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    const otherAgent = await agentOf(env.bossId);
    await conversations.create(env.orgId, env.bossId, otherAgent, {}, { source: "web" });
    const c = ctxOf(env.memId, agent);
    const out = (await run("conversations.list", {}, c)) as {
      conversations: { id: string; name: string; state: string; agentId: string }[];
      next: string | null;
    };
    expect(out.conversations).toHaveLength(1);
    expect(out.conversations[0]).toMatchObject({
      id: mine.id,
      name: "Untitled",
      state: "idle",
      agentId: agent,
    });
    expect(out.next).toBeNull();
    const got = (await run("conversations.get", { conversationId: mine.id }, c)) as {
      conversation: { id: string };
    };
    expect(got.conversation.id).toBe(mine.id);
    expect(availability(op("conversations.list"), facts("guest"))).toEqual({ ok: true });
  });

  it("someone else's conversation is not found, with the next step", async () => {
    const agent = await agentOf(env.bossId);
    const theirs = await conversations.create(env.orgId, env.bossId, agent, {}, { source: "web" });
    await expect(
      run("conversations.get", { conversationId: theirs.id }, ctxOf(env.memId, agent)),
    ).rejects.toThrow(/conversations\.list/);
  });

  it("reads the events of a conversation and refuses after together with before", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    await conversations.postUserMessage(env.orgId, conv.id, env.memId, { text: "hello there" });
    const c = ctxOf(env.memId, agent);
    const out = (await run("conversations.events", { conversationId: conv.id }, c)) as {
      events: { type: string }[];
    };
    expect(out.events.some((e) => e.type === "user_message")).toBe(true);
    const tail = (await run(
      "conversations.events",
      { conversationId: conv.id, before: "end" },
      c,
    )) as { events: unknown[]; turnsBefore: number };
    expect(tail.events.length).toBeGreaterThan(0);
    expect(() =>
      op("conversations.events").input.parse({ conversationId: conv.id, after: 1, before: 2 }),
    ).toThrow();
  });
});

describe("personal writes", () => {
  it("rename keeps the title, names the target in the card and may be remembered", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    const c = ctxOf(env.memId, agent);
    const input = { conversationId: conv.id, title: "Q3 report" };
    expect(await precheck("conversations.rename", input, c)).toEqual({ ok: true });
    expect(await classOf("conversations.rename", input, c)).toBe("personal");
    expect(await summarize("conversations.rename", input, c)).toEqual({
      zh: `将对话「${conv.id}」重命名为「Q3 report」`,
      en: `Rename conversation "${conv.id}" to "Q3 report"`,
    });
    await run("conversations.rename", input, c);
    expect((await conversations.get(env.orgId, conv.id, env.memId)).title).toBe("Q3 report");
  });

  it("archive and unarchive move the conversation out of and back into the list", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    const c = ctxOf(env.memId, agent);
    await run("conversations.archive", { conversationId: conv.id }, c);
    const listed = async (archived?: "1") =>
      (
        (await run("conversations.list", archived ? { archived } : {}, c)) as {
          conversations: { id: string; state: string }[];
        }
      ).conversations;
    expect(await listed()).toEqual([]);
    expect((await listed("1"))[0]).toMatchObject({ id: conv.id, state: "archived" });
    await run("conversations.unarchive", { conversationId: conv.id }, c);
    expect((await listed()).map((r) => r.id)).toEqual([conv.id]);
    expect(
      (await summarize("conversations.archive", { conversationId: conv.id }, c))?.en,
    ).toContain("Archive conversation");
  });

  it("a write on someone else's conversation is denied before the card", async () => {
    const agent = await agentOf(env.bossId);
    const theirs = await conversations.create(env.orgId, env.bossId, agent, {}, { source: "web" });
    const r = await precheck(
      "conversations.rename",
      { conversationId: theirs.id, title: "mine now" },
      ctxOf(env.memId, agent),
    );
    expect(r).toMatchObject({ ok: false, code: "conversation.not_found" });
  });

  it("a non-member cannot call any of them", () => {
    for (const id of ["conversations.list", "conversations.rename", "conversations.delete"]) {
      expect(availability(op(id), facts(null)).ok).toBe(false);
    }
  });
});

describe("delete", () => {
  it("is never remembered, names the target, and hides the conversation", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    await conversations.rename(env.orgId, conv.id, env.memId, "Old chat");
    const c = ctxOf(env.memId, agent);
    const input = { conversationId: conv.id };
    expect(await classOf("conversations.delete", input, c)).toBe("personal");
    expect(op("conversations.delete").rememberable).toBe(false);
    expect(op("conversations.abort").rememberable).toBe(false);
    expect(await summarize("conversations.delete", input, c)).toEqual({
      zh: "删除对话「Old chat」",
      en: 'Delete conversation "Old chat"',
    });
    expect(await precheck("conversations.delete", input, c)).toEqual({ ok: true });
    expect(await run("conversations.delete", input, c)).toEqual({
      deleted: true,
      conversationId: conv.id,
    });
    await expect(run("conversations.get", input, c)).rejects.toThrow();
  });

  it("refuses the run's root conversation also from a sub-agent's run", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    const child = randomUUID();
    await env.db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: env.orgId,
        agent_id: agent,
        account_id: env.memId,
        kind: "subagent",
        source: "subagent",
        parent_conversation_id: conv.id,
        subagent_depth: 1,
        title: "Child",
      })
      .execute();
    const fromChild = ctxOf(env.memId, agent, child);
    for (const id of ["conversations.delete", "conversations.abort"]) {
      expect(await precheck(id, { conversationId: conv.id }, fromChild)).toMatchObject({
        ok: false,
        code:
          id === "conversations.delete"
            ? "conversation.delete_current"
            : "conversation.abort_current",
      });
    }
  });

  it("refuses the conversation the run is in, and someone else's", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    const here = ctxOf(env.memId, agent, conv.id);
    expect(await precheck("conversations.delete", { conversationId: conv.id }, here)).toMatchObject(
      {
        ok: false,
        code: "conversation.delete_current",
      },
    );
    const boss = await agentOf(env.bossId);
    expect(
      await precheck("conversations.delete", { conversationId: conv.id }, ctxOf(env.bossId, boss)),
    ).toMatchObject({ ok: false, code: "conversation.not_found" });
  });
});

describe("conversation detail reads and abort", () => {
  it("reads usage, sub-agents, the agent tree, files and the device of my conversation", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    const c = ctxOf(env.memId, agent);
    const input = { conversationId: conv.id };
    expect(await run("conversations.usage", input, c)).toEqual({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(await run("conversations.subagents", input, c)).toEqual({ subagents: [], next: null });
    expect(await run("conversations.files", input, c)).toEqual({ files: [], next: null });
    expect(
      (await run("conversations.agent-tree", input, c)) as { root: { id: string } },
    ).toMatchObject({
      root: { id: conv.id },
    });
    expect(await run("conversations.device", input, c)).toHaveProperty("device");
  });

  it("someone else's conversation is not found for each detail read", async () => {
    const agent = await agentOf(env.bossId);
    const theirs = await conversations.create(env.orgId, env.bossId, agent, {}, { source: "web" });
    const c = ctxOf(env.memId, agent);
    for (const id of [
      "conversations.usage",
      "conversations.subagents",
      "conversations.files",
      "conversations.agent-tree",
      "conversations.device",
    ]) {
      await expect(run(id, { conversationId: theirs.id }, c)).rejects.toThrow(
        /conversations\.list/,
      );
    }
  });

  it("abort asks every time, names the target, and reports no active run", async () => {
    const agent = await agentOf(env.memId);
    const conv = await conversations.create(env.orgId, env.memId, agent, {}, { source: "web" });
    await conversations.rename(env.orgId, conv.id, env.memId, "Busy chat");
    const c = ctxOf(env.memId, agent);
    const input = { conversationId: conv.id };
    expect(await classOf("conversations.abort", input, c)).toBe("personal");
    expect(await precheck("conversations.abort", input, c)).toEqual({ ok: true });
    expect((await summarize("conversations.abort", input, c))?.en).toBe(
      'Stop the active run in conversation "Busy chat"',
    );
    await expect(run("conversations.abort", input, c)).rejects.toThrow(/No run is active/);
  });
});
