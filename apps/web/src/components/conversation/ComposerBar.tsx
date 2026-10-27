"use client";

import {
  AttachmentStrip,
  type AttachmentStripItem,
  Button,
  type CommandGroup,
  CommandPalette,
  ComposerBox,
  Dialog,
  Field,
  FileDrop,
  Input,
  type PickerProps,
  Stack,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiClientError } from "../../lib/api";
import { fileContentType } from "../../lib/attachments";
import {
  type ConnectorPrompt,
  type ConnectorResource,
  type ConnectorUnavailable,
  listConnectorPrompts,
  listConnectorResources,
  renderConnectorPrompt,
} from "../../lib/connectors";
import type { MessageInput } from "../../lib/conversations";
import {
  findInvocable,
  type InvocableSkill,
  listInvocableSkills,
  parseSlashCommand,
} from "../../lib/skills";
import { useErrorMessage } from "../../lib/use-error-message";
import { type DraftFile, useDraftFiles } from "../use-draft-files";
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

/** A draft's identity: text + resources + files + skill (any change makes it a new message). */
const draftKey = (
  text: string,
  attachments: DraftAttachment[],
  files: string[],
  skill: string | undefined,
) => JSON.stringify([text, attachments.map((a) => [a.connectorId, a.uri]), files, skill ?? null]);

/** A slash command: `/<connector slug>:<prompt name>`. */
export const promptCommand = (p: Pick<ConnectorPrompt, "connectorSlug" | "name">) =>
  `/${p.connectorSlug}:${p.name}`;

type Palette = "prompts" | "resources" | null;

/** What the composer sends: the message without the switch (the caller adds model / effort). */
export type ComposerMessage = Pick<
  MessageInput,
  "text" | "clientMessageId" | "attachments" | "files" | "skill"
>;

/** The name a picked skill is invoked by: `<plugin>:<name>` for a plugin's skill. */
const invokeName = (s: InvocableSkill) => (s.plugin ? `${s.plugin}:${s.name}` : s.name);

