import type { HookParentScope, Logger, ModelRequest } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { ModelRef } from "../../agents/definition.js";
import { EventLog } from "../../conversations/event-log.js";
import { ExtensionHost } from "../../extensions/host.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import { ModelPurposesService } from "../../models/purposes.js";
import type { ConversationKindForHooks } from "../../runtime/hook-calls.js";
import { StepLog } from "../../runtime/step-log.js";
import {
  boundMessages,
  newReviewTag,
  REVIEW_ASK_REASON,
  REVIEW_PURPOSE,
  runClassifier,
} from "./classifier.js";
import { reviewRules, reviewWrite } from "./rules.js";
import type { RuleHit, RuleOutcome } from "./types.js";

/**
 * The command review the tool pipeline calls (auto mode spec §5): stage 1 the pure rule table, stage
 * 2 the classifier on the `review` model purpose for the `unsure` hits, then the conversation's
 * session grants. `deny` rules apply in auto and sandbox mode alike and nothing turns a `deny` into
 * an allow; an `ask` becomes a `deny` at once in an unattended run (the pipeline does that).
 *
 * The service never throws: any failure is `ask`. Reads the rule hit's session grant from PG before
 * returning an `ask` (the `本会话允许同类` decision records the rule, not the exact command).
 */

/** One review outcome, recorded on the tool call (auto mode spec §5.4). */
export interface ReviewVerdict {
  decision: "allow" | "ask" | "deny";
  by: "rule" | "classifier";
  /** English, model- and person-readable. */
  reason: string;
  /** The rule the decision came from, or null for a classifier decision. */
  rule: string | null;
}

/** What the pipeline knows about one tool call it reviews. */
export interface ReviewInput {
  orgId: string;
  /**
   * The root conversation of the run's tree: where the person's messages (the classifier's bounded
   * input), the session grants and the review's usage event live. A sub-agent's call reviews against
   * the root, so a person's request is what the classifier sees at any depth.
   */
  conversationId: string;
  runId: string;
  accountId: string;
  /** `Bash` / `Write` / `Edit`; any other tool is not reviewed. */
  toolKey: string;
  /** The validated tool input (the command for `Bash`, the path for a file write). */
  input: unknown;
  mode: "auto" | "sandbox";
  /**
   * The device's workspace root. Absent: no device is bound, so the tool fails on its own and
   * there is nothing to review.
   */
  workspace?: string | undefined;
  /** Whether a person is present to answer an `ask` (rules may read it; the pipeline decides). */
  attended: boolean;
  /** Hook payload facts (optional: without enough of them no model hook fires). */
  agentId?: string | undefined;
  agentVersion?: number | undefined;
  conversationKind?: ConversationKindForHooks | undefined;
  parent?: HookParentScope | undefined;
}

/** The per-call facts of one review (`review(input & ReviewCall)`). */
export interface ReviewCall {
  /** The tool call's step in its run (the usage event and the hooks). */
  step: number;
  /** The tool call's id (the usage event's idempotency key and the hooks). */
  callId: string;
  /** The run's abort signal: an abort is `ask` (fail closed). */
  signal: AbortSignal;
  /** Called with the resolved target and the final classifier request just before it is sent. */
  beforeSend?: ((target: ModelRef, request: ModelRequest) => Promise<void>) | undefined;
}

/** The one entry the tool pipeline uses. */
export interface CommandReview {
  review(input: ReviewInput & ReviewCall): Promise<ReviewVerdict>;
}

/** The reasons the service itself answers with (the rule table's own reasons come from its hits). */
export const REVIEW_REASONS = {
  /** The tool is not one the review covers. */
  notReviewed: "This tool call needs no command review.",
  /** Sandbox mode confines file writes to the workspace. */
  sandboxWrite: "Sandbox mode keeps file writes inside the workspace.",
  /** No device is bound: the tool call fails on its own. */
  noDevice: "No device is bound to this conversation; the tool call fails on its own.",
  /** The person allowed this rule class for the conversation. */
  sessionGrant: "Allowed for the rest of this conversation by an earlier approval.",
} as const;

/** The tools the review covers: the shell, and the file tools whose writes may leave the workspace. */
const REVIEWED_TOOLS: ReadonlySet<string> = new Set(["Bash", "Write", "Edit"]);

/** How many of the root conversation's latest person messages are read before bounding the text. */
const PERSON_MESSAGES_READ = 20;

