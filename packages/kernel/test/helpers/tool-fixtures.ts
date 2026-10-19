import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

/** 直接插库造一个账号、组织、agent 与会话（工具管线测试用，不经 HTTP）。 */
export async function seedConversation(
  // biome-ignore lint/suspicious/noExplicitAny: 测试库无表结构类型
  raw: Kysely<any>,
): Promise<{ accountId: string; orgId: string; agentId: string; conversationId: string }> {
  const accountId = randomUUID();
  const orgId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
  return { accountId, orgId, agentId, conversationId };
}

/** 直接插库造一个应用（连接器 kind、认证方式可选），返回应用 id。 */
export async function seedApp(
  // biome-ignore lint/suspicious/noExplicitAny: 测试库无表结构类型
  raw: Kysely<any>,
  orgId: string,
  createdBy: string,
  opts: { slug: string; name?: string; connector?: string; auth?: unknown; endpoint?: unknown },
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.apps (id, org_id, slug, name, connector, endpoint, auth, created_by)
    VALUES (${id}, ${orgId}, ${opts.slug}, ${opts.name ?? opts.slug}, ${opts.connector ?? "test"},
      ${JSON.stringify(opts.endpoint ?? {})}::jsonb, ${JSON.stringify(opts.auth ?? { type: "none" })}::jsonb,
      ${createdBy})`.execute(raw);
  return id;
}
