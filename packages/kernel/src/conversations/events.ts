import { posix } from "node:path";
import {
  CONTEXT_LIMITS,
  type ContentBlock,
  DOCUMENT_MEDIA_TYPES,
  type Effort,
  hasControlChars,
  IMAGE_MEDIA_TYPES,
  isAttachmentId,
  isSkillName,
  MEDIA_NAME_MAX_CHARS,
  type MediaSource,
  type ModelUsage,
  type PermissionProfile,
  type StopReason,
  validateAllowHost,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import {
  AgentDefinitionSchema,
  DisabledSkillRef,
  DisabledToolRef,
  ModelRef,
} from "../agents/definition.js";
import { ORG_ROLES } from "../orgs/roles.js";
import { coversHost } from "../sandbox/modes.js";
import type { ScheduleMarker } from "../schedules/types.js";
import {
  TOOL_VIEW_DIFF_MAX_LINES,
  TOOL_VIEW_LINE_MAX_CHARS,
  TOOL_VIEW_PATH_MAX_CHARS,
} from "../tools/view.js";

/** Code-point ordering is independent of the host locale and UTF-16 surrogate ordering. */
export function permissionCodePointCompare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0) as number);
  const right = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] as number) - (right[i] as number);
    if (difference) return difference;
  }
  return left.length - right.length;
}
const PermissionProfileSchema = z.custom<PermissionProfile>(
  (value) => value === "request-approval" || value === "approve-for-me" || value === "full-access",
);
const PermissionPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => validateSandboxPathShape(value).length === 0,
    "Expected an absolute bounded device path",
  )
  // the authority's exact spelling: no "." segments and no trailing slash, never repaired here
  .refine(
    (value) => posix.normalize(value) === value && (value === "/" || !value.endsWith("/")),
    "Expected a normalized device path",
  );
const PermissionHosts = z
  .array(
    z
      .string()
      .max(253)
      .refine(
        (value) => validateAllowHost(value).length === 0,
        "Expected a normalized authority host",
      ),
  )
  .min(1)
  .max(100)
  .refine(
    (values) =>
      values.every(
        (value, i) => i === 0 || permissionCodePointCompare(values[i - 1] as string, value) < 0,
      ),
    "Hosts must be unique and sorted by Unicode code point",
  );
const PermissionDirectories = z
  .array(PermissionPath)
  .min(1)
  .max(64)
  .refine(
    (values) =>
      values.every(
        (value, i) => i === 0 || permissionCodePointCompare(values[i - 1] as string, value) < 0,
      ),
    "Directories must be unique and sorted by Unicode code point",
  );
const PermissionRevision = z.string().min(1).max(256);
const PermissionReason = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => value.trim().length > 0);
const PermissionId = z.string().uuid();
const PermissionScopeSchema = z
  .object({
    location: z.enum(["local", "cloud"]),
    workingRoot: PermissionPath,
    filesystem: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("device") }).strict(),
      z
        .object({
          kind: z.literal("scoped"),
          readDirectories: PermissionDirectories,
          writeDirectories: PermissionDirectories,
        })
        .strict(),
    ]),
    network: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("environment") }).strict(),
      z.object({ kind: z.literal("allowlist"), hosts: PermissionHosts }).strict(),
    ]),
    outerNetwork: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("host-environment") }).strict(),
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("open-public") }).strict(),
      z.object({ kind: z.literal("allowlist"), hosts: PermissionHosts }).strict(),
    ]),
  })
  .strict();

/** Complete recorded facts, never a grant or a requested-but-unverified scope. */
export const PermissionContextV1Schema = z
  .object({
    version: z.literal(1),
    rootConversationId: PermissionId,
    profileRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    selectedProfile: PermissionProfileSchema.nullable(),
    effectiveProfile: PermissionProfileSchema.nullable(),
    execution: z.enum(["interactive", "scheduled"]),
    inherited: z.boolean(),
    deviceId: PermissionId.nullable(),
    scopeRevision: PermissionRevision.nullable(),
    authorityRevision: PermissionRevision.nullable(),
    availability: z.discriminatedUnion("state", [
      z.object({ state: z.literal("supported") }).strict(),
      z.object({ state: z.enum(["unsupported", "unprobed"]), reason: PermissionReason }).strict(),
      z
        .object({
          state: z.literal("unavailable"),
          cause: z.enum(["no-device", "actor-device-access"]),
          reason: PermissionReason,
        })
        .strict(),
    ]),
    scope: PermissionScopeSchema.nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    if ((p.profileRevision === null) !== (p.selectedProfile === null))
      reject("Profile and revision nullability must agree");
    if (p.availability.state === "unavailable") {
      if (
        p.effectiveProfile !== null ||
        p.deviceId !== null ||
        p.scopeRevision !== null ||
        p.authorityRevision !== null ||
        p.scope !== null
      )
        reject("Unavailable context must not expose device authority");
      if (p.availability.cause === "actor-device-access") {
        if (p.selectedProfile !== null || p.profileRevision !== null)
          reject("Device access refusal must redact the owner's profile");
        if (p.availability.reason !== "This run's actor cannot use the selected device")
          reject("Invalid device access reason");
      } else if (p.availability.reason !== "Choose a device to run device operations")
        reject("Invalid no-device reason");
    } else if (
      p.selectedProfile === null ||
      p.effectiveProfile === null ||
      p.profileRevision === null ||
      p.deviceId === null ||
      p.scopeRevision === null ||
      p.authorityRevision === null
    ) {
      reject("Accessible device context requires complete profile and authority identities");
    }
    if ((p.scope !== null) !== (p.availability.state === "supported"))
      reject("Only supported context carries scope");
    if (p.effectiveProfile !== null) {
      if (p.execution === "scheduled" && p.effectiveProfile !== "request-approval")
        reject("Scheduled context requires Request approval");
      if (
        p.execution === "interactive" &&
        (p.selectedProfile === "full-access"
          ? p.effectiveProfile !== "full-access" && p.effectiveProfile !== "approve-for-me"
          : p.selectedProfile !== p.effectiveProfile)
      )
        reject("Invalid effective profile transition");
    }
    const s = p.scope;
    if (!s) return;
    if (p.effectiveProfile === "full-access") {
      if (s.filesystem.kind !== "device" || s.network.kind !== "environment")
        reject("Full access requires device filesystem and environment networking");
    } else if (s.filesystem.kind !== "scoped" || s.network.kind === "environment")
      reject("Restricted profiles require scoped filesystem and restricted networking");
    if (s.filesystem.kind === "scoped") {
      const { readDirectories, writeDirectories } = s.filesystem;
      if (
        !readDirectories.includes(s.workingRoot) ||
        !writeDirectories.includes(s.workingRoot) ||
        writeDirectories.some((p) => !readDirectories.includes(p))
      )
        reject("Writable roots must be readable and both must include the working root");
      if (new Set([...readDirectories, ...writeDirectories]).size > 64)
        reject("At most 64 combined roots are allowed");
    }
    if ((s.location === "local") !== (s.outerNetwork.kind === "host-environment"))
      reject("Outer boundary must match the device location");
    if (s.location === "cloud" && s.network.kind === "allowlist") {
      if (s.outerNetwork.kind === "none")
        reject("Network hosts exceed the disabled outer boundary");
      if (s.outerNetwork.kind === "allowlist") {
        const outer = s.outerNetwork.hosts;
        if (s.network.hosts.some((host) => !outer.some((pattern) => coversHost(pattern, host))))
          reject("Network hosts exceed the applied outer allowlist");
      }
    }
  });
export type PermissionContextV1 = z.infer<typeof PermissionContextV1Schema>;

export const ManagedDevicePathsV1Schema = z
  .object({
    permissionContextVersion: z.literal(1),
    deviceId: PermissionId,
    roots: z
      .object({ workspace: PermissionPath, skills: PermissionPath, tmp: PermissionPath })
      .strict(),
    workingRoot: PermissionPath,
  })
  .strict();
