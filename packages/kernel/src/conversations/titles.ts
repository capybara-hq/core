import type { ContentBlock, Logger } from "@capybara-hq/plugin-sdk";
import { type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import type { ModelPurposesService } from "../models/purposes.js";
import { bullConnection } from "../runtime/run-queue.js";
import type { UsageReporter } from "../runtime/usage-report.js";
import type { EventLog } from "./event-log.js";
import type { ConversationEvent } from "./events.js";

/**
 * Model-generated conversation titles (UI refresh B, spec §5.1 "Titles").
 *
 * After a completed run, {@link TitleQueue.maybeEnqueue} queues one job on `cap-kernel-titles`
 * when the conversation is a chat with no title, has not been renamed, has fewer than
 * {@link TITLE_MAX_ATTEMPTS} attempts and the log has an assistant reply with text. The job
 * ({@link runTitleJob}) claims its attempt in PG (one execution per attempt across replicas), sends
 * a short excerpt of the first exchange to the `title` purpose (unmapped → the conversation's
 * current chat model), writes the title only while `title_source IS NULL` (a rename wins, even
 * mid-call), and logs the call's usage as a `usage` event with `purpose: "title"` and no run. The
 * call is not model-visible to the agent (no DriftReason) and replays never run it. A failure
 * leaves the title null; the next completed run enqueues the next attempt.
 */

/** The title queue (no `:` in the name). */
export const TITLE_QUEUE = "cap-kernel-titles";
/** One job per attempt (no `:`: conversation ids are UUIDs). */
export const titleJobId = (conversationId: string, attempt: number): string =>
  `title-${conversationId}-${attempt}`;
/** Attempts before the conversation stays untitled. */
export const TITLE_MAX_ATTEMPTS = 3;
/** Output cap of the title call. */
export const TITLE_MAX_OUTPUT_TOKENS = 32;
/** The longest generated title (characters); a rename has the same limit. */
export const TITLE_MAX_CHARS = 120;
/** Each side of the excerpt is cut to this many characters. */
export const TITLE_EXCERPT_CHARS = 1000;
/** Time limit of one title call. */
export const TITLE_TIMEOUT_MS = 60_000;
/** How far into the log the excerpt is looked for (events). */
const EXCERPT_SCAN_EVENTS = 2000;
const PAGE = 500;
const JOB = "title";

/** The system prompt of the title call (model-facing, English). */
export const TITLE_PROMPT =
  "Write a title of at most 8 words for this conversation, in the language the user writes in. " +
  "Reply with the title only, no quotes or punctuation at the end.";

const cut = (s: string): string =>
  s.length <= TITLE_EXCERPT_CHARS ? s : `${s.slice(0, TITLE_EXCERPT_CHARS)}…`;

/** The user message of the title call: the first user message and reply, each ≤ 1,000 chars. */
export function titleExcerpt(firstUser: string, firstReply: string): string {
  return `User message:\n${cut(firstUser.trim())}\n\nAssistant reply:\n${cut(firstReply.trim())}`;
}

/**
 * The title from a model reply: the first non-empty line, without control or format characters,
 * wrapping quotes or trailing punctuation, at most {@link TITLE_MAX_CHARS} characters; null when
 * nothing is left.
 */
export function cleanTitle(reply: string): string | null {
  const line =
    reply
      .split(/\r?\n/)
      .map((l) => l.replace(/[\p{Cc}\p{Cf}]/gu, "").trim())
      .find((l) => l !== "") ?? "";
  let t = line
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「」《》`*]+|["'“”‘’「」《》`*]+$/gu, "")
    .replace(/[.。!！?？,，;；:：]+$/u, "")
    .trim();
  if (t.length > TITLE_MAX_CHARS) t = t.slice(0, TITLE_MAX_CHARS).trimEnd();
  return t === "" ? null : t;
}

const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

export interface TitleDeps {
  db: KernelDb;
  eventLog: Pick<EventLog, "append" | "readAfter" | "latestOfType" | "notify" | "publishChanged">;
  purposes: Pick<ModelPurposesService, "chat">;
  log: Pick<Logger, "warn">;
  usageReport?: Pick<UsageReporter, "enqueue">;
  /** Aborts the call (worker shutdown). */
  signal?: AbortSignal;
}

/** The attempt number to enqueue for this conversation, or null when no title job is due. */
export async function titleAttemptDue(
  db: KernelDb,
  conversationId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom("conversations as c")
    .select("c.title_attempts")
    .where("c.id", "=", conversationId)
    .where("c.kind", "=", "chat")
    .where("c.title", "is", null)
    .where("c.title_source", "is", null)
    .where("c.title_attempts", "<", TITLE_MAX_ATTEMPTS)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("conversation_events as e")
          .select(sql`1`.as("one"))
          .whereRef("e.conversation_id", "=", "c.id")
          .where("e.type", "=", "assistant_message")
          .where(sql<boolean>`e.payload -> 'content' @> '[{"type":"text"}]'::jsonb`),
      ),
    )
    .executeTakeFirst();
  return row ? row.title_attempts : null;
}

/** The first user message's text and the first assistant reply with text after it. */
async function firstExchange(
  eventLog: TitleDeps["eventLog"],
  conversationId: string,
): Promise<{ user: string; reply: string } | null> {
  let user: string | undefined;
  let after = 0;
  for (let read = 0; read < EXCERPT_SCAN_EVENTS; ) {
    const page: ConversationEvent[] = await eventLog.readAfter(conversationId, after, PAGE);
    for (const e of page) {
      if (e.type === "user_message" && user === undefined) {
        const t = textOf(e.payload.content as ContentBlock[]);
        if (t.trim() !== "") user = t;
      } else if (e.type === "assistant_message" && user !== undefined) {
        const t = textOf(e.payload.content as ContentBlock[]);
        if (t.trim() !== "") return { user, reply: t };
      }
    }
    const last = page.at(-1);
    if (page.length < PAGE || !last) break;
    after = last.seq;
    read += page.length;
  }
  return null;
}

