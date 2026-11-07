import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentsService } from "../../src/agents/agents.service.js";
import { OrgAgentTemplates } from "../../src/agents/org-templates.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { nextStepFor, toToolError } from "../../src/platform/errors.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { seedConnector } from "../helpers/tool-fixtures.js";

/**
 * Task 11 of the Platform tool: evals, connectors (delete, refresh), the agents routes beyond the
 * basics (delete, versions, pending connectors, readiness), the org's agent templates, org models,
 * background tasks and file previewers, against PG with the real services. Operations run by
 * `op.run(input, ctx)`, refusals by `availability()`.
 */

let env: OrgEnv;
let ops: PlatformOperations;

beforeAll(async () => {
  env = await startOrgEnv();
  ops = env.k.app.get(PlatformOperations);
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("eval_sets").execute();
  await env.db.deleteFrom("conversations").execute();
  await env.db.deleteFrom("agents").execute();
});

const MODEL = { provider: "model-fake", model: "fake-1" };

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
    throw toToolError(e, (code) => nextStepFor(o.errors, code, "orgAdmin"));
  });
};
const precheck = (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  if (o.precheck === undefined) throw new Error(`${id} has no precheck`);
  return o.precheck(o.input.parse(input), ctx);
};
const summarize = async (id: string, input: unknown, ctx: OperationContext) =>
  op(id).summary?.(op(id).input.parse(input), ctx);
const classOf = async (id: string, input: unknown, ctx: OperationContext) => {
  const o = op(id);
  return o.confirmFor === undefined ? o.confirm : o.confirmFor(o.input.parse(input), ctx);
};

async function agentOf(owner: string, visibility: "private" | "org", name = "Helper") {
  const r = await env.k.app.get(AgentsService).create(env.orgId, owner, {
    definition: {
      name,
      instructions: "Be helpful.",
      model: MODEL,
      tools: [{ kind: "builtin", name: "Bash" }],
      toolPolicies: {},
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      avatarUrl: null,
    },
    visibility,
  });
  return r.agent.id;
}

const ctxOf = (accountId: string, agentId: string = randomUUID()): OperationContext => ({
  orgId: env.orgId,
  actorAccountId: accountId,
  agentId,
  conversationId: randomUUID(),
  runId: randomUUID(),
  signal: new AbortController().signal,
});

const audits = (action: string) =>
  env.db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

describe("registration", () => {
  it("registers the operations of the evals, background and previewer groups", () => {
    const ids = ops.all().map((o) => o.id);
    expect(ids.filter((id) => id.startsWith("evals."))).toEqual([
      "evals.add-case",
      "evals.cancel-run",
      "evals.create-set",
      "evals.delete-set",
      "evals.estimate-run",
      "evals.get-case",
      "evals.get-result",
      "evals.get-run",
      "evals.get-set",
      "evals.label-result",
      "evals.list-results",
      "evals.list-runs",
      "evals.list-sets",
      "evals.remove-case",
      "evals.sample-cases",
      "evals.start-run",
      "evals.update-set",
    ]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "conversations.background-tasks",
        "conversations.stop-background-task",
        "extensions.previewers",
        "extensions.set-previewers",
        "models.available",
        "models.catalog",
        "connectors.delete",
        "connectors.refresh",
        "agents.delete",
        "agents.versions",
        "agents.readiness",
        "agent-templates.update",
        "agent-templates.delete",
      ]),
    );
  });
});

