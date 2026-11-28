"use client";

import {
  AttachmentStrip,
  type AttachmentStripItem,
  Button,
  ComposerBox,
  type ComposerEditorHandle,
  ComposerMenu,
  type ComposerMenuGroup,
  type ComposerMenuItem,
  type ComposerMenuKind,
  type ComposerMenuProps,
  type ComposerPlace,
  type ComposerSegment,
  type ComposerTokenData,
  type ComposerTokenKind,
  type ComposerTrigger,
  commandScore,
  Dialog,
  Field,
  FileDrop,
  formatDateTime,
  formatRelative,
  Input,
  isTouchPointer,
  type PickerProps,
  Stack,
  typeBadge,
  useComposerMenu,
  useNow,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  type ChangeEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ApiClientError } from "../../lib/api";
import {
  type ConnectorPrompt,
  type ConnectorSummary,
  type ConnectorUnavailable,
  type MentionableConnector,
  mentionableDescriptionOf,
  renderConnectorPrompt,
} from "../../lib/connectors";
import {
  MAX_CONVERSATION_REFS,
  type MessageInput,
  type MessageToken,
  TOKEN_MARKER,
} from "../../lib/conversations";
import { focusWhenPossible } from "../../lib/deferred-focus";
import type { LibraryFileView } from "../../lib/library-files";
import {
  connectorPromptsQuery,
  connectorResourcesQuery,
  connectorsQuery,
  invocableSkillsQuery,
  mentionableConnectorsQuery,
} from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { libraryFileSearchQuery } from "../../lib/query/library";
import { useAppMutation } from "../../lib/query/mutation";
import { CONVERSATION_MENTION_ROWS, conversationMentionQuery } from "../../lib/query/shell";
import {
  findInvocable,
  type InvocableSkill,
  type InvocableSource,
  parseSlashCommand,
  skillChipLabel,
  skillShownName,
} from "../../lib/skills";
import type { PromptSuggestion } from "../../lib/stream";
import { acceptAttribute, fileContentType } from "../../lib/uploads";
import { useErrorMessage } from "../../lib/use-error-message";
import { useRunStateValue } from "../client-ext/run-state";
import { ExtensionSlot } from "../extension-ui/ExtensionSlot";
import { type DraftFile, useDraftFiles } from "../use-draft-files";
import { modeMenuFromPickers } from "./PermissionPicker";
import { MAX_PROJECT_FILES, ProjectFilesPicker } from "./ProjectFilesPicker";
import type { SendResult } from "./useConversation";

/** At most this many tokens per message (kernel `MAX_TOKENS`). */
const MAX_TOKENS = 20;

/** The per-kind token caps (kernel: connectors, resources, project files, conversations). */
const MAX_OF_KIND: Partial<Record<ComposerTokenKind, number>> = {
  connector: 3,
  resource: 5,
  projectFile: MAX_PROJECT_FILES,
  conversation: MAX_CONVERSATION_REFS,
};

/** At most this many connector rows in the `@` menu's first level (composer inline tokens §4). */
const CONNECTOR_ROWS = 6;

/** At most this many resource rows in a connector's second level. */
const MAX_RESOURCE_ROWS = 50;

/**
 * `clientMessageId`: `crypto.randomUUID` only exists in secure contexts (HTTPS / localhost);
 * elsewhere the same randomness from `getRandomValues`.
 */
export function newClientMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A token of the draft (a segment that is not text). */
const isToken = (s: ComposerSegment): s is ComposerTokenData => typeof s !== "string";

/** Joins adjacent text runs and drops empty ones, so equal drafts have one shape. */
function normalize(segments: readonly ComposerSegment[]): ComposerSegment[] {
  const out: ComposerSegment[] = [];
  for (const s of segments) {
    if (typeof s === "string") {
      if (s === "") continue;
      const last = out[out.length - 1];
      if (typeof last === "string") out[out.length - 1] = last + s;
      else out.push(s);
    } else out.push(s);
  }
  return out;
}

/** The distinct entities the draft's tokens name (of `kind`, or of every kind but the skill). */
function distinctTokens(segments: readonly ComposerSegment[], kind?: ComposerTokenKind): number {
  return new Set(
    segments.flatMap((s) =>
      isToken(s) && s.kind !== "skill" && (kind === undefined || s.kind === kind)
        ? [`${s.kind}:${s.id}`]
        : [],
    ),
  ).size;
}

/** The draft's tokens as the send body counts them: every occurrence but the skill's. */
const tokenCount = (segments: readonly ComposerSegment[]): number =>
  segments.filter((s) => isToken(s) && s.kind !== "skill").length;

/** The draft holds no text (whitespace aside) and no token. */
const blank = (segments: readonly ComposerSegment[]) =>
  segments.every((s) => typeof s === "string" && s.trim() === "");

/**
 * A draft's identity (composer inline tokens spec §2 "Draft identity"): its text and each token's
 * `(kind, id)` in order, the uploads' ids and the skill invoked. Moving a token, adding one or
 * editing text makes a new message (a new `clientMessageId`); a label fetched later or a refusal
 * mark does not.
 */
export function draftKey(
  segments: readonly ComposerSegment[],
  uploads: readonly string[],
  skill: string | undefined,
): string {
  return JSON.stringify([
    normalize(segments).map((s) => (typeof s === "string" ? s : [s.kind, s.id])),
    uploads,
    skill ?? null,
  ]);
}

/** A resource token's id: `<connectorId>:<uri>` (a connector id is a UUID, it holds no colon). */
const resourceId = (connectorId: string, uri: string) => `${connectorId}:${uri}`;

/** The send body's token for one draft token (a skill token is the `skill` field, not a token). */
function messageToken(t: ComposerTokenData): MessageToken | null {
  switch (t.kind) {
    case "connector":
      return { type: "connector", connectorId: t.id };
    case "resource": {
      const at = t.id.indexOf(":");
      return at < 0
        ? null
        : { type: "resource", connectorId: t.id.slice(0, at), uri: t.id.slice(at + 1) };
    }
    case "file":
      return { type: "file", id: t.id };
    case "projectFile":
      return { type: "projectFile", path: t.id };
    case "conversation":
      return { type: "conversation", id: t.id };
    default:
      return null;
  }
}

/** Removes the token marker from typed text (the editor never lets one in; a guard). */
const withoutMarkers = (s: string) => s.split(TOKEN_MARKER).join("");

/**
 * What a draft sends (composer inline tokens spec §3.1): `text` with one U+FFFC per token, the
 * `tokens` in order, and the skill token's name, which leaves the text with the whitespace at its
 * seam collapsed to one space (or none at an edge); `shown` is the same sentence as segments, for
 * the pending bubble (the skill chip draws apart). The text is trimmed.
 */
export function composerMessageParts(segments: readonly ComposerSegment[]): {
  text: string;
  tokens: MessageToken[];
  skill?: string;
  shown: ComposerSegment[];
} {
  let text = "";
  const tokens: MessageToken[] = [];
  const shown: ComposerSegment[] = [];
  let skill: string | undefined;
  let seam = false;
  const put = (piece: string, token?: ComposerTokenData) => {
    if (seam) {
      if (text !== "") {
        text += " ";
        shown.push(" ");
      }
      seam = false;
    }
    text += piece;
    shown.push(
      token
        ? {
            kind: token.kind,
            id: token.id,
            label: token.label,
            ...(token.icon ? { icon: token.icon } : {}),
          }
        : piece,
    );
  };
  for (const s of normalize(segments)) {
    if (typeof s === "string") {
      let clean = withoutMarkers(s);
      if (seam) clean = clean.replace(/^\s+/, "");
      if (clean !== "") put(clean);
      continue;
    }
    if (s.kind === "skill") {
      skill ??= s.id;
      // the text before the skill gives up its trailing whitespace at the seam
      const trimmed = text.replace(/\s+$/, "");
      if (trimmed !== text) {
        text = trimmed;
        const last = shown[shown.length - 1];
        if (typeof last === "string") {
          const cut = last.replace(/\s+$/, "");
          if (cut === "") shown.pop();
          else shown[shown.length - 1] = cut;
        }
      }
      seam = true;
      continue;
    }
    const token = messageToken(s);
    if (token === null) continue;
    tokens.push(token);
    put(TOKEN_MARKER, s);
  }
  // trimmed as the kernel stores it; the shown sentence loses the same edges
  const lead = text.length - text.trimStart().length;
  const tail = text.length - text.trimEnd().length;
  const first = shown[0];
  if (lead > 0 && typeof first === "string") {
    const cut = first.trimStart();
    if (cut === "") shown.shift();
    else shown[0] = cut;
  }
  const last = shown[shown.length - 1];
  if (tail > 0 && typeof last === "string") {
    const cut = last.trimEnd();
    if (cut === "") shown.pop();
    else shown[shown.length - 1] = cut;
  }
  return { text: text.trim(), tokens, ...(skill !== undefined ? { skill } : {}), shown };
}

/**
 * A project-relative path as the kernel normalizes it (`./a//b/` -> `a/b`, `..` resolved), so a
 * refusal's path matches the token it came from.
 */
