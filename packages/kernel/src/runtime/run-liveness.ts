import type { KernelDb } from "../infra/database/kernel-db.js";

/**
 * The one definition of "live" for runs: an org or conversation is live while it is not
 * soft-deleted. Every path that decides from an org's or a conversation's deletion whether a run
 * may start, keep executing or be stopped (queueing, wakes, the post-run ensure, the execution
 * fence, the orphan check, deletion) goes through here; other rows' deletion (agents, accounts,
 * devices) is not run liveness.
 */
export function isLive(...deletedAt: ReadonlyArray<unknown>): boolean {
  return deletedAt.every((d) => d === null);
}

/** Whether the org exists and is live (a plain read; the fence takes its own lock variant). */
export async function orgIsLive(t: Pick<KernelDb, "selectFrom">, orgId: string): Promise<boolean> {
  const org = await t
    .selectFrom("orgs")
    .select("deleted_at")
    .where("id", "=", orgId)
    .executeTakeFirst();
  return org !== undefined && isLive(org.deleted_at);
}
