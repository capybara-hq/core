"use client";

import {
  AttachmentStrip,
  type AttachmentStripItem,
  Button,
  ComposerBox,
  ComposerMenu,
  type ComposerMenuGroup,
  type ComposerMenuItem,
  type ComposerMenuKind,
  type ComposerMenuProps,
  Dialog,
  Field,
  FileDrop,
  Input,
  isTouchPointer,
  type PickerProps,
  Stack,
  useComposerMenu,
  useToast,
} from "@capybara-hq/design";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiClientError } from "../../lib/api";
import { acceptAttribute, fileContentType } from "../../lib/attachments";
import {
  type ConnectorPrompt,
  type ConnectorResource,
  type ConnectorSummary,
  type ConnectorUnavailable,
  connectorDescriptionOf,
  renderConnectorPrompt,
} from "../../lib/connectors";
import type { MessageInput } from "../../lib/conversations";
import { focusWhenPossible } from "../../lib/deferred-focus";
import {
  connectorPromptsQuery,
  connectorResourcesQuery,
  connectorsQuery,
  invocableSkillsQuery,
} from "../../lib/query/conversation";
import { useAppMutation } from "../../lib/query/mutation";
import {
  findInvocable,
  type InvocableSkill,
  type InvocableSource,
  parseSlashCommand,
  skillChipLabel,
} from "../../lib/skills";
import type { PromptSuggestion } from "../../lib/stream";
import { useErrorMessage } from "../../lib/use-error-message";
import { useRunStateValue } from "../client-ext/run-state";
import { ExtensionSlot } from "../extension-ui/ExtensionSlot";
import { type DraftFile, useDraftFiles } from "../use-draft-files";
import { modeMenuFromPickers } from "./PermissionPicker";
import { MAX_PROJECT_FILES, ProjectFilesPicker } from "./ProjectFilesPicker";
import type { SendResult } from "./useConversation";

/** At most this many `@` resources per message (kernel `MAX_ATTACHMENTS`). */
const MAX_ATTACHMENTS = 5;

/** An `@` resource in the draft. */
export interface DraftAttachment {
  connectorId: string;
  connectorName: string;
  uri: string;
  name: string;
}

/**
 * `clientMessageId`: `crypto.randomUUID` only exists in secure contexts (HTTPS / localhost);
 * elsewhere the same randomness from `getRandomValues`.
 */
export function newClientMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A draft's identity: text + resources + files + project files + skill (any change makes it a new
 * message).
 */
const draftKey = (
  text: string,
  attachments: DraftAttachment[],
  files: string[],
  projectFiles: string[],
  skill: string | undefined,
) =>
  JSON.stringify([
    text,
    attachments.map((a) => [a.connectorId, a.uri]),
    files,
    projectFiles,
    skill ?? null,
  ]);

/** The last segment of a project file's path (its chip's name). */
const baseName = (path: string) => path.split("/").at(-1) ?? path;

/** The paths a `conversation.project_file_unavailable` refusal names (none for another error). */
function missingProjectFiles(e: unknown): string[] {
  if (!(e instanceof ApiClientError) || e.code !== "conversation.project_file_unavailable")
    return [];
  return e.rawDetails.flatMap((d) => {
    const path = (d as { path?: unknown } | null)?.path;
    return typeof path === "string" ? [path] : [];
  });
}

/** A slash command: `/<connector slug>:<prompt name>`. */
export const promptCommand = (p: Pick<ConnectorPrompt, "connectorSlug" | "name">) =>
  `/${p.connectorSlug}:${p.name}`;

/**
 * The open composer menu (spec 2026-11-28 composer menus §1–§4): its kind; where its trigger
 * (`/` or `@`) stands in the text and where the query typed after it ends (the caret at the last
 * edit), or `at: null` for a menu opened without a trigger (+, or Skills over a draft with text),
 * whose query is `q` (the compact sheet's search field); and what an `@` menu lists.
 */
type MenuState = {
  kind: ComposerMenuKind;
  at: number | null;
  end: number;
  q: string;
  scope?: "resources" | { connectorId: string };
};

/** How long the `@` query rests before the kernel is asked (each text is its own cache entry). */
const RESOURCE_SEARCH_DELAY_MS = 200;

/** At most this many `@` rows are drawn (the kernel's matches, or one connector's of them). */
const MAX_RESOURCE_ROWS = 50;

/** `value`, once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** A menu's trigger in the text: `/` alone in the draft, `@` at the start or after whitespace. */
type Trigger = { kind: "slash" | "at"; at: number; end: number };