function normalizeProjectPath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * A token a send was refused for (composer inline tokens spec §3.4), by `(kind, id)`, with the
 * refusal's code and its `reason` detail (the copy is `errors.<code>[.<reason>]`).
 */
export type RefusedToken = { kind: ComposerTokenKind; id: string; code: string; reason?: string };

const detailsOf = (e: ApiClientError) =>
  e.rawDetails.map((d) =>
    typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {},
  );
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The draft's tokens a refusal names, in draft order: a connector the agent cannot use
 * (`conversation.connector_unavailable`), a resource with nothing to read
 * (`connector.resource_unreadable`), a connector's resources the agent cannot read or a connector
 * gone (`connector.resources_disabled`, `connector.not_found` naming its `connectorId`), a project file not in the project
 * (`conversation.project_file_unavailable`, `device.path_outside_project`), a conversation that
 * cannot be referenced (`conversation.reference_unavailable`, `conversation.reference_self`), a
 * library file that is gone or not ready (`file.*` naming its `fileId`). None for another error.
 */
export function refusedTokens(e: unknown, segments: readonly ComposerSegment[]): RefusedToken[] {
  if (!(e instanceof ApiClientError)) return [];
  const named: { kind: ComposerTokenKind; match(id: string): boolean; reason?: string }[] = [];
  for (const d of detailsOf(e)) {
    const reason = str(d.reason);
    const extra = reason !== undefined ? { reason } : {};
    switch (e.code) {
      case "conversation.connector_unavailable": {
        const id = str(d.connectorId);
        if (id !== undefined) named.push({ kind: "connector", match: (x) => x === id, ...extra });
        break;
      }
      case "connector.resources_disabled":
      case "connector.not_found": {
        // a connector's resources the agent cannot read, or a connector gone: its resource
        // tokens (the one URI when named), and for a gone one its connector tokens too
        const id = str(d.connectorId);
        const uri = str(d.uri);
        if (id === undefined) break;
        named.push({
          kind: "resource",
          match: (x) => (uri !== undefined ? x === resourceId(id, uri) : x.startsWith(`${id}:`)),
        });
        if (e.code === "connector.not_found" && uri === undefined)
          named.push({ kind: "connector", match: (x) => x === id });
        break;
      }
      case "connector.resource_unreadable": {
        const id = str(d.connectorId);
        const uri = str(d.uri);
        if (id !== undefined && uri !== undefined)
          named.push({ kind: "resource", match: (x) => x === resourceId(id, uri), ...extra });
        break;
      }
      case "conversation.project_file_unavailable":
      case "device.path_outside_project": {
        const path = str(d.path);
        if (reason === "no_project") {
          // no project to reference files in: every project file token
          named.push({ kind: "projectFile", match: () => true, ...extra });
        } else if (path !== undefined) {
          // a path clipped in the details ("…" at the end) matches by its prefix
          const cut = path.endsWith("…");
          const want = normalizeProjectPath(cut ? path.slice(0, -1) : path);
          named.push({
            kind: "projectFile",
            match: (x) =>
              cut ? normalizeProjectPath(x).startsWith(want) : normalizeProjectPath(x) === want,
            ...extra,
          });
        }
        break;
      }
      case "conversation.reference_unavailable":
      case "conversation.reference_self": {
        const id = str(d.id);
        if (id !== undefined)
          named.push({ kind: "conversation", match: (x) => x === id, ...extra });
        break;
      }
      default: {
        const id = str(d.fileId);
        if (e.code.startsWith("file.") && id !== undefined)
          named.push({ kind: "file", match: (x) => x === id, ...extra });
      }
    }
  }
  const out: RefusedToken[] = [];
  for (const t of segments) {
    if (!isToken(t) || out.some((r) => r.kind === t.kind && r.id === t.id)) continue;
    const hit = named.find((n) => n.kind === t.kind && n.match(t.id));
    if (hit)
      out.push({
        kind: t.kind,
        id: t.id,
        code: e.code,
        ...(hit.reason !== undefined ? { reason: hit.reason } : {}),
      });
  }
  return out;
}

/** The draft without the tokens `drop` names, the space each one stood between kept once. */
function withoutTokens(
  segments: readonly ComposerSegment[],
  drop: (t: ComposerTokenData) => boolean,
): ComposerSegment[] {
  const out: ComposerSegment[] = [];
  let gap = false;
  for (const s of segments) {
    if (isToken(s) && drop(s)) {
      const last = out[out.length - 1];
      gap = gap || last === undefined || (typeof last === "string" && /\s$/.test(last));
      continue;
    }
    out.push(gap && typeof s === "string" ? s.replace(/^[ \t]/, "") : s);
    gap = false;
  }
  return normalize(out);
}

/** A slash command: `/<connector slug>:<prompt name>`. */
export const promptCommand = (p: Pick<ConnectorPrompt, "connectorSlug" | "name">) =>
  `/${p.connectorSlug}:${p.name}`;

/**
 * The open composer menu (composer menus spec §1–§4, composer inline tokens spec §4): its kind;
 * whether it follows a trigger typed in the text (`@` or `/`; its query is the text typed after
 * it) or was opened without one (+, whose query is `q`, the compact sheet's search field); where
 * a `/` trigger stands (`atStart`); what an `@` menu lists (everything, or the library's files
 * only: + → File library); and the connector whose resources it lists (its second level).
 */
type MenuState = {
  kind: ComposerMenuKind;
  trigger: boolean;
  q: string;
  atStart?: boolean;
  scope?: "files";
  level?: MentionableConnector;
};

/**
 * How long the `@` query rests before the kernel is asked (each text is its own cache entry, for
 * the resources, the library files and the conversations alike).
 */
const RESOURCE_SEARCH_DELAY_MS = 200;

/** `value`, once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** What the composer sends: the message without the switch (the caller adds model / effort). */
export type ComposerMessage = Pick<
  MessageInput,
  "text" | "clientMessageId" | "tokens" | "files" | "skill"
> & {
  /**
   * What a pending bubble shows until the log has the message (never sent): the skill's chip
   * label, the sentence with its tokens and the uploads' names.
   */
  display?: {
    skill?: string;
    /** The sentence as text runs and tokens (absent: `text` has no tokens). */
    segments?: ComposerSegment[];
    /** `type`: the file's type badge, as the thread's chip shows it. */
    files: { name: string; kind: "image" | "file"; type?: string }[];
  };
  /**
   * The draft as it was sent, for a view that outlives this composer (the new conversation's
   * layout switch remounts it): a failed send gives it to the next composer's `initialDraft`.
   */
  draft?: ComposerDraft;
};

/**
 * A composer's draft handed from one composer to the next (composer inline tokens spec §2
 * "Drafts"): the text and tokens (`segments`, the skill token among them), the invoked skill as
 * listed, the uploads, the draft's id, and the tokens the failed send was refused for.
 */
export type ComposerDraft = {
  segments: ComposerSegment[];
  skill: InvocableSkill | null;
  files: DraftFile[];
  /** The draft's `clientMessageId`, kept for the retry (the kernel dedupes it). */
  id?: { key: string; id: string };
  /** Tokens the failed send was refused for (marked, with the Remove line). */
  refused?: RefusedToken[];
};

/** What a page may do to its composer from outside (the new conversation's quick actions). */
export type ComposerControl = {
  /**
   * Replaces the draft with `text` and focuses the input (not on a touch device: the keyboard
   * would pop up). The draft it replaced is one undo step.
   */
  fill(text: string): void;
  /** Focuses the input (a new conversation's agent was picked). */
  focus(): void;
};

/** The `/` menu's skill headings, in order (project root §4.6). */
const SKILL_SOURCES: readonly InvocableSource[] = ["project", "agent", "platform", "plugin"];

/** The name a picked skill is invoked by: `<plugin>:<name>` for a plugin's skill. */
const invokeName = (s: InvocableSkill) => (s.plugin ? `${s.plugin}:${s.name}` : s.name);

/** The composer's text box (the editor's content editable). */
const COMPOSER_INPUT = '[data-part="composer-input"]';

/**
 * The sentence after a typed `/name ` (an invocation's arguments): its first `cut` characters,
 * which are the command, leave the first text run.
 */
function dropCommand(shown: readonly ComposerSegment[], cut: number): ComposerSegment[] {
  const [first, ...rest] = shown;
  if (typeof first !== "string") return [...shown];
  const kept = first.slice(cut).trimStart();
  return kept === "" ? rest : [kept, ...rest];
}

/** Blob previews of the draft's images, revoked when the file leaves the draft or on unmount. */
function useObjectUrls(files: DraftFile[]): ReadonlyMap<string, string> {
  const urls = useRef(new Map<string, string>());
  const [, force] = useState(0);
  useEffect(() => {
    const map = urls.current;
    let changed = false;
    const keep = new Set(files.map((f) => f.key));
    for (const [k, u] of map) {
      if (!keep.has(k)) {
        URL.revokeObjectURL(u);
        map.delete(k);
        changed = true;
      }
    }
    for (const f of files) {
      if (map.has(f.key) || !f.file || !f.file.type.startsWith("image/")) continue;
      if (typeof URL.createObjectURL !== "function") continue;
      map.set(f.key, URL.createObjectURL(f.file));
      changed = true;
    }
    if (changed) force((n) => n + 1);
  }, [files]);
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const u of map.values()) URL.revokeObjectURL(u);
      map.clear();
    };
  }, []);
  return urls.current;
}

