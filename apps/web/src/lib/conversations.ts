import type { AgentProfile, Effort } from "./agents";
import { apiFetch } from "./api";
import type { OrgRole } from "./members";
import type { PersonRef } from "./people";
import type { PermissionProfile, PermissionSelection } from "./permissions";

/**
 * 内核会话 API 的类型（浏览器端视角：只声明界面用到的字段；时间为 JSON 字符串）。
 * 与内核 `packages/kernel/src/conversations/events.ts` 的事件形状对应。Web 层不 import 内核代码。
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; content: string; isError: boolean }
  /**
   * An uploaded attachment (only in user messages): the log holds a reference, the bytes come by
   * download. `size` (bytes) is display metadata for the chip; it never follows the block to a model.
   */
  | { type: "image"; mediaType: string; source: MediaSource; name?: string; size?: number }
  | { type: "document"; mediaType: string; source: MediaSource; name?: string; size?: number }
  /** An attachment the model only gets a reference to (an xlsx, say), same rules as the others. */
  | { type: "file"; mediaType: string; source: MediaSource; name?: string; size?: number };

/**
 * A media block's source: only `ref` in the log (bytes never enter it). The events API serves the
 * stored payloads, so a block logged before the file library names its file `attachmentId` (the
 * same id): read the id with {@link refId}.
 */
export type MediaSource = { kind: "ref"; fileId: string };

/** The file id a media ref names, whichever key it was logged under. */
export const refId = (source: MediaSource): string =>
  source.fileId ?? (source as { attachmentId?: string }).attachmentId ?? "";

type FormText = string | { zh: string; en: string };

/**
 * 用户消息附带的资源（内核读取正文，这里只有元数据）。`appId` / `appName` 是连接器的 id 与名称：
 * 事件 payload 字段名在「应用」改名「连接器」后不变（内核 C27）。
 */
export interface MessageAttachment {
  appId: string;
  appName: string;
  uri: string;
  name: string;
}

