import { randomUUID } from "node:crypto";
import type { AgentTemplate } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { loadTemplates, usableTemplates } from "../../src/agents/templates.js";
import { referenceIds } from "../../src/catalog/component-state.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { currentTemplate } from "../../src/evals/worker.js";
import { resolveRoster } from "../../src/runtime/subagents/roster.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { truncateTables } from "../helpers/db.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import { createConv, eventsOf, postMessage, waitFor, waitForTerminal } from "../helpers/runs.js";

/**
 * Plugin scope phase 2, Task 4: agent templates resolve from platform components. A platform
 * template that is on in the org (its plugin on there for `follow`, its own scope for `own`, no
 * switch off, not disabled) is selectable by id and is in the roster as `<plugin>:<name>` (bare
 * `<name>` without a plugin). Org copies linked to it (ruling B2) resolve to its current version
 * under their own id unless pinned; a child keeps its frozen definition, and a follow-up finds its
 * roster entry by the template id `subagent_started` recorded.
 */

let env: OrgEnv;
const capture = captureProviderRequests();

beforeAll(async () => {
  capture.install();
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  capture.restore();
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await truncateTables(env.db, "capybara.conversations");
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
  capture.reset();
});

const tpl = (name: string, instructions: string): AgentTemplate => ({
  name,
  description: `Reviews ${name} work.`,
  instructions,
});

async function catalogItem(plugin: string): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("catalog_items")
    .values({
      id,
      name: plugin,
      package_name: `@acme/plugin-${plugin}`,
      publisher: "Acme",
      description: "d",
      latest_version: "1.0.0",
      policy: "allow",
    })
    .execute();
  return id;
}

/** A platform template `<plugin>:<name>` at version 1 (more versions: `bodies`). */
async function seedPlatform(o: {
  name: string;
  plugin: string | null;
  bodies: string[];
  scopeMode?: "follow" | "own";
  scope?: "all" | "optional" | "named";
  disabled?: boolean;
  itemId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("platform_agent_templates")
    .values({
      id,
      catalog_item_id: o.itemId ?? null,
      plugin_name: o.plugin,
      name: o.name,
      description: `Reviews ${o.name} work.`,
      current_version: o.bodies.length,
      scope_mode: o.scopeMode ?? "own",
      scope: o.scope ?? "all",
      disabled: o.disabled ?? false,
    })
    .execute();
  for (const [i, body] of o.bodies.entries()) {
    await env.db
      .insertInto("platform_agent_template_versions")
      .values({
        template_id: id,
        version: i + 1,
        definition: JSON.stringify(tpl(o.name, body)),
        catalog_version: `1.${i}.0`,
      })
      .execute();
  }
  return id;
}

/** An org template `<plugin>:<name>` at version 1. */
async function seedOrg(o: { name: string; plugin: string | null; body: string }): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("agent_templates")
    .values({ id, org_id: env.orgId, name: o.name, plugin_name: o.plugin, current_version: 1 })
    .execute();
  await env.db
    .insertInto("agent_template_versions")
    .values({
      template_id: id,
      version: 1,
      definition: JSON.stringify(tpl(o.name, o.body)),
      source_format: "capybara",
      catalog_version: "1.0.0",
    })
    .execute();
  return id;
}

/** An org agent with the agent tool that selects these templates (201 expected). */
async function lead(
  templateIds: string[],
  inline: AgentDefinition["subagents"] extends infer S
    ? S extends { inline?: infer I }
      ? I
      : never
    : never = undefined,
): Promise<{ id: string; definition: AgentDefinition }> {
  const definition = {
    name: "Lead",
    instructions: "Lead the work.",
    model: { provider: "model-fake", model: "fake-1" },
    tools: [{ kind: "builtin", name: "Agent" }],
    subagents: { templates: templateIds, ...(inline !== undefined && { inline }) },
  };
  const r = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: { definition, visibility: "org" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().agent?.id ?? r.json().id, definition: definition as AgentDefinition };
}

const types = async (definition: AgentDefinition) =>
  (await resolveRoster(env.db, env.orgId, definition)).map((e) => e.type);