const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const noSubscribe = () => () => {};

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
 * Keys: ↵ sends (interjects while a run is going); ⌘↵ / Ctrl+↵ queues while a run is going and
 * sends when idle; Shift+↵ is a newline; nothing happens while an IME is composing.
 *
 * Carried over from the old composer: each draft keeps one `clientMessageId` until it is sent or
 * changed (the kernel dedupes retries); `/` in an empty composer lists the agent's skills, then
 * the connectors' prompts, and `@` after a space their resources; files come from ＋, drop or
 * paste, upload at once and block sending while uploading or failed; a send that fails keeps the
 * draft.
 *
 * Skills (phase D spec §3): picking one shows its chip, and the text after it is the arguments
 * (Backspace at the start or the chip's × removes it and keeps the text). A draft typed as
 * `/name args` that names a listed skill is sent as its invocation; anything else as text (and a
 * typed one the kernel refuses as `skill.not_invocable`, from a stale list, is resent as text). The
 * list is read for `agentId` (with `conversationId` once the conversation exists, so its trial
 * drafts apply) when the menu opens or a typed `/name` is sent.
 */
export function ComposerBar({
  orgId,
  agentId,
  conversationId,
  running,
  stop,
  onSend,
  onQueue,
  pickers,
  placeholder,
  sendDisabled,
}: {
  orgId: string;
  /** The conversation's agent (the `/` menu lists its skills); undefined while loading. */
  agentId?: string | undefined;
  /** The conversation, once it exists and is the caller's (its trial drafts apply). */
  conversationId?: string | undefined;
  /** A run is going (or waiting for a person): ↵ interjects, ⌘↵ queues, send becomes stop. */
  running: boolean;
  stop?: { onStop(): void; stopping: boolean };
  onSend(m: ComposerMessage): Promise<SendResult>;
  /** Queue the message (⌘↵ while running); absent before the conversation exists. */
  onQueue?(m: ComposerMessage): Promise<SendResult>;
  pickers: { agent: PickerProps; model: PickerProps; effort?: PickerProps };
  placeholder: string;
  /** Nothing can be sent yet (a new conversation whose agent is still loading). */
  sendDisabled?: boolean;
}) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const mac = useSyncExternalStore(noSubscribe, isMac, () => true);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  /** The picked skill (the chip), or null. */
  const [skill, setSkill] = useState<InvocableSkill | null>(null);
  /** The agent's invocable skills, read once per agent (and refreshed when the menu opens). */
  const [skills, setSkills] = useState<{ agentId: string; items: InvocableSkill[] }>();
  const drafts = useDraftFiles(orgId);
  const files = drafts.files;
  const previews = useObjectUrls(files);
  const fileInput = useRef<HTMLInputElement>(null);

  const [pending, setPending] = useState(false);
  const [palette, setPalette] = useState<Palette>(null);
  const [prompts, setPrompts] = useState<{
    items: ConnectorPrompt[];
    unavailable: ConnectorUnavailable[];
  }>();
  const [resources, setResources] = useState<{
    items: ConnectorResource[];
    unavailable: ConnectorUnavailable[];
  }>();
  const [argsFor, setArgsFor] = useState<ConnectorPrompt | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState(false);
  const draft = useRef<{ key: string; id: string } | undefined>(undefined);
  const trigger = useRef<{ char: string; pos: number; picked: boolean } | null>(null);

  // A new agent (a new conversation's picker) has other skills: its chip and list go.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the agent only
  useEffect(() => {
    setSkill(null);
  }, [agentId]);

  /**
   * The agent's invocable skills. A conversation that is not the caller's (404) lists without it.
   * Failures read as no skills (typed `/name` is then sent as text).
   */
  async function loadSkills(): Promise<InvocableSkill[]> {
    if (agentId === undefined) return [];
    try {
      const r = await listInvocableSkills(orgId, agentId, conversationId).catch((e: unknown) => {
        if (
          conversationId !== undefined &&
          e instanceof ApiClientError &&
          e.code === "conversation.not_found"
        )
          return listInvocableSkills(orgId, agentId);
        throw e;
      });
      setSkills({ agentId, items: r.skills });
      return r.skills;
    } catch (e) {
      toast.error(errorMessage(e));
      return [];
    }
  }

  const empty = (value: string) =>
    skill === null && value === "" && (files.length === 0 || attachments.length > 0);

  async function submit(how: "send" | "queue") {
    const sentText = text;
    const sentSkill = skill;
    const sentAttachments = attachments;
    const value = text.trim();
    if (pending || drafts.blocking || sendDisabled) return;
    const sent = files.flatMap((f) => (f.id !== undefined ? [{ key: f.key, id: f.id }] : []));
    // Files alone can be sent; `@` resources need text (their bodies follow content[0]).
    if (empty(value)) return;
    const fileIds = sent.map((f) => f.id);
    setPending(true);
    // the chip, else a typed `/name args` naming a listed skill (spec §3.2)
    let invoke = skill !== null ? invokeName(skill) : undefined;
    let args = value;
    let typedInvoke = false;
    if (invoke === undefined) {
      const typed = parseSlashCommand(value);
      if (typed !== null) {
        const list =
          skills !== undefined && skills.agentId === agentId ? skills.items : await loadSkills();
        if (findInvocable(list, typed.name) !== undefined) {
          invoke = typed.name;
          args = typed.args;
          typedInvoke = true;
        }
      }
    }
    const message = (text: string, name: string | undefined): ComposerMessage => {
      const key = draftKey(text, attachments, fileIds, name);
      if (draft.current?.key !== key) draft.current = { key, id: newClientMessageId() };
      return {
        text,
        clientMessageId: draft.current.id,
        attachments: attachments.map((a) => ({ connectorId: a.connectorId, uri: a.uri })),
        files: fileIds,
        ...(name !== undefined ? { skill: { name } } : {}),
      };
    };
    const post = (m: ComposerMessage) => (how === "queue" && onQueue ? onQueue(m) : onSend(m));
    try {
      let r = await post(message(args, invoke));
      if (
        !r.ok &&
        typedInvoke &&
        r.error instanceof ApiClientError &&
        r.error.code === "skill.not_invocable"
      ) {
        // A typed `/name` from a stale list (the skill was deselected since it was read): an
        // unknown name is sent as text (spec §3.2), and the list is read again.
        void loadSkills();
        r = await post(message(value, undefined));
      }
      if (r.ok) {
        draft.current = undefined;
        // Clear only what was sent: the person may have typed on while the send was pending.
        setText((cur) =>
          cur === sentText
            ? ""
            : cur.startsWith(sentText)
              ? cur.slice(sentText.length).trimStart()
              : cur,
        );
        setSkill((cur) => (cur === sentSkill ? null : cur));
        setAttachments((cur) => cur.filter((a) => !sentAttachments.includes(a)));
        drafts.removeSent(sent.map((f) => f.key));
      } else {
        drafts.markFailed(r.error);
      }
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
    e.preventDefault();
    const modified = e.metaKey || e.ctrlKey;
    void submit(modified && running && onQueue ? "queue" : "send");
  }

  function openPalette(which: Exclude<Palette, null>, pos: number) {
    trigger.current = { char: which === "prompts" ? "/" : "@", pos, picked: false };
    setPalette(which);
    if (which === "prompts") {
      void loadSkills();
      listConnectorPrompts(orgId).then(
        (r) => setPrompts({ items: r.prompts, unavailable: r.unavailable }),
        (e: unknown) => toast.error(errorMessage(e)),
      );
    } else {
      listConnectorResources(orgId).then(
        (r) => setResources({ items: r.resources, unavailable: r.unavailable }),
        (e: unknown) => toast.error(errorMessage(e)),
      );
    }
  }

  function onChange(next: string, el?: HTMLTextAreaElement | null) {
    const caret = el?.selectionStart ?? next.length;
    if (text === "" && next === "/" && skill === null) {
      openPalette("prompts", 0);
      return;
    }
    const typed = next.length === text.length + 1 && next[caret - 1] === "@";
    if (typed && (caret === 1 || /\s/.test(next[caret - 2] ?? ""))) {
      setText(next.slice(0, caret - 1) + next.slice(caret));
      openPalette("resources", caret - 1);
      return;
    }
    setText(next);
  }

  async function insertPrompt(p: ConnectorPrompt, values: Record<string, string>) {
    setRendering(true);
    try {
      const r = await renderConnectorPrompt(orgId, p.connectorId, p.name, values);
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

  const picked = () => {
    if (trigger.current) trigger.current.picked = true;
  };

  const unavailableGroup = (list: ConnectorUnavailable[] | undefined): CommandGroup[] =>
    list && list.length > 0
      ? [
          {
            label: t("unavailableConnectors"),
            items: list.map((u) => ({
              id: `unavailable:${u.connectorId}`,
              label: `${u.connectorName} · ${t(`connectorUnavailable.${u.reason}`)}`,
              onSelect: () =>
                toast.error(
                  t(`connectorUnavailableHint.${u.reason}`, { connector: u.connectorName }),
                ),
            })),
          },
        ]
      : [];

  const byConnector = <T extends { connectorId: string; connectorName: string }>(items: T[]) => {
    const groups = new Map<string, { label: string; items: T[] }>();
    for (const it of items) {
      const g = groups.get(it.connectorId) ?? { label: it.connectorName, items: [] };
      g.items.push(it);
      groups.set(it.connectorId, g);
    }
    return [...groups.values()];
  };

  const skillItems = skills !== undefined && skills.agentId === agentId ? skills.items : [];
  const groups: CommandGroup[] =
    palette === "prompts"
      ? [
          ...(skillItems.length > 0
            ? [
                {
                  label: t("skillsGroup"),
                  items: skillItems.map((sk) => ({
                    id: `skill:${sk.id}`,
                    label: `/${sk.name}`,
                    ...(sk.argumentHint !== undefined ? { hint: sk.argumentHint } : {}),
                    ...(sk.manual || sk.fork
                      ? {
                          tags: [
                            ...(sk.manual ? [t("skillTag.manual")] : []),
                            ...(sk.fork ? [t("skillTag.fork")] : []),
                          ],
                        }
                      : {}),
                    ...(sk.plugin !== undefined
                      ? { search: `${sk.plugin}:${sk.name}`, source: sk.plugin }
                      : {}),
                    ...(sk.description !== "" ? { description: sk.description } : {}),
                    onSelect: () => {
                      picked();
                      setSkill(sk);
                    },
                  })),
                },
              ]
            : []),
          ...byConnector(prompts?.items ?? []).map((g) => ({
            label: g.label,
            items: g.items.map((p) => ({
              id: `prompt:${p.connectorId}:${p.name}`,
              label: promptCommand(p),
              search: p.name,
              ...(p.description ? { description: p.description } : {}),
              onSelect: () => {
                picked();
                pickPrompt(p);
              },
            })),
          })),
          ...unavailableGroup(prompts?.unavailable),
        ]
      : palette === "resources"
        ? [
            ...byConnector(resources?.items ?? []).map((g) => ({
              label: g.label,
              items: g.items.map((r) => ({
                id: `resource:${r.connectorId}:${r.uri}`,
                label: `${r.name} · ${r.uri}`,
                onSelect: () => {
                  picked();
                  attach(r);
                },
              })),
            })),
            ...unavailableGroup(resources?.unavailable),
          ]
        : [];

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

  const hint = running ? t(mac ? "queueHintMac" : "queueHint") : undefined;
  const textEl = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      <FileDrop label={t("dropFiles")} onFiles={drafts.add} disabled={!drafts.limits.available}>
        <ComposerBox
          value={text}
          onChange={(v) => onChange(v, textEl.current)}
          onKeyDown={onKeyDown}
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
          onAttach={() => {
            if (!drafts.limits.available) toast.error(t("filesUnavailable"));
            else fileInput.current?.click();
          }}
          attachDisabled={!drafts.limits.available}
          pickers={pickers}
          send={
            running && stop
              ? { mode: "stop", busy: stop.stopping, onClick: stop.onStop }
              : {
                  mode: "send",
                  busy: pending,
                  disabled: sendDisabled === true || drafts.blocking || empty(text.trim()),
                  onClick: () => void submit("send"),
                }
          }
          textareaRef={textEl}
        />
      </FileDrop>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        disabled={!drafts.limits.available}
        aria-label={t("addFiles")}
        accept={drafts.limits.types.join(",")}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length > 0) drafts.add(picked);
        }}
      />
      <CommandPalette
        open={palette !== null}
        onOpenChange={(open) => {
          if (open) return;
          setPalette(null);
          const tr = trigger.current;
          trigger.current = null;
          // Nothing picked: the trigger character goes back where it was typed.
          if (tr && !tr.picked) {
            setText((cur) => cur.slice(0, tr.pos) + tr.char + cur.slice(tr.pos));
          }
        }}
        groups={groups}
      />
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
