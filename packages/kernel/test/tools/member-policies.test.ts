import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { PolicyContext } from "../../src/tools/pipeline.js";
import { connectorPolicy, createDecidePolicy } from "../../src/tools/policy.js";
import { policyFromAnnotations, type ResolvedTool, specHash } from "../../src/tools/registry.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { seedConnector, seedConversation } from "../helpers/tool-fixtures.js";

/**
 * A member's own tool policies for their connection of a personal-credential connector
 * (maintainer decisions 2026-11-09), resolved highest first: the org switched the tool off
 * (unavailable) or set it to deny; the member's 禁止; the agent's setting; the member's 允许 / 询问;
 * the org default (the annotation default unless an org admin changed it). The settings read are
 * always the acting account's: the account whose connection the call uses.
 */

type P = "allow" | "ask" | "deny";

describe("connectorPolicy (pure)", () => {
  it("every combination follows the five levels", () => {
    const all: (P | undefined)[] = [undefined, "allow", "ask", "deny"];
    for (const orgDefault of ["allow", "ask", "deny"] as const) {
      for (const member of all) {
        for (const agent of all) {
          const r = connectorPolicy({ orgDefault, member, agent });
          const want =
            orgDefault === "deny"
              ? "deny"
              : member === "deny"
                ? "deny"
                : (agent ?? member ?? orgDefault);
          expect(r.policy, `${orgDefault}/${member}/${agent}`).toBe(want);
        }
      }
    }
  });

  it("names the level that decided", () => {
    expect(connectorPolicy({ orgDefault: "deny", member: "allow", agent: "allow" }).source).toBe(
      "org",
    );
    expect(connectorPolicy({ orgDefault: "ask", member: "deny", agent: "allow" }).source).toBe(
      "member",
    );
    expect(connectorPolicy({ orgDefault: "ask", member: "ask", agent: "allow" }).source).toBe(
      "agent",
    );
    expect(connectorPolicy({ orgDefault: "ask", member: "allow" }).source).toBe("member");
    expect(connectorPolicy({ orgDefault: "ask" }).source).toBe("org");
  });

  it("the annotation default: readOnlyHint true allows; write, delete and unannotated tools ask", () => {
    expect(policyFromAnnotations({ readOnlyHint: true })).toBe("allow");
    expect(policyFromAnnotations({ readOnlyHint: false })).toBe("ask");
    expect(policyFromAnnotations({ destructiveHint: true })).toBe("ask");
    expect(policyFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe("allow");
    expect(policyFromAnnotations(undefined)).toBe("ask");
    expect(policyFromAnnotations({})).toBe("ask");
  });
});

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = legacyDbFor(raw);
}, 120_000);

afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});

const agentDef: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "s-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  disabledTools: builtinsOff(),
  toolPolicies: {},
};
const SPEC: ToolSpec = {
  name: "send_message",
  description: "Send a message.",
  inputSchema: { type: "object" },
};
const KEY = "mcp__chat__send_message";

let seed: Awaited<ReturnType<typeof seedConversation>>;
let personal: string;
let orgWide: string;
let other: string;
let ctx: PolicyContext;

const tool = (connectorId: string, slug = "chat"): ResolvedTool => ({
  key: `mcp__${slug}__send_message`,
  source: { kind: "connector", connectorId, name: "send_message" },
  spec: SPEC,
  specHash: specHash(SPEC),
  defaultPolicy: "ask",
});

async function setTool(connectorId: string, policy: P, status = "enabled") {
  await sql`INSERT INTO capybara.connector_tools (connector_id, name, spec, spec_hash, status, default_policy)
    VALUES (${connectorId}, 'send_message', ${JSON.stringify(SPEC)}::jsonb, ${specHash(SPEC)}, ${status}, ${policy})
    ON CONFLICT (connector_id, name) DO UPDATE SET default_policy = EXCLUDED.default_policy,
      status = EXCLUDED.status`.execute(raw);
}

async function setMine(accountId: string, policy: P | null, connectorId = personal) {
  await sql`DELETE FROM capybara.connector_tool_account_policies
    WHERE connector_id = ${connectorId} AND account_id = ${accountId}`.execute(raw);
  if (policy === null) return;
  await sql`INSERT INTO capybara.connector_tool_account_policies
    (org_id, connector_id, account_id, tool_name, policy)
    VALUES (${seed.orgId}, ${connectorId}, ${accountId}, 'send_message', ${policy})`.execute(raw);
}

