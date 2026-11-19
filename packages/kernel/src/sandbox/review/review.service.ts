import type {
  HookParentScope,
  Logger,
  ModelRequest,
  PermissionProfile,
} from "@capybara-hq/plugin-sdk";
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
import { generateImagePaths } from "../../tools/builtins/image/paths.js";
import type { PermissionCandidate, PermissionCrossingKind } from "../permission-call-types.js";
import {
  boundMessages,
  newReviewTag,
  REVIEW_ASK_REASON,
  REVIEW_PURPOSE,
  runClassifier,
} from "./classifier.js";
import {
  approverForCrossing,
  crossingOfCandidate,
  ESCALATION_RETRY_HINT,
  escalationAskReason,
  isCredentialConsentRule,
  type PermissionApprover,
} from "./permission-candidate.js";

export { escalationAskReason, quotedJustification } from "./permission-candidate.js";

import { reviewRules, reviewWrite, writtenPaths } from "./rules.js";
import {
  applySessionGrants,
  isSessionGrantableRule,
  type ReviewResult,
  type RuleHit,
  type RuleOutcome,
} from "./types.js";

/**
 * The rule asks about reach, not consent: a write or a link outside the workspace. On the managed
 * route the enforced scope and a proposed expansion decide them.
 */
const SCOPE_ASK_RULES: ReadonlySet<string> = new Set(["ask.outside-write", "ask.outside-link"]);
/** The consent a file read keeps: reading a credential file or SSH keys. */
const CREDENTIAL_READ_RULES: ReadonlySet<string> = new Set(["ask.secret-file", "ask.ssh"]);
/**
 * Every ask about an escalation keeps its statement first: an ask the review model made, or one
 * the review fell back to (failed, unparseable, truncated), adds its own reason after it.
 */
const withEscalation = (statement: string, reason: string): string =>
  reason === statement ? statement : `${statement} Review: ${reason}`;
/** What an ask about a proposed expansion tells the person. */
const EXPANSION_ASK_REASON =
  "Approve the exact proposed directory and host access for this call. File-only grants are not supported: directory approval covers its descendants; otherwise choose an in-project path.";

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
  /**
   * The crossing a Full access allow granted by itself (approval-only profiles design): the
   * candidate's kind, or `sensitive` when it skipped a sensitive-command consent. Absent otherwise.
   */
  crossing?: PermissionCrossingKind;
  /**
   * Who decided the permission review of a call with a candidate: the person, the review model
   * or nobody (Full access). Absent outside the permission review.
   */
  approver?: PermissionApprover;
  /** The sensitive-command consents (rule ids) a Full access allow skipped. */
  sensitive?: string[];
}

/** What the pipeline knows about one tool call it reviews. */
export interface ReviewInput {
  permissionProfile?: PermissionProfile;
  permissionCandidate?: PermissionCandidate;
  /**
   * A restricted `Bash` call on a device and org whose ceiling allows running outside the sandbox:
   * a refusal of its outside reach tells the model it may retry with `sandbox: "escalated"`.
   */
  escalationAvailable?: boolean;
  orgId: string;
  /**
   * The root conversation of the run's tree: where the person's messages (the classifier's bounded
   * input), the session grants and the review's usage event live. A sub-agent's call reviews against
   * the root, so a person's request is what the classifier sees at any depth.
   */
  conversationId: string;
  runId: string;
  accountId: string;
  /** `Bash` / `Write` / `Edit` / `GenerateImage` with `file_path`; others are not reviewed. */
  toolKey: string;
  /** The validated tool input (the command for `Bash`, the path for a file write). */
  input: unknown;
  mode: "auto" | "sandbox";
  /**
   * The conversation's working root: the device's workspace root, or the bound project's root
   * (project root spec §4.3). Commands start here and a write inside it needs no ask. Absent: no
   * device is bound, so the tool fails on its own and there is nothing to review.
   */
  workspace?: string | undefined;
  /**
   * The owner's home directory (the machine's, else the device workspace's prefix), never derived
   * from a project root: `~` and the home-level sensitive paths are judged against it. Absent or
   * null: the rules derive it from `workspace`.
   */
  home?: string | null | undefined;
  /**
   * The home prefix of the device's own workspace, judged beside `home` (a project outside every
   * home still protects it). Absent or null: none.
   */
  deviceHome?: string | null | undefined;
  /** Whether a person is present to answer an `ask` (rules may read it; the pipeline decides). */
  attended: boolean;
  /** Hook payload facts (optional: without enough of them no model hook fires). */
  agentId?: string | undefined;
  agentVersion?: number | undefined;
  conversationKind?: ConversationKindForHooks | undefined;
  parent?: HookParentScope | undefined;
  /**
   * A sub-agent's call: the parent run (and its budget window) whose `subagent_tokens_used` the
   * classifier's usage counts on, as the `WebFetch` extraction does.
   */
  parentRunId?: string | undefined;
  budgetRunId?: string | undefined;
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

/**
 * The tools the review covers: the shell, and the file tools whose writes may leave the workspace
 * (`GenerateImage` writes its images into the device at `file_path`, reviewed as a `Write`; a call
 * without `file_path` writes nothing there and is not reviewed).
 */
const REVIEWED_TOOLS: ReadonlySet<string> = new Set(["Bash", "Write", "Edit", "GenerateImage"]);

/** The reviewed tools that write a file at `file_path` (the rest run a shell command). */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "GenerateImage"]);

