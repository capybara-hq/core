import { startTestPostgres } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";

/** 0010_tools.sql：工具相关数据表、runs.waiting 与 orgs.settings。 */
let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let db: ReturnType<typeof createDb>;

async function rejects(p: Promise<unknown>, re: RegExp) {
  await expect(p).rejects.toThrow(re);
}

beforeAll(async () => {
  pg = await startTestPostgres();
  db = createDb(pg.url, 5);
  await migrate(pg.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  await sql`insert into capybara.accounts (id, display_name) values ('a1', 'A')`.execute(db);
  await sql`insert into capybara.orgs (id, slug, name) values ('o1', 'o1', 'O')`.execute(db);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'a1', 'org', 1)`.execute(db);
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values ('c1', 'o1', 'ag1', 'a1')`.execute(db);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 120_000);

describe("0010_tools", () => {
  it("创建全部新表", async () => {
    for (const t of [
      "apps",
      "app_tools",
      "tool_grants",
      "approvals",
      "questions",
      "tool_outputs",
      "conversation_tool_grants",
    ]) {
      const r = await sql<{
        x: string | null;
      }>`select to_regclass(${`capybara.${t}`})::text as x`.execute(db);
      expect(r.rows[0]?.x, t).not.toBeNull();
    }
  });

  it("orgs.settings 默认 {}", async () => {
    const r = await sql<{
      settings: unknown;
    }>`select settings from capybara.orgs where id='o1'`.execute(db);
    expect(r.rows[0]?.settings).toEqual({});
  });

  it("runs 可写 waiting，且一个会话不能同时有 running 与 waiting", async () => {
    await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
      values ('r1', 'c1', 'waiting', 1, 'a1')`.execute(db);
    await rejects(
      sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
        values ('r2', 'c1', 'running', 1, 'a1')`.execute(db),
      /runs_one_active_per_conversation/,
    );
    await sql`update capybara.runs set status='completed' where id='r1'`.execute(db);
    await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
      values ('r2', 'c1', 'running', 1, 'a1')`.execute(db);
    await rejects(
      sql`update capybara.runs set status='waiting' where id='r1'`.execute(db),
      /runs_one_active_per_conversation/,
    );
    await sql`update capybara.runs set status='completed' where id='r2'`.execute(db);
  });

  it("apps：slug 在未删除行内唯一，状态受 CHECK 约束", async () => {
    const ins = (id: string, slug: string, status = "active") =>
      sql`insert into capybara.apps (id, org_id, slug, name, connector, endpoint, auth, status, created_by)
        values (${id}, 'o1', ${slug}, 'N', 'mcp', '{}', '{}', ${status}, 'a1')`.execute(db);
    await ins("app1", "crm");
    await rejects(ins("app2", "crm"), /apps_org_slug|duplicate key/);
    await sql`update capybara.apps set deleted_at = now() where id='app1'`.execute(db);
    await ins("app2", "crm");
    await rejects(ins("app3", "x", "bogus"), /check/);
  });

  it("app_tools：状态与默认策略受 CHECK 约束", async () => {
    const ins = (name: string, status: string, policy: string) =>
      sql`insert into capybara.app_tools (app_id, name, spec, spec_hash, status, default_policy)
        values ('app2', ${name}, '{}', 'h', ${status}, ${policy})`.execute(db);
    await ins("t1", "pending_review", "ask");
    await rejects(ins("t2", "weird", "ask"), /check/);
    await rejects(ins("t3", "enabled", "maybe"), /check/);
  });

  it("approvals：requested_for 与 approver_role 至少一个非空；(run_id, call_id) 唯一；scope 受限", async () => {
    await sql`insert into capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
      values ('r3', 'c1', 'completed', 1, 'a1')`.execute(db);
    const ins = (
      id: string,
      call: string,
      who: string | null,
      role: string | null,
      status = "pending",
      scope: string | null = null,
    ) =>
      sql`insert into capybara.approvals
        (id, org_id, conversation_id, run_id, call_id, tool_key, spec_hash, input, requested_for, approver_role, status, scope, expires_at)
        values (${id}, 'o1', 'c1', 'r3', ${call}, 'crm__x', 'h', '{}', ${who}, ${role}, ${status}, ${scope}, now())`.execute(
        db,
      );
    await ins("ap1", "k1", "a1", null);
    await ins("ap2", "k2", null, "admin");
    await rejects(ins("ap3", "k3", null, null), /check/);
    await rejects(ins("ap4", "k1", "a1", null), /duplicate key|approvals_run_call/);
    await rejects(ins("ap5", "k5", "a1", null, "weird"), /check/);
    await rejects(ins("ap6", "k6", "a1", null, "approved", "forever"), /check/);
    await ins("ap7", "k7", "a1", null, "approved", "always");
    // 0011：spec_hash 必填
    await rejects(
      sql`insert into capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key, requested_for, expires_at)
        values ('ap8', 'o1', 'c1', 'r3', 'k8', 'crm__x', 'a1', now())`.execute(db),
      /null value|not-null/,
    );
  });

  it("approvals.requested_for：指定处理人的账号删除时审批一并删除（不违反 approvals_target_chk）", async () => {
    await sql`insert into capybara.accounts (id, display_name) values ('a9', 'Z')`.execute(db);
    await sql`insert into capybara.approvals
      (id, org_id, conversation_id, run_id, call_id, tool_key, spec_hash, requested_for, expires_at)
      values ('ap9', 'o1', 'c1', 'r3', 'k9', 'crm__x', 'h', 'a9', now())`.execute(db);
    await sql`delete from capybara.accounts where id = 'a9'`.execute(db);
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from capybara.approvals where id = 'ap9'`.execute(db);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("0014 tool_specs：按指纹内容寻址", async () => {
    await sql`insert into capybara.tool_specs (spec_hash, spec) values ('h1', '{"name":"a"}')`.execute(
      db,
    );
    await sql`insert into capybara.tool_specs (spec_hash, spec) values ('h1', '{"name":"b"}')
      on conflict (spec_hash) do nothing`.execute(db);
    const r = await sql<{
      spec: unknown;
    }>`select spec from capybara.tool_specs where spec_hash = 'h1'`.execute(db);
    expect(r.rows.map((x) => x.spec)).toEqual([{ name: "a" }]);
  });

  it("questions：(run_id, call_id) 唯一，状态受限", async () => {
    const ins = (id: string, call: string, status = "pending") =>
      sql`insert into capybara.questions (id, org_id, conversation_id, run_id, call_id, spec, status, expires_at)
        values (${id}, 'o1', 'c1', 'r3', ${call}, '{}', ${status}, now())`.execute(db);
    await ins("q1", "k1");
    await rejects(ins("q2", "k1"), /duplicate key|questions_run_call/);
    await rejects(ins("q3", "k3", "weird"), /check/);
  });

  it("tool_outputs 与授权表可写", async () => {
    await sql`insert into capybara.tool_outputs (id, org_id, conversation_id, call_id, size_chars, line_count, content, expires_at)
      values ('to1', 'o1', 'c1', 'k1', 3, 1, 'abc', now())`.execute(db);
    await sql`insert into capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash, app_id)
      values ('o1', 'a1', 'ag1', 'crm__x', 'h', 'app1')`.execute(db);
    await sql`insert into capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash)
      values ('c1', 'crm__x', 'h')`.execute(db);
    await rejects(
      sql`insert into capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash)
        values ('c1', 'crm__x', 'h')`.execute(db),
      /duplicate key/,
    );
  });
});