const listed = async () => {
  const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/agent-templates` });
  expect(r.statusCode, r.body).toBe(200);
  return (
    r.json().templates as {
      id: string;
      type: string;
      origin: string;
      version: number;
      linkedIds?: string[];
    }[]
  ).map((t) => [t.type, t.origin, t.id, t.version, ...(t.linkedIds ? [t.linkedIds] : [])]);
};

type Started = Extract<ConversationEvent, { type: "subagent_started" }>;

/** Dispatches `crm:reviewer` (or `type`) from a new conversation of `agentId`; returns the child. */
async function dispatch(agentId: string, type = "crm:reviewer") {
  const conv = await createConv(env.boss, env.orgId, agentId);
  await postMessage(
    env.boss,
    env.orgId,
    conv,
    `tool:Agent:${JSON.stringify({ description: "Review", prompt: "echo:first", subagent_type: type })}`,
  );
  await waitForTerminal(env.db, conv, 1, 30_000);
  const dispatched = (await eventsOf(env.db, conv)).find((e) => e.type === "subagent_dispatched") as
    | Extract<ConversationEvent, { type: "subagent_dispatched" }>
    | undefined;
  const subagentId = dispatched?.payload.subagentId as string;
  expect(subagentId, JSON.stringify(await eventsOf(env.db, conv))).toBeTruthy();
  const started = (await eventsOf(env.db, subagentId)).find(
    (e) => e.type === "subagent_started",
  ) as Started;
  return { conv, subagentId, started };
}

/** The system text of the child request whose last user message includes `marker`. */
async function childSystem(marker: string): Promise<string> {
  const req = await waitFor(
    async () =>
      capture.sent.find((r) => {
        const last = r.messages.at(-1);
        return (
          last?.role === "user" &&
          JSON.stringify(last.content).includes(marker) &&
          !JSON.stringify(last.content).includes("tool:Agent")
        );
      }),
    10_000,
    `the child's request with ${marker}`,
  );
  return req.system.map((s) => s.text).join("\n");
}