/** A finished run with one step in a conversation of `agentId`: what a case snapshot is taken of. */
async function seedFinishedRun(agentId: string, accountId: string) {
  const conv = await env.k.app.get(ConversationsService).create(env.orgId, accountId, agentId, {});
  const log = env.k.app.get(EventLog);
  const runId = randomUUID();
  const [msg] = await log.append(conv.id, [
    {
      type: "user_message",
      payload: {
        content: [{ type: "text", text: "What is the refund window?" }],
        authorAccountId: accountId,
      },
    },
  ]);
  await env.db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conv.id,
      status: "completed",
      agent_version: 1,
      trigger_account_id: accountId,
      trigger_seq: msg?.seq ?? 0,
      started_at: new Date(),
      finished_at: new Date(),
    })
    .execute();
  await log.append(conv.id, [
    {
      type: "run_started",
      runId,
      payload: { agentVersion: 1, model: MODEL, triggerAccountId: accountId },
    },
    {
      type: "model_call",
      runId,
      payload: {
        step: 0,
        attempt: 0,
        provider: MODEL.provider,
        model: MODEL.model,
        fallback: false,
        request: { fromSeq: 1, toSeq: 1, summarySeq: null, systemHash: "h", reminderSeqs: [] },
      },
    },
    {
      type: "assistant_message",
      runId,
      payload: {
        step: 0,
        content: [{ type: "text", text: "Thirty days." }],
        stopReason: "end_turn",
      },
    },
    {
      type: "usage",
      runId,
      payload: {
        step: 0,
        provider: MODEL.provider,
        model: MODEL.model,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    {
      type: "run_finished",
      runId,
      payload: { reason: "completed", consumedUpToSeq: msg?.seq ?? 0 },
    },
  ]);
  return { conversationId: conv.id, runId };
}

describe("evals", () => {
  it("an org admin creates, lists, reads, updates and deletes a set; the audit says it came from the agent", async () => {
    const agent = await agentOf(env.bossId, "org");
    const c = ctxOf(env.bossId, agent);
    expect(await summarize("evals.create-set", { agentId: agent, name: "Refunds" }, c)).toEqual({
      zh: `新建评测集「Refunds」（智能体 ${agent}）`,
      en: `Create eval set "Refunds" for agent ${agent}`,
    });
    expect(await classOf("evals.create-set", { agentId: agent, name: "Refunds" }, c)).toBe("org");
    const created = (await run("evals.create-set", { agentId: agent, name: "Refunds" }, c)) as {
      set: { id: string; state: string; next?: string };
    };
    expect(created.set).toMatchObject({ state: "empty" });
    expect(created.set.next).toContain("evals.add-case");
    const [row] = await audits("eval.set_created");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "evals.create-set" });

    const list = (await run("evals.list-sets", {}, c)) as {
      items: { id: string; name: string; state: string; caseCount: number }[];
      next: string | null;
    };
    expect(list.items).toMatchObject([{ id: created.set.id, name: "Refunds", caseCount: 0 }]);
    const got = (await run("evals.get-set", { setId: created.set.id }, c)) as {
      set: { name: string };
      cases: unknown[];
    };
    expect(got).toMatchObject({ set: { name: "Refunds" }, cases: [] });

    await run("evals.update-set", { setId: created.set.id, name: "Refund policy" }, c);
    const [upd] = await audits("eval.set_updated");
    expect(upd?.detail).toMatchObject({
      via: "agent",
      operation: "evals.update-set",
      fields: ["name"],
    });
    expect(() => op("evals.update-set").input.parse({ setId: created.set.id })).toThrow();

    expect(await precheck("evals.delete-set", { setId: created.set.id }, c)).toEqual({
      ok: true,
    });
    expect(await summarize("evals.delete-set", { setId: created.set.id }, c)).toMatchObject({
      en: expect.stringContaining('Delete eval set "Refund policy"'),
    });
    await run("evals.delete-set", { setId: created.set.id }, c);
    const [del] = await audits("eval.set_deleted");
    expect(del?.detail).toMatchObject({ via: "agent", operation: "evals.delete-set" });
    expect(await precheck("evals.delete-set", { setId: created.set.id }, c)).toMatchObject({
      ok: false,
      code: "eval.set_not_found",
    });
    await expect(run("evals.get-set", { setId: created.set.id }, c)).rejects.toThrow(
      /evals\.list-sets/,
    );
  });

  it("a member does not get the evals operations", () => {
    for (const id of ["evals.list-sets", "evals.create-set", "evals.get-case", "evals.start-run"]) {
      const a = availability(op(id), facts("member"));
      expect(a.ok, id).toBe(false);
    }
    expect(availability(op("evals.list-sets"), facts("admin"))).toEqual({ ok: true });
  });

  it("adds a case, reads its trajectory with audits naming the operation, and removes it", async () => {
    const agent = await agentOf(env.bossId, "org");
    const c = ctxOf(env.bossId, agent);
    const { set } = (await run("evals.create-set", { agentId: agent, name: "S" }, c)) as {
      set: { id: string };
    };
    const seeded = await seedFinishedRun(agent, env.memId);
    const added = (await run(
      "evals.add-case",
      { setId: set.id, conversationId: seeded.conversationId, runId: seeded.runId },
      c,
    )) as { case: { id: string; name: string } };
    // the label is neutral: a title is an excerpt of the person's message
    expect(added.case.name).toBe("case 1");
    expect(JSON.stringify(added)).not.toContain("refund window");
    const [caseAudit] = await audits("eval.case_added");
    expect(caseAudit?.detail).toMatchObject({ via: "agent", operation: "evals.add-case" });
    // a known failure is denied before the card
    expect(
      await precheck(
        "evals.add-case",
        { setId: set.id, conversationId: seeded.conversationId, runId: seeded.runId },
        c,
      ),
    ).toMatchObject({ ok: false, code: "eval.case_exists" });
    await expect(
      run(
        "evals.add-case",
        { setId: set.id, conversationId: seeded.conversationId, runId: seeded.runId },
        c,
      ),
    ).rejects.toThrow(/already a case/);

    // metadata only: no trajectory, no title, no message text, and no trajectory view is audited
    const detail = await run("evals.get-case", { setId: set.id, caseId: added.case.id }, c);
    expect(detail).toMatchObject({ case: { id: added.case.id, name: "case 1", agentVersion: 1 } });
    expect(JSON.stringify(detail)).not.toMatch(/refund window|Thirty days|trajectory/);
    expect(await audits("trajectory.viewed")).toEqual([]);
    expect(
      await summarize("evals.remove-case", { setId: set.id, caseId: added.case.id }, c),
    ).toMatchObject({ en: expect.stringContaining('Remove case 1 from eval set "S"') });
    expect(
      await precheck("evals.remove-case", { setId: set.id, caseId: randomUUID() }, c),
    ).toMatchObject({ ok: false, code: "eval.case_not_found" });

    const listed = (await run("evals.get-set", { setId: set.id }, c)) as {
      cases: { id: string }[];
    };
    expect(listed.cases.map((x) => x.id)).toEqual([added.case.id]);

    // the estimate is a read: a candidate that fits the case prices it without writing
    const est = (await run(
      "evals.estimate-run",
      { setId: set.id, mode: "step", candidate: {} },
      c,
    )) as { estimate: { cases: number } };
    expect(est.estimate.cases).toBeGreaterThan(0);
    expect(
      await precheck("evals.start-run", { setId: set.id, mode: "step", candidate: {} }, c),
    ).toEqual({ ok: true });

    await run("evals.remove-case", { setId: set.id, caseId: added.case.id }, c);
    const [gone] = await audits("eval.case_removed");
    expect(gone?.detail).toMatchObject({ via: "agent", operation: "evals.remove-case" });
  });

  it("start-run is denied before the card when the set has nothing to replay", async () => {
    const agent = await agentOf(env.bossId, "org");
    const c = ctxOf(env.bossId, agent);
    const { set } = (await run("evals.create-set", { agentId: agent, name: "Empty" }, c)) as {
      set: { id: string };
    };
    const out = await precheck(
      "evals.start-run",
      { setId: set.id, mode: "step", candidate: {} },
      c,
    );
    expect(out).toMatchObject({ ok: false });
  });

  it("lists results without content, labels one, and cancels or refuses to cancel a run", async () => {
    const agent = await agentOf(env.bossId, "org");
    const c = ctxOf(env.bossId, agent);
    const { set } = (await run("evals.create-set", { agentId: agent, name: "S" }, c)) as {
      set: { id: string };
    };
    const seeded = await seedFinishedRun(agent, env.memId);
    const { case: kase } = (await run(
      "evals.add-case",
      { setId: set.id, conversationId: seeded.conversationId, runId: seeded.runId },
      c,
    )) as { case: { id: string } };
    const mkRun = async (status: string) => {
      const id = randomUUID();
      await env.db
        .insertInto("eval_runs")
        .values({
          id,
          org_id: env.orgId,
          set_id: set.id,
          mode: "step",
          candidate: JSON.stringify({}),
          judge: false,
          token_cap: 1000,
          status: status as "queued",
          cases_total: 1,
          estimate: JSON.stringify({
            cases: 1,
            modelRequests: 1,
            judgeRequests: 0,
            estimatedTokens: 10,
            estimatedCost: null,
            judgeTokens: 0,
            judgeCost: null,
            currency: "USD",
          }),
          created_by: env.bossId,
        })
        .execute();
      return id;
    };
    const finished = await mkRun("completed");
    const queued = await mkRun("queued");
    const resultId = randomUUID();
    await env.db
      .insertInto("eval_results")
      .values({
        id: resultId,
        run_id: finished,
        case_id: kase.id,
        org_id: env.orgId,
        step: 0,
        status: "done",
        candidate: JSON.stringify({ text: "secret candidate answer" }),
      })
      .execute();

    const runs = (await run("evals.list-runs", { setId: set.id }, c)) as {
      items: { id: string; state: string; progress: string }[];
    };
    expect(runs.items.map((r) => r.state).sort()).toEqual(["completed", "queued"]);
    const results = (await run("evals.list-results", { runId: finished }, c)) as {
      items: { id: string; name: string; state: string }[];
      next: string | null;
    };
    expect(results.items).toMatchObject([{ id: resultId, name: "step 0", state: "done" }]);
    expect(JSON.stringify(results)).not.toContain("secret candidate answer");
    const full = (await run("evals.get-result", { runId: finished, resultId }, c)) as {
      result: Record<string, unknown>;
    };
    expect(full.result).toMatchObject({ id: resultId, state: "done", step: 0, drift: [] });
    expect(JSON.stringify(full)).not.toContain("secret candidate answer");
    expect(full.result).not.toHaveProperty("candidate");
    expect(full.result).not.toHaveProperty("baseline");
    expect(full.result).not.toHaveProperty("diff");
    expect(
      await precheck("evals.label-result", { resultId: randomUUID(), label: "pass" }, c),
    ).toMatchObject({ ok: false, code: "eval.result_not_found" });
    const [seen] = await audits("eval.results_viewed");
    expect(seen?.detail).toMatchObject({ via: "agent", operation: "evals.list-results" });

    await run("evals.label-result", { resultId, label: "pass", note: "good" }, c);
    const [lab] = await audits("eval.result_labeled");
    expect(lab?.detail).toMatchObject({ via: "agent", operation: "evals.label-result" });
    expect(await summarize("evals.label-result", { resultId, label: "fail" }, c)).toMatchObject({
      en: `Label eval result ${resultId} as fail`,
    });

    expect(await precheck("evals.cancel-run", { runId: finished }, c)).toMatchObject({
      ok: false,
      code: "eval.run_finished",
    });
    expect(await precheck("evals.cancel-run", { runId: queued }, c)).toEqual({ ok: true });
    const done = (await run("evals.cancel-run", { runId: queued }, c)) as {
      run: { state: string };
    };
    expect(done.run.state).toBe("cancelled");
    const [can] = await audits("eval.run_cancelled");
    expect(can?.detail).toMatchObject({ via: "agent", operation: "evals.cancel-run" });
    const got = (await run("evals.get-run", { runId: queued }, c)) as { run: { status: string } };
    expect(got.run.status).toBe("cancelled");
  });
});