/**
 * One title attempt. Claims the attempt (`title_attempts = attempt` → `attempt + 1`; a second
 * execution of the same attempt finds nothing to claim and returns), calls the model, writes the
 * title only while `title_source IS NULL`, and appends the call's `usage` event (`purpose: "title"`,
 * no run, idempotent per attempt) in the same transaction. Errors are logged, not thrown.
 */
export async function runTitleJob(
  d: TitleDeps,
  conversationId: string,
  attempt: number,
): Promise<void> {
  const claimed = await d.db
    .updateTable("conversations")
    .set({ title_attempts: attempt + 1 })
    .where("id", "=", conversationId)
    .where("title_attempts", "=", attempt)
    .where("title_source", "is", null)
    .where("kind", "=", "chat")
    .returning(["org_id"])
    .executeTakeFirst();
  if (!claimed) return;
  const exchange = await firstExchange(d.eventLog, conversationId);
  if (!exchange) return;
  const started = await d.eventLog.latestOfType(conversationId, "run_started");
  const fallback: ModelRef | undefined = started?.payload.model;
  const signal = AbortSignal.any([
    AbortSignal.timeout(TITLE_TIMEOUT_MS),
    ...(d.signal ? [d.signal] : []),
  ]);
  let out: Awaited<ReturnType<ModelPurposesService["chat"]>>;
  try {
    out = await d.purposes.chat(
      claimed.org_id,
      "title",
      {
        system: [{ text: TITLE_PROMPT, cache: false }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: titleExcerpt(exchange.user, exchange.reply) }],
          },
        ],
        tools: [],
        toolChoice: "none",
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      },
      signal,
      fallback ? { fallback: { model: fallback, params: {} } } : {},
    );
  } catch (err) {
    d.log.warn("conversation title call failed", { conversationId, attempt, err });
    return;
  }
  const title = cleanTitle(textOf(out.content));
  const { written, usage } = await d.db.transaction().execute(async (t) => {
    const row =
      title === null
        ? undefined
        : await t
            .updateTable("conversations")
            .set({ title, title_source: "generated" })
            .where("id", "=", conversationId)
            .where("title_source", "is", null)
            .returning("id")
            .executeTakeFirst();
    const [ev] = await d.eventLog.append(
      conversationId,
      [
        {
          type: "usage",
          idemKey: `usage_title:${attempt}`,
          payload: {
            step: 0,
            provider: out.provider,
            model: out.model,
            ...out.usage,
            purpose: "title",
          },
        },
      ],
      t,
    );
    return { written: row !== undefined, usage: ev };
  });
  if (usage) {
    await d.eventLog.notify(conversationId, usage.seq);
    void d.usageReport?.enqueue(conversationId, usage.seq);
  }
  if (written) await d.eventLog.publishChanged(conversationId, "title");
}

export interface TitleQueueDeps extends Omit<TitleDeps, "signal"> {
  redisUrl: string;
  config: () => KernelConfig;
  log: Logger;
}

interface TitleJob {
  conversationId: string;
  attempt: number;
}

/**
 * The title queue: `maybeEnqueue` on any role (called by the run worker after a completed run),
 * the worker on the `worker` role. One attempt per job, no BullMQ retries: the next completed run
 * enqueues the next attempt.
 */
export class TitleQueue {
  private queue: Queue<TitleJob> | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker<TitleJob> | undefined;
  private workerConn: Redis | undefined;
  private closed = false;
  private readonly stopping = new AbortController();

  constructor(private readonly d: TitleQueueDeps) {}

  /** Enqueues the next title attempt when one is due. Never throws (logs instead). */
  async maybeEnqueue(conversationId: string): Promise<void> {
    if (this.closed) return;
    try {
      const attempt = await titleAttemptDue(this.d.db, conversationId);
      if (attempt === null) return;
      await this.getQueue().add(
        JOB,
        { conversationId, attempt },
        {
          jobId: titleJobId(conversationId, attempt),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.d.log.warn("cannot enqueue conversation title", { conversationId, err });
    }
  }

  startWorker(): void {
    if (this.worker || this.closed) return;
    const { jobLockMs, stalledIntervalMs } = this.d.config().runtime;
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<TitleJob>(TITLE_QUEUE, (j: Job<TitleJob>) => this.process(j), {
      connection: this.workerConn,
      concurrency: 4,
      lockDuration: jobLockMs,
      stalledInterval: stalledIntervalMs,
      maxStalledCount: 1,
    });
    this.worker.on("error", (err) => this.d.log.error("title worker error", { err }));
  }

  private async process(j: Job<TitleJob>): Promise<void> {
    await runTitleJob(
      { ...this.d, signal: this.stopping.signal },
      j.data.conversationId,
      j.data.attempt,
    );
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    const w = this.worker;
    this.worker = undefined;
    await w?.close().catch(() => {});
    const q = this.queue;
    this.queue = undefined;
    await q?.close().catch(() => {});
    for (const c of [this.workerConn, this.queueConn]) {
      if (c) await c.quit().catch(() => c.disconnect());
    }
    this.workerConn = undefined;
    this.queueConn = undefined;
  }

  private getQueue(): Queue<TitleJob> {
    if (!this.queue) {
      this.queueConn = bullConnection(this.d.redisUrl, this.d.log);
      this.queue = new Queue<TitleJob>(TITLE_QUEUE, { connection: this.queueConn });
      this.queue.on("error", (err) => this.d.log.error("title queue error", { err }));
    }
    return this.queue;
  }
}
