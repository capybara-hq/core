import {
  type ContentBlock,
  type HookScope,
  isModelError,
  type Logger,
  type ModelRequest,
  type ModelUsage,
} from "@capybara-hq/plugin-sdk";
import { type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { type ModelPurposesService, PurposeAttemptError } from "../models/purposes.js";
import {
  fireObserve,
  type HookRunner,
  hookDeniedAudit,
  hookDeniedEvent,
  hookRequestOf,
} from "../runtime/hook-calls.js";
import { bullConnection } from "../runtime/run-queue.js";
import type { UsageReporter } from "../runtime/usage-report.js";
import { HIDDEN_FORMAT_RE } from "../text.js";
import type { AppendEvent, EventLog } from "./event-log.js";
import { type ConversationEvent, typedInvocation } from "./events.js";

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

const cut = (s: string): string => {
  const cps = Array.from(s);
  return cps.length <= TITLE_EXCERPT_CHARS ? s : `${cps.slice(0, TITLE_EXCERPT_CHARS).join("")}…`;
};

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
      .map((l) =>
        l
          .replace(/\p{Cc}/gu, "")
          .replace(HIDDEN_FORMAT_RE, "")
          .trim(),
      )
      .find((l) => l !== "") ?? "";
  let t = line
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「」《》`*]+|["'“”‘’「」《》`*]+$/gu, "")
    .replace(/[.。!！?？,，;；:：]+$/u, "")
    .trim();
  // counted in code points, so a cut never splits a surrogate pair
  const cps = Array.from(t);
  if (cps.length > TITLE_MAX_CHARS) t = cps.slice(0, TITLE_MAX_CHARS).join("").trimEnd();
  return t === "" ? null : t;
}

const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

/**
 * What the person typed in a user message: its first block when that is text. The blocks after it
 * are `@` resource bodies (read with the sender's credentials) and file refs, which never go to the
 * title model.
 */
const typedText = (content: readonly ContentBlock[]): string => {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
};