describe("connectors: delete and refresh", () => {
  it("deletes a connector with a card naming it, and the audit names the operation", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the raw handle the fixture takes
    const id = await seedConnector(env.db as any, env.orgId, env.bossId, {
      slug: "crm",
      name: "CRM",
    });
    const c = ctxOf(env.bossId);
    expect(await precheck("connectors.delete", { connectorId: id }, c)).toEqual({ ok: true });
    expect(await classOf("connectors.delete", { connectorId: id }, c)).toBe("org");
    expect(await summarize("connectors.delete", { connectorId: id }, c)).toMatchObject({
      en: expect.stringContaining('Delete connector "CRM"'),
    });
    expect(await summarize("connectors.refresh", { connectorId: id }, c)).toMatchObject({
      en: expect.stringContaining('connector "CRM"'),
    });
    await run("connectors.delete", { connectorId: id }, c);
    const [row] = await audits("connector.deleted");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "connectors.delete" });
    expect(await precheck("connectors.delete", { connectorId: id }, c)).toMatchObject({
      ok: false,
      code: "connector.not_found",
    });
    expect(availability(op("connectors.delete"), facts("member")).ok).toBe(false);
  });
});

describe("agents: delete, versions, readiness and pending connectors", () => {
  it("deleting is asked every time, refuses the agent it runs as, and audits the operation", async () => {
    const mine = await agentOf(env.memId, "private");
    const shared = await agentOf(env.bossId, "org", "Shared");
    const c = ctxOf(env.memId, shared);
    const o = op("agents.delete");
    expect(o.rememberable).toBe(false);
    expect(await classOf("agents.delete", { agentId: mine }, c)).toBe("personal");
    expect(await classOf("agents.delete", { agentId: shared }, ctxOf(env.bossId, mine))).toBe(
      "org",
    );
    // the agent the call runs as stays
    expect(await precheck("agents.delete", { agentId: shared }, c)).toMatchObject({
      ok: false,
      code: "agent.delete_current",
    });
    // a member may not delete another person's shared agent: denied before the card
    expect(
      await precheck("agents.delete", { agentId: shared }, ctxOf(env.memId, mine)),
    ).toMatchObject({ ok: false, code: "forbidden" });
    await expect(
      run("agents.delete", { agentId: shared }, ctxOf(env.memId, mine)),
    ).rejects.toThrow();
    // a sub-agent runs under its parent's agent: that one stays too
    const parent = await env.k.app
      .get(ConversationsService)
      .create(env.orgId, env.memId, shared, {});
    const childId = randomUUID();
    await env.db
      .insertInto("conversations")
      .values({
        id: childId,
        org_id: env.orgId,
        agent_id: mine,
        account_id: env.memId,
        title: "Child",
        kind: "subagent",
        parent_conversation_id: parent.id,
        subagent_type: "general-purpose",
        subagent_depth: 1,
      })
      .execute();
    expect(
      await precheck(
        "agents.delete",
        { agentId: shared },
        {
          ...ctxOf(env.bossId, mine),
          conversationId: childId,
        },
      ),
    ).toMatchObject({ ok: false, code: "agent.delete_current" });
    expect(await summarize("agents.delete", { agentId: mine }, c)).toEqual({
      zh: "删除私有智能体「Helper」",
      en: 'Delete private agent "Helper"',
    });
    await run("agents.delete", { agentId: mine }, c);
    const [row] = await audits("agent.deleted");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "agents.delete" });
    expect(row?.target).toBe(mine);
  });

  it("reads versions and readiness", async () => {
    const mine = await agentOf(env.memId, "private");
    const c = ctxOf(env.memId, mine);
    const v = (await run("agents.versions", { agentId: mine }, c)) as {
      versions: { version: number }[];
    };
    expect(v.versions.map((x) => x.version)).toEqual([1]);
    const r = (await run("agents.readiness", {}, c)) as { modelProvider: string; agents: number };
    expect(r).toMatchObject({ modelProvider: "ready", agents: 1 });
    // another person's private agent is not found
    const theirs = await agentOf(env.bossId, "private", "Theirs");
    await expect(run("agents.versions", { agentId: theirs }, c)).rejects.toThrow(/agents\.list/);
  });

  it("pending connector operations speak when there is nothing pending", async () => {
    const mine = await agentOf(env.memId, "private");
    const c = ctxOf(env.memId, randomUUID());
    expect(await run("agents.connector-setup-status", { agentId: mine }, c)).toEqual({
      request: null,
    });
    await expect(run("agents.request-connector-setup", { agentId: mine }, c)).rejects.toThrow(
      /waits for no connectors/,
    );
    await expect(
      run("agents.bind-connector", { agentId: mine, key: "crm", connectorId: randomUUID() }, c),
    ).rejects.toThrow();
    expect(
      await classOf("agents.bind-connector", { agentId: mine, key: "crm", connectorId: "x" }, c),
    ).toBe("personal");
  });
});