/** How many of a conversation tree's latest assistant messages the review reads for its writes. */
const WRITTEN_EVENTS_READ = 200;

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
    @Inject(StepLog)
    private readonly stepLog: Pick<StepLog, "appendReported" | "appendCounted" | "appendAudited">,
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
      const escalation =
        input.permissionCandidate?.scopeKind === "sandbox-escalation"
          ? input.permissionCandidate.escalation
          : undefined;
      return {
        decision: "ask",
        by: "rule",
        reason: escalation
          ? withEscalation(escalationAskReason(escalation), REVIEW_ASK_REASON)
          : REVIEW_ASK_REASON,
        rule: null,
      };
    }
  }

  /**
   * The permission review of a managed call (permission operation contract, policy order), after
   * the fixed denies. The profile only chooses who approves ({@link approverForCrossing}): under
   * Full access nobody does (the candidate's crossing is granted within the device's ceilings, a
   * sensitive-command consent is skipped, both recorded), except a sub-agent's escalation, which
   * goes to the review model. Request approval and Approve for me keep the sensitive-command consent (the fixed asks: sudo, credentials, persistent changes,
   * force push, ...), which comes before any reach. A call with neither a consent ask nor a
   * proposed expansion runs under the enforced base scope with no review. Otherwise Request
   * approval asks the person and Approve for me asks the review model (an ask when it is not
   * configured, unsure or failing; its deny is never an approval). The scope asks of the rules
   * (a write or link outside the workspace) are not consent: the proposed expansion carries them,
   * and without one the enforced scope decides. An ask keeps its rule id.
   */
  private async decidePermission(
    input: ReviewInput & ReviewCall,
    result: ReviewResult,
    facts: {
      kind: "write" | "command" | "read";
      target: string;
      workspace: string;
      rootOf: () => Promise<string>;
    },
  ): Promise<ReviewVerdict> {
    const escalation =
      input.permissionCandidate?.scopeKind === "sandbox-escalation"
        ? input.permissionCandidate.escalation
        : undefined;
    // a command writing or linking outside the working directory with no proposal (only a
    // literal `cd <dir>` proposes a command's directory): no approval could let the enforced scope
    // run it, so it is refused now with what works instead
    const commandScopeHit =
      facts.kind === "command" && !input.permissionCandidate
        ? result.hits.find((h) => h.outcome === "ask" && SCOPE_ASK_RULES.has(h.id))
        : undefined;
    if (commandScopeHit)
      return {
        decision: "deny",
        by: "rule",
        rule: commandScopeHit.id,
        reason: `${commandScopeHit.reason.replace(/[.;]?\s*this needs approval\.?$/i, "")}, which this conversation's permission profile does not reach, and a command's own outside write cannot be approved inside the sandbox; write the file with Write or Edit (its directory can be approved), run the command after a literal \`cd\` into that directory, or keep it inside ${facts.workspace}${input.escalationAvailable ? `; ${ESCALATION_RETRY_HINT.trim().replace(/^If/, "if")}` : ""}`,
      };
    // the consent cases: the fixed asks and the unsure findings (an interpreter's inline code, an
    // unparsed or uncovered line), which keep the profile's review. A read keeps only the
    // credential reads: the write rules (persistence, shell config) are no consent for a read
    const consentHits = result.hits.filter((h) =>
      facts.kind === "read"
        ? h.outcome === "ask" && CREDENTIAL_READ_RULES.has(h.id)
        : (h.outcome === "ask" && !SCOPE_ASK_RULES.has(h.id)) || h.outcome === "unsure",
    );
    const candidate = input.permissionCandidate;
    const subAgent = input.parentRunId !== undefined;
    const credentialConsent = consentHits.some((h) => isCredentialConsentRule(h.id));
    // who decides (approval-only profiles design, "Profiles"): under Full access an escalation a
    // sub-agent asks for, or one carrying a credential consent, goes to the review model; the fixed
    // denies were evaluated before this
    const approver = approverForCrossing({
      profile: input.permissionProfile ?? "approve-for-me",
      crossing: candidate ? crossingOfCandidate(candidate) : "sensitive",
      subAgent,
      credentialConsent,
    });
    // why the review model sees a Full access call at all (its input says so, neutrally)
    const fullAccessReview =
      input.permissionProfile === "full-access" && approver === "review-model"
        ? {
            ...(subAgent ? { subAgent: true as const } : {}),
            ...(credentialConsent ? { credential: true as const } : {}),
          }
        : undefined;
    if (approver === "none") {
      // Full access: the candidate's crossing is granted for this call within the ceilings the
      // candidate builder checked (issuance checks them again), and a sensitive-command consent
      // is skipped but recorded (with the crossing when there is one): the sandbox still holds
      // the protected paths
      const skipped = [...new Set(consentHits.map((h) => h.id))].sort();
      if (candidate)
        return {
          ...allow(
            "Full access grants this crossing within the device's limits.",
            consentHits[0]?.id ?? null,
          ),
          crossing: crossingOfCandidate(candidate),
          approver,
          ...(skipped.length > 0 ? { sensitive: skipped } : {}),
        };
      const consentHit = consentHits[0];
      if (consentHit)
        return {
          ...allow(
            "Full access runs this sensitive command without asking; the sandbox still applies.",
            consentHit.id,
          ),
          crossing: "sensitive",
        };
      return allow("The enforced operation scope covers this call without expansion.", null);
    }
    let consent: RuleHit | undefined;
    let granted: RuleHit | undefined;
    if (consentHits.length > 0) {
      // a session grant covers its own class only, and only while the person is there to have
      // given it (hardening spec R4, R6)
      const grants = input.attended
        ? await this.grantedRules(await facts.rootOf())
        : new Set<string>();
      const after = applySessionGrants({ outcome: "ask", hits: consentHits }, (rule) =>
        grants.has(rule),
      );
      if (after.outcome === "ask" || after.outcome === "unsure") consent = after.hit;
      else granted = after.hit;
    }
    if (!consent && !candidate) {
      if (granted) return allow(REVIEW_REASONS.sessionGrant, granted.id);
      // the rule table's allow, when it has one, says why; the enforced scope covers the rest
      const allowed = result.outcome === "allow" ? decidingHit(result.hits, "allow") : undefined;
      return allowed
        ? allow(allowed.reason, allowed.id)
        : allow("The enforced operation scope covers this call without expansion.", null);
    }
    const scopeHit =
      facts.kind === "read"
        ? undefined
        : result.hits.find((h) => h.outcome === "ask" && SCOPE_ASK_RULES.has(h.id));
    const rule = consent?.id ?? (candidate ? (scopeHit?.id ?? null) : null);
    // an escalation's one ask states both what it crosses and any sensitive consent it carries
    const reason = escalation
      ? escalationAskReason(escalation, consent?.reason)
      : (consent?.reason ??
        (scopeHit?.reason ? `${scopeHit.reason} ${EXPANSION_ASK_REASON}` : EXPANSION_ASK_REASON));
    const ask: ReviewVerdict = { decision: "ask", by: "rule", rule, reason, approver };
    if (approver === "person") return ask;
    if (!(await this.classifierMapped(input.orgId))) return ask;
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
        ...(input.parentRunId !== undefined && {
          parentRunId: input.parentRunId,
          ...(input.budgetRunId !== undefined && { budgetRunId: input.budgetRunId }),
        }),
        hookFacts: {
          accountId: input.accountId,
          agentId: input.agentId,
          agentVersion: input.agentVersion,
          conversationKind: input.conversationKind,
          parent: input.parent,
        },
        input: {
          mode: input.mode,
          kind: facts.kind,
          text: facts.target,
          cwd: facts.workspace,
          ruleHits: result.hits,
          personMessages: await this.personMessages(await facts.rootOf()),
          tag: newReviewTag(),
          ...(candidate ? { permissionCandidate: candidate } : {}),
          ...(fullAccessReview ? { fullAccessReview } : {}),
        },
        beforeSend: input.beforeSend,
      },
    );
    // the review model's ask still shows the rule the person is asked about
    if (answer.decision === "ask")
      return {
        ...ask,
        by: "classifier",
        reason: escalation ? withEscalation(reason, answer.reason) : answer.reason,
      };
    return {
      decision: answer.decision,
      by: "classifier",
      reason: answer.reason,
      rule: null,
      approver,
    };
  }

  private async decide(input: ReviewInput & ReviewCall): Promise<ReviewVerdict> {
    // not a reviewed tool, a sandbox-mode write (the tools stay root-confined), or no device: the
    // tool call proceeds and fails on its own if it cannot
    if (!REVIEWED_TOOLS.has(input.toolKey) && !input.permissionProfile) {
      return allow(REVIEW_REASONS.notReviewed, null);
    }
    // a path call: the file writes, and a `Read` under a permission profile (its path is judged)
    const isWrite =
      WRITE_TOOLS.has(input.toolKey) ||
      (input.toolKey === "Read" && input.permissionProfile !== undefined);
    // every path the call names (a GenerateImage call without file_path writes none)
    const paths = isWrite ? writePathsOf(input.toolKey, input.input) : [];
    if (isWrite && paths.length === 0) return allow(REVIEW_REASONS.notReviewed, null);
    if (input.mode === "sandbox" && isWrite && !input.permissionProfile) {
      return allow(REVIEW_REASONS.sandboxWrite, null);
    }
    const workspace = input.workspace;
    if (workspace === undefined) return allow(REVIEW_REASONS.noDevice, null);

    // the classifier reads every path a write call writes, one per line
    const target = isWrite ? paths.join("\n") : commandOf(input.input);
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
      home: input.home ?? null,
      deviceHome: input.deviceHome ?? null,
      mode: input.mode,
      attended: input.attended,
    };
    // running a file this conversation wrote is not a development command (hardening spec R1)
    const result = isWrite
      ? reviewWrites(paths, facts)
      : reviewRules(target, {
          ...facts,
          written: await this.writtenInTree(await rootOf(), facts),
        });
    let hit = decidingHit(result.hits, result.outcome);

    if (result.outcome === "deny") {
      return {
        decision: "deny",
        by: "rule",
        reason: hit?.reason ?? "The command review blocks this command.",
        rule: hit?.id ?? null,
      };
    }
    // the activated permission review has its own order after the fixed denies
    if (input.permissionProfile)
      return this.decidePermission(input, result, {
        kind: input.toolKey === "Read" ? "read" : isWrite ? "write" : "command",
        target,
        workspace,
        rootOf,
      });
    if (result.outcome === "allow" && !input.permissionCandidate) {
      return allow(hit?.reason ?? "The command review allows this command.", hit?.id ?? null);
    }
    if (result.outcome === "ask" && !input.permissionCandidate) {
      // a session grant covers its own class only, and only while the person is there to have
      // given it (hardening spec R4, R6): every ask hit granted and nothing unsure left
      const granted = input.attended ? await this.grantedRules(await rootOf()) : new Set<string>();
      const after = applySessionGrants(result, (rule) => granted.has(rule));
      if (after.outcome === "allow") {
        return allow(REVIEW_REASONS.sessionGrant, after.hit?.id ?? null);
      }
      if (after.outcome === "ask") {
        return {
          decision: "ask",
          by: "rule",
          reason: after.hit?.reason ?? "This command needs the person's approval.",
          rule: after.hit?.id ?? null,
        };
      }
      // the granted asks are settled; what is left is unsure, which the classifier decides
      hit = after.hit;
    }

    // unsure: the classifier decides when the purpose is mapped; without one the deciding hit is a
    // catch-all (`unsure.*`), which no person can reason about as a class: it is an ask with no
    // grantable rule (`once` only), exactly as a classifier ask, and no stored grant is consulted.
    if (!(await this.classifierMapped(input.orgId))) {
      return {
        decision: "ask",
        by: "rule",
        reason: hit?.reason ?? "This command needs the person's approval.",
        rule: null,
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
        ...(input.parentRunId !== undefined && {
          parentRunId: input.parentRunId,
          ...(input.budgetRunId !== undefined && { budgetRunId: input.budgetRunId }),
        }),
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
          ...(input.permissionCandidate ? { permissionCandidate: input.permissionCandidate } : {}),
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
   * The rule classes the root conversation holds session grants for (`command:<ruleId>` rows).
   * Command grants carry no tool-spec fingerprint: the approval records the rule, not the command.
   * Only a concrete grantable class counts: a stored catch-all or never-session class (old data)
   * covers nothing.
   */
  private async grantedRules(rootConversationId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom("conversation_tool_grants")
      .select("tool_key")
      .where("conversation_id", "=", rootConversationId)
      .where("tool_key", "like", "command:%")
      .execute();
    const rules = rows.map((r) => r.tool_key.slice("command:".length));
    return new Set(rules.filter((rule) => isSessionGrantableRule(rule)));
  }

  /**
   * The absolute paths the conversation tree's own tool calls wrote — the root's and every
   * sub-agent's: `Write` / `Edit` targets and the write targets (downloads and copies included) of
   * their `Bash` lines, from the latest {@link WRITTEN_EVENTS_READ} assistant messages of the tree.
   * All agents of a tree share the device, so a file one of them wrote is code the run produced,
   * whoever runs it (hardening spec R1).
   */
  private async writtenInTree(
    rootConversationId: string,
    facts: {
      workspace: string;
      cwd: string;
      home: string | null;
      deviceHome: string | null;
      mode: "auto" | "sandbox";
      attended: boolean;
    },
  ): Promise<string[]> {
    const rows = await this.db
      .withRecursive("tree(id)", (db) =>
        db
          .selectFrom("conversations")
          .select("id")
          .where("id", "=", rootConversationId)
          .unionAll((q) =>
            q
              .selectFrom("conversations as c")
              .innerJoin("tree", "tree.id", "c.parent_conversation_id")
              .select("c.id"),
          ),
      )
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "in", (q) => q.selectFrom("tree").select("id"))
      .where("type", "=", "assistant_message")
      .orderBy("created_at", "desc")
      .limit(WRITTEN_EVENTS_READ)
      .execute();
    const written = new Set<string>();
    for (const row of rows) {
      for (const call of toolCallsOf(row.payload)) {
        if (WRITE_TOOLS.has(call.name)) {
          for (const path of writePathsOf(call.name, call.input)) {
            written.add(path.startsWith("/") ? path : `${facts.workspace}/${path}`);
          }
        } else if (call.name === "Bash" && typeof call.command === "string") {
          for (const path of writtenPaths(call.command, facts)) written.add(path);
        }
      }
    }
    return [...written];
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

/** The tool calls of an `assistant_message` payload, with the fields the review reads. */
function toolCallsOf(payload: unknown): { name: string; input: unknown; command?: unknown }[] {
  const content = (payload as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => {
    if (b === null || typeof b !== "object") return [];
    const block = b as { type?: unknown; name?: unknown; input?: unknown };
    if (block.type !== "tool_call" || typeof block.name !== "string") return [];
    const input = (block.input ?? {}) as { file_path?: unknown; command?: unknown };
    return [{ name: block.name, input: block.input, command: input.command }];
  });
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

/**
 * The paths a validated write call writes: `Write` / `Edit`'s `file_path`, every path of a
 * `GenerateImage` call ({@link generateImagePaths}: none without `file_path`, the suffixed paths
 * of several images). Empty when there is none (the file tools refuse such an input).
 */
function writePathsOf(toolKey: string, input: unknown): string[] {
  if (toolKey === "GenerateImage") return generateImagePaths(input);
  const path = (input as { file_path?: unknown } | null)?.file_path;
  return typeof path === "string" ? [path] : [];
}

const OUTCOME_RANK: Record<RuleOutcome, number> = { allow: 0, unsure: 1, ask: 2, deny: 3 };

/**
 * The review of a call that writes several paths: each path reviewed as a `Write`, the worst
 * outcome deciding (deny, then ask, then unsure) over all their hits, so the call is allowed only
 * when every path is and a session grant settles it only when it covers every path's asks.
 */
function reviewWrites(paths: readonly string[], facts: Parameters<typeof reviewWrite>[1]) {
  const results = paths.map((p) => reviewWrite(p, facts));
  const outcome = results.reduce<RuleOutcome>(
    (worst, r) => (OUTCOME_RANK[r.outcome] > OUTCOME_RANK[worst] ? r.outcome : worst),
    "allow",
  );
  return { outcome, hits: results.flatMap((r) => r.hits) };
}