/** What the composer sends: the message without the switch (the caller adds model / effort). */
export type ComposerMessage = Pick<
  MessageInput,
  "text" | "clientMessageId" | "attachments" | "files" | "projectFiles" | "skill"
> & {
  /**
   * What a pending bubble shows until the log has the message (never sent): the skill's chip
   * label and the files' names.
   */
  display?: { skill?: string; files: { name: string; kind: "image" | "file" }[] };
  /**
   * The draft as it was sent, for a view that outlives this composer (the new conversation's
   * layout switch remounts it): a failed send gives it to the next composer's `initialDraft`.
   */
  draft?: ComposerDraft;
};

/**
 * A composer's draft handed from one composer to the next (text, chip, resources, files, project
 * files, id).
 */
export type ComposerDraft = {
  text: string;
  skill: InvocableSkill | null;
  attachments: DraftAttachment[];
  files: DraftFile[];
  /** Referenced project file paths (composer menus §5). */
  projectFiles?: string[];
  /** The draft's `clientMessageId`, kept for the retry (the kernel dedupes it). */
  id?: { key: string; id: string };
};

/** What a page may do to its composer from outside (the new conversation's quick actions). */
export type ComposerControl = {
  /**
   * Replaces the text with `text` and focuses the input (not on a touch device: the keyboard would
   * pop up). The text it replaced is one undo step:
   * the next ⌘Z / Ctrl+Z, before any other edit, brings it back.
   */
  fill(text: string): void;
  /** Focuses the input (a new conversation's agent was picked). */
  focus(): void;
};