describe("agent templates: update, share and delete", () => {
  it("updates with the version read, refuses a stale one, shares and deletes with audits", async () => {
    const agent = await agentOf(env.bossId, "org");
    const c = ctxOf(env.bossId, agent);
    const saved = await env.k.app.get(OrgAgentTemplates).saveAs(env.orgId, env.bossId, agent, {
      name: "triage",
      description: "Triages requests.",
    });
    const id = saved.template.id;
    const def = { ...saved.template.definition, description: "Triages every request." };
    expect(
      await precheck("agent-templates.update", { templateId: id, version: 1, definition: def }, c),
    ).toEqual({ ok: true });
    await run("agent-templates.update", { templateId: id, version: 1, definition: def }, c);
    const [upd] = await audits("agent_template.updated");
    expect(upd?.detail).toMatchObject({ via: "agent", operation: "agent-templates.update" });
    await expect(
      run(
        "agent-templates.update",
        { templateId: id, version: 1, definition: { ...def, description: "Again." } },
        c,
      ),
    ).rejects.toThrow(/agent-templates\.get/);

    const preview = (await run("agent-templates.delete-preview", { templateId: id }, c)) as {
      preview: { outcome: string };
    };
    expect(preview.preview.outcome).toBe("removed");
    await run("agent-templates.set-shareable", { templateId: id, shareable: true }, c);
    const [share] = await audits("catalog.shareable_changed");
    expect(share?.detail ?? {}).toMatchObject({ via: "agent" });

    expect(await classOf("agent-templates.delete", { templateId: id }, c)).toBe("org");
    expect(await summarize("agent-templates.delete", { templateId: id }, c)).toMatchObject({
      en: expect.stringContaining('Delete org agent template "triage"'),
    });
    await run("agent-templates.delete", { templateId: id }, c);
    const [del] = await audits("agent_template.deleted");
    expect(del?.detail).toMatchObject({ via: "agent", operation: "agent-templates.delete" });
    expect(availability(op("agent-templates.delete"), facts("member")).ok).toBe(false);
  });
});

