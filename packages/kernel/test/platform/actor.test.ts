import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { PlatformActor } from "../../src/platform/actor.js";
import { availability } from "../../src/platform/availability.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor } from "../helpers/identity.js";

/**
 * `PlatformActor.facts` against PG: the role, the super admin flag, the org setting, the agent's
 * privacy and whether a person is present to confirm a write (spec §6.1). Rows are inserted
 * directly; the run origins are told apart by the conversation's kind (eval), the root of a
 * sub-agent's tree, a wake run's budget window and the org's anonymous guest account.
 */

let pgc: TestContainer;
let raw: ReturnType<typeof createDb>;
let actor: PlatformActor;

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  actor = new PlatformActor(handlesFor(raw).db);
}, 120_000);
afterAll(async () => {
  await raw?.destroy();
  await pgc?.stop();
});

let orgId: string;
let person: string;
let agentId: string;

async function account(opts: { superAdmin?: boolean; role?: string | null } = {}) {
  const id = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name, is_super_admin)
    VALUES (${id}, 'U', ${opts.superAdmin ?? false})`.execute(raw);
  if (opts.role !== null) {
    await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
      VALUES (${orgId}, ${id}, ${opts.role ?? "member"})`.execute(raw);
  }
  return id;
}

async function agent(owner: string, visibility: "private" | "org"): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${id}, ${orgId}, ${owner}, ${visibility}, 1)`.execute(raw);
  return id;
}

async function conversation(
  accountId: string,
  opts: { kind?: "chat" | "eval" | "subagent"; parent?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id)
    VALUES (${id}, ${orgId}, ${agentId}, ${accountId}, ${opts.kind ?? "chat"},
      ${opts.parent ?? null})`.execute(raw);
  return id;
}

/** A run row; `completed` because a conversation holds at most one active run (the facts ignore it). */
async function run(
  conversationId: string,
  trigger: string,
  budgetRunId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.runs
      (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq, budget_run_id)
    VALUES (${id}, ${conversationId}, 'completed', 1, ${trigger}, 1, ${budgetRunId})`.execute(raw);
  return id;
}

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  orgId = randomUUID();
  const creator = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${creator}, 'C')`.execute(raw);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${creator})`.execute(raw);
  person = await account({ role: "member" });
  agentId = await agent(person, "private");
});

const factsFor = (accountId: string, conversationId: string, runId: string | null) =>
  actor.facts({ orgId, accountId, agentId, conversationId, runId });

/** A read operation any member may call (to check a disabled account loses even reads). */
const readOp = defineOperation({
  id: "skills.list",
  description: "List the org's skills.",
  input: z.object({}),
  example: {},
  authz: { orgAction: "org.read" },
  mirrors: [],
  confirm: "read",
  run: async () => null,
}) as PlatformOperation;

describe("PlatformActor.facts", () => {
  it("a person's own run in a chat: role, private agent, setting on, present", async () => {
    const conv = await conversation(person);
    const r = await run(conv, person);
    expect(await factsFor(person, conv, r)).toEqual({
      role: "member",
      isSuperAdmin: false,
      personPresent: true,
      agentPrivateToActor: true,
      setting: "on",
    });
  });

  it("a wake run (budget window set) counts as present: the person's own run continues", async () => {
    const conv = await conversation(person);
    const first = await run(conv, person);
    const wake = await run(conv, person, first);
    expect((await factsFor(person, conv, wake)).personPresent).toBe(true);
  });

  it("a sub-agent's run follows its tree to the root chat", async () => {
    const root = await conversation(person);
    const child = await conversation(person, { kind: "subagent", parent: root });
    const grandchild = await conversation(person, { kind: "subagent", parent: child });
    const r = await run(grandchild, person, await run(root, person));
    expect((await factsFor(person, grandchild, r)).personPresent).toBe(true);
  });

  it("an eval conversation has no person present", async () => {
    const conv = await conversation(person, { kind: "eval" });
    const r = await run(conv, person);
    expect((await factsFor(person, conv, r)).personPresent).toBe(false);
  });

  it("a channel message from an unlinked user (the org's anonymous guest) has no person present", async () => {
    const guest = await account({ role: "guest" });
    await sql`INSERT INTO capybara.org_anonymous_accounts (org_id, account_id)
      VALUES (${orgId}, ${guest})`.execute(raw);
    const conv = await conversation(guest);
    const r = await run(conv, guest);
    const f = await factsFor(guest, conv, r);
    expect(f.role).toBe("guest");
    expect(f.personPresent).toBe(false);
  });

  it("no run, a run of another account or a disabled account: no person present", async () => {
    const conv = await conversation(person);
    const other = await account({ role: "member" });
    expect((await factsFor(person, conv, null)).personPresent).toBe(false);
    expect((await factsFor(person, conv, await run(conv, other))).personPresent).toBe(false);
    const r = await run(conv, person);
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${person}`.execute(raw);
    const f = await factsFor(person, conv, r);
    expect(f.personPresent).toBe(false);
    // a disabled account is refused on every HTTP request: here it is no member, reads included
    expect(f.role).toBeNull();
    const verdict = availability(readOp, f);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("disabled");
  });

  it("an actor who left the org: role null, no person present", async () => {
    const conv = await conversation(person);
    const r = await run(conv, person);
    await sql`DELETE FROM capybara.memberships WHERE account_id = ${person}`.execute(raw);
    const f = await factsFor(person, conv, r);
    expect(f.role).toBeNull();
    expect(f.personPresent).toBe(false);
  });

  it("reads the super admin flag, the agent's privacy and the org setting", async () => {
    const admin = await account({ superAdmin: true, role: "admin" });
    const conv = await conversation(admin);
    const r = await run(conv, admin);
    // the agent is private but owned by someone else
    let f = await factsFor(admin, conv, r);
    expect(f.isSuperAdmin).toBe(true);
    expect(f.agentPrivateToActor).toBe(false);
    agentId = await agent(admin, "org");
    expect((await factsFor(admin, conv, r)).agentPrivateToActor).toBe(false);
    agentId = await agent(admin, "private");
    expect((await factsFor(admin, conv, r)).agentPrivateToActor).toBe(true);
    for (const setting of ["read-only", "off", "on"] as const) {
      await sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({ platformTool: setting })}::jsonb
        WHERE id = ${orgId}`.execute(raw);
      f = await factsFor(admin, conv, r);
      expect(f.setting).toBe(setting);
    }
    await sql`UPDATE capybara.orgs SET settings = '{"platformTool":"bogus"}'::jsonb
      WHERE id = ${orgId}`.execute(raw);
    expect((await factsFor(admin, conv, r)).setting).toBe("on");
    // a disabled super admin is no super admin
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${admin}`.execute(raw);
    expect((await factsFor(admin, conv, r)).isSuperAdmin).toBe(false);
  });
});
