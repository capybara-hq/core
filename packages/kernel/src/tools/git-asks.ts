import type { Redis } from "ioredis";
import { GIT_ASK_MAX_REFS, GIT_REF_MAX_CHARS } from "../conversations/events.js";
import { gitPushGrantKey, normalizeGitRepo } from "../schedules/grant-rules.js";
import { type ApprovalRecord, GIT_ASK_CANCELLED_NOTE } from "./approvals.service.js";
import { clipKeptWith } from "./network-asks.js";

/**
 * Git push asks in the tool pipeline (sandbox git credentials spec §5.6, §7; the flow of network
 * ask-to-allow spec §6.2–§6.8): the record the gateway leaves when it holds a push, what that
 * record turns into after the command (an ask to the actor, or notes written at once) and the
 * model-visible notes. Pure apart from the Redis record helpers, which the gateway (writes) and
 * the `Bash` pipeline (reads) share.
 */

/** How long the gateway's record of a held push waits for the command's result (seconds). */
export const GIT_ASK_RECORD_TTL_SECONDS = 60 * 60;

/** The Redis key of the push the gateway held during one exec (`execId`: the tool call id). */
export const gitAskKey = (execId: string) => `git-ask:${execId}`;

/** The most git asks one run makes; later held pushes get {@link gitTooManyNote}. */
export const MAX_GIT_ASKS_PER_RUN = 5;

/** The line a kept result ends with when it had to be clipped to 16 KB. */
export const GIT_ASK_CLIPPED_NOTE =
  "[Output clipped to its first 16 KB while waiting for approval of the push.]";

/**
 * What the gateway refused during an exec (Redis `git-ask:<execId>`, TTL
 * {@link GIT_ASK_RECORD_TTL_SECONDS}): the host, the repository (`<owner>/<repo>`, normalized),
 * the refs the push would have updated and why it refused: `ask` (the policy asks the actor;
 * absent means `ask`), `unattended` (a scheduled run without a task grant, `fail` mode) or
 * `denied` (the org's or the member's policy denies it). `connectorId`: the git source whose
 * credential the push used (the ask's connector).
 */
export interface GitAskRecord {
  host: string;
  repo: string;
  refs: string[];
  connectorId?: string;
  outcome?: "ask" | "unattended" | "denied";
}

/** The Redis commands the record helpers use. */
export type GitAskRedis = Pick<Redis, "set" | "getdel">;

/** A record as stored and read back: valid fields only, refs capped; null when unusable. */
function cleanRecord(raw: unknown): GitAskRecord | null {
  const r = raw as Partial<Record<keyof GitAskRecord, unknown>> | null;
  if (r === null || typeof r !== "object") return null;
  if (typeof r.host !== "string" || r.host === "" || r.host.length > 255) return null;
  if (typeof r.repo !== "string") return null;
  const repo = normalizeGitRepo(r.repo);
  if (repo === null) return null;
  const refs = Array.isArray(r.refs)
    ? [
        ...new Set(
          r.refs.filter(
            (x): x is string => typeof x === "string" && x !== "" && x.length <= GIT_REF_MAX_CHARS,
          ),
        ),
      ].slice(0, GIT_ASK_MAX_REFS)
    : [];
  const outcome =
    r.outcome === "unattended" || r.outcome === "denied" || r.outcome === "ask"
      ? r.outcome
      : undefined;
  return {
    host: r.host.toLowerCase(),
    repo,
    refs,
    ...(typeof r.connectorId === "string" && { connectorId: r.connectorId }),
    ...(outcome !== undefined && { outcome }),
  };
}

/**
 * Records the push the gateway held during `execId` (one per exec: a later one replaces it), with
 * TTL {@link GIT_ASK_RECORD_TTL_SECONDS}. An unusable record (no `<owner>/<repo>`) is not written.
 */
export async function recordGitAsk(
  redis: GitAskRedis,
  execId: string,
  ask: GitAskRecord,
): Promise<void> {
  const clean = cleanRecord(ask);
  if (clean === null) return;
  await redis.set(gitAskKey(execId), JSON.stringify(clean), "EX", GIT_ASK_RECORD_TTL_SECONDS);
}