describe("org models", () => {
  it("lists the available models as rows, and the catalog for org admins", async () => {
    const c = ctxOf(env.memId);
    const out = (await run("models.available", {}, c)) as {
      items: { id: string; state: string; provider: string; kind: string }[];
      total: number;
    };
    expect(out.items.some((m) => m.id === "model-fake/fake-1")).toBe(true);
    expect(out.items[0]?.state).toBe("enabled");
    const cat = (await run("models.catalog", {}, ctxOf(env.bossId))) as {
      items: { id: string; state: string; models: { id: string; state: string }[] }[];
    };
    expect(cat.items.find((p) => p.id === "model-fake")?.models.map((m) => m.id)).toContain(
      "fake-1",
    );
    expect(availability(op("models.catalog"), facts("member")).ok).toBe(false);
    expect(availability(op("models.available"), facts("member"))).toEqual({ ok: true });
  });
});

describe("background tasks and previewers", () => {
  it("lists the background tasks of my conversation and refuses a task that is not there", async () => {
    const agent = await agentOf(env.memId, "private");
    const conv = await env.k.app.get(ConversationsService).create(env.orgId, env.memId, agent, {});
    const c = ctxOf(env.memId, agent);
    expect(await run("conversations.background-tasks", { conversationId: conv.id }, c)).toEqual({
      items: [],
      total: 0,
      next: null,
    });
    expect(
      await classOf(
        "conversations.stop-background-task",
        { conversationId: conv.id, taskId: "bg-1" },
        c,
      ),
    ).toBe("personal");
    await expect(
      run("conversations.stop-background-task", { conversationId: conv.id, taskId: "bg-1" }, c),
    ).rejects.toThrow(/conversations\.background-tasks/);
    // someone else's conversation is not found
    const other = await agentOf(env.bossId, "private", "Other");
    const theirs = await env.k.app
      .get(ConversationsService)
      .create(env.orgId, env.bossId, other, {});
    await expect(
      run("conversations.background-tasks", { conversationId: theirs.id }, c),
    ).rejects.toThrow(/conversations\.list/);
  });

  it("reads the previewers for org admins and sets the order with an audit naming the operation", async () => {
    const c = ctxOf(env.bossId);
    const before = (await run("extensions.previewers", {}, c)) as {
      items: unknown[];
      total: number;
    };
    expect(before.total).toBe(before.items.length);
    await run("extensions.set-previewers", { items: [] }, c);
    const [row] = await audits("org.file_previewers.updated");
    expect(row?.detail).toMatchObject({ via: "agent", operation: "extensions.set-previewers" });
    await expect(
      run(
        "extensions.set-previewers",
        { items: [{ plugin: "nope", id: "x", disabled: false }] },
        c,
      ),
    ).rejects.toThrow(/extensions\.previewers/);
    expect(availability(op("extensions.set-previewers"), facts("member")).ok).toBe(false);
    expect(await summarize("extensions.set-previewers", { items: [] }, c)).toMatchObject({
      en: expect.stringContaining("Set the order of file previewers"),
    });
  });
});
