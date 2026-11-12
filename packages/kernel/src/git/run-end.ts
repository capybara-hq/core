import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { GitTickets } from "./tickets.js";

/**
 * What a run's end does for the git gateway (sandbox git credentials spec §9): revokes the run's
 * tickets and writes the `git.fetch` summaries. `RunFinish` calls it in `afterCommit` of the
 * transaction that set the terminal status (set first, then revoke: `GitTickets.resolve` already
 * refuses a run that is not active, so revocation is cleanup and defense in depth).
 */

/** The Redis hash of a run's fetch counters: fields `<host>/<repo>|n` and `<host>/<repo>|bytes`. */
export const gitFetchKey = (runId: string): string => `git-fetch:${runId}`;
/**
 * Counters of a run that never ends cleanly (a lost end hook) expire after this. A fetch still in
 * flight after the run ended writes a counter nobody summarises: it expires by this TTL too.
 */
export const FETCH_COUNTER_TTL_SECONDS = 24 * 60 * 60;

/** Adds one fetch request and its bytes to the run's counters (atomic, with a TTL). */
export async function recordGitFetch(
  redis: Redis,
  runId: string,
  host: string,
  repo: string,
  bytes: number,
  countRequest: boolean,
): Promise<void> {
  const key = gitFetchKey(runId);
  const field = `${host}/${repo}`;
  const m = redis.multi();
  if (countRequest) m.hincrby(key, `${field}|n`, 1);
  m.hincrby(key, `${field}|bytes`, Math.max(0, Math.round(bytes)));
  await m.expire(key, FETCH_COUNTER_TTL_SECONDS).exec();
}

/** Reads and deletes a hash in one step, so a summary is written once. */
const TAKE_HASH = `
local all = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return all
`;

@Injectable()
export class GitRunEnd {
  constructor(
    @Inject(GitTickets) private readonly tickets: Pick<GitTickets, "revokeRun">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /** Run end: revokes the run's tickets and writes one `git.fetch` audit row per repository. */
  async onRunFinished(runId: string): Promise<void> {
    // both steps always run: a failing revocation must not lose the summaries, nor the reverse
    const results = await Promise.allSettled([
      this.tickets.revokeRun(runId),
      this.writeFetchSummaries(runId),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        this.log.warn("git run end failed", {
          runId,
          error: r.reason instanceof Error ? r.reason.name : "unknown",
        });
      }
    }
  }

  private async writeFetchSummaries(runId: string): Promise<void> {
    const flat = (await this.redis.eval(TAKE_HASH, 1, gitFetchKey(runId))) as string[];
    if (flat.length === 0) return;
    const perRepo = new Map<string, { count: number; bytes: number }>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const field = String(flat[i]);
      const cut = field.lastIndexOf("|");
      const target = field.slice(0, cut);
      const entry = perRepo.get(target) ?? { count: 0, bytes: 0 };
      if (field.slice(cut + 1) === "n") entry.count = Number(flat[i + 1]);
      else entry.bytes = Number(flat[i + 1]);
      perRepo.set(target, entry);
    }
    const run = await this.db.db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.conversation_id", "runs.trigger_account_id", "conversations.org_id"])
      .where("runs.id", "=", runId)
      .executeTakeFirst();
    if (run === undefined) return;
    for (const [target, { count, bytes }] of perRepo) {
      const slash = target.indexOf("/");
      await audit(this.db.db, {
        actorAccountId: run.trigger_account_id,
        orgId: run.org_id,
        action: "git.fetch",
        target,
        detail: {
          runId,
          conversationId: run.conversation_id,
          host: target.slice(0, slash),
          repo: target.slice(slash + 1),
          count,
          bytes,
        },
      });
    }
  }
}