/** 交互表单（内核输入请求的 `form`，与 plugin-sdk 的 `InputForm` 对应）。 */
export interface InputForm {
  title: FormText;
  /** 需要用户在浏览器里打开的外部页面（MCP URL 模式的 elicitation）。 */
  url?: string;
  /** Longer text under the title (plugin-sdk `InputForm.body`). */
  body?: FormText;
  fields: {
    key: string;
    label: FormText;
    description?: FormText;
    schema: Record<string, unknown>;
    multiSelect?: boolean;
    allowOther?: boolean;
    required?: boolean;
    /** Buttons in place of the control (plugin-sdk `InputForm` `choices`). */
    choices?: { value: string | boolean; label: FormText }[];
  }[];
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

/** `tool_result` 的显示摘要（plugin-sdk `ToolResult.display`）。 */
export interface ToolDisplay {
  summary: { zh: string; en: string };
}

/** Which rule asked for an approval (kernel `ApprovalPolicySource`). */
export type ApprovalPolicy =
  | "agent"
  | "connector"
  | "member"
  | "default"
  | "role"
  | "org"
  | "fixed";

/**
 * A command review's decision on a tool call (auto mode spec §5.4; display only): who decided
 * (the rule table, the classifier or the person through a `command` ask) and why.
 */
export interface ReviewRecord {
  decision: "allow" | "deny";
  by: "rule" | "classifier" | "person";
  rule: string | null;
  reason: string;
  /** The person's choice (a `session` one covers the rule for the conversation). */
  scope?: "once" | "session";
  /** SHA-256 of the command text a `command` approval holds in full (person decisions). */
  commandHash?: string;
  /** Set only when the command was actually admitted to run outside the OS sandbox. */
  sandbox?: "escalated";
  /**
   * Who approved the call's crossing: inside the scope (`scope`), the review model, or Auto
   * by itself (approval-only profiles design). Absent on a denial.
   */
  decisionSource?: "scope" | "human" | "review-model" | "full-access" | "task-grant";
  /**
   * The boundary crossing the allow covered (absent when the call crossed nothing); a loopback
   * port grant is recorded by its own review event, never shown on the row.
   */
  crossing?: "directory" | "host" | "outside-sandbox" | "sensitive" | "loopback-port";
}

/**
 * The exact reach a permission approval grants (permission profiles, Task 7): each write directory
 * with its descendants and each host. Reads are never granted (they are the device provider's
 * rule). Shown whole, never clipped.
 */
export interface PermissionScope {
  writeDirectories: string[];
  hosts: string[];
}

/**
 * A per-call sandbox escalation: the agent's justification and, for a command that starts a
 * background process, that flag and the most seconds the process may run (its deadline).
 */
export interface SandboxEscalation {
  justification: string;
  background?: true;
  maxSeconds?: number;
}

/** A `command` ask's facts (auto mode spec §5.4; display only). */
export interface CommandAsk {
  /** The exact reach this ask grants (absent on an ask without one: an auto-mode command ask). */
  permissionScope?: PermissionScope;
  /**
   * The command asks to run outside the sandbox for this call only (per-call escalation): the
   * agent's justification. The card shows it instead of a directory scope. `background`: the
   * approved command starts a background process; `maxSeconds` (with `background`) is the most
   * seconds that process may run before it is stopped.
   */
  escalation?: SandboxEscalation;
  /** The directory the command runs in (shown with an escalation). */
  workingRoot?: string;
  /** The file the call targets, informational only: the scope names its directory. */
  targetPath?: string;
  candidateHash?: string;
  kind: "command" | "write" | "read";
  /** The profile the call was reviewed under (a permission ask): the card's wording follows it. */
  profile?: "request-approval" | "approve-for-me" | "full-access";
  /** The command text, or the tool key of the write or read. */
  command: string;
  /** A write's or read's target path. */
  path?: string;
  rule: string | null;
  reason: string;
  mode: "auto" | "sandbox";
}

/**
 * Which layer refused a network host (network ask spec §4.1): the device's own policy, the org's
 * egress, a private or local address, or unknown.
 */
export type NetworkBlockedLayer = "device" | "org" | "address" | "unknown";

/** One stored image of a call's result (`tool_result.media`): a `read` attachment of the conversation. */
export interface ToolResultImage {
  attachmentId: string;
  name: string;
  mediaType: string;
  size: number;
}

/** `tool_result.view` (kernel `ToolViewSchema`): display only. */
export type ToolView =
  | { kind: "command"; description?: string; exitCode: number | null; timedOut: boolean }
  | {
      kind: "edit";
      path: string;
      created: boolean;
      added: number;
      removed: number;
      truncated: boolean;
      hunks: {
        oldStart: number;
        newStart: number;
        lines: { kind: "ctx" | "add" | "del"; text: string }[];
      }[];
    }
  | { kind: "read"; path: string; fromLine?: number; toLine?: number }
  /** `Edit` / `Write` refused by the read-before-write check: a neutral outcome, not a failure. */
  | { kind: "guard"; reason: "not_read" | "modified" }
  /** A call to a tool the step did not load: expected behaviour, a neutral notice, not a failure. */
  | { kind: "not_loaded" }
  /**
   * A background `Bash` start the kernel sent but could not confirm: the row reads reconciling, not
   * failed, until the task is confirmed running or ends (the model still got an error).
   */
  | { kind: "launch_unconfirmed"; taskId: string }
  /**
   * A `Platform` operation whose result the run's person reads once, by call (the initial
   * password, the invitation link): the web draws the reveal under the tool row.
   */
  | { kind: "reveal"; reveal: "initial_password" | "invitation_link" }
  /**
   * A `Platform` operation's link card (platform web parity spec §4.4, §6): the decision waits for
   * the person on a web page (`link`, a relative path) or an OAuth connect (`connect`).
   */
  | { kind: "handoff"; title: { zh: string; en: string }; target: HandoffTarget };

/** Where a handoff card's one button goes: a relative web path, or a connector's OAuth connect. */
export type HandoffTarget =
  | { type: "link"; url: string }
  | { type: "connect"; connectorId: string };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other" | "aborted";

type EventBody =
  | {
      type: "user_message";
      payload: {
        content: ContentBlock[];
        /** `@` 资源引用的附件：第 i 个附件的正文是 `content[i + 1]`。 */
        attachments?: MessageAttachment[];
        /**
         * Referenced project files (composer menus §5), relative to the conversation's project
         * root: file i's text block is `content[1 + attachments.length + i]`.
         */
        projectFiles?: { path: string }[];
        /**
         * Referenced conversations (@ conversations spec §2): reference i's quoted text block is
         * `content[1 + attachments.length + projectFiles.length + i]`.
         */
        conversationRefs?: ConversationRefMeta[];
        authorAccountId: string;
        /**
         * Who wrote it, at send time (model-facing data; the page names authors from the live
         * account and shows no per-message senders).
         */
        sender?: { name: string; role?: OrgRole; anonymous?: true };
        /** The sender's time zone and language at send time (the next run's context). */
        timeZone?: string;
        locale?: "zh" | "en";
        clientMessageId?: string;
        /** A retry after a failed run: the seq of the message it repeats (display only). */
        retryOf?: number;
        /**
         * A message to a sub-agent from its parent agent (phase C, agent map spec §5.1): the
         * dispatch's task (`kind` absent or `task`), or a `SendMessage` (`message`).
         */
        dispatch?: {
          parentConversationId: string;
          parentRunId: string;
          callId: string;
          kind?: "task" | "message";
        };
        /**
         * A person's skill invocation (phase D): `content[0]` is the rendered skill, this is what
         * they typed (the chip and the arguments). `template`: a template sub-agent's skill the
         * kernel wrote after the task (part of the task, not a person's message).
         */
        skill?: SkillInvocationRecord;
        /**
         * The kernel's notice, in place of a template skill's invocation, that the skill could not
         * be read at dispatch: part of the task, not a person's message.
         */
        templateSkillNotice?: { name: string };
      };
    }
  | {
      /** The person switched model / effort, or the kernel fell back to the agent's model. */
      type: "model_switched";
      payload: {
        model: ModelRef | null;
        effort: string | null;
        byAccountId: string | null;
        reason: "user" | "unavailable";
      };
    }
  | {
      /**
       * A root conversation's permission profile was set (revision 0: the first message's choice)
       * or changed. A recorded fact only: it is not an owner's live view of the profile.
       */
      type: "permission_profile_changed";
      payload: {
        oldProfile: PermissionProfile;
        newProfile: PermissionProfile;
        actorAccountId: string | null;
        reason?: "user" | "authority-changed";
        deviceId: string | null;
        scopeRevision: string | null;
        revision: number;
      };
    }
  | {
      type: "run_started";
      payload: {
        agentVersion: number;
        model: ModelRef;
        triggerAccountId?: string;
        /** `compact`: a manual compact run, which runs no model step (display only). */
        trigger?:
          | "message"
          | "background_task"
          | "subagent"
          | "schedule"
          | "compact"
          | "automation_event";
        /** A compact run started by the idle job (`idle`); absent = a manual compaction. */
        compactOrigin?: "manual" | "idle";
      };
    }
  | {
      type: "model_call";
      payload: {
        step: number;
        provider: string;
        model: string;
        /** The user messages the request took in and the tools it offered by key. */
        request: { absorbedUpToSeq: number; tools: { key: string }[] };
      };
    }
  | {
      type: "assistant_message";
      payload: { step: number; content: ContentBlock[]; stopReason: StopReason };
    }
  | {
      type: "usage";
      payload: {
        step: number;
        provider: string;
        model: string;
        /** 未缓存的输入；输入总量 = inputTokens + cacheReadTokens + cacheWriteTokens。 */
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        /**
         * Set when the usage is not the step's call: `compaction`, `title`, `web_fetch` (a
         * `WebFetch` extraction call, with that call's `callId`) or `review` (the command-review
         * classifier, also with the reviewed call's `callId`), `image` (a `GenerateImage` call),
         * `vision` (an image read by the vision purpose model, with that call's `callId`) or
         * `suggestion` (a prompt suggestion after a completed run).
         */
        purpose?:
          | "compaction"
          | "title"
          | "web_fetch"
          | "review"
          | "image"
          | "vision"
          | "suggestion";
        /** A chunked compaction call's 1-based chunk and the calls the compaction attempted. */
        chunk?: number;
        chunks?: number;
        callId?: string;
      };
    }
  | { type: "reminder"; payload: { step: number; text: string } }
  /** The model's tool set changed since its previous request (model-facing; the UI shows nothing). */
  | { type: "tools_changed"; payload: { step: number; added: string[]; removed: string[] } }
  /**
   * Who the agent is and the facts of the day, written at run start (model-facing; the UI shows
   * nothing).
   */
  | {
      type: "run_context";
      payload: {
        agent?: { name: string; description?: string };
        org?: { name: string };
        date?: string;
        timeZone?: string;
        locale?: "zh" | "en";
        dispatchedBy?: { agent: string; person: string };
      };
    }
  | {
      type: "tool_call_started";
      payload: { step: number; callId: string; toolKey: string; specHash: string };
    }
  | {
      type: "tool_result";
      payload: {
        step: number;
        callId: string;
        toolKey: string;
        content: string;
        isError: boolean;
        outputId?: string;
        contentTypes?: string[];
        loadedTools?: string[];
        /** 工具给的一句说明（中英各一份，只用于显示，不进模型上下文）。 */
        display?: ToolDisplay;
        /** Structured view of a builtin's result (display only). */
        view?: ToolView;
        /**
         * An inline card under the call (an `inline` ui contribution of the tool's extension).
         * `placement` is absent for `output` (the default); `text` is a pinned card's Markdown
         * for channels and `badge` its state ("3/5", its view's badge) for the process head
         * (process blocks spec §5).
         */
        card?: {
          plugin: string;
          view: string;
          key?: string;
          placement?: "pinned" | "process";
          text?: string;
          badge?: string;
        };
        /** The command review's decision on the call (auto mode spec §5.4; display only). */
        review?: ReviewRecord;
        /**
         * The images stored for the call (Read's copy, or the image blocks of any tool's result):
         * shown to the agent; the row shows them as thumbnails (tool result images design §4).
         */
        media?: ToolResultImage[];
      };
    }
  | {
      type: "connection_required";
      payload: { step: number; callId: string; appId: string; appName: string };
    }
  | {
      type: "approval_requested";
      payload: {
        step: number;
        callId: string;
        approvalId: string;
        toolKey: string;
        expiresAt: string;
        /** Which rule asked a tool approval (display only; absent on the other asks). */
        policy?: ApprovalPolicy;
        /** A network ask: the device-layer hosts asked for (display only). */
        network?: { hosts: string[] };
        /** A loopback port ask: the service, the port and whether it is a database port. */
        loopback?: { service: string; port: number; database: boolean };
        /** A command review ask: what is held and why (display only). */
        command?: CommandAsk;
        /** A secure input request: what the values are for and the field paths (never a value). */
        secureInput?: { target: { zh: string; en: string }; fields: string[] };
      } & Approver;
    }
  /**
   * An approval addressed to the conversation's person that the profile decided without asking
   * (Auto, or the review model under Approve for me). Display and audit only.
   */
  | {
      type: "tool_ask_decided";
      payload: {
        step: number;
        callId: string;
        toolKey: string;
        specHash: string;
        bindingHash: string;
        outcome: "allow" | "deny";
        decisionSource: "review-model" | "full-access";
        reason: string;
        profileRevision: number;
        fileSha256?: string;
      };
    }
  | {
      type: "approval_decided";
      payload: {
        approvalId: string;
        callId: string;
        /**
         * `skipped`: a network ask the person answered with a message instead. `superseded`: a
         * permission change (`reason` `user` / `authority-changed`, at root `revision`) replaced
         * the pending ask; nobody decided it.
         */
        decision: "approved" | "denied" | "expired" | "cancelled" | "skipped" | "superseded";
        /** The root permission revision that superseded the ask. */
        revision?: number;
        scope?: "once" | "session" | "always";
        byAccountId: string | null;
        /** The reason given with a denial. */
        reason?: string;
      };
    }
  /**
   * A still-pending approval changed without a decision (a network ask's device change that did
   * not take effect: its `detail.attempt`): the card reads the approval again. Display only.
   */
  | { type: "approval_updated"; payload: { approvalId: string; callId: string } }
  /**
   * A command on a device was refused network hosts (display only, never model-visible): each
   * host with the layer that refused it. Device-layer hosts are asked about in an approval; the
   * org and address layers are facts under the command's row.
   */
  | {
      type: "network_blocked";
      payload: {
        step: number;
        callId: string;
        hosts: { host: string; port: number; layer: NetworkBlockedLayer }[];
      };
    }
  /**
   * A `gh auth login --web` device-code prompt a command printed (auto mode spec §6, P-D13):
   * display only, never model-visible. The thread draws its card under the command's group.
   */
  | {
      type: "device_code";
      payload: { step: number; callId: string; url: string; code: string };
    }
  | {
      type: "question_asked";
      payload: {
        step: number;
        callId: string;
        questionId: string;
        form: InputForm;
        expiresAt: string;
        /**
         * A plugin tool's `InputRequired.open`: a `conversation.panel` of that extension the page
         * opens when the question arrives (display only).
         */
        open?: { plugin: string; contribution: string; item?: string };
        /** A watched wait (the agent waits for a condition): drawn as a wait card. */
        watch?: true;
      };
    }
  | {
      type: "question_answered";
      payload: {
        questionId: string;
        callId: string;
        answer: FormAnswer | null;
        byAccountId: string | null;
        /**
         * `skipped`: the run's starter sent a message instead of answering; `woken`: a watched
         * wait its watcher ended.
         */
        outcome: "answered" | "skipped" | "expired" | "cancelled" | "woken";
        /** `skipped` only: the seq of the `user_message` that skipped it (lower than this event's). */
        skippedBySeq?: number;
      };
    }
  | {
      /** agent 经 `Deliver` 交付的文件（产物）：字节在对象存储，经 artifacts 下载接口取。 */
      type: "artifact_created";
      payload: {
        artifactId: string;
        name: string;
        contentType: string;
        size: number;
        sourcePath: string;
        callId: string;
      };
    }
  | {
      /** 此刻生效的技能目录快照（运行开始时目录变了才写；界面不显示）。 */
      type: "skills_catalog";
      payload: {
        skills: {
          id: string;
          name: string;
          description: string;
          version: number;
          source: string;
        }[];
      };
    }
  /**
   * The paths the sandbox tools use in the conversation's device (written on its first
   * sandbox call and whenever they change; model-facing, the UI shows nothing).
   */
  | {
      type: "device_paths";
      payload: { roots: { workspace: string; skills: string; tmp: string } };
    }
  /** A bound conversation's project as a run start read it (project root §4.4). */
  | { type: "project_root"; payload: ProjectRootPayload }
  /** A background `Bash` task ended (background Bash spec §2): the thread's one-line notice. */
  | {
      type: "background_task_finished";
      payload: {
        taskId: string;
        description: string;
        status: Exclude<BackgroundTaskStatus, "running">;
        exitCode: number | null;
        elapsedMs: number;
        /** The output's last lines (at most 20 lines, 4000 characters). */
        lastLines: string;
        outputPath: string;
        reported: boolean;
        lostReason?: string;
        stoppedBy?: "person" | "deletion" | "subagent_end";
      };
    }
  | {
      type: "compaction_summary";
      payload: {
        coversUpToSeq: number;
        text: string;
        /** What compaction saved (estimated transcript minus summary). */
        savedTokens: number;
      };
    }
  | { type: "compaction_failed"; payload: { attempt: number; reason: string } }
  | {
      /**
       * A manual compaction found nothing to summarize: nothing precedes the kept tail (maintainer
       * decision 2026-11-28). `too_few_turns` is an earlier plan's reason. Display only.
       */
      type: "compaction_skipped";
      payload: {
        reason: "nothing_to_summarize" | "too_few_turns";
        keepRecentTurns?: number;
        turns: number;
        step: number;
      };
    }
  | {
      type: "media_excluded";
      payload: { attachmentIds: string[]; reason: "provider_rejected" };
    }
  | { type: "run_finished"; payload: { reason: string; consumedUpToSeq: number } }
  | { type: "run_failed"; payload: { error: { code: string; message: string } } }
  /**
   * Model context and review records the timeline does not draw (kernel `events.ts`); only a
   * loopback port grant's `permission_reviewed` marks its call's row.
   */
  | {
      type: "permission_context" | "permission_reviewed" | "plugin_context";
      payload: Record<string, unknown>;
    }
  /** A plugin policy hook denied a model request or a tool call (the timeline names the plugin). */
  | {
      type: "hook_denied";
      payload: {
        mount: "model.request" | "tool.preExecute";
        plugin: string;
        reason: string;
        cause: "deny" | "hook_error" | "timeout";
        step: number;
        attempt?: number;
        callId?: string;
      };
    }
  | { type: "run_aborted"; payload: { byAccountId: string | null; reason: string } }
  /**
   * A sub-agent conversation's first event (phase C): who dispatched it, its roster type, where its
   * definition came from (an org agent: `source: "agent"`, `id` its agent id) and the frozen
   * (narrowed) definition.
   */
  | {
      type: "subagent_started";
      payload: {
        parent: { conversationId: string; runId: string; callId: string; step: number };
        agentType: string;
        template: {
          source: "general" | "inline" | "plugin" | "agent";
          id?: string;
          version?: number;
          plugin?: string;
        };
        definition: { name: string; [key: string]: unknown };
        maxSteps: number;
        warnings?: string[];
      };
    }
  /** Parent log: the `agent` call `callId` started (or resumed) the sub-agent `subagentId`. */
  | {
      type: "subagent_dispatched";
      payload: {
        step: number;
        callId: string;
        subagentId: string;
        childRunId: string;
        agentType: string;
        description: string;
        resumed: boolean;
        model: ModelRef;
        tierFallback?: boolean;
        /** Phase D: the person's fork invocation this dispatch runs (`callId` `skill-<seq>`). */
        invokedSeq?: number;
      };
    }
  /**
   * Root log: a sub-agent of the tree, at any depth, waits for a person (its approval, question or
   * connection). `path`: the child conversation ids from the root's child down to `subagentId`
   * (absent in logs written before nesting, where it was the parent's own child).
   */
  | {
      type: "subagent_waiting";
      payload: {
        subagentId: string;
        childRunId: string;
        path?: string[];
        kind: "approval" | "input" | "connect";
        approvalId?: string;
        questionId?: string;
        toolKey: string;
        expiresAt?: string;
        /** The child's question is a watched wait. */
        watch?: true;
      } & Approver;
    }
  /**
   * Parent log (agent map spec §4.5): a sub-agent's report (`SubagentHandback`), its note
   * (`SendMessage` to the parent) or its run's end; model-visible.
   */
  | {
      type: "subagent_delivery";
      payload: {
        subagentId: string;
        childRunId: string;
        description: string;
        kind: "report" | "note" | "finished";
        text: string;
        /** `finished` only. */
        status?: SubagentEndStatus;
        /** `finished` only: a report was handed back before (no text then). */
        handedBack?: boolean;
        errorCode?: string;
        abortedBy?: "user" | "parent";
        triggerAccountId: string;
      };
    }
  /** Parent log: a sub-agent's run ended. */
  | {
      type: "subagent_finished";
      payload: {
        subagentId: string;
        childRunId: string;
        callId: string;
        status: SubagentEndStatus;
        errorCode?: string;
        toolCalls: number;
        durationMs: number;
        usage: ConversationUsage;
      };
    };

/** The `skill` of a person's invocation message (kernel `user_message.skill`, phase D). */
export interface SkillInvocationRecord {
  id: string;
  version: number;
  source: string;
  /** The skill's bare name. */
  name: string;
  plugin?: string;
  /** As typed (trimmed). */
  arguments: string;
  mode: "inline" | "fork";
  /** Fork only: the sub-agent type it ran as. */
  agentType?: string;
  /**
   * Written by the kernel at a template sub-agent's dispatch (one per template skill, after the
   * task): nobody typed it; shown with the task.
   */
  template?: true;
}

/** Phase D: the report of the sub-agent that ran a person's fork invocation (model-visible). */
type SkillForkResultBody = {
  type: "skill_fork_result";
  payload: { invokedSeq: number; subagentId?: string; childRunId?: string; text: string };
};

/** How a sub-agent's run ended (`subagent_finished.status`). */
export type SubagentEndStatus =
  | "completed"
  | "max_steps"
  | "max_duration"
  | "budget"
  | "max_output"
  | "aborted"
  | "timed_out"
  | "failed";

/** Token usage summed over events (`GET .../usage`, a `subagent_finished`). */
export interface ConversationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Who may decide an approval (display only): the assigned member, else the escalation role
 * (`approval_requested`, and a sub-agent's in `subagent_waiting`, where only an approval has it).
 */
export interface Approver {
  requestedFor?: string | null;
  approverRole?: OrgRole | null;
}

/**
 * A `project_root` event's payload (kernel `events.ts`): the project and its root, its `AGENTS.md`
 * when found, its skills (name, description, digest), or why it is unavailable (then no
 * `AGENTS.md` and no skills).
 */
export interface ProjectRootPayload {
  project: string;
  root: string;
  agentsMd?: string;
  agentsMdTruncated?: true;
  skills: { name: string; description: string; digest: string }[];
  skillsTruncated?: true;
  unavailable?: {
    reason: "gone" | "outside_mode" | "unreadable" | "unsupported" | "removed";
    message: string;
  };
}

/** The state a conversation's latest `project_root` records (kernel `ProjectState`). */
export type ProjectState =
  | { loaded: true; agentsMd: boolean }
  | { unavailable: NonNullable<ProjectRootPayload["unavailable"]>["reason"] };

/** 已写入日志的会话事件。 */
export type ConversationEvent = (EventBody | SkillForkResultBody) & {
  conversationId: string;
  seq: number;
  runId: string | null;
  createdAt: string;
};

export interface ModelRef {
  provider: string;
  model: string;
}

/** The model / effort a person switched to; nulls = the agent's own. */
export interface Selection {
  model: ModelRef | null;
  effort: string | null;
}

export interface Conversation {
  id: string;
  orgId: string;
  agentId: string;
  title: string | null;
  /** Who wrote `title`. */
  titleSource: "generated" | "manual" | null;
  selection?: Selection;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  /** A sub-agent conversation's parent (null or absent for a chat conversation). */
  parentConversationId?: string | null;
  /** A sub-agent conversation's roster type. */
  subagentType?: string | null;
  /** The conversation's owner. */
  accountId?: string;
  /** The owner as a person (null when the account is gone); read with the one conversation. */
  owner?: PersonRef | null;
  /** The device it runs in, bound at the first message (null: none). */
  deviceId: string | null;
  /** The automation that started it (a `new`-mode task); null otherwise. */
  automationId?: string | null;
  /**
   * The event subject it serves (a `subject`-mode automation's conversation): the emitting
   * extension and the subject; null for any other conversation.
   */
  subject?: { source: string; kind: string; id: string; title: string } | null;
  /**
   * The device project it is bound to (project root §4.3: chosen at creation, never changed);
   * null in free mode.
   */
  project?: { name: string; path: string } | null;
  /**
   * Its latest `project_root` snapshot, wherever it lies in the log: loaded (and whether the
   * project's `AGENTS.md` was found) or why the project is unavailable; null before the first run
   * start recorded one (and in a list row).
   */
  projectState?: ProjectState | null;
  /** What it is doing now: a run in progress, or waiting for me. */
  activity: "running" | "waiting" | null;
}

/** A parent conversation's sub-agent (`GET .../conversations/:id/subagents`). */
export interface SubagentView {
  id: string;
  agentType: string;
  description: string;
  /** The latest run's status (`runs.status`). */
  status: string;
  /** Tool calls of the latest run. */
  toolCalls: number;
  startedAt: string;
  finishedAt: string | null;
  usage: ConversationUsage;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
  /** The pending questions that are watched waits: a subset of `pendingQuestionIds`. */
  watchedQuestionIds?: string[];
}

/** A background `Bash` task's status (kernel `BackgroundTaskStatus`). */
export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "lost";

/** A background task (`GET .../conversations/:id/background-tasks`). */
export interface BackgroundTaskView {
  id: string;
  /** The conversation the task was asked for. */
  conversationId: string;
  /** The sub-agent (child conversation) that started it; null for the conversation's own. */
  subagentId: string | null;
  description: string;
  command: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  lostReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** A stop is under way (another request is handling it); the task still runs. */
  stopping: boolean;
  /** With `stopping`: the stop is recorded and owed, no attempt under way (waits for the device). */
  stopWaiting: boolean;
  /** Why the owed stop's last attempt did not settle; null when none failed. */
  stopFailure: "unreachable" | "failed" | null;
  /** The start was sent but not confirmed yet: the kernel is reconciling it. */
  starting: boolean;
}

/**
 * Why a task's output cannot be read live (kernel `OutputUnavailable`): the reason and where the
 * task ran, a `local` device or a `cloud` sandbox.
 */
export interface BackgroundTaskUnavailable {
  reason:
    | "starting"
    | "not_started"
    | "device_offline"
    | "suspended"
    | "rebuilt"
    | "output_missing"
    | "no_access"
    | "unavailable"
    | "read_failed";
  /** The provider of the device the task ran on; null when none is known. */
  provider: string | null;
}

/**
 * The end of a task's output (`live`: read from the environment; `event`: the finish's last
 * lines, with why it was not read live).
 */
export interface BackgroundTaskOutput {
  text: string;
  truncated: boolean;
  source: "live" | "event";
  unavailable?: BackgroundTaskUnavailable;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations`;
const one = (orgId: string, id: string) => `${base(orgId)}/${encodeURIComponent(id)}`;

/** 每页事件上限（内核 `limit` 的最大值）。 */
export const EVENTS_PAGE = 500;

export const createConversation = (orgId: string, agentId: string) =>
  apiFetch<{ conversation: Conversation }>(base(orgId), {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });

/** At most this many conversations a message references (kernel `MAX_CONVERSATION_REFS`). */
export const MAX_CONVERSATION_REFS = 3;

/** One referenced conversation as a logged `user_message` names it (`payload.conversationRefs`). */
export interface ConversationRefMeta {
  id: string;
  /** The title at send time; null: untitled. */
  title: string | null;
  /** `summary`: built from its latest compaction summary; `excerpt`: from its last messages. */
  source: "summary" | "excerpt";
  /** The highest seq read from it. */
  upToSeq: number;
}

/** What a message carries besides its text (`POST …/messages`, the first message). */
export interface MessageInput {
  text: string;
  clientMessageId: string;
  attachments?: { connectorId: string; uri: string }[];
  files?: string[];
  /**
   * Files of the conversation's device project, referenced, not uploaded (composer menus §5):
   * paths relative to the project root, at most 10; they need text like `@` resources.
   */
  projectFiles?: { path: string }[];
  /**
   * The sender's own conversations, referenced by id (@ conversations spec §1): at most
   * {@link MAX_CONVERSATION_REFS}; they need text like `@` resources.
   */
  conversationRefs?: { id: string }[];
  /** Switch the conversation's model from the next run (the agent's own model = back to it). */
  model?: ModelRef;
  effort?: Effort;
  /** A retry after a failed run: the seq of the repeated message. */
  retryOf?: number;
  /** Invoke this skill (phase D): `text` is its arguments. */
  skill?: { name: string };
}

/**
 * The sender's browser time zone and UI language, sent with every message (run context spec
 * §3.4): the kernel uses them unless the person set a time zone in their preferences.
 */
export function browserContext(): { timeZone?: string; locale?: "zh" | "en" } {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    timeZone = undefined;
  }
  const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
  const locale = lang === "zh" || lang === "en" ? lang : undefined;
  return {
    ...(timeZone !== undefined && { timeZone }),
    ...(locale !== undefined && { locale }),
  };
}

const messageBody = (m: MessageInput) => ({
  text: m.text,
  clientMessageId: m.clientMessageId,
  ...(m.attachments !== undefined && m.attachments.length > 0 && { attachments: m.attachments }),
  ...(m.files !== undefined && m.files.length > 0 && { files: m.files }),
  ...(m.projectFiles !== undefined &&
    m.projectFiles.length > 0 && { projectFiles: m.projectFiles }),
  ...(m.conversationRefs !== undefined &&
    m.conversationRefs.length > 0 && { conversationRefs: m.conversationRefs }),
  ...(m.model !== undefined && { model: m.model }),
  ...(m.effort !== undefined && { effort: m.effort }),
  ...(m.retryOf !== undefined && { retryOf: m.retryOf }),
  ...(m.skill !== undefined && { skill: m.skill }),
  ...browserContext(),
});

/**
 * What a new conversation's first message asks for (`POST …/conversations/first-message`): the
 * message, the permission profile chosen in the composer (with the consented scope revision for
 * Auto) and the device and project; no device for a device-less restricted choice.
 */
export interface FirstMessageRequest {
  agentId: string;
  message: Omit<MessageInput, "retryOf" | "clientMessageId">;
  permission: PermissionSelection;
  deviceId?: string;
  /** One of the device's projects to bind (project root §4.3); undefined: free mode. */
  project?: string;
}

/** The first message's answer: 201 created, or 200 for a retry of the same request. */
export interface FirstMessageAnswer {
  conversation: Conversation;
  event: ConversationEvent;
  /** Every event the create wrote, from seq 1 (the initial profile, a `model_switched` …). */
  events: ConversationEvent[];
}

/**
 * The first message's exact request body, built once (the browser context included): every retry
 * of it sends these bytes again, so a retry after a lost answer is the same request to the kernel
 * (same `clientMessageId`, same body) and never a second conversation.
 */
export function serializeFirstMessage(r: FirstMessageRequest, clientMessageId: string): string {
  return JSON.stringify({
    agentId: r.agentId,
    message: messageBody({ ...r.message, clientMessageId }),
    ...(r.deviceId !== undefined ? { deviceId: r.deviceId } : {}),
    ...(r.project !== undefined ? { project: r.project } : {}),
    permission: r.permission,
  });
}

/**
 * Create on first send, atomically with the chosen permission profile: the conversation, its
 * profile and its first message in one call (the profile governs the first operation; nothing is
 * created and then changed). Sends `serializedBody` as it is: build it once with
 * {@link serializeFirstMessage}. A generic 409 `conflict` is a stale displayed scope or the same
 * id with another body; it never says whether an earlier attempt committed.
 */
export const submitFirstMessage = (orgId: string, serializedBody: string) =>
  apiFetch<FirstMessageAnswer>(`${base(orgId)}/first-message`, {
    method: "POST",
    body: serializedBody,
  });

/** Rename (owner only): a manual title is never regenerated. */
export const renameConversation = (orgId: string, id: string, title: string) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });

/**
 * Manual compaction (context compaction spec §4.7): starts a compact run that summarizes the
 * conversation's earlier history, `202 { runId }`; the same run id comes back while one is queued
 * or running. The body is `{}` (the endpoint also accepts a bodyless POST; only an optional
 * `clientRequestId` may go in it). A busy conversation is `409 conversation.busy`; an eval or
 * someone else's is not found.
 */
export const compactConversation = (orgId: string, id: string) =>
  apiFetch<{ runId: string }>(`${one(orgId, id)}/compact`, {
    method: "POST",
    body: JSON.stringify({}),
  });

/** Archive or unarchive (owner only); archiving does not stop a running run. */
export const archiveConversation = (orgId: string, id: string, archived: boolean) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });

/** Delete (owner only, soft): stops a running run first. */
export const deleteConversation = (orgId: string, id: string) =>
  apiFetch<void>(one(orgId, id), { method: "DELETE" });

/** The agent's name and the avatar half of its profile, as the agents API returns them. */
export interface ConversationAgent {
  id: string;
  name: string;
  profile: Pick<AgentProfile, "avatar" | "updatedAt">;
}

/**
 * A row of the by-time list: the conversation and its agent (null only in a rare race, when the
 * agent became invisible between the kernel's two reads).
 */
export type ConversationListRow = Conversation & { agent: ConversationAgent | null };

/**
 * A page of the by-time list; `total` (all my matching conversations) only on a first page read
 * with `withTotal`.
 */
export interface ConversationListPage {
  conversations: ConversationListRow[];
  next: string | null;
  total?: number;
}

/** One agent's group of my conversations (`GET .../conversations/groups`, the sidebar). */
export interface ConversationGroup {
  agent: ConversationAgent;
  /** The group's latest activity (ISO). */
  latestAt: string;
  /** At most `perGroup`, newest first. */
  conversations: Conversation[];
  /** The group has more conversations than it lists (load them with `listConversations`). */
  more: boolean;
}

/** A query string from the defined options, in the given order (`""` when none is set). */
function query(opts: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/**
 * What narrows my conversations (web order §2.1): a title substring (`q`, case-insensitive), a run
 * state, and the archived list instead of the live one. A blank `q` and state `all` are omitted
 * (the kernel rejects `?q=`); `q` is cut to the kernel's 100 characters.
 */
export type ConversationSearch = {
  q?: string;
  state?: "all" | "running" | "waiting";
  archived?: boolean;
};

const searchQuery = (s: ConversationSearch) => {
  const q = s.q?.trim().slice(0, 100);
  return {
    q: q === "" ? undefined : q,
    state: s.state === undefined || s.state === "all" ? undefined : s.state,
    archived: s.archived === true ? "1" : undefined,
  };
};

/** One page of {@link listConversationGroups}. */
export interface ConversationGroupsPage {
  groups: ConversationGroup[];
  next: string | null;
  archivedCount?: number;
}

/**
 * My conversations grouped by agent, by latest activity; `next` is passed back as `after`.
 * `archivedCount` counts my archived conversations whatever the search (the archived entry).
 *
 * The cursor is the last group's agent id, re-read at that group's latest activity when the next
 * page is asked for: a group that gets new activity between two pages can come back on the next
 * page (and one that moved up is skipped until a reload). Callers merge pages by agent id
 * (`useConversationGroups`).
 */
export const listConversationGroups = (
  orgId: string,
  opts: { perGroup?: number; limit?: number; after?: string } & ConversationSearch = {},
) =>
  apiFetch<ConversationGroupsPage>(
    `${base(orgId)}/groups${query({
      perGroup: opts.perGroup,
      limit: opts.limit,
      after: opts.after,
      ...searchQuery(opts),
    })}`,
  );

/**
 * My conversations, newest first; `agentId` keeps one agent's (a group's "More"). `withTotal` asks
 * the first page (no `after`) for `total`, which the kernel counts over every match: only a page
 * that shows the count asks, never a polled list.
 */
export const listConversations = (
  orgId: string,
  opts: {
    agentId?: string;
    after?: string;
    limit?: number;
    withTotal?: boolean;
  } & ConversationSearch = {},
) =>
  apiFetch<ConversationListPage>(
    `${base(orgId)}${query({
      agentId: opts.agentId,
      after: opts.after,
      limit: opts.limit,
      withTotal: opts.withTotal === true && opts.after === undefined ? "true" : undefined,
      ...searchQuery(opts),
    })}`,
  );

export const getConversation = (orgId: string, id: string) =>
  apiFetch<{ conversation: Conversation }>(one(orgId, id));

export const listEvents = (orgId: string, id: string, after: number, limit = EVENTS_PAGE) =>
  apiFetch<{ events: ConversationEvent[]; people: Record<string, PersonRef> }>(
    `${one(orgId, id)}/events?after=${after}&limit=${limit}`,
  );

/**
 * Whether `events` (the cached window of a log) start at the log's beginning: seqs are allocated
 * from 1 without gaps, so the first event has seq 1 (an empty log has nothing before it either).
 */
export const fromStart = (events: readonly ConversationEvent[]): boolean =>
  events.length === 0 || (events[0] as ConversationEvent).seq === 1;

/** How many events a page of history reads (the first paint's last page, each earlier page). */
export const HISTORY_PAGE = 200;

/**
 * The turn-aligned page of events before `before` (`"end"`: the log's last page), with how many
 * runs started before its first event (history paging spec §2).
 */
export const listEventsBefore = (
  orgId: string,
  id: string,
  before: number | "end",
  limit = HISTORY_PAGE,
) =>
  apiFetch<{
    events: ConversationEvent[];
    /** Every account the events name, by id (read time); an absent id has left. */
    people: Record<string, PersonRef>;
    turnsBefore?: number;
  }>(`${one(orgId, id)}/events?before=${before}&limit=${limit}`);

/** 读完 `after` 之后的全部事件（逐页）。 */
export async function listAllEvents(
  orgId: string,
  id: string,
  after = 0,
): Promise<{ events: ConversationEvent[]; people: Record<string, PersonRef> }> {
  const out: ConversationEvent[] = [];
  const people: Record<string, PersonRef> = {};
  let cursor = after;
  for (;;) {
    const page = await listEvents(orgId, id, cursor);
    out.push(...page.events);
    Object.assign(people, page.people);
    const last = page.events.at(-1);
    if (page.events.length < EVENTS_PAGE || last === undefined) return { events: out, people };
    cursor = last.seq;
  }
}

/**
 * 发送用户消息（运行中发送即插话）：202 `{ event }`。`attachments`（`@` 资源引用）由内核以当前用户的凭据读取，
 * 作为附加文本块写入同一条消息；`files`（已 finalize 的上传附件 id）作为 image / document 引用块追加在最后。
 */
export const postMessage = (orgId: string, id: string, m: MessageInput) =>
  apiFetch<{ event: ConversationEvent }>(`${one(orgId, id)}/messages`, {
    method: "POST",
    body: JSON.stringify(messageBody(m)),
  });

/**
 * A message an older version queued (kernel `QueueItem`): not in the log until the kernel sends it
 * after a run. Nothing new is queued (run input spec 2026-11-07 D3); the web only lists leftovers.
 */
export interface QueueItem {
  id: string;
  text: string;
  files: { attachmentId: string; name: string; mediaType: string }[];
  attachments: { connectorId: string; name: string; uri: string }[];
  clientMessageId: string;
  /** The model / effort pick the message switches to when sent (null: none). */
  model: ModelRef | null;
  effort: string | null;
  createdAt: string;
  position: number;
  /** A queued skill invocation (phase D): `text` is its arguments. */
  skill?: { name: string; arguments: string; mode: "inline" | "fork" };
}

/** Why the queue paused (kernel `QueuePauseReason`; absent when not recorded). */
export type QueuePauseReason = "run_ended" | "author_cannot_send" | "skill_not_invocable";

export const listQueue = (orgId: string, id: string) =>
  apiFetch<{ items: QueueItem[]; paused: boolean; pauseReason?: QueuePauseReason }>(
    `${one(orgId, id)}/queue`,
  );

/** "Continue sending" after a pause. */
export const resumeQueue = (orgId: string, id: string) =>
  apiFetch<Record<string, never>>(`${one(orgId, id)}/queue/resume`, { method: "POST" });

/** A step's icon (kernel `ToolIcon`): a named design icon, or a catalog item's icon. */
export type ToolIcon =
  | {
      kind: "name";
      name:
        | "terminal"
        | "file-text"
        | "square-pen"
        | "search"
        | "globe"
        | "skills"
        | "agent"
        | "list-checks"
        | "connector"
        | "extension";
    }
  | { kind: "catalog"; itemId: string };

/** Display metadata of a tool (kernel `ToolInfo`). */
export interface ToolInfo {
  key: string;
  title: string | null;
  kind: "command" | "read" | "edit" | "search" | "connector" | "meta" | "task" | "tool";
  icon: ToolIcon;
  /** True exactly for the builtin tools that run in the conversation's sandbox. */
  sandbox: boolean;
  keyArgs: string[];
  /** How the tool's input is previewed while it streams (kernel `ToolSpec.inputView`), or null. */
  inputView:
    | { kind: "file_write"; path: string; content: string }
    | { kind: "file_edit"; path: string; old: string; new: string }
    | { kind: "command"; command: string; description?: string }
    | { kind: "text"; field: string }
    | null;
  /** A connector or extension tool's local name (`mcp__crm__delete` -> `delete`); else null. */
  tool: string | null;
  source:
    | { kind: "builtin" }
    | { kind: "extension"; name: string; displayName: { zh: string; en: string } }
    | { kind: "connector"; id: string; name: string }
    | { kind: "unknown" };
}

export const getToolInfo = (orgId: string, id: string, keys: readonly string[]) =>
  apiFetch<{ tools: ToolInfo[] }>(
    `${one(orgId, id)}/tools?keys=${keys.map(encodeURIComponent).join(",")}`,
  );
/** The parent conversation's sub-agents, newest first (owner only). */
export const listSubagents = (orgId: string, id: string, limit = 100) =>
  apiFetch<{ subagents: SubagentView[]; next: string | null }>(
    `${one(orgId, id)}/subagents?limit=${limit}`,
  );

/** The conversation's token usage, its sub-agents' included. */
export const getConversationUsage = (orgId: string, id: string) =>
  apiFetch<{ usage: ConversationUsage }>(`${one(orgId, id)}/usage`);

/**
 * One agent of a conversation tree (`GET …/agent-tree`, agent map spec §8): the root conversation
 * or a sub-agent at any depth. `idle`: no run is active and the latest one completed (or none ran).
 */
export interface AgentTreeNode {
  id: string;
  /** A sub-agent's dispatched description; the root's title ("" before it has one). */
  description: string;
  /** The sub-agent type; null for the root (and a sub-agent without one). */
  agentType: string | null;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" | "idle";
  model: ModelRef | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The wall time of its own runs (a running run up to now). */
  durationMs: number;
  /** The tokens of its own runs (never its descendants'). */
  tokens: number;
  toolCalls: number;
  /** The sub-agents it dispatched, oldest first. */
  children: AgentTreeNode[];
}

/** The agent tree of a root conversation (its owner only; 404 for a sub-agent conversation). */
export const getAgentTree = (orgId: string, id: string) =>
  apiFetch<{ root: AgentTreeNode }>(`${one(orgId, id)}/agent-tree`);

/** The conversation's background tasks and its sub-agents', newest first. */
export const listBackgroundTasks = (orgId: string, id: string) =>
  apiFetch<{ tasks: BackgroundTaskView[] }>(`${one(orgId, id)}/background-tasks`);

/** A person's stop: the task after it (`running` with `stopping` while the stop goes on). */
export const stopBackgroundTask = (orgId: string, id: string, taskId: string) =>
  apiFetch<{ task: BackgroundTaskView }>(
    `${one(orgId, id)}/background-tasks/${encodeURIComponent(taskId)}/stop`,
    { method: "POST" },
  );

/**
 * The end of a task's output; 409 `background_task.output_unavailable` when nothing is readable,
 * its `details[0]` saying why ({@link BackgroundTaskUnavailable}).
 */
export const readBackgroundTaskOutput = (orgId: string, id: string, taskId: string) =>
  apiFetch<BackgroundTaskOutput>(
    `${one(orgId, id)}/background-tasks/${encodeURIComponent(taskId)}/output`,
  );

/** 中止当前运行：202 `{ runId }`；没有活跃运行时内核返回 409 `run.not_active`。 */
export const abortRun = (orgId: string, id: string) =>
  apiFetch<{ runId: string }>(`${one(orgId, id)}/abort`, { method: "POST" });

/** 会话事件流的 URL（SSE，经同源代理）。 */
export const streamUrl = (orgId: string, id: string, after: number) =>
  `${one(orgId, id)}/stream?after=${after}`;

/** 工具输出存档的一页（内核按字符分页；`next` 为下一页的 offset，已到末尾为 null）。 */
export interface OutputPage {
  id: string;
  text: string;
  offset: number;
  totalChars: number;
  next: number | null;
}

/** 网页读存档时最多取的页数（每页至多 20 万字符），再多就只显示已取到的部分。 */
export const OUTPUT_MAX_PAGES = 5;

/**
 * 读工具输出存档的全文（`GET .../conversations/:id/outputs/:outputId`，逐页）：
 * 会话不可见 → `conversation.not_found`；存档不属于该会话或已过期 → `conversation.output_not_found`。
 * 超过 {@link OUTPUT_MAX_PAGES} 页时 `complete` 为 false。
 */
export async function readToolOutput(
  orgId: string,
  conversationId: string,
  outputId: string,
): Promise<{ text: string; complete: boolean }> {
  let text = "";
  let offset = 0;
  for (let page = 0; page < OUTPUT_MAX_PAGES; page++) {
    const q = offset === 0 ? "" : `?offset=${offset}`;
    const { output } = await apiFetch<{ output: OutputPage }>(
      `${one(orgId, conversationId)}/outputs/${encodeURIComponent(outputId)}${q}`,
    );
    text += output.text;
    if (output.next === null) return { text, complete: true };
    offset = output.next;
  }
  return { text, complete: false };
}

/** The size of an archived output (characters), from a one-character first page. */
export const toolOutputSize = (orgId: string, conversationId: string, outputId: string) =>
  apiFetch<{ output: OutputPage }>(
    `${one(orgId, conversationId)}/outputs/${encodeURIComponent(outputId)}?limit=1`,
  ).then((r) => r.output.totalChars);

/** A row action without a current org: AppFrame shows `shell.noCurrentOrg`. */
export class NoCurrentOrgError extends Error {
  constructor() {
    super("no current organization");
    this.name = "NoCurrentOrgError";
  }
}