/** The agent's current version with `policy` on the tool (null: no setting). */
async function setAgent(policy: P | null, version: number) {
  const def = { ...agentDef, toolPolicies: policy === null ? {} : { [KEY]: policy } };
  await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
    VALUES (${seed.agentId}, ${version}, ${JSON.stringify(def)}::jsonb, ${seed.accountId})`.execute(
    raw,
  );
  await sql`UPDATE capybara.agents SET current_version = ${version} WHERE id = ${seed.agentId}`.execute(
    raw,
  );
  return def as AgentDefinition;
}

const outcome = (d: unknown): string =>
  typeof d === "string"
    ? d
    : d !== null && typeof d === "object" && "ask" in d
      ? `ask:${(d as { ask: { policy: string } }).ask.policy}`
      : d !== null && typeof d === "object" && "unavailable" in d
        ? "unavailable"
        : JSON.stringify(d);

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  seed = await seedConversation(raw);
  other = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${other}, 'Other')`.execute(
    raw,
  );
  for (const a of [seed.accountId, other]) {
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${seed.orgId}, ${a}, 'member')`.execute(raw);
  }
  personal = await seedConnector(raw, seed.orgId, seed.accountId, {
    slug: "chat",
    auth: { type: "bearer", ownership: "personal" },
  });
  orgWide = await seedConnector(raw, seed.orgId, seed.accountId, {
    slug: "team",
    auth: { type: "bearer", ownership: "org" },
  });
  await setTool(personal, "ask");
  await setTool(orgWide, "ask");
  const runId = randomUUID();
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${runId}, ${seed.conversationId}, 'running', 1, ${seed.accountId}, 0)`.execute(raw);
  ctx = {
    orgId: seed.orgId,
    accountId: seed.accountId,
    agentId: seed.agentId,
    conversationId: seed.conversationId,
    runId,
  };
});