export type ManagedDevicePathsV1 = z.infer<typeof ManagedDevicePathsV1Schema>;
export const PermissionContextMetaV1Schema = z
  .object({
    version: z.literal(1),
    contextSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PermissionContextMetaV1 = z.infer<typeof PermissionContextMetaV1Schema>;

/** 供应商私有数据（`ProviderOpaque`）：原样保存、只回放给同一供应商。 */
const ProviderOpaqueSchema = z.object({
  provider: z.string(),
  model: z.string(),
  data: z.unknown(),
});

/**
 * 日志里的媒体来源：只有附件引用。字节（`base64`）绝不进事件日志——日志是事实源、字节不是；
 * 构建模型请求时内核按 `attachmentId` 取字节换成 `base64`（见 {@link LogContentBlock}）。
 */
const AttachmentIdSchema = z.string().refine(isAttachmentId, "attachmentId must be a UUID");

const RefMediaSourceSchema = z.object({
  kind: z.literal("ref"),
  attachmentId: AttachmentIdSchema,
});

/**
 * Who may decide an approval, as the approval row says (display only): the assigned account
 * (`requestedFor`), else the escalation role (`approverRole`). Pages word the waiting state with it
 * ("Waiting for Alice to approve") for viewers who cannot decide.
 */
const ApproverFields = {
  requestedFor: z.string().nullable(),
  approverRole: z.enum(ORG_ROLES).nullable(),
};

/** The most hosts one network ask (and one `network_blocked` event) lists. */
export const NETWORK_ASK_MAX_HOSTS = 20;
/** The longest host name a network ask or `network_blocked` event carries. */
export const NETWORK_HOST_MAX_CHARS = 255;
/** The most refs one git push ask (and its `approval_requested.git`) lists. */
export const GIT_ASK_MAX_REFS = 20;
/** The longest ref name a git push ask carries. */
export const GIT_REF_MAX_CHARS = 255;
/**
 * The longest `<owner>/<repo>` a git push ask carries (GitHub allows 39 + 100 characters): the
 * grant key `git:push:<owner>/<repo>` must fit an org's `forbiddenTools` entry (200 characters).
 */
export const GIT_REPO_MAX_CHARS = 191;
/** The longest deny reason (characters): the decision route's limit and `approval_decided.reason`'s. */
export const APPROVAL_DENY_REASON_MAX_CHARS = 500;
/** The most characters a command ask's command / reason carries (display only). */
export const COMMAND_ASK_TEXT_MAX_CHARS = 2000;
/**
 * The longest command a `command` ask holds in full: the person's approval binds the whole text,
 * so a longer command is refused rather than clipped (`Bash` accepts an unbounded `command`).
 */
export const COMMAND_ASK_MAX_CHARS = 32 * 1024;

/**
 * A command review's decision on a tool call (auto mode spec §5.4): display only, never model-visible
 * beyond the result's own text. `by` says who decided — the rule table, the classifier, or the person
 * through a `command` approval; `scope` is the person's choice (`once` / `session`);
 * `commandHash` is the SHA-256 of the command text the approval holds in full, so an audit can
 * match a record to what ran.
 */
export const PermissionExpansionSchema = z
  .object({
    readDirectories: z.array(z.string().max(4096)).max(64),
    writeDirectories: z.array(z.string().max(4096)).max(64),
    hosts: z.array(z.string().max(253)).max(100),
  })
  .strict();
export const PermissionCallBindingSchema = z
  .object({
    orgId: z.string(),
    rootConversationId: z.string(),
    conversationId: z.string(),
    deviceId: z.string(),
    accountId: z.string(),
    runId: z.string(),
    callId: z.string(),
    toolKey: z.string(),
    specHash: z.string(),
    callInputHash: z.string(),
    resolvedInputHash: z.string(),
    profile: z.enum(["request-approval", "approve-for-me", "full-access"]),
    profileRevision: z.number().int().nonnegative(),
    scopeRevision: z.string(),
    authorityRevision: z.string(),
  })
  .strict();
export const ReviewRecordSchema = z
  .object({
    profile: z.enum(["request-approval", "approve-for-me", "full-access"]).optional(),
    profileRevision: z.number().int().nonnegative().optional(),
    scopeRevision: z.string().optional(),
    decisionSource: z
      .enum(["scope", "human", "review-model", "full-access", "task-grant"])
      .optional(),
    decision: z.enum(["allow", "deny"]),
    by: z.enum(["rule", "classifier", "person"]),
    rule: z.string().nullable(),
    reason: z.string(),
    scope: z.enum(["once", "session"]).optional(),
    commandHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/** The display-only `approval_requested.command` facts of a `command` ask (auto mode spec §5.4). */
export const CommandAskSchema = z
  .object({
    permissionScope: PermissionExpansionSchema.optional(),
    targetPath: z.string().max(4096).optional(),
    candidateHash: z.string().optional(),
    /** A shell command or a file write. */
    kind: z.enum(["command", "write"]),
    /** The command text, or the tool key of the write. */
    command: z.string().max(COMMAND_ASK_TEXT_MAX_CHARS),
    /** A file write's target path. */
    path: z.string().max(4096).optional(),
    rule: z.string().max(200).nullable(),
    reason: z.string().max(COMMAND_ASK_TEXT_MAX_CHARS),
    mode: z.enum(["auto", "sandbox"]),
  })
  .strict();

/** A command review record as the log carries it (the pipeline writes {@link ReviewRecordSchema}). */
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
/** A command ask's display facts, as `approval_requested.command` carries them. */
export type CommandAsk = z.infer<typeof CommandAskSchema>;
/** 一条 `media_excluded` 事件最多的附件数。 */
export const MEDIA_EXCLUDED_MAX_IDS = 50;
/** 一份 `skills_catalog` 快照最多的技能数（组织技能引用上限 100，余量给 agent 自己的技能）。 */
export const SKILLS_CATALOG_MAX = 1000;

/** 媒体块的名字：与 plugin-sdk `validateMediaBlock` 同规则（≤255 字符、不含控制字符）。 */
const MediaNameSchema = z
  .string()
  .max(MEDIA_NAME_MAX_CHARS)
  .refine((s) => !hasControlChars(s), "name must not contain control characters");

const ArtifactNameSchema = MediaNameSchema.min(1);

/** 产物名（`artifact_created.name`）是否合法：与日志 schema 同一规则（非空、≤255、不含控制字符）。 */
export const isValidArtifactName = (name: string): boolean =>
  ArtifactNameSchema.safeParse(name).success;

/**
 * A `file` block's media type: any non-empty `type/subtype` with no whitespace or control
 * characters, the rule of plugin-sdk's `validateMediaBlock`.
 */
const FileMediaTypeSchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "mediaType must be a non-empty type/subtype string")
  .refine((s) => !hasControlChars(s), "mediaType must not contain control characters");

/** `size` on a media block: display metadata (the UI chip, the reference line), never sent. */
const MediaBlockSizeSchema = z.number().int().nonnegative().optional();

/**
 * A content block as the log carries it: plugin-sdk's `ContentBlock`, but the source of an image,
 * document or file block may only be a `ref` (blocks written with a `base64` source are rejected).
 */
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), opaque: ProviderOpaqueSchema.optional() }),
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    opaque: ProviderOpaqueSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    opaque: ProviderOpaqueSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("image"),
    mediaType: z.enum(IMAGE_MEDIA_TYPES),
    source: RefMediaSourceSchema,
    name: MediaNameSchema.optional(),
    size: MediaBlockSizeSchema,
  }),
  z.object({
    type: z.literal("document"),
    mediaType: z.enum(DOCUMENT_MEDIA_TYPES),
    source: RefMediaSourceSchema,
    name: MediaNameSchema.optional(),
    size: MediaBlockSizeSchema,
  }),
  z.object({
    type: z.literal("file"),
    mediaType: FileMediaTypeSchema,
    source: RefMediaSourceSchema,
    name: MediaNameSchema.optional(),
    size: MediaBlockSizeSchema,
  }),
]);

type MediaBlock = Extract<ContentBlock, { type: "image" | "document" | "file" }>;
/**
 * 日志形状的内容块：与 plugin-sdk 的 `ContentBlock` 相同，只是媒体块的 `source` 收窄为 `ref`。
 * 它是 `ContentBlock` 的子类型，所以从日志读出的块可直接当 `ContentBlock` 用（请求构建时再解析 ref）。
 */
export type LogContentBlock =
  | Exclude<ContentBlock, MediaBlock>
  | (MediaBlock extends infer B
      ? B extends MediaBlock
        ? Omit<B, "source"> & { source: Extract<MediaSource, { kind: "ref" }> }
        : never
      : never);

const STOP_REASONS = ["end_turn", "tool_use", "max_tokens", "refusal", "other"] as const;
/** The standard effort values (plugin-sdk `EFFORT_VALUES`, as a tuple for zod). */
const EFFORT_ENUM = ["low", "medium", "high", "xhigh", "max"] as const;

const seqNo = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

/**
 * The state of a file a `Read` / `Write` / `Edit` saw or left (display only, but the kernel reads it
 * back from the log to decide read-before-write): the full normalized path, the file's full size and
 * the sha256 of the bytes handled (the first bytes only for a file over `Read`'s byte limit).
 */
