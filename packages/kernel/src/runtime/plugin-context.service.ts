import { createHash } from "node:crypto";
import {
  CONTEXT_LIMITS,
  type ContextProvider,
  type ContextResult,
  type ConversationSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { ExtensionPointDefaults, type PointProvider } from "../extensions/point-defaults.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { OrgRole } from "../orgs/roles.js";
import { latestPluginContexts, pluginContextIdemKey } from "./context/plugin-context.js";

/** What a run start tells {@link PluginContextService.record}. */
export interface PluginContextInput {
  orgId: string;
  conversationId: string;
  runId: string;
  agentId: string;
  /** The run's agent definition name. */
  agentName: string;
  /** The conversation's owner (`conversations.account_id`) and display name. */
  ownerAccountId: string;
  ownerName: string;
  /** The account whose message started the run. */
  triggerAccountId: string;
  source: ConversationSource;
  /** The trigger account's role in the org. */
  role: OrgRole;
  /** The conversation's kind: only a chat run asks the providers. */
  kind: "chat" | "eval" | "subagent";
  /**
   * The keys of the run's resolved tool set, by plugin (resolved with `forAgent` once, and only
   * when some provider is asked).
   */
  toolKeysByPlugin: () => Promise<Map<string, string[]>>;
  /** Aborts every provider call (with its own time limit). */
  signal: AbortSignal;
}

/** A provider's answer for this run: the text ("" for nothing), or why it was dropped. */
type Answer = { ok: true; text: string } | { ok: false; reason: string };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Run start's plugin context (memory plugin spec §6.1): asks every `context@1` provider enabled in
 * the org (valid config) for its text, in parallel and outside any transaction, each under the
 * run's signal and {@link CONTEXT_LIMITS}.timeoutMs; then appends a `plugin_context` event for each
 * plugin whose text differs from the latest one it recorded in the conversation. Fail open: a
 * provider that throws, times out or returns too much is skipped for this run (its earlier text
 * stays in effect) and logged. A provider loaded here that recorded text but no longer serves the
 * org (switched off, its config invalid) gets an empty event, so its text stops following
 * summaries; a plugin not loaded on this replica is left alone (another replica may still load
 * it during a rollout, and blanking it here would make its text flap), and so is one whose status
 * could not be read (a transient error must not flip the model's context). Chat runs only: an
 * eval replay reads the recorded events, and a sub-agent gets no plugin context (spec §5.4).
 */
@Injectable()
export class PluginContextService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "appendIn" | "notify">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ExtensionPointDefaults)
    private readonly points: Pick<ExtensionPointDefaults, "providersFor">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** Asks the providers and records what changed (see the class); notifies after the commit. */
  async record(input: PluginContextInput): Promise<void> {
    if (input.kind !== "chat") return;
    let found: { providers: PointProvider<ContextProvider>[]; failed: Set<string> };
    try {
      found = await this.points.providersFor<ContextProvider>(input.orgId, "context");
    } catch (err) {
      // fail open: without the org's providers nothing is asked and nothing is switched off
      this.log.warn("context providers not read; plugin context left as recorded", {
        orgId: input.orgId,
        conversationId: input.conversationId,
        runId: input.runId,
        err,
      });
      return;
    }
    const { providers } = found;
    const tools = providers.length > 0 ? await input.toolKeysByPlugin() : new Map();
    const answers = await Promise.all(
      providers.map(async (p) => {
        const answer = await this.ask(p, input, tools.get(p.extension) ?? []);
        if (!answer.ok) {
          this.log.warn("context provider skipped for this run", {
            orgId: input.orgId,
            conversationId: input.conversationId,
            runId: input.runId,
            plugin: p.extension,
            reason: answer.reason,
          });
        }
        return [p.extension, answer] as const;
      }),
    );
    const texts = new Map<string, string>();
    for (const [plugin, answer] of answers) if (answer.ok) texts.set(plugin, answer.text);
    const serving = new Set(providers.map((p) => p.extension));
    const off = new Set(
      this.registry
        .list("context")
        .map((e) => e.plugin)
        // a provider whose status could not be read (a transient error) keeps its recorded text
        .filter((plugin) => !serving.has(plugin) && !found.failed.has(plugin)),
    );
    // nothing answered and nothing to switch off: no transaction, no row lock
    if (texts.size === 0 && off.size === 0) return;
    const seq = await this.append(input, texts, off);
    if (seq !== null) await this.eventLog.notify(input.conversationId, seq);
  }

  /** One provider's call, bounded by the run's signal and the time limit. */
  private async ask(
    p: PointProvider<ContextProvider>,
    input: PluginContextInput,
    tools: string[],
  ): Promise<Answer> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(CONTEXT_LIMITS.timeoutMs)]);
    let result: ContextResult;
    try {
      result = await untilAborted(
        Promise.resolve().then(() =>
          p.impl.provide({
            orgId: input.orgId,
            accountId: input.triggerAccountId,
            agentId: input.agentId,
            agentName: input.agentName,
            conversationId: input.conversationId,
            runId: input.runId,
            source: input.source,
            role: input.role,
            ownerAccountId: input.ownerAccountId,
            ownerName: input.ownerName,
            tools,
            config: p.config,
            signal,
          }),
        ),
        signal,
      );
    } catch (err) {
      if (signal.aborted) {
        return { ok: false, reason: input.signal.aborted ? "run aborted" : "timed out" };
      }
      return { ok: false, reason: `threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (result === null) return { ok: true, text: "" };
    const text = (result as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") return { ok: false, reason: "returned no text" };
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > CONTEXT_LIMITS.maxBytes) {
      return { ok: false, reason: `text of ${bytes} bytes is over ${CONTEXT_LIMITS.maxBytes}` };
    }
    return { ok: true, text };
  }

  /**
   * One transaction under the conversation row lock (as `RunContextService`): compares each
   * answer's hash with the plugin's latest `plugin_context` and appends the ones that differ (a
   * plugin with no earlier event and no text writes nothing), plus an empty event for each plugin
   * in `off` whose latest text is not empty. Idem key per run and plugin, so a retried run
   * start finds its events or nothing changed. Returns the last seq written.
   */
  @Transactional()
  private async append(
    input: PluginContextInput,
    texts: Map<string, string>,
    off: Set<string>,
  ): Promise<number | null> {
    const t = this.db.db;
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", input.conversationId)
      .forUpdate()
      .executeTakeFirst();
    const rows = await t
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", input.conversationId)
      .where("type", "=", "plugin_context")
      .orderBy("seq", "asc")
      .execute();
    const latest = latestPluginContexts(
      rows.map(
        (r) =>
          ({ type: "plugin_context", seq: Number(r.seq), payload: r.payload }) as ConversationEvent,
      ),
      Number.POSITIVE_INFINITY,
    );
    const next = new Map(texts);
    for (const [plugin, prev] of latest) {
      if (off.has(plugin) && prev.text !== "") next.set(plugin, "");
    }
    const changed = [...next]
      .filter(([plugin, text]) => {
        const prev = latest.get(plugin);
        return prev === undefined ? text !== "" : prev.hash !== sha256(text);
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (changed.length === 0) return null;
    const written = await this.eventLog.appendIn(
      input.conversationId,
      changed.map(([plugin, text]) => ({
        type: "plugin_context" as const,
        runId: input.runId,
        idemKey: pluginContextIdemKey(input.runId, plugin),
        payload: { plugin, text, hash: sha256(text) },
      })),
    );
    return Math.max(...written.map((e) => e.seq));
  }
}

/** `p`, or a rejection once `signal` aborts (a provider that ignores its signal never holds a run). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
