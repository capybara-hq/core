import type { Selectable } from "kysely";
import type { EventLog } from "../conversations/event-log.js";
import type { SkillChangeRequestsTable } from "../db/kernel-schema.js";
import type { KernelDb } from "../infra/database/kernel-db.js";
import type { KernelLogger } from "../log.js";
import {
  type CatalogSkill,
  type PinnedSkill,
  type SkillsSnapshot,
  sameSnapshot,
} from "../runtime/context/skills.js";
import { fitPinned, invocationOf, lockLatestCatalog } from "./catalog.js";

/** What appending a conversation's skills catalog snapshot needs. */
export interface ConversationCatalogDeps {
  db: KernelDb;
  log: KernelLogger;
  eventLog: EventLog;
}

const byName = (a: CatalogSkill, b: CatalogSkill) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * In the caller's transaction, derives the conversation's next skills catalog snapshot from its
 * latest one and appends it (only when different). It first locks the conversation row (the lock
 * `EventLog.append` takes) and reads the latest snapshot under it, so no other snapshot slips in
 * between "read latest" and "append". Returns the seq written, or null when nothing was written;
 * the caller calls `eventLog.notify` after the commit.
 * `derive` gets the whole latest payload, so `pinned` and `toolMap` are carried forward; a pinned
 * entry is kept only while `skills` has the same id, version and source (pinned ⊆ skills), and the
 * pinned bodies still fit the size limit. The tool map is only recomputed at run start.
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
  const live = (p: PinnedSkill) =>
    skills.some((s) => s.id === p.id && s.version === p.version && s.source === p.source);
  const pinned = fitPinned((derived.pinned ?? []).filter(live), deps.log, { conversationId });
  const next: SkillsSnapshot = {
    skills,
    ...(pinned.length > 0 && { pinned }),
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
 * snapshot, the draft's entry is replaced by the agent skill's current real version (already the
 * post-decision state in the transaction), or removed when there is none. No snapshot is written
 * when the latest one no longer has the draft. While the conversation runs, the notice lands at the
 * current position (built after the tool results) and applies at the next step. A removal does not
 * guess an org skill of the same name (it was replaced in the snapshot); the next run start's
 * resolution brings it back.
 */
export async function revertTrialCatalog(
  deps: ConversationCatalogDeps,
  req: Selectable<SkillChangeRequestsTable>,
): Promise<number | null> {
  const name = req.proposed_version.manifest.name;
  const real = await deps.db
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
    .where("skills.scope", "=", "agent")
    .where("skills.agent_id", "=", req.agent_id)
    .where("skills.name", "=", name)
    .where("skills.deleted_at", "is", null)
    .executeTakeFirst();
  return appendConversationCatalog(
    deps,
    req.requested_in_conversation,
    (base) => {
      if (!base.skills.some((s) => s.source === req.object_prefix)) return null;
      const rest = base.skills.filter((s) => s.source !== req.object_prefix);
      // The draft's pinned entry goes (Decision 8): the next run start pins the real version
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
        ...(base.pinned && {
          pinned: base.pinned.filter((p) => p.source !== req.object_prefix),
        }),
      };
    },
    `skills_catalog:revert:${req.id}`,
  );
}