const FileStateViewSchema = z.object({
  path: z.string().max(4096),
  size: count,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Structured view of a builtin tool's result (UI refresh B, spec §5.5 / §5.9): display only, like
 * `display`. `command`: `Bash` (the model's `description`, the exit code, null when the
 * command was stopped, and whether it timed out; a non-zero exit is information, not a failure:
 * the web shows "Failed" only for a timeout or a stopped command, as `isError` does);
 * `edit`: `Edit` / `Write` (a capped line diff); `read`: `Read` (the line range shown);
 * `guard`: `Edit` / `Write` refused by the read-before-write check (`not_read`: the file was never
 * read in the conversation, `modified`: it changed since). The result stays `isError: true` for
 * the model; the web shows the refusal as a neutral outcome, not a failure.
 * `not_loaded`: a call to a tool the catalog holds but the step's request did not carry
 * (ToolSearch mode, spec 5.5): expected behaviour, the model is told to load it first. The result
 * stays `isError: true` for the model; the web shows it as a neutral outcome too.
 */
export const ToolViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    description: z.string().max(120).optional(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
  }),
  z.object({
    kind: z.literal("edit"),
    path: z.string().max(TOOL_VIEW_PATH_MAX_CHARS),
    created: z.boolean(),
    added: count,
    removed: count,
    truncated: z.boolean(),
    file: FileStateViewSchema.optional(),
    hunks: z
      .array(
        z.object({
          oldStart: count,
          newStart: count,
          lines: z
            .array(
              z.object({
                kind: z.enum(["ctx", "add", "del"]),
                text: z.string().max(TOOL_VIEW_LINE_MAX_CHARS),
              }),
            )
            .max(TOOL_VIEW_DIFF_MAX_LINES),
        }),
      )
      .max(TOOL_VIEW_DIFF_MAX_LINES),
  }),
  z.object({
    kind: z.literal("read"),
    path: z.string().max(TOOL_VIEW_PATH_MAX_CHARS),
    fromLine: count.optional(),
    toLine: count.optional(),
    file: FileStateViewSchema.optional(),
  }),
  z.object({
    kind: z.literal("guard"),
    reason: z.enum(["not_read", "modified"]),
  }),
  z.object({ kind: z.literal("not_loaded") }),
]);
export type ToolView = z.infer<typeof ToolViewSchema>;

const ModelUsageShape = {
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  /** Images produced (an image generation call). */
  outputImages: count.exactOptional(),
};

/**
 * How a sub-agent's run ended (`subagent_finished`, a `subagent_delivery` finish). `timed_out`:
 * stopped by the parent's sub-agents wait timeout (`run_aborted.detail`).
 */
export const SubagentFinishStatusSchema = z.enum([
  "completed",
  "max_steps",
  "max_duration",
  "budget",
  "aborted",
  "timed_out",
  "failed",
]);

/** 双语或纯文本（plugin-sdk `InputForm` 的文案字段）。 */
const FormTextSchema = z.union([z.string(), z.object({ zh: z.string(), en: z.string() })]);

/** 交互表单（plugin-sdk 的 `InputForm`；字段 schema 已由 `validateInputForm` 校验过，这里只记形状）。 */
const InputFormSchema = z.object({
  title: FormTextSchema,
  /** 需要用户在浏览器里打开的外部页面（MCP URL 模式的 elicitation）。较早的事件没有。 */
  url: z.string().optional(),
  fields: z.array(
    z.object({
      key: z.string(),
      label: FormTextSchema,
      description: FormTextSchema.optional(),
      schema: z.record(z.string(), z.unknown()),
      multiSelect: z.boolean().optional(),
      allowOther: z.boolean().optional(),
      required: z.boolean().optional(),
    }),
  ),
});

/** 表单答案（plugin-sdk 的 `FormAnswer`）。 */
const FormAnswerSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);

/** The languages a run context names (the org `locale` values). */
export const RUN_CONTEXT_LOCALES = ["zh", "en"] as const;

/** `user_message.sender` (run context spec §3.2). */
export const MessageSenderSchema = z.object({
  name: z.string().min(1).max(80),
  /** Absent = no membership. */
  role: z.enum(ORG_ROLES).optional(),
  /** An IM sender served as the org's anonymous guest; `name` is the IM profile name. */
  anonymous: z.literal(true).optional(),
});

/** `user_message.schedule` (scheduled tasks spec §6): the `ScheduleMarker` shape. */
export const ScheduleMarkerSchema = z.object({
  taskId: z.string(),
  taskRunId: z.string(),
  scheduledFor: z.string(),
  trial: z.boolean(),
  taskName: z.string(),
  localTime: z.string(),
});

/** `run_context` (run context spec §3.1): every field optional, a later event holds changes only. */
export const RunContextSchema = z.object({
  /** The agent itself: its name and its versioned description collapsed to one line. */
  agent: z
    .object({ name: z.string().min(1).max(130), description: z.string().max(200).optional() })
    .optional(),
  org: z.object({ name: z.string().min(1).max(200) }).optional(),
  /** Today in `timeZone`, `YYYY-MM-DD`. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** IANA name. */
  timeZone: z.string().min(1).max(64).optional(),
  /** The language of the person whose message started the run. */
  locale: z.enum(RUN_CONTEXT_LOCALES).optional(),
  /** Sub-agents only: who dispatched this conversation. */
  dispatchedBy: z
    .object({ agent: z.string().min(1).max(130), person: z.string().min(1).max(80) })
    .optional(),
  /**
   * The attribution a run's requests carry for git commits and pull requests it creates (spec
   * 2026-11-14-agent-attribution): the effective values fixed at run start (platform defaults or
   * the agent's override), so request building never reads config or the database. Absent when it
   * did not change (as every field here). An empty `commit` / `pr` turns that line off; `sessionUrl` is the resolved conversation
   * link, or null.
   */
  attribution: z
    .object({
      commit: z.string().max(500),
      pr: z.string().max(500),
      sessionUrl: z.string().max(2048).nullable(),
    })
    .optional(),
});

const ev = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

/**
 * The most UTF-8 bytes a `plugin_context` event's text may hold (memory spec §6.1): the providers'
 * limit, so the log takes every text a provider may return.
 */
export const PLUGIN_CONTEXT_MAX_BYTES: number = CONTEXT_LIMITS.maxBytes;

/**
 * `plugin_context` (memory spec §6.1): the text a `context@1` provider added at a run start. Empty
 * text means the provider has nothing (any more); `hash` is the sha256 (hex) of `text`.
 */