/** ⌘Z on a Mac, Ctrl+Z elsewhere (either is taken: the browser's own undo also takes both). */
export const isUndoKey = (e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z";

/** The `/` menu's skill headings, in order (project root §4.6). */
const SKILL_SOURCES: readonly InvocableSource[] = ["project", "agent", "platform", "plugin"];

/** The name a picked skill is invoked by: `<plugin>:<name>` for a plugin's skill. */
const invokeName = (s: InvocableSkill) => (s.plugin ? `${s.plugin}:${s.name}` : s.name);

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
 * The composer (spec §5.2, §6.16.2): text, the attachment strip, the pickers and send / stop.
 *
 * Keys: ↵ and ⌘↵ / Ctrl+↵ send; while a run is going the message is an interjection the run takes
 * in at its next step (run input spec 2026-11-07 D1, D2; there is no queue); Shift+↵ is a newline;
 * nothing happens while an IME is composing.
 *
 * Carried over from the old composer: each draft keeps one `clientMessageId` until it is sent or
 * changed (the kernel dedupes retries); files come from +, drop or paste, upload at once and
 * block sending while uploading or failed; a send that fails keeps the draft.
 *
 * Menus (composer menus spec §1–§4): one `ComposerMenu` anchored to the composer, the textarea its
 * combobox. + lists what can be added or used (upload, connector resources, skills, the usable
 * connectors); `/` in an empty composer lists the agent's skills, the connectors' prompts and the
 * commands last; `@` at the start or after whitespace (never mid-word, never from an IME
 * composition) searches the connectors' resources on the kernel. The trigger stays in the text and
 * what follows it is the query; a pick takes both out, Esc closes and keeps the text.
 *
 * Skills (phase D spec §3): picking one shows its chip, and the text after it is the arguments
 * (Backspace at the start or the chip's × removes it and keeps the text). A draft typed as
 * `/name args` that names a listed skill is sent as its invocation; anything else as text (and a
 * typed one the kernel refuses as an unknown skill, `skill.not_invocable` `not_found`, from a stale
 * list, is resent as text; any other refusal keeps the draft and shows why). The
 * list is read for `agentId` (with `conversationId` once the conversation exists, so its trial
 * drafts apply) when the menu opens or a typed `/name` is sent.
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
  quickActions,
  agents,
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
    device?: PickerProps;
    /** The conversation's permission profile, after the device (design slot order). */
    permission?: PickerProps;
    model: PickerProps;
    effort?: PickerProps;
  };
  /** The selected agent's quick actions (`QuickActions`), after the effort picker. */
  quickActions?: ReactNode;
  /** The agent map's entry (`AgentsChip`, AC3), after the quick actions; a conversation's only. */
  agents?: ReactNode;
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
   * Its files can be referenced from the + menu (项目文件); a change of it drops the references.
   */
  project?: { deviceId: string; name: string } | undefined;
}) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    initialDraft?.attachments ?? [],
  );
  /** The picked skill (the chip), or null. */
  const [skill, setSkill] = useState<InvocableSkill | null>(initialDraft?.skill ?? null);
  /** Referenced project file paths (composer menus §5), in pick order. */
  const [projectFiles, setProjectFiles] = useState<string[]>(initialDraft?.projectFiles ?? []);
  /** Paths the kernel refused at the last send (`conversation.project_file_unavailable`). */
  const [missingFiles, setMissingFiles] = useState<readonly string[]>([]);
  const [pickingFiles, setPickingFiles] = useState(false);
  /** The device cannot list its project files: the + row shows why, disabled. */
  const [listUnsupported, setListUnsupported] = useState<string | null>(null);
  // another project (the new conversation's picker) has other files: the references go
  const projectKey =
    project === undefined ? null : JSON.stringify([project.deviceId, project.name]);
  const projectAt = useRef(projectKey);
  useEffect(() => {
    if (projectAt.current === projectKey) return;
    projectAt.current = projectKey;
    setProjectFiles([]);
    setMissingFiles([]);
    setPickingFiles(false);
    setListUnsupported(null);
  }, [projectKey]);
  const qc = useQueryClient();
  /** The agent's invocable skills (read again when the menu opens once they are stale). */
  const skillsQ = invocableSkillsQuery(orgId, agentId ?? "", conversationId);
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
    drafts.add(list);
  };

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [argsFor, setArgsFor] = useState<ConnectorPrompt | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState(false);
  const draft = useRef<{ key: string; id: string } | undefined>(initialDraft?.id);
  /** A typed `/name` is being resolved (the skills read): a second ↵ waits for it. */
  const resolving = useRef(false);
  /**
   * An IME composition is going (between compositionstart and compositionend): its intermediate
   * text never opens or closes a menu and is never searched; what it commits is checked at its end.
   * (Keys an IME commits directly, such as Shift+2 giving `@`, report keyCode 229 without a
   * composition and open the menu like any typed character.)
   */
  const composing = useRef(false);
  const [composingNow, setComposingNow] = useState(false);
  /** Where the caret goes once the text a pick left is rendered (the pick's position). */
  const caretAfter = useRef<number | null>(null);

  // A new agent (a new conversation's picker) has other skills: its chip and list go.
  // (a change, not the mount: a given-back draft keeps its chip)
  const agentAt = useRef(agentId);
  useEffect(() => {
    if (agentAt.current === agentId) return;
    agentAt.current = agentId;
    setSkill(null);
  }, [agentId]);

  /**
   * The agent's invocable skills. A conversation that is not the caller's (404) lists without it.
   * Failures read as no skills (typed `/name` is then sent as text).
   */
  async function loadSkills(fresh = false): Promise<InvocableSkill[]> {
    if (agentId === undefined) return [];
    const q = invocableSkillsQuery(orgId, agentId, conversationId);
    try {
      // The menu opening and a refusal read the list again (a person's action, not a view).
      return await qc.fetchQuery(fresh ? { ...q, staleTime: 0 } : q);
    } catch (e) {
      toast.error(errorMessage(e));
      return [];
    }
  }

  /** `@` resources or project files are attached: they need text (their blocks follow it). */
  const needsText = attachments.length > 0 || projectFiles.length > 0;
  // A lone "/" is the menu's trigger, not a message.
  const empty = (value: string) =>
    skill === null && (value === "" || value === "/") && (files.length === 0 || needsText);

  /**
   * Runs the built-in `/compact` (shared by the typed command and the `/` menu entry): the
   * composer clears the text it ran from and keeps it if the kernel refuses (a busy conversation
   * read from another tab).
   */
  async function runCompact(clearText: string) {
    if (onCompact === undefined) return;
    setText((cur) => (cur === clearText ? "" : cur));
    try {
      await onCompact();
    } catch (e) {
      setText((cur) => (cur.trim() === "" ? clearText : cur));
      toast.error(errorMessage(e));
    }
  }

  async function submit() {
    const sentText = text;
    const sentSkill = skill;
    const sentAttachments = attachments;
    const sentProjectFiles = projectFiles;
    const value = text.trim();
    if (sendDisabled && !empty(value)) onBlocked?.();
    if (drafts.blocking || sendDisabled || resolving.current) return;
    const sent = files.flatMap((f) => (f.id !== undefined ? [{ key: f.key, id: f.id }] : []));
    // Files alone can be sent; `@` resources and project files need text (their blocks follow
    // content[0]).
    if (empty(value)) return;
    // The built-in /compact command (context compaction spec §4.10), before the skill lookup: no
    // arguments, no user message. A skill chip owns the text after it, so it is not a command then.
    if (onCompact !== undefined && skill === null) {
      const command = parseSlashCommand(value);
      if (command !== null && command.name === "compact") {
        if (command.args !== "") toast.error(t("compactNoArgs"));
        else if (running) toast.error(t("compactBusy"));
        else await runCompact(sentText);
        return;
      }
    }
    const fileIds = sent.map((f) => f.id);
    const shownFiles = files
      .filter((f) => f.id !== undefined)
      .map((f) => ({
        name: f.name,
        kind:
          f.file && fileContentType(f.file).startsWith("image/")
            ? ("image" as const)
            : ("file" as const),
      }));
    // the chip, else a typed `/name args` naming a listed skill (spec §3.2)
    let invoke = skill !== null ? invokeName(skill) : undefined;
    let args = value;
    let typedInvoke = false;
    if (invoke === undefined) {
      const typed = parseSlashCommand(value);
      if (typed !== null) {
        resolving.current = true;
        const list = skills ?? (await loadSkills().finally(() => (resolving.current = false)));
        resolving.current = false;
        if (findInvocable(list, typed.name) !== undefined) {
          invoke = typed.name;
          args = typed.args;
          typedInvoke = true;
        }
      }
    }
    // The composer clears now, with the pending bubble in the same render (conversation send
    // spec §2.1; a typed `/name` first resolves, review fix 4): the message shows where it was
    // sent and comes back here if the kernel refuses it. Only what was sent is cleared (the
    // person may have typed on while the skills were read).
    setText((cur) =>
      cur === sentText
        ? ""
        : cur.startsWith(sentText)
          ? cur.slice(sentText.length).trimStart()
          : cur,
    );
    setSkill((cur) => (cur === sentSkill ? null : cur));
    setAttachments((cur) => cur.filter((a) => !sentAttachments.includes(a)));
    setProjectFiles((cur) => cur.filter((p) => !sentProjectFiles.includes(p)));
    setMissingFiles([]);
    const taken = drafts.take(sent.map((f) => f.key));
    const restore = () => {
      setText((cur) => (cur.trim() === "" ? sentText : `${sentText}\n${cur}`));
      setSkill((cur) => cur ?? sentSkill);
      setAttachments((cur) => [
        ...sentAttachments,
        ...cur.filter((a) => !sentAttachments.includes(a)),
      ]);
      setProjectFiles((cur) => [
        ...sentProjectFiles,
        ...cur.filter((p) => !sentProjectFiles.includes(p)),
      ]);
      drafts.restore(taken);
    };
    const message = (text: string, name: string | undefined): ComposerMessage => {
      const key = draftKey(text, attachments, fileIds, sentProjectFiles, name);
      if (draft.current?.key !== key) draft.current = { key, id: newClientMessageId() };
      return {
        text,
        clientMessageId: draft.current.id,
        attachments: attachments.map((a) => ({ connectorId: a.connectorId, uri: a.uri })),
        files: fileIds,
        ...(sentProjectFiles.length > 0
          ? { projectFiles: sentProjectFiles.map((path) => ({ path })) }
          : {}),
        ...(name !== undefined ? { skill: { name } } : {}),
        // the chip shows the bare name, as the thread's bubble does
        display: {
          files: [
            ...shownFiles,
            ...sentProjectFiles.map((path) => ({ name: path, kind: "file" as const })),
          ],
          ...(name !== undefined ? { skill: skillChipLabel(name) } : {}),
        },
        draft: {
          text: sentText,
          skill: sentSkill,
          attachments: sentAttachments,
          files: taken,
          projectFiles: sentProjectFiles,
          id: draft.current,
        },
      };
    };
    try {
      let r = await onSend(message(args, invoke));
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
        r = await onSend(message(value, undefined));
      }
      if (r.ok) {
        draft.current = undefined;
      } else {
        restore();
        drafts.markFailed(r.error);
        setMissingFiles(missingProjectFiles(r.error));
      }
    } catch (e) {
      restore();
      throw e;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // The one undo step of a fill: only while the text is still what the fill put there.
    const undo = undoFill.current;
    if (undo !== null && isUndoKey(e)) {
      undoFill.current = null;
      if (text === undo.text) {
        e.preventDefault();
        setText(undo.before);
        return;
      }
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
    e.preventDefault();
    // ↵ and ⌘↵ / Ctrl+↵ alike: while a run is going the message is an interjection (D1, D2).
    void submit();
  }

  /** Opens a menu and reads what it lists (the `@` menu's resources follow its query). */
  function openMenu(next: MenuState) {
    setMenu(next);
    if (next.kind === "slash") {
      void loadSkills(true);
      qc.fetchQuery(connectorPromptsQuery(orgId)).catch((e) => toast.error(errorMessage(e)));
    }
  }

  /** The text without the open menu's trigger and query (what a pick leaves). */
  const withoutTrigger = (): string =>
    menu !== null && menu.at !== null ? text.slice(0, menu.at) + text.slice(menu.end) : text;

  /** The textarea takes the focus again (a click moved it), never on a touch device (keyboard). */
  const refocus = () => {
    if (!isTouchPointer()) focusText();
  };

  /** The menu a character just put at `caret` opens, if it is a trigger there. */
  const triggerAt = (next: string, caret: number): Trigger | null => {
    if (next === "/" && caret === 1 && skill === null) return { kind: "slash", at: 0, end: 1 };
    // `@` at the start or after whitespace; `a@b` is an address
    if (next[caret - 1] === "@" && (caret === 1 || /\s/.test(next[caret - 2] ?? ""))) {
      return { kind: "at", at: caret - 1, end: caret };
    }
    return null;
  };

  function onCompositionStart() {
    composing.current = true;
    setComposingNow(true);
  }

  /** The composition committed its text: the open menu follows it, a committed trigger opens one. */
  function onCompositionEnd(e: CompositionEvent<HTMLTextAreaElement>) {
    composing.current = false;
    setComposingNow(false);
    const el = e.currentTarget;
    if (menu !== null && menu.at !== null) {
      onChange(el.value, el);
      return;
    }
    if (menu === null && (e.data === "@" || e.data === "/")) {
      const trigger = triggerAt(el.value, el.selectionStart ?? el.value.length);
      if (trigger !== null) openMenu({ ...trigger, q: "" });
    }
  }

  /** + (or the footer's `/`): the `/` menu, its trigger typed into an empty draft. */
  function openSlash() {
    const base = withoutTrigger();
    if (base === "" && skill === null) {
      setText("/");
      openMenu({ kind: "slash", at: 0, end: 1, q: "" });
    } else {
      // over a draft the picked skill's chip takes the text as its arguments
      setText(base);
      openMenu({ kind: "slash", at: null, end: 0, q: "" });
    }
    refocus();
  }

  /** + (or the footer's `@`): the `@` menu, its trigger typed at the end of the draft. */
  function openAt(scope?: MenuState["scope"]) {
    const base = withoutTrigger();
    const next = base === "" || /\s$/.test(base) ? `${base}@` : `${base} @`;
    setText(next);
    openMenu({
      kind: "at",
      at: next.length - 1,
      end: next.length,
      q: "",
      ...(scope !== undefined ? { scope } : {}),
    });
    refocus();
  }

  function onChange(next: string, el?: HTMLTextAreaElement | null) {
    // An edit after a fill: ⌘Z is the browser's own again.
    undoFill.current = null;
    const caret = el?.selectionStart ?? next.length;
    // a menu with a trigger follows the text after it, and goes when the trigger does
    if (menu !== null && menu.at !== null) {
      // an IME's intermediate text: checked once the composition commits (onCompositionEnd)
      if (composing.current) {
        setMenu({ ...menu, end: Math.max(caret, menu.at + 1) });
        setText(next);
        return;
      }
      const query = next.slice(menu.at + 1, caret);
      const gone =
        next[menu.at] !== (menu.kind === "slash" ? "/" : "@") ||
        caret <= menu.at ||
        query.includes("\n") ||
        // `/name args`: past the name the text is the skill's arguments, not a search
        (menu.kind === "slash" && /\s/.test(query)) ||
        // `@ `: an address or plain text, not a pick
        (menu.kind === "at" && /^\s/.test(query));
      setMenu(gone ? null : { ...menu, end: caret });
      setText(next);
      return;
    }
    // one character typed (an IME's intermediate text never opens a menu)
    if (!composing.current && next.length === text.length + 1) {
      const trigger = triggerAt(next, caret);
      if (trigger !== null) {
        setText(next);
        openMenu({ ...trigger, q: "" });
        return;
      }
    }
    // a menu opened without a trigger (+) goes with any edit
    if (menu !== null) setMenu(null);
    setText(next);
  }

  async function insertPrompt(p: ConnectorPrompt, values: Record<string, string>) {
    setRendering(true);
    try {
      const r = await renderPrompt({ p, values });
      setText(r.text);
      setArgsFor(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRendering(false);
    }
  }

  function pickPrompt(p: ConnectorPrompt) {
    if (p.arguments.length === 0) {
      void insertPrompt(p, {});
      return;
    }
    setArgs({});
    setArgsFor(p);
  }

  function attach(r: ConnectorResource) {
    if (attachments.some((a) => a.connectorId === r.connectorId && a.uri === r.uri)) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast.error(t("attachLimit", { max: MAX_ATTACHMENTS }));
      return;
    }
    setAttachments([
      ...attachments,
      { connectorId: r.connectorId, connectorName: r.connectorName, uri: r.uri, name: r.name },
    ]);
  }

  /** A pick: the trigger and its query leave the text (the caret stays there), the menu closes. */
  const picked = () => {
    if (menu !== null && menu.at !== null) caretAfter.current = menu.at;
    setText(withoutTrigger());
    setMenu(null);
  };

  // What the menus list. The connectors give the + menu its rows and every row of a connector
  // its icon; the `@` menu's resources are searched on the kernel as the query rests.
  const query = menu === null ? "" : menu.at !== null ? text.slice(menu.at + 1, menu.end) : menu.q;
  const connectorList = useQuery({ ...connectorsQuery(orgId), enabled: menu !== null }).data
    ?.connectors;
  // while an IME composes inside the `@` menu its intermediate text (pinyin) is not the query
  const liveAtQuery = menu?.kind === "at" ? query.trim() : "";
  const heldAtQuery = useRef(liveAtQuery);
  if (!composingNow) heldAtQuery.current = liveAtQuery;
  const atQuery = heldAtQuery.current;
  const searched = useDebounced(atQuery, RESOURCE_SEARCH_DELAY_MS);
  const resourcesQ = useQuery({
    ...connectorResourcesQuery(orgId, searched),
    enabled: menu?.kind === "at",
    placeholderData: keepPreviousData,
  });
  const resources = resourcesQ.data;
  // The rows are an earlier query's (the query has not rested yet, or its answer is on its way):
  // the menu filters them by the query itself, so ↵ never attaches a row the query no longer
  // matches.
  const staleResources = searched !== atQuery || resourcesQ.isPlaceholderData;
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
                setMenu(null);
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
    // a plugin's skill names its plugin first ("superpowers · Think before building")
    const description = [
      ...(sk.plugin !== undefined ? [sk.plugin] : []),
      ...tags,
      ...(sk.description !== "" ? [sk.description] : []),
    ].join(" · ");
    return {
      id: sk.id,
      label: sk.name,
      icon: "skills",
      ...(sk.argumentHint !== undefined ? { hint: sk.argumentHint } : {}),
      ...(description !== "" ? { description } : {}),
      ...(sk.plugin !== undefined ? { keywords: [`${sk.plugin}:${sk.name}`] } : {}),
      onSelect: () => {
        picked();
        setSkill(sk);
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
          onSelect: () => {
            picked();
            pickPrompt(p);
          },
        }),
      ),
    })),
    ...unavailableGroup(prompts?.unavailable),
  ];

  /** The `@` menu: the kernel's matches grouped by connector (one connector's when scoped). */
  const atContent = (scope: MenuState["scope"]): ComposerMenuGroup[] => {
    const only = typeof scope === "object" ? scope.connectorId : undefined;
    const list = (resources?.resources ?? [])
      .filter((r) => only === undefined || r.connectorId === only)
      .slice(0, MAX_RESOURCE_ROWS);
    return [
      ...byConnector(list).map((g) => ({
        id: `resources-${g.id}`,
        label: g.label,
        items: g.items.map(
          (r): ComposerMenuItem => ({
            id: r.uri,
            label: r.name,
            description: r.uri,
            mark: markOf(r.connectorId, r.connectorName),
            onSelect: () => {
              picked();
              attach(r);
            },
          }),
        ),
      })),
      ...unavailableGroup(
        resources?.unavailable.filter((u) => only === undefined || u.connectorId === only),
      ),
    ];
  };

  /** The + menu (spec §2): Add, Abilities, then one row per usable connector. */
  const plusContent = (): ComposerMenuGroup[] => {
    const usable = (connectorList ?? []).filter((c) => c.status === "active");
    return [
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
          // the file library row joins with the file library
          ...(project !== undefined
            ? [
                {
                  id: "project-files",
                  label: t("composerMenu.projectFiles"),
                  icon: "folder",
                  description:
                    listUnsupported ??
                    t("composerMenu.projectFilesHint", { project: project.name }),
                  ...(listUnsupported !== null ? { disabled: true } : {}),
                  onSelect: () => {
                    setMenu(null);
                    setPickingFiles(true);
                  },
                } satisfies ComposerMenuItem,
              ]
            : []),
          {
            id: "resources",
            label: t("composerMenu.resources"),
            icon: "connector",
            onSelect: () => openAt("resources"),
          },
        ],
      },
      {
        id: "abilities",
        label: t("composerMenu.abilities"),
        items: [
          {
            id: "skills",
            label: t("composerMenu.skills"),
            icon: "skills",
            onSelect: openSlash,
          },
        ],
      },
      {
        id: "connectors",
        label: t("composerMenu.connectors"),
        items: usable.map((c): ComposerMenuItem => {
          const description = connectorDescriptionOf(c, locale);
          const waiting = c.setup === "needs_config";
          return {
            id: c.id,
            label: c.name,
            mark: { text: c.name, ...(c.icon ? { image: c.icon } : {}) },
            ...(description !== null ? { description } : {}),
            ...(waiting ? { disabled: true, badge: t("composerMenu.needsConfig") } : {}),
            onSelect: () => openAt({ connectorId: c.id }),
          };
        }),
      },
    ];
  };

  const contentGroups: ComposerMenuGroup[] =
    menu === null
      ? []
      : menu.kind === "slash"
        ? slashContent()
        : menu.kind === "at"
          ? atContent(menu.scope)
          : plusContent();

  // The built-in /compact command (context compaction spec §4.10) is always in the `/` menu, after
  // what the agent offers (a command never takes the first Enter meant for a skill: the groups
  // keep their order whatever the query). It is not part of the `@` menu. With nothing invocable
  // the "no skills selected" guidance (spec §5 rule 11) stands below the list, next to the
  // command; `/compact` is also still typed and parsed.
  const commandGroup: ComposerMenuGroup | null =
    menu?.kind === "slash" && onCompact !== undefined
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
                const rest = withoutTrigger();
                setMenu(null);
                if (running) {
                  setText(rest);
                  toast.error(t("compactBusy"));
                  return;
                }
                setText(rest);
                void runCompact(rest);
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
  const menuProps: ComposerMenuProps | null =
    menu === null
      ? null
      : {
          kind: menu.kind,
          groups,
          // the `@` menu's query is the one searched (an IME's intermediate text is not)
          query: menu.kind === "at" ? atQuery : query,
          // the `@` menu's rows are the kernel's matches already, unless they are an earlier query's
          filter: menu.kind !== "at" || staleResources,
          loading:
            menu.kind === "at" &&
            (resourcesQ.isFetching || searched !== atQuery) &&
            !resourcesQ.isError,
          empty:
            menu.kind === "at" && resourcesQ.isError
              ? errorMessage(resourcesQ.error)
              : noInvocable && commandGroup === null
                ? guidance
                : menu.kind === "at"
                  ? t("composerMenu.noResources")
                  : t("composerMenu.noMatch"),
          ...(noInvocable
            ? commandGroup !== null
              ? {
                  notice: { text: guidance, ...(guidanceAction ? { action: guidanceAction } : {}) },
                }
              : guidanceAction
                ? { notice: { action: guidanceAction } }
                : {}
            : {}),
          onClose: () => setMenu(null),
          onSwitch: (kind) => (kind === "at" ? openAt() : openSlash()),
          onQueryChange: (q) => {
            if (menu.at === null) {
              setMenu({ ...menu, q });
              return;
            }
            setText(text.slice(0, menu.at + 1) + q + text.slice(menu.end));
            setMenu({ ...menu, end: menu.at + 1 + q.length });
          },
          searchLabel: t("composerMenu.search"),
        };
  const menuController = useComposerMenu(menuProps);

  const missingArgs =
    argsFor?.arguments.filter((a) => a.required && (args[a.name] ?? "").trim() === "") ?? [];

  const strip: AttachmentStripItem[] = [
    ...files.map((f): AttachmentStripItem => {
      const type = f.file ? fileContentType(f.file) : "";
      const src = previews.get(f.key);
      return {
        id: f.key,
        kind: type.startsWith("image/") && f.status !== "error" ? "image" : "file",
        name: f.name,
        contentType: type,
        size: f.size,
        ...(src !== undefined ? { src } : {}),
        ...(f.status === "uploading" ? { progress: f.progress } : {}),
        ...(f.status === "error" ? { error: drafts.errorText(f) } : {}),
        ...(drafts.canRetry(f) ? { onRetry: () => drafts.retry(f.key) } : {}),
        onRemove: () => drafts.remove(f.key),
      };
    }),
    ...projectFiles.map(
      (path): AttachmentStripItem => ({
        id: `project:${path}`,
        kind: "file",
        name: baseName(path),
        size: 0,
        ...(missingFiles.includes(path) ? { error: t("projectFileMissing", { path }) } : {}),
        onRemove: () => {
          setProjectFiles((list) => list.filter((x) => x !== path));
          setMissingFiles((list) => list.filter((x) => x !== path));
        },
      }),
    ),
    ...attachments.map(
      (a): AttachmentStripItem => ({
        id: `@${a.connectorId}:${a.uri}`,
        kind: "file",
        name: `@${a.name}`,
        size: 0,
        onRemove: () =>
          setAttachments((list) =>
            list.filter((x) => !(x.connectorId === a.connectorId && x.uri === a.uri)),
          ),
      }),
    ),
  ];

  const hint =
    waiting === "skip"
      ? t("waitingSkipHint")
      : waiting === "hold"
        ? t("waitingHint")
        : running
          ? t("runningHint")
          : needsText && skill === null && empty(text.trim())
            ? t("referencesNeedText")
            : undefined;
  const runState = useRunStateValue().state;
  const textEl = useRef<HTMLTextAreaElement>(null);
  /**
   * The text a fill replaced, while the fill's text is unedited. A controlled textarea's value set
   * by React is not on the browser's undo stack, so the composer keeps this one step itself.
   */
  const undoFill = useRef<{ before: string; text: string } | null>(null);
  const textNow = useRef(text);
  textNow.current = text;
  // a pick puts the caret where its trigger stood (a controlled value set moves it to the end)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the picked text is rendered
  useLayoutEffect(() => {
    const at = caretAfter.current;
    const el = textEl.current;
    if (at === null || el === null) return;
    caretAfter.current = null;
    const pos = Math.min(at, el.value.length);
    el.setSelectionRange(pos, pos);
  }, [text]);
  // A pending composer frame hides the composer for up to 1.5 s (focus() is a no-op then): the
  // focus waits for the reveal or the winner's composer (client extensions spec §6.3)
  const cancelFocus = useRef<() => void>(() => {});
  const focusText = useCallback(() => {
    cancelFocus.current();
    cancelFocus.current = focusWhenPossible(() => textEl.current);
  }, []);
  useEffect(() => () => cancelFocus.current(), []);
  useImperativeHandle(
    control,
    () => ({
      fill(next: string) {
        const before = textNow.current;
        undoFill.current = before === next ? null : { before, text: next };
        // a fill (a quick action) is an edit: the suggestion goes for this run
        dismissSuggestion();
        textNow.current = next;
        setText(next);
        // a value set from outside puts the caret after the text; on a touch device the text is
        // only placed, never focused (focus would pop the keyboard for a tap on a quick action)
        if (!isTouchPointer()) focusText();
      },
      focus() {
        focusText();
      },
    }),
    [focusText, dismissSuggestion],
  );

  // The built-in composer: framed, the frame slot's default; bare (`frame={false}`), the inputs a
  // replacement wraps in its own frame (the host checks after commit that the composer's textarea
  // is in the document). A replacement renders one of the two.
  const composer = (frame: boolean) => (
    <ComposerBox
      frame={frame}
      value={text}
      onChange={(v) => {
        // any edit ends the suggestion for this run, also one that empties the draft
        dismissSuggestion();
        onChange(v, textEl.current);
      }}
      onKeyDown={onKeyDown}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      placeholder={placeholder}
      {...(hint !== undefined ? { hint } : {})}
      {...(skill !== null
        ? {
            token: {
              label: `/${skill.name}`,
              ...(skill.argumentHint !== undefined ? { hint: skill.argumentHint } : {}),
              onRemove: () => setSkill(null),
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
        // an open `/` or `@` menu's trigger and query leave the text first
        if (menu !== null) setText(withoutTrigger());
        openMenu({ kind: "plus", at: null, end: 0, q: "" });
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
      // one mode button before send holds the profile and the effort (from 640 up)
      {...(pickers.permission !== undefined
        ? {
            mode: modeMenuFromPickers(pickers.permission, pickers.effort, t("permission.modeHint")),
          }
        : {})}
      {...(quickActions !== undefined ? { quickActions } : {})}
      {...(agents !== undefined ? { agents } : {})}
      send={
        running && stop
          ? { mode: "stop", busy: stop.stopping, onClick: stop.onStop }
          : {
              // Never busy: the message is pending in the thread, not in the composer.
              mode: "send",
              disabled: sendDisabled === true || drafts.blocking || empty(text.trim()),
              onClick: () => void submit(),
            }
      }
      // the token warning's 仍然发送 sends as ↵ does, also while the button is Stop
      onSend={() => void submit()}
      textareaRef={textEl}
      {...(offered !== null
        ? { suggestion: { text: offered.text, onDismiss: dismissSuggestion } }
        : {})}
    />
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
          initial={projectFiles}
          onClose={() => {
            setPickingFiles(false);
            refocus();
          }}
          onConfirm={(paths) => {
            dismissSuggestion();
            setProjectFiles(paths.slice(0, MAX_PROJECT_FILES));
            setMissingFiles((list) => list.filter((x) => paths.includes(x)));
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
