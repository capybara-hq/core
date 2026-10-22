"use client";

import {
  AttachmentChip,
  Badge,
  Button,
  type CommandGroup,
  CommandPalette,
  Dialog,
  Field,
  FileButton,
  FileDrop,
  IconButton,
  Input,
  Stack,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ChangeEvent, type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import {
  type ConnectorPrompt,
  type ConnectorResource,
  type ConnectorUnavailable,
  listConnectorPrompts,
  listConnectorResources,
  renderConnectorPrompt,
} from "../lib/connectors";
import { useErrorMessage } from "../lib/use-error-message";
import { useDraftFiles } from "./use-draft-files";

/** 一条消息最多附件数（与内核 `MAX_ATTACHMENTS` 一致）。 */
const MAX_ATTACHMENTS = 5;

/** 草稿里的附件（`@` 资源引用）。 */
export interface DraftAttachment {
  connectorId: string;
  connectorName: string;
  uri: string;
  name: string;
}

/**
 * `clientMessageId`：`crypto.randomUUID` 只在安全上下文可用（HTTPS / localhost），
 * 其余情况用 `getRandomValues` 生成同等随机度的 id。
 */
function newClientMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type { DraftFile } from "./use-draft-files";

/** `onSend` 的结果：失败时带上错误（如附件不存在，用来标出对应条目）。 */
export type SendResult = { ok: true } | { ok: false; error: unknown };

/** 草稿的身份：文本 + 附件 + 文件（任一变了即视为新消息）。 */
const draftKey = (text: string, attachments: DraftAttachment[], files: string[]) =>
  JSON.stringify([text, attachments.map((a) => [a.connectorId, a.uri]), files]);

/** 斜杠命令的写法：`/<连接器 slug>:<提示名>`。 */
export const promptCommand = (p: Pick<ConnectorPrompt, "connectorSlug" | "name">) =>
  `/${p.connectorSlug}:${p.name}`;

type Palette = "prompts" | "resources" | null;

/**
 * 输入框（PlaygroundPage 的 composer 区）：Enter 发送、Shift+Enter 换行。运行中不禁用（此时发送即为插话）；
 * 只在本条消息提交期间禁用发送按钮，避免重复提交。`onSend` 失败时保留输入内容与附件。
 *
 * 每条待发送的草稿持有一个 `clientMessageId`：发送失败（网络错误、5xx、响应丢失）后重试沿用同一个 id，
 * 内核据此去重，不会在只追加的日志里写出重复的 user_message；发送成功或文本 / 附件改动后才换新 id。
 *
 * 连接器内容（D4，仿 Claude Code）：
 * - 空输入框里输入 `/` → 命令面板列出各连接器的提示模板（`/连接器:提示名`）；选中后填参数（有参数时弹对话框），
 *   内核渲染为文本放进输入框，由用户检查后发送。
 * - 在开头或空白后输入 `@` → 命令面板列出各连接器的资源；选中的资源作为附件随消息发送（内核读取正文）。
 * 未连接个人凭据的连接器在面板里单独列出，选中时提示去连接。
 *
 * 上传文件（与 `@` 资源分开的一份列表）：点「+」选择、拖入输入区或粘贴。先在前端按类型 / 大小预检
 * （文案与内核错误码一致），通过的立即上传（登记 → 预签名直传，显示进度 → finalize）。上传中或有出错的文件时
 * 不能发送；出错的文件显示原因，可以移除或重试。发送时带上已就绪的附件 id（`files`），成功后只移除发出去的；
 * 内核说某个附件不存在 / 未就绪时把对应条目标为出错。上限取自内核（见 `useDraftFiles`）。
 */
export function Composer({
  orgId,
  onSend,
  stop,
}: {
  orgId: string;
  onSend: (
    text: string,
    clientMessageId: string,
    attachments: DraftAttachment[],
    files: string[],
  ) => Promise<SendResult>;
  /** 运行中时传入：输入框旁显示「停止」（任何宽度一次点击即可停止）。 */
  stop?: { onStop(): void; stopping: boolean } | undefined;
}) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const drafts = useDraftFiles(orgId);
  const files = drafts.files;

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
  /** 正在填参数的提示模板。 */
  const [argsFor, setArgsFor] = useState<ConnectorPrompt | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState(false);
  /** 当前草稿的 id 及其对应的内容（变了就作废）。 */
  const draft = useRef<{ key: string; id: string } | undefined>(undefined);
  /**
   * 打开面板的触发字符及其位置：关闭面板而没有选中任何条目时把它放回原处（用户可以发以 `/` 或 `@` 开头的普通消息）。
   */
  const trigger = useRef<{ char: string; pos: number; picked: boolean } | null>(null);

  async function submit() {
    const value = text.trim();
    if (pending || drafts.blocking) return;
    const sent = files.flatMap((f) => (f.id !== undefined ? [{ key: f.key, id: f.id }] : []));
    // 只有文件也能发（内核允许 text 为空）；带 `@` 资源时必须有文字（资源正文按 content[i + 1] 对应）
    if (value === "" && (sent.length === 0 || attachments.length > 0)) return;
    const fileIds = sent.map((f) => f.id);
    const key = draftKey(value, attachments, fileIds);
    if (draft.current?.key !== key) draft.current = { key, id: newClientMessageId() };
    const clientMessageId = draft.current.id;
    setPending(true);
    try {
      const r = await onSend(value, clientMessageId, attachments, fileIds);
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

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void submit();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  function openPalette(which: Exclude<Palette, null>, pos: number) {
    trigger.current = { char: which === "prompts" ? "/" : "@", pos, picked: false };
    setPalette(which);
    // 每次打开都重新读取（凭据与连接器可能已变化）
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

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    // 空输入框里键入 `/` → 斜杠命令
    if (text === "" && next === "/") {
      openPalette("prompts", 0);
      return;
    }
    // 开头或空白后键入 `@` → 资源引用（`@` 本身不留在文本里）
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

  /** 不可用的连接器：单独一组，选中时说明原因。 */
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

  return (
    <form onSubmit={onSubmit}>
      <FileDrop label={t("dropFiles")} onFiles={drafts.add} disabled={!drafts.limits.available}>
        <Stack gap={8}>
          {files.length > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: 文件条目分组；apps/web 不能写样式，用 role=group
            <div role="group" aria-label={t("files")}>
              <Stack direction="row" gap={8} wrap>
                {files.map((f) => (
                  <AttachmentChip
                    key={f.key}
                    name={f.name}
                    size={f.size}
                    status={f.status}
                    progress={f.progress}
                    {...(f.status === "error" && { error: drafts.errorText(f) })}
                    {...(drafts.canRetry(f) && { onRetry: () => drafts.retry(f.key) })}
                    onRemove={() => drafts.remove(f.key)}
                  />
                ))}
              </Stack>
            </div>
          )}
          {attachments.length > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: 附件条目分组；apps/web 不能写样式，用 role=group
            <div role="group" aria-label={t("attachments")}>
              <Stack direction="row" gap={8} wrap>
                {attachments.map((a) => (
                  <Stack key={`${a.connectorId}:${a.uri}`} direction="row" gap={4} align="center">
                    <Badge>{`@${a.name}`}</Badge>
                    <IconButton
                      size={24}
                      icon="✕"
                      label={t("removeAttachment", { name: a.name })}
                      onClick={() =>
                        setAttachments(
                          attachments.filter(
                            (x) => !(x.connectorId === a.connectorId && x.uri === a.uri),
                          ),
                        )
                      }
                    />
                  </Stack>
                ))}
              </Stack>
            </div>
          )}
          <Stack direction="row" gap={8} align="end">
            <FileButton
              label={drafts.limits.available ? t("addFiles") : t("filesUnavailable")}
              onFiles={drafts.add}
              accept={drafts.limits.types.join(",")}
              disabled={!drafts.limits.available}
              multiple
            />
            <Textarea
              name="message"
              aria-label={t("inputLabel")}
              rows={3}
              placeholder={t("placeholder")}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
            />
            {stop && (
              <Button onClick={stop.onStop} disabled={stop.stopping}>
                {t("stop")}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={
                pending ||
                drafts.blocking ||
                (text.trim() === "" && (files.length === 0 || attachments.length > 0))
              }
            >
              {t("send")}
            </Button>
          </Stack>
        </Stack>
      </FileDrop>
      <CommandPalette
        open={palette !== null}
        onOpenChange={(open) => {
          if (open) return;
          setPalette(null);
          const tr = trigger.current;
          trigger.current = null;
          // 没有选中任何条目：把触发字符放回去
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
    </form>
  );
}