export const PluginContextSchema = z.object({
  plugin: z.string().min(1).max(64),
  text: z.string().refine((t) => Buffer.byteLength(t, "utf8") <= PLUGIN_CONTEXT_MAX_BYTES, {
    message: `at most ${PLUGIN_CONTEXT_MAX_BYTES} UTF-8 bytes`,
  }),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * 会话事件（`type` + `payload`）的判别联合。事件日志只追加，写入前用它校验 payload；
 * 读出时按写入时的形状原样返回。
 */
export const ConversationEventSchema = z.discriminatedUnion("type", [
  ev("permission_context", PermissionContextV1Schema),
  ev(
    "permission_reviewed",
    z.object({
      binding: PermissionCallBindingSchema,
      permissionScope: PermissionExpansionSchema,
      targetPath: z.string().max(4096).optional(),
      scopeKind: z.literal("directories-and-hosts"),
      candidateHash: z.string(),
      outcome: z.enum(["allow", "ask", "deny"]),
      reason: z.string(),
      decisionSource: z.literal("review-model"),
    }),
  ),
  ev(
    "permission_profile_changed",
    z.object({
      oldProfile: z.enum(["request-approval", "approve-for-me", "full-access"]),
      newProfile: z.enum(["request-approval", "approve-for-me", "full-access"]),
      actorAccountId: z.string().nullable(),
      reason: z.enum(["user", "authority-changed"]).optional(),
      deviceId: z.string().nullable(),
      scopeRevision: z.string().nullable(),
      revision: z.number().int().nonnegative(),
    }),
  ),
  ev(
    "user_message",
    z.object({
      content: z.array(ContentBlockSchema),
      /**
       * `@` 资源引用的附件元数据：第 i 个附件的正文是 `content[i + 1]`（`content[0]` 是用户输入的文本）。
       * 界面据此把附件显示为条目而不是正文。较早的事件没有。`appId` / `appName` 是连接器的 id 与名称：
       * 「应用」改名「连接器」后字段名不变（D17 / C27：日志确定性）。
       */
      attachments: z
        .array(
          z.object({ appId: z.string(), appName: z.string(), uri: z.string(), name: z.string() }),
        )
        .optional(),
      authorAccountId: z.string(),
      /**
       * Who wrote the message, at send time (run context spec §3.2): display name and org role
       * only (never email or ids). Absent on a sub-agent's task or `SendMessage` message. Model-visible only through the sender line, written when the sender changes
       * (`senderLines`, runtime/context/run-context.ts).
       */
      sender: MessageSenderSchema.optional(),
      /**
       * The sender's time zone (IANA) and language at send time (run context spec §3.4): an IM
       * platform's values, the account setting, the browser's, the person's latest web language,
       * the org defaults (`readMessageContext`). Not model-visible: the next run's `run_context`
       * is derived from them.
       */
      timeZone: z.string().min(1).max(64).optional(),
      locale: z.enum(RUN_CONTEXT_LOCALES).optional(),
      clientMessageId: z.string().optional(),
      /**
       * A retry after a failed run (UI refresh B): the seq of the message it repeats. Display only
       * (the page folds it into the failed divider); the model sees the message itself.
       */
      retryOf: seqNo.optional(),
      /**
       * A skill invocation: which skill version was rendered into `content[0]`, with the
       * arguments (trimmed). Not model-visible (the rendered text is). `name` is the skill's bare
       * name, `plugin` its catalog item; `agentType` is set for `mode: "fork"`.
       * - A person's (`/name args`, phase D spec §4.3): the arguments as typed; the web renders
       *   the chip and the arguments from it.
       * - `template: true`: written by the kernel at a template sub-agent's dispatch, after its
       *   task, for each of the template's skills (`runtime/subagents/template-skills.ts`;
       *   `mode: "inline"`, no arguments, `authorAccountId` the person whose run dispatched it);
       *   nobody typed it: the web shows it with the task, never as a person's message.
       */
      skill: z
        .object({
          id: z.string(),
          version: z.number().int(),
          source: z.string(),
          name: z.string(),
          plugin: z.string().optional(),
          arguments: z.string(),
          mode: z.enum(["inline", "fork"]),
          agentType: z.string().optional(),
          template: z.literal(true).optional(),
        })
        .optional(),
      /**
       * The kernel's notice, written at a template sub-agent's dispatch in place of a template
       * skill's invocation, that the skill (`name`) could not be read
       * (`runtime/subagents/template-skills.ts`). Display only (the model sees the text): nobody
       * typed it, so the web shows it with the task and eval case titles skip it, as a `template`
       * invocation. It carries no `skill` record: nothing was rendered from a version.
       */
      templateSkillNotice: z.object({ name: z.string() }).optional(),
      /**
       * A scheduled task's message (scheduled tasks spec §6, §12): which task and tick posted it.
       * Not model-visible as such: request building renders only `taskName` and `localTime`, fixed
       * here at write time, as the header `[Scheduled task "<name>", run for <local time>]`
       * (`scheduleHeader`). The run this message triggers is unattended
       * (`runs.scheduled_task_run_id`).
       */
      schedule: ScheduleMarkerSchema.optional(),
      /**
       * Set on a sub-agent's task message (phase C, spec §6.3): which parent call dispatched it.
       * Not model-visible; the web renders the message as the task block.
       */
      dispatch: z
        .object({
          parentConversationId: z.string(),
          parentRunId: z.string(),
          callId: z.string(),
          /**
           * `message`: sent by the parent agent with `SendMessage` (agent map spec §5.1); absent or
           * `task`: the task of a dispatch or follow-up.
           */
          kind: z.enum(["task", "message"]).optional(),
          /**
           * A follow-up (`resume`, final review I1): the frozen and the current version's
           * turned-off tools and skills together (`narrowFollowUp`); the child's run uses these
           * instead of the frozen ones. Absent on a first dispatch.
           */
          narrowed: z
            .object({
              disabledTools: z.array(DisabledToolRef),
              disabledSkills: z.array(DisabledSkillRef),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
  /**
   * The person switched the conversation's model or effort (UI refresh B), written just before the
   * message that carried the switch; or the kernel fell back to the agent's model because the
   * switched-to one no longer resolves (`reason: "unavailable"`, `byAccountId: null`, written by
   * that run before its `run_started`). Applies from the next run that starts (`selectionAt`). Not
   * model-visible itself: its effect is recorded per request in `model_call` (model and params).
   */
  ev(
    "model_switched",
    z.object({
      /** null = back to the agent's model. */
      model: ModelRef.nullable(),
      /** null = the agent's saved effort or the model's default. */
      effort: z.enum(EFFORT_ENUM).nullable(),
      /** null = the kernel (fallback). */
      byAccountId: z.string().nullable(),
      reason: z.enum(["user", "unavailable"]),
    }),
  ),
  ev(
    "run_started",
    z.object({
      agentVersion: z.number().int().positive(),
      model: ModelRef,
      triggerAccountId: z.string(),
      /**
       * What started the run (display only): absent or `message` = a person's message (or a
       * sub-agent's task), `background_task` = a finished background task woke the conversation
       * (spec 2026-11-05-background-bash-design §3), `subagent` = a sub-agent's delivery woke it
       * (agent map spec §5.3), `schedule` = a scheduled task's message (scheduled tasks spec §6),
       * `compact` = a manual compaction run (context compaction spec §4.7): no message, no model
       * step, only the summary and its usage.
       */
      trigger: z.enum(["message", "background_task", "subagent", "schedule", "compact"]).optional(),
      /**
       * A wake run's boundary: the seq of the finish or delivery that woke it (full-run replay
       * seeds from it).
       */
      triggerSeq: seqNo.optional(),
    }),
  ),
  ev(
    "model_call",
    z.object({
      step: count,
      attempt: count,
      provider: z.string(),
      model: z.string(),
      fallback: z.boolean(),
      request: z
        .object({
          fromSeq: seqNo,
          toSeq: seqNo,
          summarySeq: seqNo.nullable(),
          systemHash: z.string(),
          permissionContext: PermissionContextMetaV1Schema.optional(),
          reminderSeqs: z.array(seqNo),
          /**
           * The request's output cap: `min(model cap, maxOutputTokens knob ??
           * runtime.maxOutputTokens)`, clamped by the hard fit guard.
           */
          maxOutputTokens: count,
          /**
           * The request's model parameters (`ModelRequest.params`): the agent's saved parameters
           * sanitized against the model's declarations (defaults filled in), from `modelParams` for
           * the agent's model and `fallbackParams` for a fallback attempt.
           */
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          /** Parameter keys sanitizing dropped (undeclared or no longer valid, e.g. after a plugin upgrade); absent when none were dropped. */
          droppedParams: z.array(z.string()).optional(),
          /**
           * The input token estimate (uncalibrated) when the request went out. With the later
           * `usage.inputTokens` it feeds the next `calibrate`. The runtime always writes it; calls
           * logged before it was recorded lack it, and no value would stand in for them (a made-up
           * estimate would skew the calibration), so it stays optional and such a call calibrates
           * nothing.
           */
          estimatedInputTokens: count.optional(),
          /**
           * The largest absorbable event seq the loop had taken in when the request went out (R31):
           * absorbable events with a larger seq are not in this request (a later step takes them in
           * or they start the next run). Reconstruction places and leaves out messages by it.
           */
          absorbedUpToSeq: seqNo,
          /**
           * The tools the request carried, in sending order (sorted by key without ToolSearch; with
           * it, the builtin tools sorted by key, then the loaded tools in first-load order), with
           * their definition fingerprints (`ResolvedTool.specHash`). Empty when the model has no
           * tool support (see `toolsOmitted`).
           */
          tools: z.array(z.object({ key: z.string(), specHash: z.string() })),
          /**
           * The kernel left this step's tools out because the model has no tool support
           * (`capabilities.tools` false while the step had tools): `tools` is empty and says nothing
           * about the step's resolved set. Absent when the request carried the step's tools.
           */
          toolsOmitted: z.literal(true).optional(),
          /**
           * With ToolSearch on, the tools of the catalog in the system's second block (sorted by
           * key) with their definition fingerprints; the definitions are in `capybara.tool_specs`
           * too, so the catalog text can be rebuilt from them. Absent without ToolSearch.
           */
          catalog: z.array(z.object({ key: z.string(), specHash: z.string() })).optional(),
          /**
           * The request's `toolChoice`: `"none"` on the wrap-up call (tools carried as usual, but
           * none may be called); absent on ordinary steps (the model decides). The definitions
           * themselves are in `capybara.tool_specs` by specHash.
           */
          toolChoice: z.enum(["auto", "none"]).optional(),
          /**
           * What became of each attachment in the request (Ruling M8, in first-seen order, one
           * entry per attachment): bytes sent (`bytes`, with the etag at finalize), inline text, a
           * reference line only (`reference`: a `file` block, or text over the inline cap), a
           * placeholder for an unsupported kind, left out for the request's media budget
           * (`omitted`), too many images (`too_many_images`), one over the provider's limit
           * (`too_large`), no longer available, too many PDF pages, or excluded by
           * `media_excluded`. Absent without media; written together with `mediaBudgetBytes`.
           */
          media: z
            .array(
              z.object({
                attachmentId: AttachmentIdSchema,
                outcome: z.enum([
                  "bytes",
                  "inline",
                  "reference",
                  "placeholder_unsupported",
                  "omitted",
                  "too_many_images",
                  "too_large",
                  "unavailable",
                  "too_many_pages",
                  "excluded",
                ]),
                etag: z.string().max(1024).optional(),
              }),
            )
            .optional(),
          /**
           * The request's media byte budget (`attachments.requestMediaBytes`, see planMedia):
           * written only when the request has media (together with `media`); reconstruction uses
           * it to repeat the same omissions.
           */
          mediaBudgetBytes: count.optional(),
          /**
           * The hard fit guard's plan (context compaction spec §4.3): indexes into the assembled
           * request's message list that were dropped, and text / tool_result blocks replaced by the
           * truncation note. `assembleModelRequest` applies it (the runtime `buildRequest` calls it,
           * and `evals/reconstruct` calls it directly), so the request replays byte-for-byte; absent
           * when the request fit (and in older recordings). A candidate model with another window
           * recomputes it and reports `context_fit`.
           */
          fit: z
            .object({
              droppedMessageIndexes: z.array(count),
              truncated: z.array(z.object({ messageIndex: count, block: count, note: z.string() })),
            })
            .optional(),
        })
        .refine((r) => (r.media === undefined) === (r.mediaBudgetBytes === undefined), {
          message: "media and mediaBudgetBytes are recorded together",
        }),
    }),
  ),
  ev(
    "assistant_message",
    z.object({
      step: count,
      content: z.array(ContentBlockSchema),
      stopReason: z.enum([...STOP_REASONS, "aborted"]),
    }),
  ),
  /**
   * Usage of one model call. Absent `purpose` = the step's call (written with its
   * `assistant_message`); `compaction` = the compaction call before the step (I-1: billed and
   * reported, but no step consumer may pair it with the step's `model_call`); `title` = the
   * conversation title call (UI refresh B: no run, `step` 0, not model-visible, billed and reported);
   * `web_fetch` = a `WebFetch` extraction call (web tools spec §5: the tool call's run and step,
   * `callId` = the call; not model-visible, billed and reported, counted on a sub-agent's parent);
   * `review` = the command-review classifier's call (auto mode spec §5.3: not model-visible, billed
   * and reported, `callId` = the reviewed tool call); `image` = a `GenerateImage` call (image
   * generation spec §7: the tool call's run and step, `callId` = the call, `outputImages` = the
   * images produced; not model-visible, billed and reported, counted on a sub-agent's parent);
   * `suggestion` = the prompt suggestion call after a completed run (prompt suggestions spec §7: no
   * run, `step` 0, one per run, not model-visible, billed and reported).
   */
  ev(
    "usage",
    z.object({
      step: count,
      provider: z.string(),
      model: z.string(),
      ...ModelUsageShape,
      purpose: z
        .enum(["compaction", "title", "web_fetch", "review", "image", "suggestion"])
        .optional(),
      /**
       * The chunk a chunked compaction call summarised (1-based), with the number of calls the
       * compaction attempted (the full chunk count on a completed one; on a failed or hook-denied
       * run only the calls that were made). Absent on a single-call compaction.
       */
      chunk: count.optional(),
      chunks: count.optional(),
      /** The tool call a `web_fetch`, `review` or `image` usage belongs to. */
      callId: z.string().optional(),
    }),
  ),
  ev("reminder", z.object({ step: count, text: z.string() })),
  /**
   * Who the agent is and the facts of the day (run context spec §3.1), written at run start
   * (`RunContextService.record`): the conversation's first one holds every field that applies, a
   * later one only the fields that changed. **Model-visible**: rendered at its position as a
   * system message (`runContextText`); a summary covering it restores the current values.
   */
  ev("run_context", RunContextSchema),
  /**
   * Text a `context@1` provider added at a run start (memory spec §6.1), written only when its
   * hash differs from the plugin's previous one in the conversation. **Model-visible**: rendered
   * at its position as a system message (`pluginContextText`, nothing for empty text); a summary
   * covering it is followed by the latest non-empty one per plugin again.
   */
  ev("plugin_context", PluginContextSchema),
  /**
   * The step's resolved tool set differs from the one the conversation's previous model request
   * offered (`toolSetChange`): tool names as the model sees them, sorted. Written before that
   * step's request, never before a conversation's first one. **Model-visible**: rendered at its
   * position as a system message (`toolsChangedText`); dropped once a summary covers it.
   */
  ev(
    "tools_changed",
    z.object({ step: count, added: z.array(z.string()), removed: z.array(z.string()) }),
  ),
  /**
   * The directories of the instance a sandbox tool call entered and the device's sandbox level
   * (environments spec §13.1; sandbox dev tiers spec §11.5: `tier`, `isolation`, and when they
   * apply `network: "none"`, a local device's `localhost` / `unixSockets` and `unattended`; all
   * absent on events recorded before tiers). Written on a conversation's first sandbox call and whenever
   * they change, before that call's result. **Model-visible**: rendered at its position as a
   * system message (`devicePathsText`); a summary covering it is followed by the latest one again.
   */
  ev(
    "device_paths",
    z.union([
      ManagedDevicePathsV1Schema,
      z.object({
        permissionContextVersion: z.never().optional(),
        roots: z.object({
          workspace: z.string().min(1).max(4096),
          skills: z.string().min(1).max(4096),
          tmp: z.string().min(1).max(4096),
        }),
        tier: z.enum(["strict", "dev", "open"]).optional(),
        isolation: z.enum(["sandbox", "none"]).optional(),
        /** The current network (`none` on events recorded before auto mode). */
        network: z
          .union([
            z.literal("none"),
            z.object({
              kind: z.enum(["open-public", "allowlist"]),
              hosts: z.array(z.string()),
            }),
          ])
          .optional(),
        localhost: z.enum(["on", "off-proxy-detected", "off"]).optional(),
        unixSockets: z.enum(["roots", "all-masked", "off"]).optional(),
        unattended: z.literal(true).optional(),
        /** Auto mode: the mode and its ceiling, and whether the device is a connected machine. */
        mode: z.enum(["auto", "sandbox"]).optional(),
        allowedMode: z.enum(["auto", "sandbox"]).optional(),
        local: z.boolean().optional(),
      }),
    ]),
  ),
  /**
   * The project a bound conversation's run read at its start (project root spec §4.4): the
   * project's name and root, its `AGENTS.md` text, and per skill its name, description and digest;
   * or, for a project the run cannot use, why (`unavailable`). The payload holds everything the
   * event renders, so the request is reconstructable from the log. A run writes it before its first
   * model call when it differs from the conversation's latest one; within a run the snapshot is
   * fixed, so the request stays append-only. **Model-visible**: rendered at its position as a
   * system message, after the agent's own instructions (`project root` spec §4.5); a summary
   * covering it is followed by the latest one again. A new event type's new content needs no
   * `DriftReason`.
   */
  ev(
    "project_root",
    z
      .object({
        /** The project's name, as the conversation's binding resolved it. */
        project: z.string().min(1).max(255),
        /** Its root on the device, the run's working directory. */
        root: z.string().min(1).max(4096),
        /**
         * The project's `AGENTS.md` as read at run start, cut at 64 KiB by the reader (the visible
         * marker is part of that cap). Absent when the project has none (no reason, no notice:
         * spec §4.7) or is unavailable.
         */
        agentsMd: z.string().optional(),
        /** `agentsMd` ends at the reader's cap and carries the marker. Absent: not cut. */
        agentsMdTruncated: z.literal(true).optional(),
        /**
         * The run cannot use the project: its root is `gone`, `outside_mode` (the device's current
         * mode cannot read it), `unreadable`, the device offers no projects (`unsupported`), or the
         * device no longer keeps the bound name and path (`removed`); `message` says so in English
         * for the model. Set alone: no `agentsMd`, no skills.
         */
        unavailable: z
          .object({
            reason: z.enum(["gone", "outside_mode", "unreadable", "unsupported", "removed"]),
            message: z.string().min(1).max(500),
          })
          .strict()
          .optional(),
        /**
         * The project's `.agents/skills/*` SKILL.md files: name, description and a digest of the
         * file. Bodies are never recorded (`Skill` reads one on demand, and its result is a
         * `tool_result`). Empty for a project without skills; the reader keeps the first 100.
         */
        skills: z
          .array(
            z.object({
              name: z.string().refine(isSkillName, "invalid skill name"),
              description: z.string().max(4096),
              digest: z.string().min(1).max(128),
            }),
          )
          .max(SKILLS_CATALOG_MAX)
          .default([]),
        /** The project has more skill directories than `skills` was read from. Absent: all read. */
        skillsTruncated: z.literal(true).optional(),
      })
      .strict()
      .superRefine((p, ctx) => {
        if (p.unavailable === undefined) return;
        if (
          p.agentsMd !== undefined ||
          p.agentsMdTruncated !== undefined ||
          p.skillsTruncated !== undefined ||
          p.skills.length > 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["unavailable"],
            message: "an unavailable project carries no AGENTS.md and no skills",
          });
        }
      }),
  ),
  /** 工具调用开始执行之前写入（续跑时「有开始无结果」的调用记为结果未知，不再执行）。 */
  ev(
    "tool_call_started",
    z.object({
      step: count,
      callId: z.string(),
      toolKey: z.string(),
      specHash: z.string(),
      permissionInput: z
        .object({ callInputHash: z.string(), resolvedInputHash: z.string() })
        .optional(),
    }),
  ),
  /**
   * 工具调用的结果（模型看到的文本）。构建请求时还原为紧随该步 assistant 消息的 user 消息中的
   * `tool_result` 块。`outputId`：超长结果转存后的存档 id；`contentTypes`：结果里出现的内容类型。
   */
  ev(
    "tool_result",
    z.object({
      step: count,
      callId: z.string(),
      toolKey: z.string(),
      content: z.string(),
      isError: z.boolean(),
      outputId: z.string().optional(),
      contentTypes: z.array(z.string()).optional(),
      /**
       * The command review's decision on the call (auto mode spec §5.4): display only (request
       * building reads only `callId` / `content` / `isError`, so replays never re-review). `by`
       * says who decided: the rule table, the classifier, or the person through a `command` ask.
       */
      review: ReviewRecordSchema.optional(),
      /**
       * `ToolSearch` 本次加载的工具 key（没有匹配时不写）。已加载集合 = 会话中全部 tool_result 的
       * `loadedTools` 并集（含已被摘要覆盖的部分），构建请求时由日志还原，不放进程内存。
       */
      loadedTools: z.array(z.string()).optional(),
      /**
       * 工具给的一句话说明（`ToolResult.display`，中英文），只给界面显示：不进模型请求（重建请求只用
       * callId / content / isError），也不进压缩记录。插件 / 内置工具给出且通过 `validateToolDisplay` 时才写。
       */
      display: z.object({ summary: z.object({ zh: z.string(), en: z.string() }) }).optional(),
      /** Structured view ({@link ToolViewSchema}); builtins only, display only, not in compaction. */
      view: ToolViewSchema.optional(),
      /**
       * An inline card under the call (`ToolResult.card`, UI refresh B): an `inline` ui contribution
       * of the extension that ran the tool. Display only: never in the model request or compaction.
       */
      card: z
        .object({
          plugin: z.string().min(1).max(100),
          view: z.string().min(1).max(100),
          key: z.string().min(1).max(200).optional(),
        })
        .optional(),
    }),
  ),
  /**
   * 工具调用时发现发起人尚未连接个人凭据的连接器：界面据此显示连接卡片（不进模型请求；模型看到的是
   * 同一调用的 tool_result 错误说明）。组织凭据缺失不写此事件。`appId` / `appName` 是连接器的 id 与名称，
   * 改名后字段名不变（D17 / C27）。
   */
  ev(
    "connection_required",
    z.object({ step: count, callId: z.string(), appId: z.string(), appName: z.string() }),
  ),
  /**
   * 工具调用需要人审批（策略为 `ask`）：审批记录已建，run 暂停等待处理。界面据此显示审批卡片
   * （不进模型请求；该调用的结果在审批处理后写入）。
   */
  ev(
    "approval_requested",
    z.object({
      step: count,
      callId: z.string(),
      approvalId: z.string(),
      toolKey: z.string(),
      expiresAt: z.string(),
      /** Which rule asked a tool approval (UI refresh B; display only; absent on the other asks). */
      policy: z.enum(["agent", "connector", "default", "role", "org", "fixed"]).optional(),
      /**
       * A network ask (network ask-to-allow spec §6.1): the hosts the device owner is asked to
       * allow. Display only, never model-visible: the model sees the call's `tool_result` only.
       */
      network: z
        .object({
          hosts: z
            .array(z.string().min(1).max(NETWORK_HOST_MAX_CHARS))
            .min(1)
            .max(NETWORK_ASK_MAX_HOSTS),
        })
        .optional(),
      /**
       * A git push ask (sandbox git credentials spec §7): the host, repository and refs the push
       * the gateway held would have updated. Display only, never model-visible, as `network`.
       */
      git: z
        .object({
          host: z.string().min(1).max(NETWORK_HOST_MAX_CHARS),
          repo: z.string().min(1).max(GIT_REPO_MAX_CHARS),
          refs: z.array(z.string().min(1).max(GIT_REF_MAX_CHARS)).max(GIT_ASK_MAX_REFS),
        })
        .optional(),
      /**
       * A command review ask (auto mode spec §5.4): what is held and why. Display only, never
       * model-visible, as `network` and `git`; the model sees the call's `tool_result` only.
       */
      command: CommandAskSchema.optional(),
      ...ApproverFields,
    }),
  ),
  /**
   * 审批已处理（批准 / 拒绝 / 超时 / 取消，或 `skipped`：网络询问被运行发起人的消息跳过，`byAccountId`
   * 为消息作者）；`scope` 只在批准时出现，`byAccountId` 为处理人（超时 / 取消为 null）。
   */
  ev(
    "approval_decided",
    z.object({
      approvalId: z.string(),
      callId: z.string(),
      decision: z.enum(["approved", "denied", "expired", "cancelled", "skipped", "superseded"]),
      revision: z.number().int().nonnegative().optional(),
      scope: z.enum(["once", "session", "always"]).optional(),
      byAccountId: z.string().nullable(),
      /**
       * The reason given with a denial (UI refresh B; display only here: the model sees it in the
       * denied call's `tool_result`).
       */
      reason: z.string().max(APPROVAL_DENY_REASON_MAX_CHARS).optional(),
    }),
  ),
  /**
   * A still-pending approval changed without a decision: a network ask's 「这台设备一直允许」 whose
   * device change was not applied or not confirmed (`detail.attempt`, transactional outbox spec
   * §7). Display only, never model-visible: the page reads the approval again.
   */
  ev("approval_updated", z.object({ approvalId: z.string(), callId: z.string() })),
  /**
   * 工具调用需要用户输入（`AskUserQuestion`、插件工具的 `input_required`、MCP elicitation）：输入请求已建，
   * run 暂停等待回答。界面据此显示表单卡片（不进模型请求）。
   */
  ev(
    "question_asked",
    z.object({
      step: count,
      callId: z.string(),
      questionId: z.string(),
      form: InputFormSchema,
      expiresAt: z.string(),
    }),
  ),
  /**
   * An input request ended: answered, skipped (the run's starter sent a message instead; `answer`
   * null, `byAccountId` the message's author, `skippedBySeq` that `user_message`'s seq, written in
   * the same transaction), expired or cancelled (`answer` and `byAccountId` null). Not model-visible.
   */
  ev(
    "question_answered",
    z.object({
      questionId: z.string(),
      callId: z.string(),
      answer: FormAnswerSchema.nullable(),
      byAccountId: z.string().nullable(),
      outcome: z.enum(["answered", "skipped", "expired", "cancelled"]),
      skippedBySeq: seqNo.optional(),
    }),
  ),
  /**
   * 带媒体的模型请求被供应商以不可重试的 `invalid_request` / `context_overflow` 拒绝（Ruling M8）：这些附件
   * （该请求里发了字节的）此后一律换成「被供应商拒绝」的占位，会话不会因同一个附件永久卡住。不进模型请求
   * 本身，只影响之后的请求构建（可由日志推出）。
   */
  ev(
    "media_excluded",
    z.object({
      attachmentIds: z.array(AttachmentIdSchema).min(1).max(MEDIA_EXCLUDED_MAX_IDS),
      reason: z.enum(["provider_rejected"]),
    }),
  ),
  /**
   * agent 经 `Deliver` 把沙箱里的文件交付给用户（M5 T8，C3）：字节在对象存储
   * `kernel/<orgId>/<objectKey>`（`objectKey` = `artifacts/<conversationId>/<artifactId>`，相对内核前缀），
   * 这里只有元数据。网页从日志重建产物列表；不进模型请求（模型看到的是同一调用的 tool_result 确认）。
   */
  ev(
    "artifact_created",
    z.object({
      artifactId: z.uuid(),
      name: ArtifactNameSchema,
      contentType: z.string().min(1).max(200),
      size: z.number().int().nonnegative(),
      objectKey: z.string().min(1),
      sourcePath: z.string().min(1),
      callId: z.string(),
      /**
       * The hex sha256 of the bytes (truthful delivery spec §2): the same bytes are delivered once
       * per delivery scope. Optional only because earlier events cannot be backfilled; an event
       * without it never matches.
       */
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  ),
  /**
   * 本对话此刻生效的技能（M5 T14，Ruling M17）：运行开始时内核解析生效的技能集合（agent 版本选中的组织技能 +
   * agent 自己的技能，未删除，取 current_version），与日志里上一份快照不同才写。模型看到的技能目录只来自这里：
   * 第一份（在任何 `model_call` 之前）进 system 缓存段，之后的在所在位置渲染为英文变更提醒；`Skill` 按最新一份
   * 把名字解析为 id 与版本。按 name 排序。
   */
  ev(
    "skills_catalog",
    z.object({
      skills: z
        .array(
          z.object({
            id: z.string().min(1).max(100),
            name: z.string().refine(isSkillName, "invalid skill name"),
            description: z.string().max(4096),
            version: z.number().int().positive(),
            /**
             * 内容来源（对象前缀，T15）：已生成的版本为 `skill_versions.object_prefix`，试用中的草稿为申请的
             * `object_prefix`。同号的草稿与正式版本靠它区分；`Skill` 只按它解析。
             */
            source: z.string().min(1).max(512),
            /**
             * The catalog item (plugin) name the skill came from (phase B); absent for the org's
             * own and the agent's skills, and in snapshots written before phase B. `Skill`
             * resolves `<plugin>:<name>` with it; it is not model-visible otherwise.
             */
            plugin: z.string().min(1).max(64).optional(),
            /**
             * Listed by name only, past the catalog budget (`skills.catalogBudgetChars`, skills
             * default-on spec §7): decided when the snapshot is written, so a later budget never
             * changes an old request. Absent in every snapshot before phase 2 (= described).
             */
            nameOnly: z.literal(true).optional(),
          }),
        )
        .max(SKILLS_CATALOG_MAX),
      /**
       * The Claude Code tool-name map text (`CLAUDE_CODE_TOOL_MAP`), present iff a skill in
       * `skills` came from a Claude Code plugin.
       */
      toolMap: z.string().max(4000).optional(),
    }),
  ),
  /**
   * A plugin policy hook denied a model request or a tool call (E6). Not model-visible: request building
   * skips it; the model sees only `reason`, inside the tool error of a denied tool call (and nothing for a
   * denied model request, whose run fails with `run.hook_denied`). No raw hook error here (Ruling R12):
   * the events API reaches conversation participants, so the raw text lives in the `hook.denied` audit
   * row only.
   */
  ev(
    "hook_denied",
    z.object({
      mount: z.enum(["model.request", "tool.preExecute"]),
      plugin: z.string(),
      reason: z.string().max(500),
      cause: z.enum(["deny", "hook_error", "timeout"]),
      step: count,
      attempt: count.optional(),
      callId: z.string().optional(),
    }),
  ),
  /**
   * The network refusals a command reported (network ask-to-allow spec §6.5), whether or not they
   * raised an ask: the web draws the facts and the org-layer request under the command's row. Not
   * model-visible: request building skips it; the model sees only the call's `tool_result` (the
   * device's trailer and the kernel's note).
   */
  ev(
    "network_blocked",
    z.object({
      step: count,
      callId: z.string(),
      hosts: z
        .array(
          z.object({
            host: z.string().min(1).max(NETWORK_HOST_MAX_CHARS),
            port: z.number().int().min(1).max(65535),
            layer: z.enum(["device", "org", "address", "unknown"]),
          }),
        )
        .min(1)
        .max(NETWORK_ASK_MAX_HOSTS),
    }),
  ),
  /**
   * A `gh auth login --web` device-code prompt a command printed (auto mode spec §6, P-D13): the
   * URL to open and the one-time code. Display only, never model-visible: request building skips
   * it (the model sees only the command's own output). The token the login finally writes stays in
   * the device's container, so no event carries it.
   */
  ev(
    "device_code",
    z.object({
      step: count,
      callId: z.string(),
      url: z.string().min(1).max(2048),
      code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
    }),
  ),
  /**
   * The first event of a sub-agent's (child) conversation (phase C, spec §6.3), written once in the
   * dispatch transaction. Request building for a `subagent` conversation takes the definition and
   * the preamble from here, never from `agent_versions`, so later changes never alter an old
   * child's request. The event itself is not rendered as a message.
   */
  ev(
    "subagent_started",
    z.object({
      parent: z.object({
        conversationId: z.string(),
        runId: z.string(),
        callId: z.string(),
        step: count,
      }),
      agentType: z.string().min(1).max(130),
      template: z.object({
        source: z.enum(["general", "inline", "plugin", "agent"]),
        id: z.string().optional(),
        version: z.number().int().positive().optional(),
        plugin: z.string().optional(),
        /**
         * Plugin scope phase 2: the platform template whose content a `plugin` child ran (a
         * platform template, or an org copy linked to one, recorded under the copy's `id`). Absent
         * = the org's own template. Eval metadata, not model-visible.
         */
        platformTemplateId: z.string().optional(),
        /**
         * Phase D: the child runs a forked skill a person invoked (display and eval metadata, not
         * model-visible).
         */
        invokedSkill: z
          .object({ id: z.string(), version: z.number().int(), name: z.string() })
          .optional(),
      }),
      /** The effective (narrowed) definition, frozen at dispatch. */
      definition: AgentDefinitionSchema,
      /**
       * `SUBAGENT_PREAMBLE` at dispatch time. Children dispatched between skills default-on and
       * template skills written as invocations end it with the line naming a template's skills
       * the child loads first (`Before you start, load these skills with Skill: …`).
       */
      preamble: z.string(),
      /** The child's step limit; 0 = no limit (`runtime.maxSteps` 0, no template limit). */
      maxSteps: z.number().int().nonnegative(),
      warnings: z.array(z.string()).optional(),
    }),
  ),
  /**
   * Parent log (phase C, spec §14.1): the `Agent` call `callId` started (or resumed) the sub-agent
   * `subagentId` (its child conversation id) with run `childRunId`. Not model-visible: the model
   * sees the call's tool_call / tool_result pair.
   */
  ev(
    "subagent_dispatched",
    z.object({
      step: count,
      callId: z.string(),
      subagentId: z.string(),
      childRunId: z.string(),
      agentType: z.string(),
      description: z.string(),
      resumed: z.boolean(),
      model: z.object({ provider: z.string(), model: z.string() }),
      tierFallback: z.boolean().optional(),
      /**
       * Phase D: the seq of the person's fork invocation this dispatch runs (`callId` is
       * `skill-<seq>`, step 0, no tool call); absent for an `Agent` call.
       */
      invokedSeq: seqNo.optional(),
    }),
  ),
  /**
   * Root log (agent map spec §7): a sub-agent `subagentId` of the tree, at any depth, waits for a
   * person (approval, input or a connection). Not model-visible. `path`: the child conversation ids
   * from the root's child down to `subagentId` (`[subagentId]` for a child of the root); logged under
   * the root run that last dispatched the root's child on that path.
   */
  ev(
    "subagent_waiting",
    z.object({
      subagentId: z.string(),
      childRunId: z.string(),
      path: z.array(z.string()).min(1).max(16),
      kind: z.enum(["approval", "input", "connect"]),
      approvalId: z.string().optional(),
      questionId: z.string().optional(),
      toolKey: z.string(),
      expiresAt: z.string().optional(),
      /** An approval's approver (`kind: "approval"` only), as in `approval_requested`. */
      requestedFor: ApproverFields.requestedFor.optional(),
      approverRole: ApproverFields.approverRole.optional(),
    }),
  ),
  /** Parent log: a sub-agent's run ended. Not model-visible (its reply is the call's tool_result). */
  ev(
    "subagent_finished",
    z.object({
      subagentId: z.string(),
      childRunId: z.string(),
      callId: z.string(),
      status: SubagentFinishStatusSchema,
      errorCode: z.string().optional(),
      toolCalls: count,
      durationMs: count,
      usage: z.object(ModelUsageShape),
    }),
  ),
  /**
   * Parent log (agent map spec §4.5, §5.2): a sub-agent `subagentId` (its child conversation id)
   * handed back a report (`SubagentHandback`), sent a note (`SendMessage to: "parent"`) or its run
   * `childRunId` finished. **Model-visible**: absorbed like an interjection and rendered as a system
   * message (`renderSubagentDelivery`). A finish after a handback carries `text: ""` and
   * `handedBack: true` and renders as one status line, except that a run that handed back and
   * `completed` writes no finished delivery at all (acceptance 2026-11-07); a finish without a handback carries the child's
   * final reply, a failed finish its error message (`errorCode` the code), an aborted one no text
   * (`abortedBy` who stopped it), with `subagent_finished`'s vocabulary. `status` is present exactly
   * on `kind: "finished"`. `triggerAccountId`: the child run's trigger account, the one a wake runs
   * as (§7).
   */
  ev(
    "subagent_delivery",
    z
      .object({
        subagentId: z.string(),
        childRunId: z.string(),
        description: z.string(),
        kind: z.enum(["report", "note", "finished"]),
        text: z.string().max(200_000),
        /** `kind: "finished"` only (required there). */
        status: SubagentFinishStatusSchema.optional(),
        /** `kind: "finished"` only: a report was handed back before the run finished. */
        handedBack: z.boolean().optional(),
        /** `status: "failed"` only: the child run's error code. */
        errorCode: z.string().optional(),
        /** `status: "aborted"` only: a person stopped it, or the kernel on its parent's behalf. */
        abortedBy: z.enum(["user", "parent"]).optional(),
        triggerAccountId: z.string(),
      })
      .superRefine((p, ctx) => {
        if ((p.kind === "finished") !== (p.status !== undefined)) {
          ctx.addIssue({
            code: "custom",
            path: ["status"],
            message: "status is required on a finished delivery and allowed only there",
          });
        }
      }),
  ),
  /**
   * Phase D (spec §6.3): the report of the sub-agent that ran a person's fork invocation
   * (`invokedSeq`), written once (idem `skill_fork_result:<seq>`) before the parent's next model
   * call. **Model-visible**: request building renders `text` as user content right after the
   * invocation message. `subagentId` / `childRunId` are absent when no sub-agent ran (refused, or
   * the run ended before it started).
   */
  ev(
    "skill_fork_result",
    z.object({
      invokedSeq: seqNo,
      subagentId: z.string().optional(),
      childRunId: z.string().optional(),
      text: z.string(),
    }),
  ),
  /**
   * A background Bash task ended (spec 2026-11-05-background-bash-design §2). Model-visible: it is
   * absorbed like an interjection and rendered as a system message (`renderBackgroundFinished`).
   * `reported`: a TaskOutput or TaskStop in the same run already told the model; it is absorbed
   * like any other, renders as one short line and never wakes a run. `lastLines` is the tail of
   * the task's output.
   */
  ev(
    "background_task_finished",
    z.object({
      taskId: z.string().min(1).max(64),
      description: z.string(),
      status: z.enum(["completed", "failed", "stopped", "timed_out", "lost"]),
      exitCode: z.number().int().nullable(),
      elapsedMs: count,
      lastLines: z.string().max(4000),
      outputPath: z.string(),
      reported: z.boolean(),
      lostReason: z.string().optional(),
      /**
       * The finish never wakes a run, but the next run absorbs it like any other (background
       * Bash §3): `person`, a person stopped the task (the conversation's background section);
       * `deletion`, the conversation was being deleted; `subagent_end`, the sub-agent that owns it
       * ended (a fork's run, or a stopped background sub-agent; agent map spec §5.3).
       */
      stoppedBy: z.enum(["person", "deletion", "subagent_end"]).optional(),
    }),
  ),
  ev(
    "compaction_summary",
    z.object({
      coversUpToSeq: seqNo,
      text: z.string(),
      /**
       * The estimated transcript input minus the stored summary output (context compaction spec
       * §4.9), so the UI needs no chunked usage to show what compaction saved.
       */
      savedTokens: count,
      /**
       * The user messages that started the run being compacted, when the summary covers them
       * (context compaction spec §4.2, revision 2026-11-15), in seq order: request building
       * re-renders exactly these after the summary text. Decided when the summary is written, so a
       * request never depends on later events. Absent when the summary covers no opening message
       * (nothing re-rendered).
       */
      openingSeqs: z.array(seqNo).optional(),
      /**
       * The step the compaction ran in (0 for a manual compact run), so a later compaction in the
       * same step takes the next idempotency key.
       */
      step: count,
    }),
  ),
  ev(
    "compaction_failed",
    z.object({
      attempt: count,
      reason: z.string(),
      /** The step the compaction ran in, as on `compaction_summary`. */
      step: count,
    }),
  ),
  ev(
    "run_finished",
    z.object({
      /** `budget`: a sub-agent stopped at its parent run's token cap (phase C, spec §8.3). */
      reason: z.enum(["completed", "max_steps", "max_duration", "budget"]),
      consumedUpToSeq: seqNo,
    }),
  ),
  ev("run_failed", z.object({ error: z.object({ code: z.string(), message: z.string() }) })),
  ev(
    "run_aborted",
    z.object({
      byAccountId: z.string().nullable(),
      /** `eval_stopped`：评测整轮回放被评测运行停下（只出现在 `kind = 'eval'` 的对话里），原因见 `detail`。 */
      reason: z.enum(["user", "shutdown_exhausted", "eval_stopped", "org_deleted"]),
      /**
       * Why an eval replay stopped (`eval_stopped`), or `wait_timeout`: a sub-agent run stopped
       * (`user`, no account) because its parent's sub-agents wait timed out (phase C).
       */
      detail: z
        .enum(["cancelled", "capped", "too_many_errors", "claim_lost", "shutdown", "wait_timeout"])
        .optional(),
    }),
  ),
]);

/** 事件体：`{ type, payload }` 的判别联合。 */
export type ConversationEventBody = z.infer<typeof ConversationEventSchema>;
export type ConversationEventType = ConversationEventBody["type"];

/** 已写入日志的事件。 */
export type ConversationEvent = ConversationEventBody & {
  conversationId: string;
  seq: number;
  runId: string | null;
  createdAt: Date;
};

/**
 * An event a run absorbs at a step boundary: a person's message, a finished background task or a
 * sub-agent's delivery.
 */
export type AbsorbableEvent = Extract<
  ConversationEvent,
  { type: "user_message" | "background_task_finished" | "subagent_delivery" }
>;

/**
 * Whether `e` is absorbed like an interjection (spec 2026-11-05-background-bash-design §2.4): the
 * loop takes it at its next step boundary, `consumed_seq` moves past it, and request building
 * places it where the model call that absorbed it was built.
 */
export const isAbsorbable = (e: ConversationEvent): e is AbsorbableEvent =>
  e.type === "user_message" ||
  e.type === "background_task_finished" ||
  e.type === "subagent_delivery";

/**
 * What the person typed for a skill invocation (phase D): `/<plugin>:<name> <arguments>` (no
 * plugin: `/<name>`). Titles and eval case titles use it instead of the rendered skill in
 * `content[0]`.
 */
export const typedInvocation = (skill: {
  name: string;
  plugin?: string | undefined;
  arguments: string;
}): string =>
  `/${skill.plugin === undefined ? "" : `${skill.plugin}:`}${skill.name}${
    skill.arguments === "" ? "" : ` ${skill.arguments}`
  }`;

/** 某类事件的 payload。 */
export type EventPayload<T extends ConversationEventType> = Extract<
  ConversationEventBody,
  { type: T }
>["payload"];

// 编译期核对：zod 形状与 plugin-sdk 的类型一致（任一方改动而另一方未跟上则 typecheck 失败）。
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type StripOpt<T> = T extends unknown ? { [K in keyof T]: Exclude<T[K], undefined> } : never;
// 日志 schema 对的是收窄后的 LogContentBlock（媒体块只认 ref）；再核对它确是 ContentBlock 的子类型。
const _blocks: Same<StripOpt<z.infer<typeof ContentBlockSchema>>, StripOpt<LogContentBlock>> = true;
const _logIsBlock: [LogContentBlock] extends [ContentBlock] ? true : false = true;
const _stop: Same<(typeof STOP_REASONS)[number], StopReason> = true;
const _effort: Same<(typeof EFFORT_ENUM)[number], Effort> = true;
void _effort;
const _usage: Same<z.infer<z.ZodObject<typeof ModelUsageShape>>, ModelUsage> = true;
// tool_result 事件与内容块中的 tool_result 共享 callId / content / isError 的形状。
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;
const _toolResult: Same<
  Pick<EventPayload<"tool_result">, "callId" | "content" | "isError">,
  Omit<ToolResultBlock, "type">
> = true;
void _toolResult;
const _schedule: Same<z.infer<typeof ScheduleMarkerSchema>, ScheduleMarker> = true;
void _schedule;
void _blocks;
void _logIsBlock;
void _stop;
void _usage;
