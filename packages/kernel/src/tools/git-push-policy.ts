import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { budgetRunOf } from "../runtime/subagents/limits.js";
import { GIT_PUSH_GRANT, gitPushGrantKey, normalizeGitRepo } from "../schedules/grant-rules.js";
import { type UnattendedRun, unattendedRules, unattendedRunOf } from "../schedules/unattended.js";
import { gitPushPolicyName, personalAuth } from "./connector-account-policies.js";
import type { GitRunState } from "./git-asks.js";
import { connectorPolicy } from "./policy.js";
import type { ToolPolicy } from "./registry.js";

/**
 * The push policy of the git gateway (sandbox git credentials spec §7): fetches run, a push
 * follows the connector's virtual tool `git_push`. Read from PG on every push (no in-process
 * state), so a decision on one replica holds on every other.
 *
 * Storage (no new table): the org's default is `connectors.git_push_policy` (default `ask`); a
 * member's standing allow (or deny) for one repository is their `connector_tool_account_policies`
 * row `git_push:<owner>/<repo>` (a personal connector only: an org connector's push acts as the
 * org); a run grant is an approved `once` git ask of the run tree; a scheduled task's grants are
 * `git:push` and `git:push:<owner>/<repo>` in `scheduled_task_grants`.
 */

/** The statuses of a run that has not ended: its run grants still apply. */
const LIVE_RUN = ["queued", "running", "waiting"] as const;

/** The statuses of a git ask that refuse its repository for the rest of the run tree. */
const REFUSING = new Set(["denied", "expired", "skipped", "cancelled"]);

/** Why {@link decideGitPush} decided as it did. */
export type GitPushReason =
  /** The org's default for the connector allows pushes. */
  | "org_allow"
  /** The member's standing allow for the repository. */
  | "member_allow"
  /** An approved 「这次允许」 of the run tree for the repository. */
  | "run_grant"
  /** The scheduled task's `git:push` / `git:push:<owner>/<repo>` grant (unattended run). */
  | "task_grant"
  /** The policy asks the actor. */
  | "ask"
  /** The org's default denies pushes through the connector. */
  | "org_deny"
  /** The member denied pushes to the repository for themselves. */
  | "member_deny"
  /** The org forbids `git:push` (or the repository's key) in scheduled runs. */
  | "forbidden"
  /** An unattended run in `fail` mode without a task grant: no one can be asked. */
  | "unattended"
  /** The connector is not a live, active connector of the org. */
  | "unavailable"
  /** The repository is not `<owner>/<repo>`. */
  | "invalid_repo";

/** The decision about one push. */
export interface GitPushDecision {
  decision: "allow" | "ask" | "deny";
  reason: GitPushReason;
  /** The repository as keyed (`<owner>/<repo>`, lower-cased); null when it was invalid. */
  repo: string | null;
  /** An unattended refusal's `missing_grants` key (`git:push:<owner>/<repo>`) and task run. */
  missingGrant?: { taskRunId: string; key: string };
}

/** What {@link decideGitPush} decides about. */
export interface GitPushInput {
  orgId: string;
  /** The actor whose credential the push uses (the ticket's account). */
  accountId: string;
  /** The run the exec belongs to (the ticket's run). */
  runId: string;
  /** The git source the push uses (the connector whose credential is injected). */
  connectorId: string;
  host: string;
  /** `<owner>/<repo>` (a trailing `.git` and case are normalized here). */
  repo: string;
  /**
   * The scheduled task context of the run, when the caller has it (`unattendedRunOf`); undefined:
   * read here. Null: an attended run.
   */
  unattended?: UnattendedRun | null;
}

/** A decision the actor's or the org's policy settles without grants (pure). */
export function gitPushBase(input: {
  orgDefault: ToolPolicy;
  /** The member's own setting for the repository (a personal connector only). */
  member?: ToolPolicy | undefined;
}): { policy: ToolPolicy; reason: GitPushReason } {
  const r = connectorPolicy({ orgDefault: input.orgDefault, member: input.member });
  if (r.policy === "deny")
    return { policy: "deny", reason: r.source === "org" ? "org_deny" : "member_deny" };
  if (r.policy === "allow") {
    return { policy: "allow", reason: r.source === "member" ? "member_allow" : "org_allow" };
  }
  return { policy: "ask", reason: "ask" };
}

/**
 * Decides a push (sandbox git credentials spec §7), highest first:
 * 1. the org's default `deny` for the connector; the member's own `deny` for the repository;
 * 2. the member's standing allow for the repository (personal connector), else the org's
 *    default `allow`; a member's `ask` keeps an org `allow` asking;
 * 3. an ask is allowed by a run grant (an approved `once` git ask of the live run tree for the
 *    host and repository);
 * 4. an unattended run (no trial, no person joined): a forbidden `git:push` denies; a task grant
 *    `git:push` or `git:push:<owner>/<repo>` allows; else `fail` mode refuses (`unattended`, with
 *    the missing grant to record) and `wait` mode asks the creator.
 * Grants never lift a deny. The caller records the missing grant and the Redis ask record.
 */
