import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";

/**
 * The delayed idle compaction job (idle compaction spec §4.2, §4.3): owed by the terminal
 * transaction of a chat run that passed the arm decision (`RunFinish.finishIn`, S4), due shortly
 * before the run's prompt cache expires, on the maintenance queue. A leaf module, so the run finish
 * and the job's consumer import the name without importing each other.
 */
export const IDLE_COMPACTION_JOB = "idle-compaction";

/** One job per arming run (no `:`): a duplicate owe of the same run is a no-op. */
export const idleCompactionJobId = (runId: string): string => `idle-compact-${runId}`;

/** What every `idle-compaction` job carries. */
interface IdleCompactionJobBase {
  orgId: string;
  conversationId: string;
  /** The run that armed the job. */
  runId: string;
  /** The seq of that run's terminal `run_finished` event (S4). */
  armedSeq: number;
}

/**
 * The `idle-compaction` job's data, by how the job compacts (compaction model spec §6.2): in the
 * armed prompt cache (`cache`, with the call the expiry was derived from and the expiry), or on the
 * compaction model (`compaction_model`, due `idleDelayMinutes` after the run, no expiry). A row
 * owed by the previous release has no `mode`: readers take `data.mode ?? "cache"` (C5).
 */
export type IdleCompactionJobData =
  | (IdleCompactionJobBase & {
      mode: "cache";
      /** The seq of the `model_call` the cache expiry was derived from (`CacheExpiry.callSeq`). */
      cacheCallSeq: number;
      /** When the prompt cache entry expires, epoch ms. */
      expiresAt: number;
    })
  | (IdleCompactionJobBase & { mode: "compaction_model" });

/**
 * A delivered job's data: {@link IdleCompactionJobData}, or a cache-mode row owed before `mode`
 * existed (still in the outbox or the queue across the deploy, C5).
 */
export type IdleCompactionJobInput =
  | IdleCompactionJobData
  | (Omit<Extract<IdleCompactionJobData, { mode: "cache" }>, "mode"> & { mode?: undefined });

/** Owes the idle compaction job in the caller's transaction (throws outside one), due at `runAt`. */
export function oweIdleCompaction(
  outbox: Pick<OutboxService, "add">,
  data: IdleCompactionJobData,
  runAt: number,
): Promise<boolean> {
  return outbox.add<IdleCompactionJobData>({
    queue: MAINTENANCE_QUEUE_NAME,
    name: IDLE_COMPACTION_JOB,
    jobId: idleCompactionJobId(data.runId),
    data,
    runAt: new Date(runAt),
    orgId: data.orgId,
  });
}
