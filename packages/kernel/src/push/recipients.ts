import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { ORG_ROLES, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { pluginDisplayNames } from "../tools/display-names.js";
import type { PushFanoutData } from "./jobs.js";
import type { ResolvedPush } from "./texts.js";
import { pushTriggerOf } from "./triggers.js";

/** An event's push before the event id is attached: who receives it and what it says. */
export type ResolvedRecipients = Omit<ResolvedPush, "eventId">;

/**
 * Who an event's push reaches, read when the fanout runs (mobile app spec §9.4, the plan's
 * Triggers table), or null when nothing is pushed. Every check is made now, not when the event was
 * written (review focus 1):
 *
 * - the org is not deleted, and every recipient is an `active` account that is still a member of
 *   the event's org (an account of another org never qualifies, whatever a row names);
 * - `waiting`: an approval goes to `requested_for`, else to every member whose role is at least
 *   `approver_role` except the run's trigger account (as `canHandle`, review focus 2), and only
 *   while it is still `pending`; a question only while pending; both, and a connect request, go to
 *   the run's trigger account (an approval assigned to someone goes to that person);
 * - `replies`: chat conversations only, to the conversation's owner, never for a run serving a
 *   automation (that pushes as `automations`);
 * - `tasks`: the root conversation's owner;
 * - `automations`: the task's owner, for a task run `completed` or `failed` of a task not deleted;
 * - `inbox`: the item's person, while the item is open and unexpired (a plugin item only while
 *   its plugin is enabled in the org);
 * - eval conversations (a sub-agent under an eval root too) and deleted conversations never push;
 * - an escalated approval whose run is gone pushes nothing (its initiator is unknown).
 *
 * The path carries the org (`/chat/<root>?org=<orgId>`, `&subagent=<child>` for an event of a
 * sub-agent's log; an automation run without a conversation opens `/inbox?org=<orgId>`), the thread
 * is the root conversation (`automation-<taskId>` for an automation), the title the root's agent name
 * (the task's name).
 */
export async function resolveRecipients(
  db: KernelSchemaDb,
  source: PushFanoutData["source"],
): Promise<ResolvedRecipients | null> {
  switch (source.kind) {
    case "automation":
      return resolveAutomation(db, source.taskRunId);
    case "inbox":
      return resolveInboxItem(db, source.itemId);
    default:
      return resolveConversation(db, source.conversationId, source.seq);
  }
}

async function resolveInboxItem(
  db: KernelSchemaDb,
  itemId: string,
): Promise<ResolvedRecipients | null> {
  // org-filter: itemId comes from the kernel-written push fan-out job; this read learns the item's
  // org, which every later read filters by
  const item = await db
    .selectFrom("inbox_items")
    .select(["org_id", "account_id", "plugin", "title", "state", "expires_at"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item || item.state !== "open" || item.expires_at.getTime() <= Date.now()) return null;
  const orgId = item.org_id;
  if (!(await orgLive(db, orgId))) return null;
  if (item.plugin !== null && !(await isExtensionEnabled(db, orgId, item.plugin))) return null;
  const accountIds = await activeMembers(db, orgId, [item.account_id]);
  if (accountIds.length === 0) return null;
  const title =
    item.plugin === null
      ? "Capybara"
      : ((await pluginDisplayNames(db, [item.plugin])).get(item.plugin) ?? item.plugin);
  return {
    orgId,
    accountIds,
    category: "inbox",
    path: `/inbox?org=${encodeURIComponent(orgId)}#item=${encodeURIComponent(itemId)}`,
    threadId: "inbox",
    title,
    conversationTitle: item.title,
    text: "inboxItem",
  };
}

async function resolveConversation(
  db: KernelSchemaDb,
  conversationId: string,
  seq: number,
): Promise<ResolvedRecipients | null> {
  const event = await db
    .selectFrom("conversation_events")
    .select(["type", "payload", "run_id"])
    .where("conversation_id", "=", conversationId)
    .where("seq", "=", String(seq))
    .executeTakeFirst();
  if (!event) return null;
  const trigger = pushTriggerOf({ type: event.type, payload: event.payload } as never);
  if (trigger === null) return null;
  // org-filter: conversationId comes from the kernel-written push fan-out job; this read learns
  // the conversation's org, which every later read filters by
  const conv = await db
    .selectFrom("conversations")
    .select(["org_id", "kind", "account_id", "deleted_at"])
    .where("id", "=", conversationId)
    .executeTakeFirst();
  if (!conv || conv.kind === "eval" || conv.deleted_at !== null) return null;
  if (trigger.category === "replies" && conv.kind !== "chat") return null;
  const orgId = conv.org_id;
  if (!(await orgLive(db, orgId))) return null;
  const rootId =
    conv.kind === "subagent" ? await rootConversationOf(db, conversationId) : conversationId;
  const root =
    rootId === conversationId
      ? null
      : await db
          .selectFrom("conversations")
          .select(["org_id", "kind", "account_id", "deleted_at"])
          .where("id", "=", rootId)
          .where("org_id", "=", orgId)
          .executeTakeFirst();
  if (
    root !== null &&
    (root === undefined ||
      root.org_id !== orgId ||
      root.kind === "eval" ||
      root.deleted_at !== null)
  ) {
    return null;
  }
  const owner = root?.account_id ?? conv.account_id;

  const payload = event.payload as { approvalId?: unknown; questionId?: unknown };
  let candidates: string[];
  switch (trigger.text) {
    case "approval": {
      if (typeof payload.approvalId !== "string") return null;
      const approval = await db
        .selectFrom("approvals")
        .select(["run_id", "requested_for", "approver_role", "status"])
        .where("id", "=", payload.approvalId)
        .where("org_id", "=", orgId)
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      if (approval?.status !== "pending") return null;
      if (approval.requested_for !== null) {
        candidates = [approval.requested_for];
        break;
      }
      const role = approval.approver_role as OrgRole | null;
      if (role === null || !ORG_ROLES.includes(role)) return null;
      // without its run the initiator is unknown, and only `canHandle` with it may decide
      const initiator = await triggerAccountOf(db, approval.run_id);
      if (initiator === null) return null;
      const roles = ORG_ROLES.filter((r) => roleAtLeast(r, role));
      const rows = await db
        .selectFrom("memberships")
        .select("account_id")
        .where("org_id", "=", orgId)
        .where("role", "in", roles)
        .execute();
      candidates = rows.map((r) => r.account_id).filter((a) => a !== initiator);
      break;
    }
    case "question": {
      if (typeof payload.questionId !== "string") return null;
      const question = await db
        .selectFrom("questions")
        .select(["run_id", "status"])
        .where("id", "=", payload.questionId)
        .where("org_id", "=", orgId)
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      if (question?.status !== "pending") return null;
      candidates = optional(await triggerAccountOf(db, question.run_id));
      break;
    }
    case "connect":
      candidates = event.run_id === null ? [] : optional(await triggerAccountOf(db, event.run_id));
      break;
    case "runFinished":
    case "runFailed": {
      if (event.run_id === null) return null;
      const run = await db
        .selectFrom("runs")
        .select(["automation_run_id", "compact_origin"])
        .where("id", "=", event.run_id)
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      // an automation's run is pushed by the automation; an idle compaction ran after the person
      // left and answered nobody (idle compaction spec §6): neither pushes a reply
      if (!run || run.automation_run_id !== null || run.compact_origin === "idle") return null;
      candidates = [owner];
      break;
    }
    default:
      candidates = [owner];
  }
  const accountIds = await activeMembers(db, orgId, candidates);
  if (accountIds.length === 0) return null;

  const rootRow = await db
    .selectFrom("conversations")
    .select(["agent_id", "title"])
    .where("id", "=", rootId)
    .where("org_id", "=", orgId)
    .executeTakeFirstOrThrow();
  const org = encodeURIComponent(orgId);
  const path =
    rootId === conversationId
      ? `/chat/${rootId}?org=${org}`
      : `/chat/${rootId}?org=${org}&subagent=${conversationId}`;
  return {
    orgId,
    accountIds,
    category: trigger.category,
    path,
    threadId: rootId,
    title: await agentName(db, orgId, rootRow.agent_id),
    conversationTitle: rootRow.title,
    text: trigger.text,
  };
}

async function resolveAutomation(
  db: KernelSchemaDb,
  taskRunId: string,
): Promise<ResolvedRecipients | null> {
  // org-filter: taskRunId comes from the kernel-written push fan-out job; this read learns the
  // run's org (checked against its task's below), which every later read filters by
  const row = await db
    .selectFrom("automation_runs")
    .innerJoin("automations", "automations.id", "automation_runs.automation_id")
    .select([
      "automation_runs.org_id",
      "automation_runs.status",
      "automation_runs.conversation_id",
      "automations.id as automation_id",
      "automations.org_id as task_org_id",
      "automations.account_id",
      "automations.name",
    ])
    .where("automation_runs.id", "=", taskRunId)
    // a deleted task pushes nothing
    .where("automations.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row || row.org_id !== row.task_org_id) return null;
  if (row.status !== "completed" && row.status !== "failed") return null;
  const orgId = row.org_id;
  if (!(await orgLive(db, orgId))) return null;
  const accountIds = await activeMembers(db, orgId, [row.account_id]);
  if (accountIds.length === 0) return null;
  const conv =
    row.conversation_id === null
      ? undefined
      : await db
          .selectFrom("conversations")
          .select(["title"])
          .where("id", "=", row.conversation_id)
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
  const org = encodeURIComponent(orgId);
  return {
    orgId,
    accountIds,
    category: "automations",
    path: conv === undefined ? `/inbox?org=${org}` : `/chat/${row.conversation_id}?org=${org}`,
    threadId: `automation-${row.automation_id}`,
    title: row.name,
    conversationTitle: conv?.title ?? null,
    text: row.status === "completed" ? "automationRan" : "automationFailed",
  };
}

const optional = (id: string | null): string[] => (id === null ? [] : [id]);

/** Whether the org exists and is not deleted. */
async function orgLive(db: KernelSchemaDb, orgId: string): Promise<boolean> {
  const org = await db
    .selectFrom("orgs")
    .select("id")
    .where("id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return org !== undefined;
}

/** The trigger account of a run, or null when the run is gone. */
async function triggerAccountOf(db: KernelSchemaDb, runId: string): Promise<string | null> {
  const run = await db
    .selectFrom("runs")
    .select("trigger_account_id")
    .where("id", "=", runId)
    .executeTakeFirst();
  return run?.trigger_account_id ?? null;
}

/** The accounts among `ids` that are active and members of `orgId`, sorted. */
async function activeMembers(
  db: KernelSchemaDb,
  orgId: string,
  ids: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .selectFrom("memberships")
    .innerJoin("accounts", "accounts.id", "memberships.account_id")
    .select("accounts.id")
    .where("memberships.org_id", "=", orgId)
    .where("memberships.account_id", "in", unique)
    .where("accounts.status", "=", "active")
    .orderBy("accounts.id")
    .execute();
  return rows.map((r) => r.id);
}

/** The agent's name in its current version (empty when it has none). */
async function agentName(db: KernelSchemaDb, orgId: string, agentId: string): Promise<string> {
  const row = await db
    .selectFrom("agents")
    .innerJoin("agent_versions", (j) =>
      j
        .onRef("agent_versions.agent_id", "=", "agents.id")
        .onRef("agent_versions.version", "=", "agents.current_version"),
    )
    .select("agent_versions.definition")
    .where("agents.id", "=", agentId)
    .where("agents.org_id", "=", orgId)
    .executeTakeFirst();
  const name = (row?.definition as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : "";
}