/** Reads and deletes the push held during `execId` (null: none, expired or unreadable). */
export async function takeGitAsk(redis: GitAskRedis, execId: string): Promise<GitAskRecord | null> {
  const raw = await redis.getdel(gitAskKey(execId));
  if (raw === null) return null;
  try {
    return cleanRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A ref as notes and cards show it (`refs/heads/` dropped). */
const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

/** "acme/app (main, feat/x)": the repository and up to three refs. */
function target(repo: string, refs: readonly string[]): string {
  if (refs.length === 0) return repo;
  const shown = refs.slice(0, 3).map(shortRef).join(", ");
  return `${repo} (${refs.length > 3 ? `${shown} and ${refs.length - 3} more` : shown})`;
}

/** "[git] The push to acme/app (main) was held for the user's approval." (the lead of ask notes). */
const heldLead = (repo: string, refs: readonly string[]) =>
  `[git] The push to ${target(repo, refs)} was held for the user's approval.`;

/**
 * Asked: the line the gateway's refusal carries (git prints it in the command's output, so the
 * model reads it in the kept result while the ask waits).
 */
export const gitAskedNote = (repo: string) =>
  `[git] Push to ${repo} needs approval; the user is asked after this command.`;

/** Asked, allowed for the rest of the run (a run grant). */
export const gitAllowedOnceNote = (repo: string, refs: readonly string[]) =>
  `${heldLead(repo, refs)} The user allowed pushes to ${repo} for the rest of this task. Run the push again.`;

/** Asked, allowed from now on (the member's standing allow for the repository). */
export const gitAllowedAlwaysNote = (repo: string, refs: readonly string[]) =>
  `${heldLead(repo, refs)} The user allowed pushes to ${repo} from now on. Run the push again.`;

/** Asked and declined (also a repository refused earlier in the run). */
export const gitDeniedNote = (repo: string, refs: readonly string[], reason?: string | null) =>
  `${heldLead(repo, refs)} The user declined the push to ${repo}. Do not push it another way; continue without pushing or ask the user.` +
  (reason != null && reason !== "" ? ` Reason: ${reason}` : "");

/** Asked, no answer within the approval timeout. */
export const gitExpiredNote = (repo: string, refs: readonly string[], hours: number) =>
  `${heldLead(repo, refs)} The user did not answer within ${hours}h; the push was not made.`;

/** Asked, the person sent a message instead. */
export const gitSkippedNote = (repo: string, refs: readonly string[]) =>
  `${heldLead(repo, refs)} The user sent a message instead of answering; the push was not made.`;

/** Asked, the run was stopped before the answer (the note abort writes too). */
export const gitCancelledNote = (): string => GIT_ASK_CANCELLED_NOTE;

/** Not asked: another git push ask of the run tree is waiting (at most one at a time). */
export const gitOtherAskPendingNote = (repo: string, refs: readonly string[]) =>
  `[git] The push to ${target(repo, refs)} was not made: another push request is waiting for the user. Run it again after that one is answered.`;

/** Not asked: the run made {@link MAX_GIT_ASKS_PER_RUN} asks already. */
export const gitTooManyNote = (repo: string, refs: readonly string[]) =>
  `[git] The push to ${target(repo, refs)} was not made: too many push requests in this task. Ask the user to push or to allow ${repo}.`;

/** An unattended run in `fail` mode: no ask, the creator can add a task grant. */
export const gitUnattendedNote = (repo: string, refs: readonly string[]) =>
  `[git] The push to ${target(repo, refs)} was not made: this scheduled run cannot ask for approval. The task's owner can allow pushes to ${repo} for the task. Continue without pushing.`;

/** The org's or the member's policy denies pushes to the repository. */
export const gitPolicyDeniedNote = (repo: string, refs: readonly string[]) =>
  `[git] The push to ${target(repo, refs)} was not made: pushes to ${repo} are not allowed by this organization's policy. Do not push it another way; continue without pushing or tell the user.`;

/** The push had no credential: the actor has no connection for the host (spec §6.2). */
export const gitNotConnectedNote = (host: string) =>
  `[git] The push to ${host} was not made: the user has no connection that can push there. The user can connect one under Settings → Connectors; continue without pushing or ask the user.`;

/** What the run tree's git asks add up to (the network asks' rules, §6.8 there). */
export interface GitRunState {
  /** Repositories allowed for the rest of the run tree (「这次允许」). */
  granted: Set<string>;
  /** Repositories refused in the run tree (denied, expired, skipped, cancelled): never asked again. */
  refused: Set<string>;
  /** Git asks of this run (the per-run cap counts them). */
  asks: number;
  /** A git ask of the run tree is still pending (at most one at a time). */
  pending: boolean;
}

/** What to do with a push the gateway held. */
export interface GitPlan {
  /** Ask the actor about the push (the record's facts become the ask's detail). */
  ask: boolean;
  /** Notes written now, after the command output. */
  notes: string[];
  /** `missing_grants` keys of an unattended run (`git:push:<owner>/<repo>`). */
  missingGrants: string[];
}

/**
 * Decides what a held push becomes after its command (the caller asks only for a foreground
 * `Bash` call): the gateway's own refusals (`unattended`: its note and a missing grant;
 * `denied`: the policy note) are written at once; an ask (`ask`) about a repository refused
 * earlier in the run tree gets the denied note, one while another git ask of the tree is pending
 * or after {@link MAX_GIT_ASKS_PER_RUN} asks of the run gets its note; the rest is asked.
 */
export function planGitAsk(record: GitAskRecord, run: GitRunState | null): GitPlan {
  const { repo, refs } = record;
  switch (record.outcome) {
    case "unattended":
      return {
        ask: false,
        notes: [gitUnattendedNote(repo, refs)],
        missingGrants: [gitPushGrantKey(repo)],
      };
    case "denied":
      return { ask: false, notes: [gitPolicyDeniedNote(repo, refs)], missingGrants: [] };
    default:
      break;
  }
  if (run?.refused.has(repo)) {
    return { ask: false, notes: [gitDeniedNote(repo, refs)], missingGrants: [] };
  }
  if (run?.pending === true) {
    return { ask: false, notes: [gitOtherAskPendingNote(repo, refs)], missingGrants: [] };
  }
  if ((run?.asks ?? 0) >= MAX_GIT_ASKS_PER_RUN) {
    return { ask: false, notes: [gitTooManyNote(repo, refs)], missingGrants: [] };
  }
  return { ask: true, notes: [], missingGrants: [] };
}

/**
 * The note of a settled git ask: one line per outcome; `hours` is the ask's own wait (created to
 * expiry). Null while it is pending or for an approval of another kind.
 */
export function settledGitNotes(a: ApprovalRecord, hours: number): string[] | null {
  if (a.git === null) return null;
  const { repo, refs } = a.git;
  switch (a.status) {
    case "approved":
      return [
        a.scope === "always" ? gitAllowedAlwaysNote(repo, refs) : gitAllowedOnceNote(repo, refs),
      ];
    case "denied":
      return [gitDeniedNote(repo, refs, a.denyReason)];
    case "expired":
      return [gitExpiredNote(repo, refs, hours)];
    case "skipped":
      return [gitSkippedNote(repo, refs)];
    case "cancelled":
      return [gitCancelledNote()];
    default:
      return null;
  }
}

/** `text` followed by `notes` after a blank line (unchanged without notes). */
export const withGitNotes = (text: string, notes: readonly string[]): string =>
  notes.length === 0 ? text : `${text}\n\n${notes.join("\n")}`;

/**
 * A kept result's content within 16 KB (UTF-8): the head, then {@link GIT_ASK_CLIPPED_NOTE}. The
 * caller archives large output first, so this rarely cuts.
 */
export const clipGitKept = (content: string): string => clipKeptWith(content, GIT_ASK_CLIPPED_NOTE);
