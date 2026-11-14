import type { ExtensionContext, Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { conversationTopic } from "../conversations/event-log.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";

/** The three phases of a compaction (context compaction spec §4.6). */
export type CompactionPhase = "preparing" | "summarizing" | "writing";

/**
 * A compaction's progress (context compaction spec §4.6): ephemeral, Redis-kept and display-only.
 * `chunk` / `chunks` are set only in the chunked path (a real `i/N`, never a percentage); `chars`
 * is how much of the running summary has streamed in the current call.
 */
export interface CompactionProgress {
  phase: CompactionPhase;
  step: number;
  chunk?: number;
  chunks?: number;
  chars?: number;
  /** When this compaction started (the web row's elapsed time). */
  startedAt: number;
}

/** One snapshot to publish: the run and conversation it belongs to and the progress itself. */
export interface CompactionProgressUpdate {
  runId: string;
  conversationId: string;
  agentId?: string;
  progress: CompactionProgress;
}

/** How long a progress key lives without a write (a backstop; each write refreshes it). */
export const COMPACTION_PROGRESS_TTL_SECONDS = 600;
/** At most one write per run per window while the summary streams (a phase change always writes). */
export const COMPACTION_PROGRESS_FLUSH_MS = 200;

/** The run's progress key. */
export const compactionProgressKey = (runId: string): string => `capk:run-compaction:${runId}`;

/** What the run publishes inside `maybeCompact` (the injected service implements it). */
export interface CompactionProgressSink {
  update(u: CompactionProgressUpdate): void;
  clear(runId: string): void;
}

/** The writer-local throttle state of one run. */
interface Last {
  writtenAt: number;
  phase: CompactionPhase;
}

/**
 * Compaction progress for the conversation SSE (context compaction spec §4.6). The process running
 * the compaction writes the run's Redis key (`capk:run-compaction:<runId>`, TTL
 * {@link COMPACTION_PROGRESS_TTL_SECONDS}) and publishes a `compaction_progress` message on the
 * conversation's topic, which the SSE forwards as `event: compaction`.
 *
 * Multi-replica safe: the durable state is the Redis key (a viewer may read it on any replica); the
 * in-memory map only throttles this writer's own writes and a phase change always writes. Progress
 * is display-only, never in the event log: a lost write or publish costs nothing, and failures are
 * logged, never thrown to the run.
 */
@Injectable()
export class CompactionProgressService implements CompactionProgressSink {
  /** Writer-local: when each run was last written, and its phase then. */
  private readonly last = new Map<string, Last>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_BUS) private readonly bus: Pick<ExtensionContext["bus"], "publish">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {}

  /**
   * Publishes one snapshot: a phase change writes at once; while the summary streams (`chars`
   * moving) a write happens at most every {@link COMPACTION_PROGRESS_FLUSH_MS}. Fire-and-forget.
   */
  update(u: CompactionProgressUpdate): void {
    const { runId, progress } = u;
    const now = Date.now();
    const prev = this.last.get(runId);
    if (
      prev !== undefined &&
      prev.phase === progress.phase &&
      now - prev.writtenAt < COMPACTION_PROGRESS_FLUSH_MS
    ) {
      return;
    }
    this.last.set(runId, { writtenAt: now, phase: progress.phase });

    this.redis
      .set(
        compactionProgressKey(runId),
        JSON.stringify(progress),
        "EX",
        COMPACTION_PROGRESS_TTL_SECONDS,
      )
      .catch((err) => this.log.warn("compaction progress write failed", { runId, err }));
    this.bus
      .publish(conversationTopic(u.conversationId), {
        kind: "compaction_progress",
        runId,
        conversationId: u.conversationId,
        ...(u.agentId !== undefined && { agentId: u.agentId }),
        ...progress,
      })
      .catch((err) => this.log.warn("compaction progress publish failed", { runId, err }));
  }

  /** Deletes the run's progress key (the compaction ended); the TTL is the backstop. */
  clear(runId: string): void {
    this.last.delete(runId);
    this.redis
      .del(compactionProgressKey(runId))
      .catch((err) => this.log.warn("compaction progress clear failed", { runId, err }));
  }
}