/**
 * The composer (spec §5.2, §6.16.2): the editor (text with inline tokens), the attachment strip
 * (uploads), the pickers and send / stop.
 *
 * Keys: ↵ and ⌘↵ / Ctrl+↵ send; while a run is going the message is an interjection the run takes
 * in at its next step (run input spec 2026-11-07 D1, D2; there is no queue); Shift+↵ is a newline;
 * nothing happens while an IME is composing (the editor holds its triggers and ↵).
 *
 * Carried over from the old composer: each draft keeps one `clientMessageId` until it is sent or
 * changed (the kernel dedupes retries; {@link draftKey}); uploads come from +, drop or paste,
 * upload at once and block sending while uploading or failed; a send that fails keeps the draft.
 *
 * Tokens (composer inline tokens spec): everything picked through `/` or `@` is an inline token
 * where it was typed: a skill, a connector, a connector resource, a library file, a conversation;
 * + → Project files inserts project file tokens at the caret. Uploads stay cards in the strip. The
 * message goes out as `text` with one U+FFFC per token and the `tokens` in order; the skill token
 * leaves the text as `skill` (at most one per message). A refusal marks the tokens it names and
 * shows the Remove line.
 *
 * Menus (composer menus spec §1–§4, inline tokens §4): one `ComposerMenu` anchored to the
 * composer, the editor its combobox. + lists what can be added or used (upload, the file library,
 * project files, skills, the agent's connectors); `/` at the start or after whitespace lists the
 * agent's skills and the connectors' prompts, and the commands when the `/` is the whole draft;
 * `@` lists the agent's connectors (→ opens one's resources), the library's files and the
 * sender's conversations. The trigger stays in the text and what follows it is the query; a pick
 * replaces both with its token, Esc closes and keeps the text.
 *
 * A draft typed as `/name args` that names a listed skill is sent as its invocation; anything
 * else as text (a typed one the kernel refuses as an unknown skill, `skill.not_invocable`
 * `not_found`, from a stale list, is resent as text; any other refusal keeps the draft and shows
 * why). The list is read for `agentId` (with `conversationId` once the conversation exists, so
 * its trial drafts apply) when the menu opens or a typed `/name` is sent.
 */
