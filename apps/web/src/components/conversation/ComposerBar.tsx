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

/** A draft's identity: text + resources + files (any change makes it a new message). */
const draftKey = (text: string, attachments: DraftAttachment[], files: string[]) =>
  JSON.stringify([text, attachments.map((a) => [a.connectorId, a.uri]), files]);

/** A slash command: `/<connector slug>:<prompt name>`. */
export const promptCommand = (p: Pick<ConnectorPrompt, "connectorSlug" | "name">) =>
  `/${p.connectorSlug}:${p.name}`;

type Palette = "prompts" | "resources" | null;

/** What the composer sends: the message without the switch (the caller adds model / effort). */
export type ComposerMessage = Pick<
  MessageInput,
  "text" | "clientMessageId" | "attachments" | "files"
>;

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
 * changed (the kernel dedupes retries); `/` in an empty composer lists the connectors' prompts and
 * `@` after a space their resources; files come from ＋, drop or paste, upload at once and block
 * sending while uploading or failed; a send that fails keeps the draft.
 */
export function ComposerBar({
  orgId,
  running,
  stop,
  onSend,
  onQueue,
  pickers,
  placeholder,
}: {
  orgId: string;
  /** A run is going (or waiting for a person): ↵ interjects, ⌘↵ queues, send becomes stop. */
  running: boolean;
  stop?: { onStop(): void; stopping: boolean };
  onSend(m: ComposerMessage): Promise<SendResult>;
  /** Queue the message (⌘↵ while running); absent before the conversation exists. */
  onQueue?(m: ComposerMessage): Promise<SendResult>;
  pickers: { agent: PickerProps; model: PickerProps; effort?: PickerProps };
  placeholder: string;
}) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const mac = useSyncExternalStore(noSubscribe, isMac, () => true);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
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

  const empty = (value: string) => value === "" && (files.length === 0 || attachments.length > 0);

  async function submit(how: "send" | "queue") {
    const value = text.trim();
    if (pending || drafts.blocking) return;
    const sent = files.flatMap((f) => (f.id !== undefined ? [{ key: f.key, id: f.id }] : []));
    // Files alone can be sent; `@` resources need text (their bodies follow content[0]).
    if (empty(value)) return;
    const fileIds = sent.map((f) => f.id);
    const key = draftKey(value, attachments, fileIds);
    if (draft.current?.key !== key) draft.current = { key, id: newClientMessageId() };
    const m: ComposerMessage = {
      text: value,
      clientMessageId: draft.current.id,
      attachments: attachments.map((a) => ({ connectorId: a.connectorId, uri: a.uri })),
      files: fileIds,
    };
    setPending(true);
    try {
      const r = how === "queue" && onQueue ? await onQueue(m) : await onSend(m);
      if (r.ok) {
        draft.current = undefined;
        setText("");
        setAttachments([]);
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
    if (text === "" && next === "/") {
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

  const groups: CommandGroup[] =
    palette === "prompts"
      ? [
          ...byConnector(prompts?.items ?? []).map((g) => ({
            label: g.label,
            items: g.items.map((p) => ({
              id: `prompt:${p.connectorId}:${p.name}`,
              label: `${promptCommand(p)}${p.description ? ` — ${p.description}` : ""}`,
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
                  disabled: drafts.blocking || empty(text.trim()),
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