export async function decideGitPush(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get">,
  input: GitPushInput,
): Promise<GitPushDecision> {
  const repo = normalizeGitRepo(input.repo);
  if (repo === null) return { decision: "deny", reason: "invalid_repo", repo: null };
  const host = input.host.toLowerCase();
  const connector = await db
    .selectFrom("connectors")
    .select(["auth", "status", "git_push_policy"])
    .where("id", "=", input.connectorId)
    .where("org_id", "=", input.orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (connector?.status !== "active") {
    return { decision: "deny", reason: "unavailable", repo };
  }
  let member: ToolPolicy | undefined;
  if (personalAuth(connector.auth)) {
    const row = await db
      .selectFrom("connector_tool_account_policies")
      .select("policy")
      .where("connector_id", "=", input.connectorId)
      .where("account_id", "=", input.accountId)
      .where("tool_name", "=", gitPushPolicyName(repo))
      .executeTakeFirst();
    member = row?.policy;
  }
  const base = gitPushBase({ orgDefault: connector.git_push_policy, member });
  if (base.policy !== "ask") return { decision: base.policy, reason: base.reason, repo };
  if (await hasRunGrant(db, input.orgId, input.runId, host, repo)) {
    return { decision: "allow", reason: "run_grant", repo };
  }
  const unattended =
    input.unattended !== undefined
      ? input.unattended
      : await unattendedRunOf(db, config, input.orgId, input.runId);
  if (unattendedRules(unattended)) {
    const key = gitPushGrantKey(repo);
    if (
      unattended.forbiddenTools.includes(GIT_PUSH_GRANT) ||
      unattended.forbiddenTools.includes(key)
    ) {
      return { decision: "deny", reason: "forbidden", repo };
    }
    const granted = await db
      .selectFrom("scheduled_task_grants")
      .select("tool_key")
      .where("task_id", "=", unattended.taskId)
      .where("tool_key", "in", [GIT_PUSH_GRANT, key])
      .executeTakeFirst();
    if (granted !== undefined) return { decision: "allow", reason: "task_grant", repo };
    if (unattended.unattendedAsk === "fail") {
      return {
        decision: "deny",
        reason: "unattended",
        repo,
        missingGrant: { taskRunId: unattended.taskRunId, key },
      };
    }
  }
  return { decision: "ask", reason: "ask", repo };
}

/** The runs of the tree whose budget run is `root`. */
const treeOf = (db: KernelSchemaDb, root: string) =>
  db
    .selectFrom("runs")
    .select("id")
    .where((eb) => eb.or([eb("id", "=", root), eb("budget_run_id", "=", root)]));

/**
 * Whether the run tree holds a run grant for pushes to `repo` on `host`: an approved `once` git
 * ask of the tree in the org, while the tree's root run has not ended (a grant ends with its run;
 * a later run of the same budget window does not inherit it). An `always` decision is the member's
 * policy row and is read there, not here.
 */
async function hasRunGrant(
  db: KernelSchemaDb,
  orgId: string,
  runId: string,
  host: string,
  repo: string,
): Promise<boolean> {
  const root = await budgetRunOf(db, runId);
  const live = await db
    .selectFrom("runs")
    .select("id")
    .where("id", "=", root)
    .where("status", "in", LIVE_RUN)
    .executeTakeFirst();
  if (live === undefined) return false;
  const row = await db
    .selectFrom("approvals")
    .select("id")
    .where("kind", "=", "git")
    .where("org_id", "=", orgId)
    .where("status", "=", "approved")
    .where("scope", "=", "once")
    .where(sql<string>`detail->>'repo'`, "=", repo)
    .where(sql<string>`lower(detail->>'host')`, "=", host)
    .where("run_id", "in", treeOf(db, root))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The run tree's git asks (the network asks' rules, network ask-to-allow spec §6.8): the
 * repositories granted and refused in the tree, this run's asks, a pending ask of the tree.
 */
export async function gitRunState(db: KernelSchemaDb, runId: string): Promise<GitRunState> {
  const root = await budgetRunOf(db, runId);
  const rows = await db
    .selectFrom("approvals")
    .select(["run_id", "status", "scope", "detail"])
    .where("kind", "=", "git")
    .where("run_id", "in", treeOf(db, root))
    .execute();
  const state: GitRunState = { granted: new Set(), refused: new Set(), asks: 0, pending: false };
  for (const r of rows) {
    if (r.run_id === runId) state.asks++;
    const repo = (r.detail as { repo?: unknown } | null)?.repo;
    if (r.status === "pending") state.pending = true;
    else if (typeof repo !== "string") continue;
    else if (r.status === "approved" && r.scope === "once") state.granted.add(repo);
    else if (REFUSING.has(r.status)) state.refused.add(repo);
  }
  return state;
}
