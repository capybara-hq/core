import { type Selectable, sql } from "kysely";
import type { EventLog } from "../conversations/event-log.js";
import type { SkillChangeRequestsTable } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import type { KernelDb } from "../infra/database/kernel-db.js";
import type { KernelLogger } from "../log.js";
import { type CatalogSkill, type SkillsSnapshot, sameSnapshot } from "../runtime/context/skills.js";
import { invocationOf, lockLatestCatalog } from "./catalog.js";

/** What appending a conversation's skills catalog snapshot needs. */
export interface ConversationCatalogDeps {
  db: KernelDb;
  log: KernelLogger;
  eventLog: EventLog;
}

/** Cancelled requests: draft prefixes to delete and (conversation, seq) to publish after the commit. */
export interface CancelledDrafts {
  prefixes: string[];
  seqs: [string, number][];
}

const byName = (a: CatalogSkill, b: CatalogSkill) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * In the caller's transaction, derives the conversation's next skills catalog snapshot from its
 * latest one and appends it (only when different). It first locks the conversation row (the lock
 * `EventLog.append` takes) and reads the latest snapshot under it, so no other snapshot slips in
 * between "read latest" and "append". Returns the seq written, or null when nothing was written;
 * the caller calls `eventLog.notify` after the commit.
 * `derive` gets the whole latest payload, so `toolMap` is carried forward (it is only recomputed at
 * run start). `pinned` of an old snapshot never is: new snapshots carry no pinned skills (skills
 * default-on spec §8).
 */
export async function appendConversationCatalog(
  deps: ConversationCatalogDeps,
  conversationId: string,
  derive: (base: SkillsSnapshot) => SkillsSnapshot | null,
  idemKey: string,
  runId?: string | null,
): Promise<number | null> {
  const base = (await lockLatestCatalog(deps.db.db, conversationId)) ?? { skills: [] };
  const derived = derive(base);
  if (derived === null) return null;
  const skills = [...derived.skills].sort(byName);
  const next: SkillsSnapshot = {
    skills,
    ...(derived.toolMap !== undefined && { toolMap: derived.toolMap }),
  };
  if (sameSnapshot(base, next)) return null;
  const written = await deps.eventLog.appendIn(conversationId, [
    {
      type: "skills_catalog",
      ...(runId !== undefined && runId !== null && { runId }),
      idemKey,
      payload: next,
    },
  ]);
  return Math.max(...written.map((e) => e.seq));
}

/**
 * When a draft stops applying (rejected / cancelled), appends a reverting snapshot to the
 * requesting conversation in the caller's transaction: derived from that conversation's latest
 * snapshot, the draft's entry is replaced by the skill's current real version (already the
 * post-decision state in the transaction; for a version proposal the org skill it targets), or
 * removed when there is none. No snapshot is written when the latest one no longer has the draft,
 * nor for a request without a conversation or a share request (no trial). While the conversation
 * runs, the notice lands at the current position (built after the tool results) and applies at
 * the next step. A removal does not guess an org skill of the same name (it was replaced in the
 * snapshot); the next run start's resolution brings it back.
 */
export async function revertTrialCatalog(
  deps: ConversationCatalogDeps,
  req: Selectable<SkillChangeRequestsTable>,
): Promise<number | null> {
  const conversationId = req.requested_in_conversation;
  if (conversationId === null || req.kind === "share") return null;
  const name = req.proposed_version.manifest.name;
  let q = deps.db
    .selectFrom("skills")
    .innerJoin("skill_versions", (j) =>
      j
        .onRef("skill_versions.skill_id", "=", "skills.id")
        .onRef("skill_versions.version", "=", "skills.current_version"),
    )
    .select([
      "skills.id",
      "skills.current_version",
      "skill_versions.manifest",
      "skill_versions.object_prefix",
    ])
    .where("skills.org_id", "=", req.org_id)
    .where("skills.deleted_at", "is", null);
  // A proposal on a shared org skill goes back to that skill's current version; one served from
  // a platform skill (promoted or linked without a pin) is removed instead, and the next run start
  // resolves it again
  q =
    req.skill_id !== null
      ? q
          .where("skills.id", "=", req.skill_id)
          .where("skills.scope", "=", "org")
          .where((eb) =>
            eb.or([
              eb("skills.platform_skill_id", "is", null),
              eb("skills.pinned_version", "is not", null),
            ]),
          )
      : q
          .where("skills.scope", "=", "agent")
          .where("skills.agent_id", "=", req.agent_id)
          .where("skills.name", "=", name);
  const real = await q.executeTakeFirst();
  return appendConversationCatalog(
    deps,
    conversationId,
    (base) => {
      if (!base.skills.some((s) => s.source === req.object_prefix)) return null;
      const rest = base.skills.filter((s) => s.source !== req.object_prefix);
      return {
        ...base,
        // A manual-only current version (phase D) stays out of the model's catalog
        skills:
          real && invocationOf(real.manifest).model
            ? [
                ...rest,
                {
                  id: real.id,
                  name,
                  description: real.manifest.description,
                  version: real.current_version,
                  source: real.object_prefix,
                },
              ]
            : rest,
      };
    },
    `skills_catalog:revert:${req.id}`,
  );
}

/**
 * In the caller's transaction (the request row locked), cancels a pending request: status
 * `cancelled`, audit `skill.change_decided` with the reason. A version draft also gets a
 * reverting snapshot in its conversation (unless `revert` is false: the caller appends the next
 * one) and its prefix is queued in `out` for deletion after the commit; a share request points at
 * the skill's own version files, which stay.
 */
export async function cancelRequestIn(
  deps: ConversationCatalogDeps,
  req: Selectable<SkillChangeRequestsTable>,
  out: CancelledDrafts,
  how: { actorAccountId: string; actorTokenId?: string; reason: string; revert?: boolean },
): Promise<void> {
  await deps.db
    .updateTable("skill_change_requests")
    .set({ status: "cancelled", decided_at: sql<Date>`now()` })
    .where("id", "=", req.id)
    .execute();
  await audit(deps.db.db, {
    actorAccountId: how.actorAccountId,
    ...(how.actorTokenId !== undefined && { actorTokenId: how.actorTokenId }),
    orgId: req.org_id,
    action: "skill.change_decided",
    target: req.id,
    detail: {
      decision: "cancelled",
      reason: how.reason,
      kind: req.kind,
      agentId: req.agent_id,
      name: req.proposed_version.manifest.name,
    },
  });
  if (req.kind === "share") return;
  if (how.revert !== false) {
    const seq = await revertTrialCatalog(deps, req);
    if (seq !== null && req.requested_in_conversation !== null) {
      out.seqs.push([req.requested_in_conversation, seq]);
    }
  }
  out.prefixes.push(req.object_prefix);
}