const allow = (reason: string, rule: string | null): ReviewVerdict => ({
  decision: "allow",
  by: "rule",
  reason,
  rule,
});

/**
 * The hit that decided `outcome`: the first hit of that rank in rule order (`unsure` stands in for
 * an `ask` the classifier never made). The table's reasons are already English.
 */
function decidingHit(hits: readonly RuleHit[], outcome: RuleOutcome): RuleHit | undefined {
  const rank = outcome === "ask" ? ["ask", "unsure"] : [outcome];
  for (const r of rank) {
    const hit = hits.find((h) => h.outcome === r);
    if (hit !== undefined) return hit;
  }
  return hits[0];
}

@Injectable()
export class CommandReviewService implements CommandReview {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(ModelPurposesService)
    private readonly purposes: Pick<ModelPurposesService, "chat" | "chatLimits" | "resolve">,
    @Inject(StepLog) private readonly stepLog: Pick<StepLog, "appendReported" | "appendAudited">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "notify">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
    /** Extension hooks (absent in a hand-built test service: none fire). */
    @Inject(ExtensionHost)
    private readonly host: Pick<ExtensionHost, "hooks" | "current"> | undefined,
  ) {}

  private get db() {
    return this.kdb.db;
  }

  async review(input: ReviewInput & ReviewCall): Promise<ReviewVerdict> {
    try {
      return await this.decide(input);
    } catch (err) {
      // fail closed: a review that could not run is an ask, never an allow
      this.log.warn("command review failed; asking", {
        conversationId: input.conversationId,
        callId: input.callId,
        toolKey: input.toolKey,
        err,
      });
      return { decision: "ask", by: "rule", reason: REVIEW_ASK_REASON, rule: null };
    }
  }

  private async decide(input: ReviewInput & ReviewCall): Promise<ReviewVerdict> {
    // not a reviewed tool, a sandbox-mode write (the tools stay root-confined), or no device: the
    // tool call proceeds and fails on its own if it cannot
    if (!REVIEWED_TOOLS.has(input.toolKey)) {
      return allow(REVIEW_REASONS.notReviewed, null);
    }
    const isWrite = input.toolKey === "Write" || input.toolKey === "Edit";
    if (input.mode === "sandbox" && isWrite) {
      return allow(REVIEW_REASONS.sandboxWrite, null);
    }
    const workspace = input.workspace;
    if (workspace === undefined) return allow(REVIEW_REASONS.noDevice, null);

    const target = isWrite ? pathOf(input.input) : commandOf(input.input);
    if (target === null) {
      // argument validation runs before this stage; a shape the tool itself will refuse
      return allow(REVIEW_REASONS.notReviewed, null);
    }
    // the person's messages and the session grants live on the root, whatever conversation the
    // caller named (a sub-agent's conversation carries agent-authored task text, never shown here)
    let root: string | undefined;
    const rootOf = async (): Promise<string> =>
      (root ??= await this.rootConversationOf(input.conversationId));
    const facts = {
      workspace,
      cwd: workspace,
      mode: input.mode,
      attended: input.attended,
    };
    const result = isWrite ? reviewWrite(target, facts) : reviewRules(target, facts);
    const hit = decidingHit(result.hits, result.outcome);

    if (result.outcome === "deny") {
      return {
        decision: "deny",
        by: "rule",
        reason: hit?.reason ?? "The command review blocks this command.",
        rule: hit?.id ?? null,
      };
    }
    if (result.outcome === "allow") {
      return allow(hit?.reason ?? "The command review allows this command.", hit?.id ?? null);
    }
    if (result.outcome === "ask") {
      return (await this.sessionGranted(await rootOf(), hit?.id ?? null))
        ? allow(REVIEW_REASONS.sessionGrant, hit?.id ?? null)
        : {
            decision: "ask",
            by: "rule",
            reason: hit?.reason ?? "This command needs the person's approval.",
            rule: hit?.id ?? null,
          };
    }

    // unsure: the classifier decides when the purpose is mapped, else the hit itself is an ask
    if (!(await this.classifierMapped(input.orgId))) {
      const rule = hit?.id ?? "unsure.uncovered";
      return (await this.sessionGranted(await rootOf(), rule))
        ? allow(REVIEW_REASONS.sessionGrant, rule)
        : {
            decision: "ask",
            by: "rule",
            reason: hit?.reason ?? "This command needs the person's approval.",
            rule,
          };
    }
    const answer = await runClassifier(
      {
        purposes: this.purposes,
        eventLog: this.eventLog,
        stepLog: this.stepLog,
        config: this.config,
        log: this.log,
        hooks: this.host?.hooks,
      },
      {
        orgId: input.orgId,
        conversationId: input.conversationId,
        runId: input.runId,
        step: input.step,
        callId: input.callId,
        signal: input.signal,
        hookFacts: {
          accountId: input.accountId,
          agentId: input.agentId,
          agentVersion: input.agentVersion,
          conversationKind: input.conversationKind,
          parent: input.parent,
        },
        input: {
          mode: input.mode,
          kind: isWrite ? "write" : "command",
          text: target,
          cwd: workspace,
          ruleHits: result.hits,
          personMessages: await this.personMessages(await rootOf()),
          tag: newReviewTag(),
        },
        beforeSend: input.beforeSend,
      },
    );
    return {
      decision: answer.decision,
      by: "classifier",
      reason: answer.reason,
      // a classifier decision has no rule hit: `本会话允许同类` is offered only for rule asks
      rule: null,
    };
  }

  /** Whether a `review` model purpose is mapped and usable in the organization. */
  private async classifierMapped(orgId: string): Promise<boolean> {
    try {
      await this.purposes.resolve(orgId, REVIEW_PURPOSE);
      return true;
    } catch {
      // an unmapped purpose (or one the org cannot use) means no classifier: unsure becomes ask
      return false;
    }
  }

  /**
   * The root conversation of the tree `conversationId` belongs to, by walking
   * `parent_conversation_id`: the person's messages and the session grants live there, so a caller
   * that names a sub-agent's conversation still reviews against what the person asked for, never
   * against agent-authored task text. The input is normally the root already (one query).
   */
  private async rootConversationOf(conversationId: string): Promise<string> {
    let id = conversationId;
    // a tree is shallow (`subagents.maxDepth`); the cap only guards a corrupted parent chain
    for (let depth = 0; depth < 64; depth++) {
      const row = await this.db
        .selectFrom("conversations")
        .select(["kind", "parent_conversation_id"])
        .where("id", "=", id)
        .executeTakeFirst();
      // a missing conversation (or one deleted meanwhile) is left to the reads that follow
      if (row === undefined || row.kind !== "subagent" || row.parent_conversation_id === null) {
        return id;
      }
      id = row.parent_conversation_id;
    }
    return id;
  }

  /**
   * Whether the root conversation holds a session grant for this rule class (`command:<ruleId>`).
   * Command grants carry no tool-spec fingerprint: the approval records the rule, not the command.
   */
  private async sessionGranted(rootConversationId: string, rule: string | null): Promise<boolean> {
    if (rule === null) return false;
    const grant = await this.db
      .selectFrom("conversation_tool_grants")
      .select("tool_key")
      .where("conversation_id", "=", rootConversationId)
      .where("tool_key", "=", `command:${rule}`)
      .executeTakeFirst();
    return grant !== undefined;
  }

  /**
   * The bounded text of the root conversation's last person messages: the `user_message` text blocks
   * only, never an assistant message or a tool result. `sandbox.review.messageTokens` caps it.
   */
  private async personMessages(conversationId: string): Promise<string> {
    const rows = await this.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "user_message")
      .orderBy("seq", "desc")
      .limit(PERSON_MESSAGES_READ)
      .execute();
    const texts = rows.map((r) => textOfUserMessage(r.payload)).filter((t) => t !== "");
    return boundMessages(texts, this.config.get().sandbox.review.messageTokens);
  }
}

/** The text blocks of a `user_message` payload (its images, documents and attachments are skipped). */
function textOfUserMessage(payload: unknown): string {
  const content = (payload as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) => {
      if (b === null || typeof b !== "object") return [];
      const block = b as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
}

/** The command of a validated `Bash` input, or null when it has none (the tool will refuse it). */
function commandOf(input: unknown): string | null {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : null;
}

/** The path of a validated `Write` / `Edit` input, or null when it has none (the tool refuses it). */
function pathOf(input: unknown): string | null {
  const path = (input as { file_path?: unknown } | null)?.file_path;
  return typeof path === "string" ? path : null;
}