export function ComposerBar({
  orgId,
  agentId,
  skillsHref,
  conversationId,
  running,
  waiting,
  stop,
  onSend,
  pickers,
  place,
  quickActions,
  agents,
  context,
  placeholder,
  sendDisabled,
  initialDraft,
  onBlocked,
  onCompact,
  control,
  suggestion,
  project,
}: {
  orgId: string;
  /** The conversation's agent (the `/` menu lists its skills); undefined while loading. */
  agentId?: string | undefined;
  /**
   * The agent's skills section, for someone who can edit the agent: the `/` menu with nothing to
   * invoke links it (spec §5 rule 11: an org skill must be selected on the agent). Undefined for
   * someone who cannot edit it (the menu only explains).
   */
  skillsHref?: string | undefined;
  /** The conversation, once it exists and is the caller's (its trial drafts apply). */
  conversationId?: string | undefined;
  /** A run is going (or waiting for a person): ↵ interjects, the hint says so, send becomes stop. */
  running: boolean;
  /**
   * The run waits for a person (`composerWait`): `"skip"`, a question the viewer can skip by
   * sending a message; `"hold"`, anything else (a message is taken in once the wait ends). The
   * hint says which; sending stays possible either way.
   */
  waiting?: "skip" | "hold" | null | undefined;
  stop?: { onStop(): void; stopping: boolean };
  onSend(m: ComposerMessage): Promise<SendResult>;
  /** The agent picker is absent on the new conversation page (its agents row picks). */
  pickers: {
    agent?: PickerProps;
    /** The conversation's permission profile (design slot order). */
    permission?: PickerProps;
    model: PickerProps;
    effort?: PickerProps;
  };
  /**
   * The top strip (composer menus spec §6, §7): the device, then its project (absent when the
   * device offers none); both locked on an existing conversation. Absent without a device choice.
   */
  place?: ComposerPlace | undefined;
  /** The selected agent's quick actions (`QuickActions`), after the effort picker. */
  quickActions?: ReactNode;
  /** The agent map's entry (`AgentsChip`, AC3), after the quick actions; a conversation's only. */
  agents?: ReactNode;
  /** The context meter before send / stop: `pct` of the window used, `over` from the threshold. */
  context?: { pct: number; over: boolean } | undefined;
  placeholder: string;
  /** Nothing can be sent yet (a new conversation whose agent, or a thread, is still loading). */
  sendDisabled?: boolean;
  /** A failed send's draft to start from (read at mount). */
  initialDraft?: ComposerDraft | undefined;
  /** ↵ with a draft while `sendDisabled` (the caller says why; the draft stays). */
  onBlocked?(): void;
  /**
   * The conversation can be compacted (context compaction spec §4.10): enables the built-in
   * `/compact` command and its `/` menu entry. Absent while there is no conversation to compact
   * (a new conversation, a sub-agent's) and for an eval conversation (never shown here).
   */
  onCompact?(): Promise<void>;
  /** Filled with {@link ComposerControl} while this composer is mounted. */
  control?: Ref<ComposerControl>;
  /**
   * The prompt suggestion to offer (prompt suggestions spec §5), already past the reader's rule; a
   * root conversation's only (never the new conversation page or a sub-agent's composer). Once
   * dismissed it stays away for that run.
   */
  suggestion?: Pick<PromptSuggestion, "runId" | "text"> | undefined;
  /**
   * The device project the message goes to (composer menus §5): the conversation's binding, or
   * the new conversation's pick, and only for the device's owner (the listing is the owner's).
   * Its files can be referenced from the + menu (Project files); a change of it drops their
   * tokens.
   */
  project?: { deviceId: string; name: string } | undefined;
}) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const te = useTranslations("errors");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  /** The draft: text runs and tokens, the skill token among them. */
  const [segments, setSegments] = useState<ComposerSegment[]>(initialDraft?.segments ?? []);
  const segmentsNow = useRef(segments);
  segmentsNow.current = segments;
  /** The skill picked last, as listed (its argument hint); the skill token names it by id. */
  const [pickedSkill, setPickedSkill] = useState<InvocableSkill | null>(
    initialDraft?.skill ?? null,
  );
  /** The tokens the last send was refused for (composer inline tokens spec §3.4). */
  const [refused, setRefused] = useState<RefusedToken[]>(initialDraft?.refused ?? []);
  const editor = useRef<ComposerEditorHandle | null>(null);
  const [pickingFiles, setPickingFiles] = useState(false);
  /** The device cannot list its project files: the + row shows why, disabled. */
  const [listUnsupported, setListUnsupported] = useState<string | null>(null);
  const qc = useQueryClient();
  /** The agent's invocable skills (read again when the menu opens once they are stale). */
  const skillsQ = invocableSkillsQuery(orgId, agentId ?? "", conversationId, project);
  // Read when the menu opens or a typed `/name` is sent (`loadSkills`), or prefetched with the page.
  const skills = useQuery({ ...skillsQ, enabled: false }).data;
  // The `/` menu's prompts, read when it opens (`openMenu`).
  const prompts = useQuery({ ...connectorPromptsQuery(orgId), enabled: false }).data;
  // The rendered text goes into the input: nothing cached changes.
  const { mutateAsync: renderPrompt } = useAppMutation({
    fn: (v: { p: ConnectorPrompt; values: Record<string, string> }) =>
      renderConnectorPrompt(orgId, v.p.connectorId, v.p.name, v.values),
    invalidates: () => [],
  });
  const drafts = useDraftFiles(orgId, initialDraft?.files);
  const files = drafts.files;
  const previews = useObjectUrls(files);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The run whose suggestion was dismissed (Esc, Tab, an edit, a file): it sticks for that run. */
  const [dismissedRun, setDismissedRun] = useState<string | null>(null);
  const offered = suggestion !== undefined && suggestion.runId !== dismissedRun ? suggestion : null;
  const offeredRun = useRef<string | null>(null);
  offeredRun.current = offered?.runId ?? null;
  const dismissSuggestion = useCallback(() => {
    const run = offeredRun.current;
    if (run !== null) setDismissedRun(run);
  }, []);
  /** Files attached any way (a drop, a paste, the picker) count as typing. */
  const addFiles = (list: File[]) => {
    dismissSuggestion();
    // library file tokens count toward the per-message file cap
    drafts.add(list, distinctTokens(segmentsNow.current, "file"));
  };

  const [menu, setMenu] = useState<MenuState | null>(null);
  /** What a menu opened through `openTrigger` (a + row) lists once its trigger is reported. */
  const opening = useRef<Pick<MenuState, "scope" | "level"> | null>(null);
  const [argsFor, setArgsFor] = useState<ConnectorPrompt | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState(false);
  const draft = useRef<{ key: string; id: string } | undefined>(initialDraft?.id);
  /** A typed `/name` is being resolved (the skills read): a second ↵ waits for it. */
  const resolving = useRef(false);

  /** The draft's skill token (at most one counts), and the skill it names as listed. */
  const skillToken = segments.find((s): s is ComposerTokenData => isToken(s) && s.kind === "skill");
  const skill: InvocableSkill | null =
    skillToken === undefined
      ? null
      : pickedSkill !== null && invokeName(pickedSkill) === skillToken.id
        ? pickedSkill
        : ((skills ?? []).find((s) => invokeName(s) === skillToken.id) ?? null);

  /** Replaces the draft (the editor follows: a restore, a removal). */
  const putSegments = useCallback((next: ComposerSegment[]) => {
    segmentsNow.current = next;
    setSegments(next);
  }, []);

  // Another project (the new conversation's picker) has other files: their tokens go.
  const projectKey =
    project === undefined ? null : JSON.stringify([project.deviceId, project.name]);
  const projectAt = useRef(projectKey);
  useEffect(() => {
    if (projectAt.current === projectKey) return;
    projectAt.current = projectKey;
    const cur = segmentsNow.current;
    if (cur.some((s) => isToken(s) && s.kind === "projectFile")) {
      putSegments(withoutTokens(cur, (x) => x.kind === "projectFile"));
    }
    setPickingFiles(false);
    setListUnsupported(null);
  }, [projectKey, putSegments]);

  // A new agent (a new conversation's picker) has other skills: the skill token goes.
  // (a change, not the mount: a given-back draft keeps its token)
  const agentAt = useRef(agentId);
  useEffect(() => {
    if (agentAt.current === agentId) return;
    agentAt.current = agentId;
    const cur = segmentsNow.current;
    if (cur.some((s) => isToken(s) && s.kind === "skill")) {
      putSegments(withoutTokens(cur, (x) => x.kind === "skill"));
    }
    setPickedSkill(null);
  }, [agentId, putSegments]);

  /**
   * The agent's invocable skills. A conversation that is not the caller's (404) lists without it.
   * Failures read as no skills (typed `/name` is then sent as text).
   */
  async function loadSkills(fresh = false): Promise<InvocableSkill[]> {
    if (agentId === undefined) return [];
    const q = invocableSkillsQuery(orgId, agentId, conversationId, project);
    try {
      // The menu opening and a refusal read the list again (a person's action, not a view).
      return await qc.fetchQuery(fresh ? { ...q, staleTime: 0 } : q);
    } catch (e) {
      toast.error(errorMessage(e));
      return [];
    }
  }

  /** Nothing to send: no text, token, skill or upload (a lone "/" is the menu's trigger). */
  const isEmpty = (p: ReturnType<typeof composerMessageParts>) =>
    p.skill === undefined &&
    p.tokens.length === 0 &&
    (p.text === "" || p.text === "/") &&
    (files.length === 0 || p.text === "/");
  const empty = isEmpty(composerMessageParts(segments));

  /**
   * Runs the built-in `/compact` (shared by the typed command and the `/` menu entry): the
   * composer clears the draft it ran from and gives it back if the kernel refuses (a busy
   * conversation read from another tab).
   */
  async function runCompact(from: ComposerSegment[]) {
    if (onCompact === undefined) return;
    if (draftKey(segmentsNow.current, [], undefined) === draftKey(from, [], undefined)) {
      editor.current?.clear();
      putSegments([]);
    }
    try {
      await onCompact();
    } catch (e) {
      if (blank(segmentsNow.current)) putSegments(from);
      toast.error(errorMessage(e));
    }
  }

  async function submit() {
    // the editor's latest draft: its change may not have rendered yet (a paste right before ↵)
    const sentSegments = segmentsNow.current;
    const sentPicked = skill;
    const sent = composerMessageParts(sentSegments);
    const nothing = isEmpty(sent);
    if (sendDisabled && !nothing) onBlocked?.();
    if (drafts.blocking || sendDisabled || resolving.current) return;
    const uploads = files.flatMap((f) => (f.id !== undefined ? [{ key: f.key, id: f.id }] : []));
    if (nothing) return;
    // The built-in /compact command (context compaction spec §4.10), before the skill lookup: no
    // arguments, no user message. A skill token owns the text after it, so it is not a command
    // then.
    if (onCompact !== undefined && sent.skill === undefined && sent.tokens.length === 0) {
      const command = parseSlashCommand(sent.text);
      if (command !== null && command.name === "compact") {
        if (command.args !== "") toast.error(t("compactNoArgs"));
        else if (running) toast.error(t("compactBusy"));
        else await runCompact(sentSegments);
        return;
      }
    }
    const fileIds = uploads.map((f) => f.id);
    const shownFiles = files
      .filter((f) => f.id !== undefined)
      .map((f) => ({
        name: f.name,
        kind:
          f.file && fileContentType(f.file).startsWith("image/")
            ? ("image" as const)
            : ("file" as const),
        // a library file has no local blob: its chip shows the type badge
        ...(f.library ? { type: typeBadge(f.name, f.contentType ?? "") } : {}),
      }));
    // the skill token, else a typed `/name args` naming a listed skill (spec §3.2)
    let invoke = sent.skill;
    let args = sent.text;
    let shown = sent.shown;
    let typedInvoke = false;
    if (invoke === undefined) {
      const typed = parseSlashCommand(sent.text);
      if (typed !== null) {
        resolving.current = true;
        const list = skills ?? (await loadSkills().finally(() => (resolving.current = false)));
        resolving.current = false;
        const found = findInvocable(list, typed.name);
        if (found !== undefined) {
          // a project skill typed by its bare name is invoked as `project:<name>`
          invoke = found.source === "project" ? found.name : typed.name;
          args = typed.args;
          shown = dropCommand(sent.shown, sent.text.length - typed.args.length);
          typedInvoke = true;
        }
      }
    }
    // The composer clears now, with the pending bubble in the same render (conversation send
    // spec §2.1; a typed `/name` first resolves, review fix 4): the message shows where it was
    // sent and comes back here if the kernel refuses it. Only the draft that was sent is cleared
    // (the person may have typed on while the skills were read).
    if (draftKey(segmentsNow.current, [], undefined) === draftKey(sentSegments, [], undefined)) {
      editor.current?.clear();
      putSegments([]);
    }
    setRefused([]);
    const taken = drafts.take(uploads.map((f) => f.key));
    const restore = (marks: RefusedToken[]) => {
      // a skill picked while the send was out gives way to the sent one: one skill per message
      const sentSkill = sentSegments.some((x) => isToken(x) && x.kind === "skill");
      const cur = sentSkill
        ? withoutTokens(segmentsNow.current, (x) => x.kind === "skill")
        : segmentsNow.current;
      putSegments(blank(cur) ? sentSegments : normalize([...sentSegments, "\n", ...cur]));
      setPickedSkill((p) => p ?? sentPicked);
      setRefused(marks);
      drafts.restore(taken);
    };
    const message = (
      text: string,
      tokens: MessageToken[],
      name: string | undefined,
      bubble: ComposerSegment[],
    ): ComposerMessage => {
      const key = draftKey(sentSegments, fileIds, name);
      if (draft.current?.key !== key) draft.current = { key, id: newClientMessageId() };
      return {
        text,
        clientMessageId: draft.current.id,
        ...(tokens.length > 0 ? { tokens } : {}),
        files: fileIds,
        ...(name !== undefined ? { skill: { name } } : {}),
        // the chip shows the bare name, as the thread's bubble does
        display: {
          files: shownFiles,
          ...(tokens.length > 0 ? { segments: bubble } : {}),
          ...(name !== undefined ? { skill: skillChipLabel(name) } : {}),
        },
        draft: {
          segments: sentSegments,
          skill: sentPicked,
          files: taken,
          id: draft.current,
        },
      };
    };
    try {
      let r = await onSend(message(args, sent.tokens, invoke, shown));
      if (
        !r.ok &&
        typedInvoke &&
        r.error instanceof ApiClientError &&
        r.error.code === "skill.not_invocable" &&
        (r.error.rawDetails[0] as { reason?: unknown } | undefined)?.reason === "not_found"
      ) {
        // A typed `/name` from a stale list (the skill was deselected since it was read): an
        // unknown name is sent as text (spec §3.2), and the list is read again. Any other refusal
        // (a project skill the project cannot serve now, ...) keeps the draft and says why.
        void loadSkills(true);
        r = await onSend(message(sent.text, sent.tokens, undefined, sent.shown));
      }
      if (r.ok) {
        draft.current = undefined;
      } else {
        const marks = refusedTokens(r.error, sentSegments);
        restore(marks);
        // the agent's connectors changed under the menu: read them again
        if (
          agentId !== undefined &&
          marks.some((x) => x.kind === "connector" || x.kind === "resource")
        )
          void qc.invalidateQueries({ queryKey: keys.org(orgId).mentionableConnectors(agentId) });
        drafts.markFailed(r.error);
      }
    } catch (e) {
      restore([]);
      throw e;
    }
  }

  /** Opens a menu and reads what it lists. */
  function openMenu(next: MenuState) {
    setMenu(next);
    if (next.kind === "slash") {
      void loadSkills(true);
      qc.fetchQuery(connectorPromptsQuery(orgId)).catch((e) => toast.error(errorMessage(e)));
    }
  }

  /** The editor takes the focus again (a click moved it), never on a touch device (keyboard). */
  const refocus = () => {
    if (!isTouchPointer()) focusText();
  };

  /**
   * The editor's trigger at the caret (composer inline tokens spec §2): `/` or `@` typed at the
   * start or after whitespace opens its menu, the text after it is the query, and the menu goes
   * with the trigger. A menu opened without a trigger (+) is left to the edits (`onChange`).
   */
  function onTrigger(tr: ComposerTrigger | null) {
    if (tr === null) {
      setMenu((cur) => (cur?.trigger ? null : cur));
      return;
    }
    const kind = tr.trigger === "@" ? "at" : "slash";
    // what a + row asked the new menu to list, taken once here: the updater below stays pure
    // (StrictMode calls it twice)
    const following = menu?.trigger === true && menu.kind === kind;
    const extra = following ? {} : (opening.current ?? {});
    if (!following) opening.current = null;
    setMenu((cur) =>
      cur?.trigger && cur.kind === kind
        ? { ...cur, q: tr.query, atStart: tr.atStart }
        : { kind, trigger: true, q: tr.query, atStart: tr.atStart, ...extra },
    );
    if (kind === "slash" && !(menu?.trigger && menu.kind === "slash")) {
      void loadSkills(true);
      qc.fetchQuery(connectorPromptsQuery(orgId)).catch((e) => toast.error(errorMessage(e)));
    }
  }

  /** + (or the footer's `/`): the `/` menu, its trigger typed at the caret. */
  function openSlash() {
    setMenu(null);
    opening.current = null;
    editor.current?.openTrigger("/");
    refocus();
  }

  /**
   * + (or the footer's `@`): the `@` menu, its trigger typed at the caret; `files` lists only the
   * library's files (+ → File library), `level` opens straight on a connector's resources.
   */
  function openAt(extra: Pick<MenuState, "scope" | "level"> = {}) {
    setMenu(null);
    opening.current = extra;
    editor.current?.openTrigger("@");
    refocus();
  }

  /**
   * Puts a token where the open trigger and its query stand (or at the caret for a menu opened
   * without one), the menu closing. A kind at its cap says so instead.
   */
  function insert(token: ComposerTokenData) {
    const cur = segmentsNow.current.filter(isToken);
    const already = cur.some((x) => x.kind === token.kind && x.id === token.id);
    // the kernel caps the tokens array itself (one marker each): a repeat counts too
    if (token.kind !== "skill" && tokenCount(segmentsNow.current) >= MAX_TOKENS) {
      toast.error(t("tokenTotalLimit", { max: MAX_TOKENS }));
      return;
    }
    if (!already && token.kind !== "skill") {
      const cap = MAX_OF_KIND[token.kind];
      const ofKind = distinctTokens(segmentsNow.current, token.kind);
      if (cap !== undefined && ofKind >= cap) {
        toast.error(t("tokenLimit", { max: cap }));
        return;
      }
      // file tokens and uploads share the per-message file cap
      const max = drafts.limits.maxPerMessage;
      if (token.kind === "file" && ofKind + files.length >= max) {
        toast.error(t("filesLimit", { max }));
        return;
      }
    }
    const m = menu;
    setMenu(null);
    dismissSuggestion();
    editor.current?.insertToken(
      token,
      m?.trigger ? { trigger: m.kind === "at" ? "@" : "/", length: m.q.length + 1 } : undefined,
    );
    refocus();
  }

  /** Closes the menu (Esc, a pick that inserts nothing): a trigger's stays closed until retyped. */
  function closeMenu() {
    if (menu?.trigger) editor.current?.dismissTrigger();
    setMenu(null);
  }

  async function insertPrompt(p: ConnectorPrompt, values: Record<string, string>) {
    setRendering(true);
    try {
      const r = await renderPrompt({ p, values });
      // where the `/` and its query stood; the rest of the draft stays
      editor.current?.insertText(r.text);
      setArgsFor(null);
      // the arguments dialog had the focus: the text box takes it back (never on touch)
      refocus();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRendering(false);
    }
  }

  function pickPrompt(p: ConnectorPrompt) {
    // the typed `/` and its query leave the draft (the rendered prompt replaces it later)
    if (menu?.trigger) editor.current?.setTriggerQuery(menu.q.length + 1, "");
    closeMenu();
    if (p.arguments.length === 0) {
      void insertPrompt(p, {});
      return;
    }
    setArgs({});
    setArgsFor(p);
  }

  // What the menus list. The connectors give the `/` menu's prompt rows their icons; the `@` menu
  // lists the agent's connectors, and its files, conversations and a connector's resources are
  // searched on the kernel as the query rests.
  const query = menu?.q ?? "";
  const connectorList = useQuery({
    ...connectorsQuery(orgId),
    enabled: menu?.kind === "slash",
  }).data?.connectors;
  const wantsConnectors = menu !== null && menu.kind !== "slash" && agentId !== undefined;
  const mentionableQ = useQuery({
    ...mentionableConnectorsQuery(orgId, agentId ?? ""),
    enabled: wantsConnectors,
  });
  const mentionable = mentionableQ.data;
  const atQuery = menu?.kind === "at" ? query.trim() : "";
  const searched = useDebounced(atQuery, RESOURCE_SEARCH_DELAY_MS);
  const level = menu?.kind === "at" ? menu.level : undefined;
  const firstLevel = menu?.kind === "at" && level === undefined;
  const showFiles = firstLevel && (menu.scope === undefined || menu.scope === "files");
  // the agent's connectors and the sender's conversations: only in the whole `@` menu
  const showConnectors = firstLevel && menu.scope === undefined;
  const showConversations = firstLevel && menu.scope === undefined;
  const resourcesQ = useQuery({
    ...connectorResourcesQuery(orgId, level?.id ?? "", searched),
    enabled: level !== undefined,
    placeholderData: keepPreviousData,
  });
  const resources = resourcesQ.data;
  // The library's files matching the same rested query (composer menus §4), their own cache entry.
  const filesQ = useQuery({
    ...libraryFileSearchQuery(orgId, searched),
    enabled: showFiles,
    placeholderData: keepPreviousData,
  });
  // The sender's conversations whose title matches the same rested query, their own cache entry.
  const conversationsQ = useQuery({
    ...conversationMentionQuery(orgId, searched),
    enabled: showConversations,
    placeholderData: keepPreviousData,
  });
  // The query the shown files answer (placeholder rows are an earlier query's): it names the group.
  const [filesFor, setFilesFor] = useState("");
  const filesSettled = filesQ.data !== undefined && !filesQ.isPlaceholderData;
  useEffect(() => {
    if (filesSettled) setFilesFor(searched);
  }, [filesSettled, searched]);
  const timeZone = useTimeZone();
  const now = useNow();
  // The rows are an earlier query's (the query has not rested yet, or its answer is on its way):
  // the menu filters them by the query itself, so ↵ never picks a row the query no longer
  // matches.
  const staleRows =
    searched !== atQuery ||
    (level !== undefined && resourcesQ.isPlaceholderData) ||
    (showFiles && filesQ.isPlaceholderData) ||
    (showConversations && conversationsQ.isPlaceholderData);
  const connectorById = new Map<string, ConnectorSummary>(
    (connectorList ?? []).map((c) => [c.id, c]),
  );
  /** A connector's mark: its plugin's icon, else its initial. */
  const markOf = (connectorId: string, name: string): NonNullable<ComposerMenuItem["mark"]> => {
    const icon = connectorById.get(connectorId)?.icon;
    return { text: name, ...(icon ? { image: icon } : {}) };
  };

  const unavailableGroup = (list: ConnectorUnavailable[] | undefined): ComposerMenuGroup[] =>
    list && list.length > 0
      ? [
          {
            id: "unavailable",
            label: t("unavailableConnectors"),
            items: list.map((u) => ({
              id: u.connectorId,
              label: u.connectorName,
              mark: markOf(u.connectorId, u.connectorName),
              badge: t(`connectorUnavailable.${u.reason}`),
              onSelect: () => {
                closeMenu();
                toast.error(
                  t(`connectorUnavailableHint.${u.reason}`, { connector: u.connectorName }),
                );
              },
            })),
          },
        ]
      : [];

  const byConnector = <T extends { connectorId: string; connectorName: string }>(items: T[]) => {
    const groups = new Map<string, { id: string; label: string; items: T[] }>();
    for (const it of items) {
      const g = groups.get(it.connectorId) ?? {
        id: it.connectorId,
        label: it.connectorName,
        items: [],
      };
      g.items.push(it);
      groups.set(it.connectorId, g);
    }
    return [...groups.values()];
  };

  const skillItem = (sk: InvocableSkill): ComposerMenuItem => {
    const tags = [
      ...(sk.manual ? [t("skillTag.manual")] : []),
      ...(sk.fork ? [t("skillTag.fork")] : []),
    ];
    // a plugin's skill names its plugin first ("superpowers · Think before building"); a project
    // skill shows its bare name and names the project the same way
    const description = [
      ...(sk.plugin !== undefined ? [sk.plugin] : []),
      ...(sk.source === "project" ? [t("skillSourceTag.project")] : []),
      ...tags,
      ...(sk.description !== "" ? [sk.description] : []),
    ].join(" · ");
    return {
      id: sk.id,
      label: skillShownName(sk),
      icon: "skills",
      ...(sk.argumentHint !== undefined ? { hint: sk.argumentHint } : {}),
      // one skill per message (composer inline tokens spec): with a skill token in the draft the
      // others say so, disabled
      ...(skillToken !== undefined
        ? { disabled: true, description: t("composerMenu.oneSkill") }
        : description !== ""
          ? { description }
          : {}),
      ...(sk.plugin !== undefined ? { keywords: [`${sk.plugin}:${sk.name}`] } : {}),
      // `project:` still finds a project skill
      ...(sk.source === "project" ? { keywords: [sk.name] } : {}),
      onSelect: () => {
        setPickedSkill(sk);
        insert({ kind: "skill", id: invokeName(sk), label: skillShownName(sk) });
      },
    };
  };

  /** The `/` menu: skills by source, connector prompts by connector, unavailable connectors. */
  const slashContent = (): ComposerMenuGroup[] => [
    // a heading per source (project root §4.6): the conversation's project first, then the
    // agent's own, the library's and the plugins'
    ...SKILL_SOURCES.flatMap((source) => {
      const items = (skills ?? []).filter((sk) => sk.source === source);
      return items.length === 0
        ? []
        : [
            {
              id: `skills-${source}`,
              label: t(`skillSource.${source}`),
              items: items.map(skillItem),
            },
          ];
    }),
    ...byConnector(prompts?.prompts ?? []).map((g) => ({
      id: `prompts-${g.id}`,
      label: g.label,
      items: g.items.map(
        (p): ComposerMenuItem => ({
          id: p.name,
          label: p.name,
          mark: markOf(p.connectorId, p.connectorName),
          keywords: [`${p.connectorSlug}:${p.name}`, ...(p.title ? [p.title] : [])],
          ...(p.description ? { description: p.description } : {}),
          onSelect: () => pickPrompt(p),
        }),
      ),
    })),
    ...unavailableGroup(prompts?.unavailable),
  ];

  /** A library file's muted line: when it came and how ("Research assistant, generated 2026-11-20"). */
  const fileDescription = (f: LibraryFileView): string => {
    const how = t(`composerMenu.fileOrigin.${f.origin}`, {
      date: formatDateTime(f.createdAt, "full", timeZone).slice(0, 10),
    });
    return f.origin !== "upload" && f.agentName !== undefined && f.agentName !== ""
      ? t("composerMenu.fileByAgent", { agent: f.agentName, how })
      : how;
  };

  /** A connector's token: its icon through the kernel's icon route, its initial otherwise. */
  const connectorToken = (c: MentionableConnector): ComposerTokenData => ({
    kind: "connector",
    id: c.id,
    label: c.name,
    icon: { initial: c.name, ...(c.icon ? { src: c.icon } : {}) },
  });

  /**
   * A connector row (composer inline tokens spec §4): its icon, its name, its description (or
   * "Connect your account first"); waiting for setup it is disabled with its Needs setup badge;
   * with readable resources a → opens them. The row's pick inserts the connector's token.
   */
  const connectorItem = (c: MentionableConnector, fromPlus: boolean): ComposerMenuItem => {
    const waiting = c.state === "needs_config";
    const description =
      c.credential === "missing"
        ? t("composerMenu.connectYourAccount")
        : mentionableDescriptionOf(c, locale);
    return {
      id: `connector:${c.id}`,
      label: c.name,
      mark: { text: c.name, ...(c.icon ? { image: c.icon } : {}) },
      keywords: [c.slug],
      ...(description !== undefined && description !== "" ? { description } : {}),
      ...(waiting ? { disabled: true, badge: t("composerMenu.needsConfig") } : {}),
      ...(c.resources && !waiting
        ? {
            drill: {
              label: t("composerMenu.drill", { name: c.name }),
              onDrill: () => (fromPlus ? openAt({ level: c }) : drillInto(c)),
            },
          }
        : {}),
      onSelect: () => insert(connectorToken(c)),
    };
  };

  /** The `@` menu's second level: the connector's resources, its query typed after the `@`. */
  function drillInto(c: MentionableConnector) {
    if (menu === null || !menu.trigger) return;
    // the text after `@` that named the connector goes (the `@` stays): typing filters resources
    editor.current?.setTriggerQuery(menu.q.length, "");
    setMenu({ ...menu, q: "", level: c });
  }

  /** The agent's connectors matching the query, best first, at most {@link CONNECTOR_ROWS}. */
  const connectorsGroup = (): ComposerMenuGroup[] => {
    const q = atQuery;
    const list = (mentionable ?? [])
      .map((c, i) => ({
        c,
        i,
        score:
          q === ""
            ? 1
            : commandScore(
                {
                  label: c.name,
                  search: c.slug,
                  ...(mentionableDescriptionOf(c, locale) !== undefined
                    ? { description: mentionableDescriptionOf(c, locale) as string }
                    : {}),
                },
                q,
              ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, CONNECTOR_ROWS)
      .map((x) => connectorItem(x.c, false));
    return list.length === 0
      ? []
      : [{ id: "connectors", label: t("composerMenu.connectorsGroup"), items: list }];
  };

  /** The `@` menu's files group: Recent files for the empty query, else Matching files. */
  const filesGroup = (): ComposerMenuGroup[] => {
    const list = filesQ.data?.files ?? [];
    if (list.length === 0) return [];
    return [
      {
        id: "files",
        label: filesFor === "" ? t("composerMenu.recentFiles") : t("composerMenu.matchingFiles"),
        items: list.map(
          (f): ComposerMenuItem => ({
            id: f.id,
            label: f.name,
            file: { name: f.name },
            // without storage no file can be sent: the rows say why, disabled
            ...(drafts.limits.available
              ? { description: fileDescription(f) }
              : { disabled: true, description: t("filesUnavailable") }),
            onSelect: () =>
              insert({
                kind: "file",
                id: f.id,
                label: f.name,
                icon: { fileType: typeBadge(f.name, f.contentType) },
              }),
          }),
        ),
      },
    ];
  };

  /**
   * The `@` menu's conversations group (@ conversations spec §3): the sender's matching
   * conversations, newest first, without the one written in and those already in the draft, at
   * most {@link CONVERSATION_MENTION_ROWS}; with {@link MAX_CONVERSATION_REFS} in the draft the
   * rows are disabled and say why.
   */
  const conversationsGroup = (): ComposerMenuGroup[] => {
    const inDraft = new Set(
      segments.flatMap((s) => (isToken(s) && s.kind === "conversation" ? [s.id] : [])),
    );
    const list = (conversationsQ.data?.conversations ?? [])
      .filter((c) => c.id !== conversationId && !inDraft.has(c.id))
      .slice(0, CONVERSATION_MENTION_ROWS);
    if (list.length === 0) return [];
    const full = inDraft.size >= MAX_CONVERSATION_REFS;
    return [
      {
        id: "conversations",
        label: t("composerMenu.conversations"),
        items: list.map((c): ComposerMenuItem => {
          const when = formatRelative(c.updatedAt, locale, now);
          const title = c.title || t("composerMenu.untitledConversation");
          return {
            id: `conversation:${c.id}`,
            label: title,
            icon: "chats",
            ...(full
              ? {
                  disabled: true,
                  description: t("composerMenu.conversationLimit", { max: MAX_CONVERSATION_REFS }),
                }
              : { description: c.agent ? `${c.agent.name} · ${when}` : when }),
            onSelect: () => insert({ kind: "conversation", id: c.id, label: title }),
          };
        }),
      },
    ];
  };

  /** A connector's resources (the second level), as the kernel lists them for the query. */
  const resourcesGroups = (c: MentionableConnector): ComposerMenuGroup[] => {
    const list = (resources?.resources ?? []).slice(0, MAX_RESOURCE_ROWS);
    const mark = { text: c.name, ...(c.icon ? { image: c.icon } : {}) };
    return [
      ...(list.length > 0
        ? [
            {
              id: `resources-${c.id}`,
              items: list.map(
                (r): ComposerMenuItem => ({
                  id: r.uri,
                  label: r.name,
                  description: r.description ?? r.uri,
                  mark,
                  onSelect: () =>
                    insert({
                      kind: "resource",
                      id: resourceId(r.connectorId, r.uri),
                      label: r.name,
                      icon: { initial: c.name, ...(c.icon ? { src: c.icon } : {}) },
                    }),
                }),
              ),
            },
          ]
        : []),
    ];
  };

  /** The `@` menu: the agent's connectors, the library's files, the sender's conversations. */
  const atContent = (m: MenuState): ComposerMenuGroup[] => {
    if (m.level !== undefined) return resourcesGroups(m.level);
    const filesRows = showFiles ? filesGroup() : [];
    if (m.scope === "files") return filesRows;
    return [
      ...(showConnectors ? connectorsGroup() : []),
      ...filesRows,
      ...(showConversations ? conversationsGroup() : []),
    ];
  };

  /** The + menu (spec §2, inline tokens §4): Add, Abilities, then the agent's connectors. */
  const plusContent = (): ComposerMenuGroup[] => [
    {
      id: "add",
      label: t("composerMenu.add"),
      items: [
        {
          id: "upload",
          label: t("composerMenu.upload"),
          icon: "upload",
          ...(drafts.limits.available
            ? {}
            : { disabled: true, description: t("filesUnavailable") }),
          onSelect: () => {
            setMenu(null);
            fileInput.current?.click();
          },
        },
        {
          id: "library",
          label: t("composerMenu.library"),
          icon: "file-text",
          ...(drafts.limits.available
            ? {}
            : { disabled: true, description: t("filesUnavailable") }),
          onSelect: () => openAt({ scope: "files" }),
        },
        ...(project !== undefined
          ? [
              {
                id: "project-files",
                label: t("composerMenu.projectFiles"),
                icon: "folder",
                description:
                  listUnsupported ?? t("composerMenu.projectFilesHint", { project: project.name }),
                ...(listUnsupported !== null ? { disabled: true } : {}),
                onSelect: () => {
                  setMenu(null);
                  setPickingFiles(true);
                },
              } satisfies ComposerMenuItem,
            ]
          : []),
      ],
    },
    {
      id: "abilities",
      label: t("composerMenu.abilities"),
      items: [
        { id: "skills", label: t("composerMenu.skills"), icon: "skills", onSelect: openSlash },
      ],
    },
    {
      id: "connectors",
      label: t("composerMenu.connectors"),
      items: (mentionable ?? []).map((c) => connectorItem(c, true)),
    },
  ];

  const contentGroups: ComposerMenuGroup[] =
    menu === null
      ? []
      : menu.kind === "slash"
        ? slashContent()
        : menu.kind === "at"
          ? atContent(menu)
          : plusContent();

  // The built-in /compact command (context compaction spec §4.10) is in the `/` menu only while
  // the `/` is the whole draft, after what the agent offers (a command never takes the first
  // Enter meant for a skill: the groups keep their order whatever the query). With nothing
  // invocable the "no skills selected" guidance (spec §5 rule 11) stands below the list, next to
  // the command; `/compact` is also still typed and parsed.
  const wholeDraft =
    menu?.kind === "slash" &&
    menu.trigger &&
    menu.atStart === true &&
    segments.every((s) => typeof s === "string") &&
    segments.join("").trim() === `/${menu.q}`;
  const commandGroup: ComposerMenuGroup | null =
    wholeDraft && onCompact !== undefined
      ? {
          id: "commands",
          label: t("commandsGroup"),
          items: [
            {
              id: "compact",
              label: "compact",
              icon: "terminal",
              description: t("compactCommandHint"),
              onSelect: () => {
                const from = segmentsNow.current;
                closeMenu();
                if (running) {
                  toast.error(t("compactBusy"));
                  return;
                }
                void runCompact(from);
              },
            },
          ],
        }
      : null;
  const groups: ComposerMenuGroup[] =
    commandGroup !== null ? [...contentGroups, commandGroup] : contentGroups;
  // Nothing to invoke (a skill or a prompt): the guidance stands under the list (next to the
  // command when there is one, else as the empty line with the link under it).
  const noInvocable = menu?.kind === "slash" && contentGroups.length === 0;
  const guidance = skillsHref !== undefined ? t("noInvocable") : t("noInvocableReadOnly");
  const guidanceAction =
    skillsHref !== undefined ? { label: t("noInvocableAction"), href: skillsHref } : undefined;
  // The `@` menu loads while a source it lists is on its way; it fails as a whole only when every
  // source it lists failed (then the empty line is the reason).
  const libraryFailed = showFiles && filesQ.isError;
  const connectorsFailed = showConnectors && mentionableQ.isError;
  const resourcesFailed = level !== undefined && resourcesQ.isError;
  const conversationsFailed = showConversations && conversationsQ.isError;
  const resting = searched !== atQuery;
  const atLoading =
    (showFiles && !filesQ.isError && (filesQ.isFetching || resting)) ||
    (showConnectors && mentionableQ.isFetching) ||
    (showConversations && !conversationsQ.isError && (conversationsQ.isFetching || resting)) ||
    (level !== undefined && !resourcesQ.isError && (resourcesQ.isFetching || resting));
  const failures = [
    ...(connectorsFailed
      ? [t("composerMenu.connectorsFailed", { reason: errorMessage(mentionableQ.error) })]
      : []),
    ...(libraryFailed
      ? [t("composerMenu.libraryFailed", { reason: errorMessage(filesQ.error) })]
      : []),
    ...(conversationsFailed
      ? [t("composerMenu.conversationsFailed", { reason: errorMessage(conversationsQ.error) })]
      : []),
  ];
  const sources = (showConnectors ? 1 : 0) + (showFiles ? 1 : 0) + (showConversations ? 1 : 0);
  const everyFailed =
    level !== undefined ? resourcesFailed : sources > 0 && failures.length === sources;
  const atEmpty = (): string => {
    if (level !== undefined)
      return resourcesFailed
        ? t("composerMenu.resourcesFailed", { reason: errorMessage(resourcesQ.error) })
        : t("composerMenu.noResources", { name: level.name });
    if (everyFailed)
      return errorMessage(
        connectorsFailed ? mentionableQ.error : libraryFailed ? filesQ.error : conversationsQ.error,
      );
    return t(
      menu?.kind === "at" && menu.scope === "files"
        ? "composerMenu.noFiles"
        : "composerMenu.noAtMatch",
    );
  };
  const menuProps: ComposerMenuProps | null =
    menu === null
      ? null
      : {
          kind: menu.kind,
          groups,
          query: menu.kind === "at" ? atQuery : query,
          // the `@` menu's server rows are the kernel's matches already (its connectors are
          // filtered here), unless they are an earlier query's
          filter: menu.kind !== "at" || staleRows,
          loading: menu.kind === "at" && atLoading,
          empty:
            menu.kind === "at"
              ? atEmpty()
              : noInvocable && commandGroup === null
                ? guidance
                : t("composerMenu.noMatch"),
          // some sources failed and others did not: the failures are said under the rows
          ...(menu.kind === "at" && level === undefined && !everyFailed && failures.length > 0
            ? { notice: { text: failures.join(" ") } }
            : {}),
          ...(noInvocable
            ? commandGroup !== null
              ? {
                  notice: { text: guidance, ...(guidanceAction ? { action: guidanceAction } : {}) },
                }
              : guidanceAction
                ? { notice: { action: guidanceAction } }
                : {}
            : {}),
          ...(level !== undefined
            ? {
                level: {
                  title: t("composerMenu.resourcesHead", { name: level.name }),
                  onBack: () =>
                    setMenu((cur) => {
                      if (cur === null) return cur;
                      const { level: _level, ...rest } = cur;
                      return rest;
                    }),
                },
              }
            : {}),
          onClose: closeMenu,
          onSwitch: (kind) => (kind === "at" ? openAt() : openSlash()),
          onQueryChange: (q) => {
            if (!menu.trigger) {
              setMenu({ ...menu, q });
              return;
            }
            // the sheet's search field types into the query after the trigger
            editor.current?.setTriggerQuery(menu.q.length, q);
          },
          searchLabel: t("composerMenu.search"),
        };
  const menuController = useComposerMenu(menuProps);

  const missingArgs =
    argsFor?.arguments.filter((a) => a.required && (args[a.name] ?? "").trim() === "") ?? [];

  /** A refusal's line for its token: the error's own copy (`errors.<code>[.<reason>]`). */
  const refusalCopy = (r: RefusedToken): string => {
    if (!te.has(r.code)) return te("unknown");
    const copy: unknown = te.raw(r.code);
    if (typeof copy === "string") return te(r.code);
    const entries = (copy ?? {}) as Record<string, unknown>;
    if (r.reason !== undefined && typeof entries[r.reason] === "string")
      return te(`${r.code}.${r.reason}`);
    return typeof entries.default === "string" ? te(`${r.code}.default`) : te("unknown");
  };
  // The refusal marks (composer inline tokens spec §1): only for tokens still in the draft.
  const marked = segments.filter(isToken);
  const refusedNow = refused.filter((r) => marked.some((x) => x.kind === r.kind && x.id === r.id));
  const refusalOf = (x: ComposerTokenData) =>
    refusedNow.find((r) => r.kind === x.kind && r.id === x.id);
  const shownSegments = segments.map((s): ComposerSegment => {
    if (!isToken(s)) return s;
    const { state: _state, reason: _reason, ...plain } = s;
    const r = refusalOf(s);
    return r === undefined ? plain : { ...plain, state: "refused", reason: refusalCopy(r) };
  });
  const refusedCount = new Set(refusedNow.map((r) => `${r.kind}:${r.id}`)).size;
  const firstRefused = shownSegments.find(
    (s): s is ComposerTokenData => isToken(s) && s.state === "refused",
  );

  const strip: AttachmentStripItem[] = files.map((f): AttachmentStripItem => {
    const type = f.file ? fileContentType(f.file) : (f.contentType ?? "");
    const src = previews.get(f.key);
    return {
      id: f.key,
      // a library image has no local preview: it shows as a file with its type mark
      kind: type.startsWith("image/") && f.status !== "error" && !f.library ? "image" : "file",
      name: f.name,
      contentType: type,
      size: f.size,
      ...(src !== undefined ? { src } : {}),
      ...(f.status === "uploading" ? { progress: f.progress } : {}),
      ...(f.status === "error" ? { error: drafts.errorText(f) } : {}),
      ...(drafts.canRetry(f) ? { onRetry: () => drafts.retry(f.key) } : {}),
      onRemove: () => drafts.remove(f.key),
    };
  });

  const hint =
    waiting === "skip"
      ? t("waitingSkipHint")
      : waiting === "hold"
        ? t("waitingHint")
        : running
          ? t("runningHint")
          : undefined;
  const runState = useRunStateValue().state;
  // A pending composer frame hides the composer for up to 1.5 s (focus() is a no-op then): the
  // focus waits for the reveal or the winner's composer (client extensions spec §6.3)
  const cancelFocus = useRef<() => void>(() => {});
  const focusText = useCallback(() => {
    cancelFocus.current();
    cancelFocus.current = focusWhenPossible(() => {
      const handle = editor.current;
      if (handle === null) return null;
      handle.focus();
      const active = document.activeElement;
      return active instanceof HTMLElement && active.matches(COMPOSER_INPUT) ? active : null;
    });
  }, []);
  useEffect(() => () => cancelFocus.current(), []);
  useImperativeHandle(
    control,
    () => ({
      fill(next: string) {
        // a fill (a quick action) is an edit: the suggestion goes for this run; the draft it
        // replaced is one undo step in the editor
        dismissSuggestion();
        editor.current?.replace([next]);
        // on a touch device the text is only placed, never focused (focus would pop the keyboard
        // for a tap on a quick action)
        if (!isTouchPointer()) focusText();
      },
      focus() {
        focusText();
      },
    }),
    [focusText, dismissSuggestion],
  );

  // The built-in composer: framed, the frame slot's default; bare (`frame={false}`), the inputs a
  // replacement wraps in its own frame (the host checks after commit that the composer's text box
  // is in the document). A replacement renders one of the two.
  const composer = (frame: boolean) => (
    <ComposerBox
      frame={frame}
      segments={shownSegments}
      onChange={(next) => {
        // any edit ends the suggestion for this run, also one that empties the draft
        dismissSuggestion();
        segmentsNow.current = next;
        setSegments(next);
        // a menu opened without a trigger (+) goes with any edit
        setMenu((cur) => (cur !== null && !cur.trigger ? null : cur));
      }}
      editorRef={editor}
      onTrigger={onTrigger}
      onPasteFiles={addFiles}
      onSubmit={() => void submit()}
      placeholder={placeholder}
      {...(hint !== undefined ? { hint } : {})}
      {...(skill?.argumentHint !== undefined ? { skillHint: skill.argumentHint } : {})}
      {...(firstRefused !== undefined
        ? {
            refused: {
              label:
                refusedCount > 1
                  ? `${firstRefused.label} (+${refusedCount - 1})`
                  : firstRefused.label,
              reason: firstRefused.reason ?? "",
              onRemove: () => {
                putSegments(withoutTokens(segmentsNow.current, (x) => refusalOf(x) !== undefined));
                setRefused([]);
              },
            },
          }
        : {})}
      {...(strip.length > 0
        ? {
            attachments: (
              // biome-ignore lint/a11y/useSemanticElements: a labelled group of draft files (no styles in web)
              <div role="group" aria-label={t("files")}>
                <AttachmentStrip items={strip} />
              </div>
            ),
          }
        : {})}
      // + opens the + menu (its upload row is the file picker) and closes it again
      onAttach={() => {
        if (menu?.kind === "plus") {
          setMenu(null);
          return;
        }
        // an open `/` or `@` menu closes first (its trigger stays as typed text)
        if (menu?.trigger) editor.current?.dismissTrigger();
        openMenu({ kind: "plus", trigger: false, q: "" });
        refocus();
      }}
      attachOpen={menu?.kind === "plus"}
      menu={{
        ...(menuProps !== null
          ? { node: <ComposerMenu {...menuProps} controller={menuController} /> }
          : {}),
        combobox: menuController.combobox,
        onKeyDown: menuController.onKeyDown,
      }}
      pickers={pickers}
      {...(place !== undefined ? { place } : {})}
      // one mode button before send holds the profile and the effort (from 640 up)
      {...(pickers.permission !== undefined
        ? {
            mode: modeMenuFromPickers(pickers.permission, pickers.effort, t("permission.modeHint")),
          }
        : {})}
      {...(quickActions !== undefined ? { quickActions } : {})}
      {...(agents !== undefined ? { agents } : {})}
      {...(context !== undefined ? { context } : {})}
      send={
        running && stop
          ? { mode: "stop", busy: stop.stopping, onClick: stop.onStop }
          : {
              // Never busy: the message is pending in the thread, not in the composer.
              mode: "send",
              disabled: sendDisabled === true || drafts.blocking || empty,
              onClick: () => void submit(),
            }
      }
      {...(offered !== null
        ? { suggestion: { text: offered.text, onDismiss: dismissSuggestion } }
        : {})}
    />
  );

  /** The project files already in the draft (the picker starts from none and adds tokens). */
  const projectTokens = segments.flatMap((s) =>
    isToken(s) && s.kind === "projectFile" ? [s.id] : [],
  );

  return (
    <>
      <FileDrop label={t("dropFiles")} onFiles={addFiles} disabled={!drafts.limits.available}>
        {/* a plugin may draw the frame around the composer (client extensions spec §6.2) */}
        <ExtensionSlot
          slot="conversation.composer.frame"
          args={{ orgId }}
          host={{
            builtin: composer(true),
            children: composer(false),
            conversationId: conversationId ?? null,
            runState,
          }}
        />
      </FileDrop>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        disabled={!drafts.limits.available}
        aria-label={t("addFiles")}
        accept={acceptAttribute(drafts.limits)}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length > 0) addFiles(picked);
        }}
      />
      {project !== undefined ? (
        <ProjectFilesPicker
          orgId={orgId}
          deviceId={project.deviceId}
          project={project.name}
          open={pickingFiles}
          initial={[]}
          onClose={() => {
            setPickingFiles(false);
            refocus();
          }}
          onConfirm={(paths) => {
            dismissSuggestion();
            // each picked path not in the draft yet becomes a token at the caret
            const kindRoom = MAX_PROJECT_FILES - new Set(projectTokens).size;
            const totalRoom = MAX_TOKENS - tokenCount(segmentsNow.current);
            const room = Math.max(Math.min(kindRoom, totalRoom), 0);
            const fresh = [...new Set(paths)].filter((p) => !projectTokens.includes(p));
            for (const path of fresh.slice(0, room))
              editor.current?.insertToken({ kind: "projectFile", id: path, label: path });
            if (fresh.length > room)
              toast.error(
                kindRoom <= totalRoom
                  ? t("tokenLimit", { max: MAX_PROJECT_FILES })
                  : t("tokenTotalLimit", { max: MAX_TOKENS }),
              );
          }}
          onUnsupported={(e) => {
            const reason = errorMessage(e);
            setListUnsupported(reason);
            toast.error(reason);
          }}
        />
      ) : null}
      <Dialog
        open={argsFor !== null}
        onOpenChange={(open) => {
          if (!open) setArgsFor(null);
        }}
        title={argsFor ? promptCommand(argsFor) : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setArgsFor(null)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={rendering}
              disabled={missingArgs.length > 0}
              onClick={() => argsFor && void insertPrompt(argsFor, args)}
            >
              {t("insertPrompt")}
            </Button>
          </>
        }
      >
        <Stack gap={12}>
          {argsFor?.arguments.map((a) => (
            <Field
              key={a.name}
              label={a.name}
              {...(a.required ? { required: true } : {})}
              {...(a.description ? { help: a.description } : {})}
            >
              <Input
                value={args[a.name] ?? ""}
                onChange={(e) => setArgs({ ...args, [a.name]: e.target.value })}
              />
            </Field>
          ))}
        </Stack>
      </Dialog>
    </>
  );
}