export interface TitleDeps {
  db: KernelDb;
  eventLog: Pick<EventLog, "append" | "readAfter" | "latestOfType" | "notify" | "publishChanged">;
  purposes: Pick<ModelPurposesService, "chat">;
  log: Pick<Logger, "warn">;
  /**
   * Extension hooks: the title call fires `model.request` (policy, then observe; a denial skips the
   * title and uses up the attempt) and `model.response` with `purpose: "title"`, like compaction.
   */
  hooks?: HookRunner;
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

/** The first user message's typed text and the first assistant reply with text after it. */
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
        // a skill invocation: what the person typed, never the rendered skill (content[0])
        const t =
          e.payload.skill !== undefined
            ? typedInvocation(e.payload.skill)
            : typedText(e.payload.content as ContentBlock[]);
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
  // look for the excerpt first: an attempt is used up only by a call that can be made
  const exchange = await firstExchange(d.eventLog, conversationId);
  if (!exchange) return;
  if (d.signal?.aborted) return;
  const claimed = await d.db
    .updateTable("conversations")
    .set({ title_attempts: attempt + 1 })
    .where("id", "=", conversationId)
    .where("title_attempts", "=", attempt)
    .where("title_source", "is", null)
    .where("kind", "=", "chat")
    .returning(["org_id", "account_id", "agent_id"])
    .executeTakeFirst();
  if (!claimed) return;
  const started = await d.eventLog.latestOfType(conversationId, "run_started");
  const fallback: ModelRef | undefined = started?.payload.model;
  const signal = AbortSignal.any([
    AbortSignal.timeout(TITLE_TIMEOUT_MS),
    ...(d.signal ? [d.signal] : []),
  ]);
  const scope: HookScope = {
    orgId: claimed.org_id,
    accountId: claimed.account_id,
    agentId: claimed.agent_id,
    agentVersion: started?.payload.agentVersion ?? (await agentVersionOf(d.db, claimed.agent_id)),
    conversationId,
    runId: "",
  };
  let sent: { provider: string; model: string; at: number } | undefined;
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
      {
        ...(fallback && { fallback: { model: fallback, params: {} } }),
        beforeSend: async (target, request) => {
          await checkTitleHooks(d, scope, target, request, signal);
          sent = { ...target, at: Date.now() };
        },
      },
    );
  } catch (err) {
    if (err instanceof TitleDenied) {
      // a policy denial is deterministic: no retries (one audit row, not one per attempt)
      await d.db
        .updateTable("conversations")
        .set({ title_attempts: TITLE_MAX_ATTEMPTS })
        .where("id", "=", conversationId)
        .execute();
      return;
    }
    if (sent && d.hooks) observeTitle(d, scope, sent, null, err, signal);
    // the replica is shutting down: give the attempt back unless something else took over
    if (d.signal?.aborted && !(err instanceof PurposeAttemptError)) {
      await giveBack(d.db, conversationId, attempt);
      return;
    }
    d.log.warn("conversation title call failed", { conversationId, attempt, err });
    // a sent call is billed: log its estimated usage like a successful one
    if (err instanceof PurposeAttemptError) {
      await logUsage(d, conversationId, attempt, {
        provider: err.provider,
        model: err.model,
        usage: {
          inputTokens: err.tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    }
    return;
  }
  if (sent && d.hooks) observeTitle(d, scope, sent, out, null, signal);
  const title = cleanTitle(textOf(out.content));
  const { written, usage } = await d.db.transaction().execute(async (t) => {
    // Append first: it locks the conversation row FOR UPDATE before this transaction touches it.
    // Updating the title first held the row FOR NO KEY UPDATE, which lets in another
    // transaction's foreign key check (FOR KEY SHARE, e.g. inserting an approval); the append's
    // FOR UPDATE then waited for that one while it waited for the title row: 40P01
    const [ev] = await d.eventLog.append(conversationId, [usageEvent(attempt, out)], t);
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
    return { written: row !== undefined, usage: ev };
  });
  if (usage) {
    await d.eventLog.notify(conversationId, usage.seq);
    void d.usageReport?.enqueue(conversationId, usage.seq);
  }
  if (written) await d.eventLog.publishChanged(conversationId, "title");
}

/** A `model.request` policy hook denied the title call (already recorded). */
class TitleDenied extends Error {}

const usageEvent = (
  attempt: number,
  u: { provider: string; model: string; usage: ModelUsage },
): AppendEvent => ({
  type: "usage",
  idemKey: `usage_title:${attempt}`,
  payload: { step: 0, provider: u.provider, model: u.model, ...u.usage, purpose: "title" },
});

async function logUsage(
  d: TitleDeps,
  conversationId: string,
  attempt: number,
  u: { provider: string; model: string; usage: ModelUsage },
): Promise<void> {
  const [ev] = await d.eventLog.append(conversationId, [usageEvent(attempt, u)]);
  if (ev) void d.usageReport?.enqueue(conversationId, ev.seq);
}

/** Returns a claimed attempt (shutdown before the call was sent). */
async function giveBack(db: KernelDb, conversationId: string, attempt: number): Promise<void> {
  await db
    .updateTable("conversations")
    .set({ title_attempts: attempt })
    .where("id", "=", conversationId)
    .where("title_attempts", "=", attempt + 1)
    .where("title_source", "is", null)
    .execute();
}

async function agentVersionOf(db: KernelDb, agentId: string): Promise<number> {
  const row = await db
    .selectFrom("agents")
    .select("current_version")
    .where("id", "=", agentId)
    .executeTakeFirst();
  return row?.current_version ?? 1;
}

/**
 * `model.request` for the title call (`purpose: "title"`, step 0, attempt 1, run ""). A denial
 * (including a policy extension not loaded on this replica) writes the `hook.denied` audit row and
 * throws {@link TitleDenied}: the title is skipped and no further attempt is made. No `hook_denied`
 * event: the call is not a step of a run.
 */
async function checkTitleHooks(
  d: TitleDeps,
  scope: HookScope,
  target: ModelRef,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<void> {
  if (!d.hooks?.has("model.request")) return;
  const verdict = await d.hooks.run(
    "model.request",
    {
      ...scope,
      purpose: "title",
      step: 0,
      attempt: 1,
      provider: target.provider,
      model: target.model,
      request: hookRequestOf(request, d.log),
    },
    signal,
  );
  if (verdict.allowed) return;
  const site = {
    orgId: scope.orgId,
    conversationId: scope.conversationId,
    runId: "",
    accountId: scope.accountId,
    agentId: scope.agentId,
    idemKey: "",
  };
  const entry = hookDeniedAudit(
    site,
    hookDeniedEvent(site, "model.request", verdict, { step: 0, attempt: 1 }).payload,
    verdict,
  );
  entry.detail = { ...entry.detail, purpose: "title" };
  await d.db.transaction().execute((t) => audit(t, entry));
  d.log.warn("conversation title blocked by a policy hook", {
    conversationId: scope.conversationId,
    plugin: verdict.plugin,
    cause: verdict.cause,
  });
  throw new TitleDenied();
}

const errorCodeOf = (err: unknown): string => {
  const cause = err instanceof PurposeAttemptError ? err.cause : err;
  return isModelError(cause) ? `model.${cause.kind}` : "model.unknown";
};

/** `model.response` for a sent title call (observe only, not awaited). */
function observeTitle(
  d: TitleDeps,
  scope: HookScope,
  sent: { provider: string; model: string; at: number },
  out: Awaited<ReturnType<ModelPurposesService["chat"]>> | null,
  err: unknown,
  signal: AbortSignal,
): void {
  if (!d.hooks) return;
  fireObserve(
    d.hooks,
    "model.response",
    {
      ...scope,
      purpose: "title",
      step: 0,
      attempt: 1,
      provider: sent.provider,
      model: sent.model,
      outcome: out ? "ok" : "failed",
      content: out?.content ?? [],
      stopReason: out?.stopReason ?? null,
      usage: out?.usage ?? null,
      latencyMs: Date.now() - sent.at,
      ...(out === null && { errorCode: errorCodeOf(err) }),
    },
    signal,
    d.log,
  );
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