describe("createDecidePolicy: a member's own policies on their connection", () => {
  it("without settings: the org default; the member's 允许 / 询问 replace it", async () => {
    const policy = createDecidePolicy(db);
    expect(outcome(await policy(tool(personal), agentDef, ctx))).toBe("ask:connector");
    await setMine(seed.accountId, "allow");
    expect(outcome(await policy(tool(personal), agentDef, ctx))).toBe("allow");
    await setTool(personal, "allow");
    await setMine(seed.accountId, "ask");
    expect(outcome(await policy(tool(personal), agentDef, ctx))).toBe("ask:member");
  });

  it("the agent's setting overrides the member's 允许 / 询问: agent 允许 vs member 询问 -> allowed", async () => {
    const policy = createDecidePolicy(db);
    await setMine(seed.accountId, "ask");
    const allow = await setAgent("allow", 2);
    expect(outcome(await policy(tool(personal), allow, ctx))).toBe("allow");
    await setMine(seed.accountId, "allow");
    const ask = await setAgent("ask", 3);
    expect(outcome(await policy(tool(personal), ask, ctx))).toBe("ask:agent");
    const deny = await setAgent("deny", 4);
    expect(outcome(await policy(tool(personal), deny, ctx))).toBe("deny");
  });

  it("the member's 禁止 is a floor: agent 允许 vs member 禁止 -> denied", async () => {
    const policy = createDecidePolicy(db);
    await setMine(seed.accountId, "deny");
    const allow = await setAgent("allow", 2);
    expect(outcome(await policy(tool(personal), allow, ctx))).toBe("deny");
  });

  it("the org locks: a tool switched off is unavailable, an org deny is denied, whatever the member and the agent say", async () => {
    const policy = createDecidePolicy(db);
    await setMine(seed.accountId, "allow");
    const allow = await setAgent("allow", 2);
    await setTool(personal, "deny");
    expect(outcome(await policy(tool(personal), allow, ctx))).toBe("deny");
    await setTool(personal, "allow", "disabled");
    expect(outcome(await policy(tool(personal), allow, ctx))).toBe("unavailable");
  });

  it("an agent 允许 the owner removed since the run started no longer applies", async () => {
    const policy = createDecidePolicy(db);
    const allow = await setAgent("allow", 2);
    expect(outcome(await policy(tool(personal), allow, ctx))).toBe("allow");
    await setAgent(null, 3);
    // the run still holds version 2 with 允许: the current version has no setting
    expect(outcome(await policy(tool(personal), allow, ctx))).toBe("ask:connector");
  });

  it("only the acting account's settings count (cross-account isolation)", async () => {
    const policy = createDecidePolicy(db);
    await setMine(other, "allow");
    expect(outcome(await policy(tool(personal), agentDef, ctx))).toBe("ask:connector");
    await setMine(other, "deny");
    expect(outcome(await policy(tool(personal), agentDef, ctx))).toBe("ask:connector");
    // the other account acting (a channel message from them, a run they trigger): theirs apply
    expect(outcome(await policy(tool(personal), agentDef, { ...ctx, accountId: other }))).toBe(
      "deny",
    );
  });

  it("a channel trigger acts for the sender's account: the sender's settings, never the agent owner's", async () => {
    const policy = createDecidePolicy(db);
    // the seeded account owns the agent; `other` sends the channel message the run answers
    await setMine(seed.accountId, "allow");
    await setMine(other, "ask");
    const sender: PolicyContext = { ...ctx, accountId: other };
    expect(outcome(await policy(tool(personal), agentDef, sender))).toBe("ask:member");
  });

  it("a sub-agent acts for its tree's account: the same member's settings, the parent agent's setting on top", async () => {
    const policy = createDecidePolicy(db);
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES ('ag-child', ${seed.orgId}, ${seed.accountId}, 'org', 1)`.execute(raw);
    await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
      VALUES ('ag-child', 1, ${JSON.stringify(agentDef)}::jsonb, ${seed.accountId})`.execute(raw);
    const child: PolicyContext = {
      ...ctx,
      agentId: "ag-child",
      conversationId: "child-conv",
      parentConversationId: seed.conversationId,
    };
    await setMine(seed.accountId, "deny");
    await setAgent("allow", 2);
    expect(outcome(await policy(tool(personal), agentDef, child))).toBe("deny");
    await setMine(seed.accountId, "ask");
    // the parent agent's 允许 (its current version) reaches the child's call
    expect(outcome(await policy(tool(personal), agentDef, child))).toBe("allow");
    await setMine(seed.accountId, null);
    await setAgent(null, 3);
    expect(outcome(await policy(tool(personal), agentDef, child))).toBe("ask:connector");
  });

  it("a connector with one org credential has no member level", async () => {
    const policy = createDecidePolicy(db);
    await setMine(seed.accountId, "allow", orgWide);
    expect(outcome(await policy(tool(orgWide, "team"), agentDef, ctx))).toBe("ask:connector");
    await setMine(seed.accountId, "deny", orgWide);
    expect(outcome(await policy(tool(orgWide, "team"), agentDef, ctx))).toBe("ask:connector");
  });

  it("an org-credential connector: the agent's 允许 does not lift the org's 询问 (it only tightens there)", async () => {
    const policy = createDecidePolicy(db);
    const teamKey = "mcp__team__send_message";
    const withPolicy = async (p: P, version: number) => {
      const def = { ...agentDef, toolPolicies: { [teamKey]: p } };
      await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
        VALUES (${seed.agentId}, ${version}, ${JSON.stringify(def)}::jsonb, ${seed.accountId})`.execute(
        raw,
      );
      await sql`UPDATE capybara.agents SET current_version = ${version} WHERE id = ${seed.agentId}`.execute(
        raw,
      );
      return def as AgentDefinition;
    };
    const allow = await withPolicy("allow", 2);
    expect(outcome(await policy(tool(orgWide, "team"), allow, ctx))).toBe("ask:connector");
    const deny = await withPolicy("deny", 3);
    expect(outcome(await policy(tool(orgWide, "team"), deny, ctx))).toBe("deny");
    // an org default allow with an agent ask still asks (tightening keeps working)
    await setTool(orgWide, "allow");
    const ask = await withPolicy("ask", 4);
    expect(outcome(await policy(tool(orgWide, "team"), ask, ctx))).toBe("ask:agent");
  });

  it("an agent 允许 on a tool that is not a connector's changes nothing (it only tightens there)", async () => {
    const policy = createDecidePolicy(db);
    const plugin: ResolvedTool = {
      key: "plugin__probe__write",
      source: { kind: "plugin", plugin: "probe", name: "write" },
      spec: { name: "write", description: "Write.", inputSchema: { type: "object" } },
      specHash: "h",
      defaultPolicy: "ask",
    };
    const def = { ...agentDef, toolPolicies: { plugin__probe__write: "allow" as const } };
    expect(outcome(await policy(plugin, def, ctx))).toBe("ask:default");
  });
});