describe("agent templates from platform components", () => {
  it("a platform template on in the org is selectable and in the roster; off, it is not", async () => {
    const p = await seedPlatform({
      name: "reviewer",
      plugin: "crm",
      bodies: ["Review P1."],
      scope: "named",
    });
    await env.db
      .insertInto("component_scope_orgs")
      .values({ kind: "agent_template", component_id: p, org_id: env.orgId })
      .execute();
    const { definition } = await lead([p]);
    expect(await types(definition)).toEqual(["general-purpose", "crm:reviewer"]);
    expect(await listed()).toEqual([["crm:reviewer", "platform", p, 1, []]]);

    // a switch off in the org (named scope, listed): gone from the roster and the list
    await env.db
      .insertInto("component_org_switches")
      .values({ kind: "agent_template", component_id: p, org_id: env.orgId, enabled: false })
      .execute();
    expect(await types(definition)).toEqual(["general-purpose"]);
    expect(await listed()).toEqual([]);
    await env.db.deleteFrom("component_org_switches").execute();

    // disabled on the platform: off
    await env.db.updateTable("platform_agent_templates").set({ disabled: true }).execute();
    expect(await types(definition)).toEqual(["general-purpose"]);
    await env.db.updateTable("platform_agent_templates").set({ disabled: false }).execute();

    // follow: on only while the plugin is installed in the org
    await env.db
      .updateTable("platform_agent_templates")
      .set({ scope_mode: "follow", catalog_item_id: await catalogItem("crm") })
      .execute();
    expect(await types(definition)).toEqual(["general-purpose"]);
    // a platform id that is not on cannot be saved
    const r = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: { definition: { ...definition, name: "Other" }, visibility: "org" },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).toContain("not_found");
  });

  it("a platform template dispatches with its definition and records its own id and version", async () => {
    const p = await seedPlatform({
      name: "reviewer",
      plugin: "crm",
      bodies: ["Review P1.", "Review P2."],
    });
    const { id: agentId } = await lead([p]);
    const { started } = await dispatch(agentId);
    expect(started.payload.template).toEqual({
      source: "plugin",
      id: p,
      version: 2,
      plugin: "crm",
      platformTemplateId: p,
    });
    expect(await childSystem("echo:first")).toContain("Review P2.");
  }, 60_000);

  it("a template without a plugin is the bare type; one clashing with general-purpose or an inline name is skipped", async () => {
    const bare = await seedPlatform({ name: "reviewer", plugin: null, bodies: ["Bare."] });
    const gp = await seedPlatform({ name: "general-purpose", plugin: null, bodies: ["GP."] });
    const { id: agentId, definition } = await lead([bare]);
    expect(await types(definition)).toEqual(["general-purpose", "reviewer"]);
    const { started } = await dispatch(agentId, "reviewer");
    expect(started.payload.template).toEqual({
      source: "plugin",
      id: bare,
      version: 1,
      platformTemplateId: bare,
    });

    // saving a clash is refused: the reserved type, and an inline template of the same name
    const clash = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: { ...definition, name: "Clash", subagents: { templates: [gp] } },
        visibility: "org",
      },
    });
    expect(clash.statusCode, clash.body).toBe(400);
    expect(clash.body).toContain("duplicate");
    const inline = [{ name: "reviewer", description: "Inline.", instructions: "I." }];
    const clash2 = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: { ...definition, name: "Clash2", subagents: { templates: [bare], inline } },
        visibility: "org",
      },
    });
    expect(clash2.statusCode, clash2.body).toBe(400);
    expect(clash2.body).toContain("duplicate");

    // a clash reached without a save (state changed since): the reserved type and the inline
    // template keep their entries; the clashing templates are skipped with a warning
    const warn = vi.fn();
    const roster = await resolveRoster(
      env.db,
      env.orgId,
      { subagents: { templates: [gp, bare], inline } } as AgentDefinition,
      { warn },
    );
    expect(roster.map((e) => [e.type, e.source])).toEqual([
      ["general-purpose", "general"],
      ["reviewer", "inline"],
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("the org's own template wins a type clash; a linked copy is listed as its platform template", async () => {
    const p = await seedPlatform({ name: "reviewer", plugin: "crm", bodies: ["Review P1."] });
    const own = await seedOrg({ name: "reviewer", plugin: "crm", body: "Review O1." });
    const warn = vi.fn();
    expect(
      (await usableTemplates(env.db, env.orgId, { warn })).map((t) => [t.id, t.origin]),
    ).toEqual([[own, "org"]]);
    expect(warn).toHaveBeenCalledTimes(1);
    await env.db
      .updateTable("agent_templates")
      .set({ platform_template_id: p })
      .where("id", "=", own)
      .execute();
    // the linked copy's id rides on its platform template, so the editor keeps it selected
    expect(await listed()).toEqual([["crm:reviewer", "platform", p, 1, [own]]]);
    // a definition selecting both (reachable only without a save): one entry, the other an alias
    const both = await resolveRoster(env.db, env.orgId, {
      subagents: { templates: [own, p] },
    } as AgentDefinition);
    expect(both.map((e) => [e.type, e.templateId, e.aliasTemplateIds])).toEqual([
      ["general-purpose", undefined, undefined],
      ["crm:reviewer", own, [p]],
    ]);
    await env.db
      .updateTable("agent_templates")
      .set({ pinned_version: 1 })
      .where("id", "=", own)
      .execute();
    expect(await listed()).toEqual([["crm:reviewer", "org", own, 1]]);
  });

  it("a child of an org copy resumes after the copy is linked, on its frozen definition; new dispatches follow the platform unless pinned", async () => {
    const p = await seedPlatform({
      name: "reviewer",
      plugin: "crm",
      bodies: ["Review P1.", "Review P2."],
    });
    const copy = await seedOrg({ name: "reviewer", plugin: "crm", body: "Review O1." });
    const { id: agentId, definition } = await lead([copy]);
    const first = await dispatch(agentId);
    expect(first.started.payload.template).toEqual({
      source: "plugin",
      id: copy,
      version: 1,
      plugin: "crm",
    });
    expect(await childSystem("echo:first")).toContain("Review O1.");

    // link the copy (no pin): it resolves to the platform's current version under its own id
    await env.db
      .updateTable("agent_templates")
      .set({ platform_template_id: p })
      .where("id", "=", copy)
      .execute();
    const roster = await resolveRoster(env.db, env.orgId, definition);
    expect(roster.find((e) => e.type === "crm:reviewer")?.templateId).toBe(copy);

    // the running child's follow-up finds its entry by the recorded id and keeps its definition
    capture.reset();
    await postMessage(
      env.boss,
      env.orgId,
      first.conv,
      `tool:Agent:${JSON.stringify({ description: "Again", prompt: "echo:again", resume: first.subagentId })}`,
    );
    await waitForTerminal(env.db, first.conv, 2, 30_000);
    const again = await childSystem("echo:again");
    expect(again).toContain("Review O1.");
    expect(again).not.toContain("Review P2.");
    const child = await eventsOf(env.db, first.subagentId);
    expect(child.filter((e) => e.type === "subagent_started")).toHaveLength(1);

    // a new dispatch: the platform's current version, recorded under the copy's id
    capture.reset();
    const second = await dispatch(agentId);
    expect(second.started.payload.template).toEqual({
      source: "plugin",
      id: copy,
      version: 2,
      plugin: "crm",
      platformTemplateId: p,
    });
    expect(await childSystem("echo:first")).toContain("Review P2.");
    // the eval worker compares with the same resolution
    const caseOf = (s: Started) =>
      ({ orgId: env.orgId, events: [{ ...s, runId: null }] }) as unknown as CaseSnapshot;
    expect(await currentTemplate(env.db, caseOf(second.started))).toEqual({
      id: copy,
      version: 2,
      platformTemplateId: p,
    });

    // pinned: the copy serves its own stored version again
    await env.db
      .updateTable("agent_templates")
      .set({ pinned_version: 1 })
      .where("id", "=", copy)
      .execute();
    capture.reset();
    const third = await dispatch(agentId);
    expect(third.started.payload.template).toEqual({
      source: "plugin",
      id: copy,
      version: 1,
      plugin: "crm",
    });
    expect(await childSystem("echo:first")).toContain("Review O1.");
    // the pin changed the source: the linked case differs, the first (org) case matches again
    expect(await currentTemplate(env.db, caseOf(second.started))).toEqual({ id: copy, version: 1 });
    expect(first.started.payload.template.platformTemplateId).toBeUndefined();
  }, 150_000);

  it("a selected platform id shadowed by an org row of the same component stays in the roster as its alias", async () => {
    const itemId = await catalogItem("crm");
    const p = await seedPlatform({
      name: "reviewer",
      plugin: "crm",
      bodies: ["Review P1."],
      itemId,
    });
    const { id: agentId, definition } = await lead([p]);
    const first = await dispatch(agentId);
    expect(first.started.payload.template).toMatchObject({ id: p, platformTemplateId: p });

    // the org gets its own row of the same component (an install writes one): it wins the type
    const own = await seedOrg({ name: "reviewer", plugin: "crm", body: "Review O1." });
    await env.db
      .updateTable("agent_templates")
      .set({ catalog_item_id: itemId })
      .where("id", "=", own)
      .execute();
    const roster = await resolveRoster(env.db, env.orgId, definition);
    expect(roster.map((e) => [e.type, e.templateId, e.aliasTemplateIds])).toEqual([
      ["general-purpose", undefined, undefined],
      ["crm:reviewer", own, [p]],
    ]);

    // the follow-up recorded under the platform id still finds its entry, on its frozen definition
    capture.reset();
    await postMessage(
      env.boss,
      env.orgId,
      first.conv,
      `tool:Agent:${JSON.stringify({ description: "Again", prompt: "echo:again", resume: first.subagentId })}`,
    );
    await waitForTerminal(env.db, first.conv, 2, 30_000);
    expect(await childSystem("echo:again")).toContain("Review P1.");
    // a new dispatch runs the org row
    capture.reset();
    const second = await dispatch(agentId);
    expect(second.started.payload.template).toEqual({
      source: "plugin",
      id: own,
      version: 1,
      plugin: "crm",
    });
  }, 120_000);
  it("a pinned linked copy follows its platform template's availability and counts as a reference (ruling P2-18)", async () => {
    const p = await seedPlatform({ name: "reviewer", plugin: "crm", bodies: ["Review P1."] });
    const own = await seedOrg({ name: "reviewer", plugin: "crm", body: "Review O1." });
    await env.db
      .updateTable("agent_templates")
      .set({ platform_template_id: p, pinned_version: 1 })
      .where("id", "=", own)
      .execute();
    const usable = async () => (await usableTemplates(env.db, env.orgId)).map((t) => t.id);
    const byId = async () => [...(await loadTemplates(env.db, env.orgId, [own])).keys()];
    expect(await usable()).toEqual([own]);
    expect(await byId()).toEqual([own]);
    expect(await referenceIds(env.db, env.orgId, "agent_template", [p])).toEqual(
      new Map([
        [p, p],
        [own, p],
      ]),
    );
    await env.db
      .updateTable("platform_agent_templates")
      .set({ disabled: true })
      .where("id", "=", p)
      .execute();
    expect(await usable()).toEqual([]);
    expect(await byId()).toEqual([]);
    // removed by a plugin update (ruling P2-7): the pinned copy keeps its own version
    await env.db
      .updateTable("platform_agent_templates")
      .set({ disabled: false, deleted_at: new Date() })
      .where("id", "=", p)
      .execute();
    expect(await usable()).toEqual([own]);
    expect(await byId()).toEqual([own]);
  });
});
