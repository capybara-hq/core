"use client";

import {
  Badge,
  Button,
  type CommandGroup,
  CommandPalette,
  Dialog,
  Field,
  IconButton,
  Input,
  Stack,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ChangeEvent, type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import {
  type AppPrompt,
  type AppResource,
  type AppUnavailable,
  listAppPrompts,
  listAppResources,
  renderAppPrompt,
} from "../lib/apps";
import { useErrorMessage } from "../lib/use-error-message";

/** 一条消息最多附件数（与内核 `MAX_ATTACHMENTS` 一致）。 */
const MAX_ATTACHMENTS = 5;

/** 草稿里的附件（`@` 资源引用）。 */
export interface DraftAttachment {
  appId: string;
  appName: string;
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

/** 草稿的身份：文本 + 附件（任一变了即视为新消息）。 */
const draftKey = (text: string, attachments: DraftAttachment[]) =>
  JSON.stringify([text, attachments.map((a) => [a.appId, a.uri])]);

/** 斜杠命令的写法：`/<应用 slug>:<提示名>`。 */
export const promptCommand = (p: Pick<AppPrompt, "appSlug" | "name">) => `/${p.appSlug}:${p.name}`;

type Palette = "prompts" | "resources" | null;

/**
 * 输入框（PlaygroundPage 的 composer 区）：Enter 发送、Shift+Enter 换行。运行中不禁用（此时发送即为插话）；
 * 只在本条消息提交期间禁用发送按钮，避免重复提交。`onSend` 失败时保留输入内容与附件。
 *
 * 每条待发送的草稿持有一个 `clientMessageId`：发送失败（网络错误、5xx、响应丢失）后重试沿用同一个 id，
 * 内核据此去重，不会在只追加的日志里写出重复的 user_message；发送成功或文本 / 附件改动后才换新 id。
 *
 * 应用内容（D4，仿 Claude Code）：
 * - 空输入框里输入 `/` → 命令面板列出各应用的提示模板（`/应用:提示名`）；选中后填参数（有参数时弹对话框），
 *   内核渲染为文本放进输入框，由用户检查后发送。
 * - 在开头或空白后输入 `@` → 命令面板列出各应用的资源；选中的资源作为附件随消息发送（内核读取正文）。
 * 未连接个人凭据的应用在面板里单独列出，选中时提示去连接。
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
  ) => Promise<boolean>;
  /** 运行中时传入：输入框旁显示「停止」（任何宽度一次点击即可停止）。 */
  stop?: { onStop(): void; stopping: boolean } | undefined;
}) {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [pending, setPending] = useState(false);
  const [palette, setPalette] = useState<Palette>(null);
  const [prompts, setPrompts] = useState<{ items: AppPrompt[]; unavailable: AppUnavailable[] }>();
  const [resources, setResources] = useState<{
    items: AppResource[];
    unavailable: AppUnavailable[];
  }>();
  /** 正在填参数的提示模板。 */
  const [argsFor, setArgsFor] = useState<AppPrompt | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState(false);
  /** 当前草稿的 id 及其对应的内容（变了就作废）。 */
  const draft = useRef<{ key: string; id: string } | undefined>(undefined);

  async function submit() {
    const value = text.trim();
    if (value === "" || pending) return;
    const key = draftKey(value, attachments);
    if (draft.current?.key !== key) draft.current = { key, id: newClientMessageId() };
    const clientMessageId = draft.current.id;
    setPending(true);
    try {
      if (await onSend(value, clientMessageId, attachments)) {
        draft.current = undefined;
        setText("");
        setAttachments([]);
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

  function openPalette(which: Exclude<Palette, null>) {
    setPalette(which);
    // 每次打开都重新读取（凭据与应用可能已变化）
    if (which === "prompts") {
      listAppPrompts(orgId).then(
        (r) => setPrompts({ items: r.prompts, unavailable: r.unavailable }),
        (e: unknown) => toast.error(errorMessage(e)),
      );
    } else {
      listAppResources(orgId).then(
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
      openPalette("prompts");
      return;
    }
    // 开头或空白后键入 `@` → 资源引用（`@` 本身不留在文本里）
    const typed = next.length === text.length + 1 && next[caret - 1] === "@";
    if (typed && (caret === 1 || /\s/.test(next[caret - 2] ?? ""))) {
      setText(next.slice(0, caret - 1) + next.slice(caret));
      openPalette("resources");
      return;
    }
    setText(next);
  }

  async function insertPrompt(p: AppPrompt, values: Record<string, string>) {
    setRendering(true);
    try {
      const r = await renderAppPrompt(orgId, p.appId, p.name, values);
      setText(r.text);
      setArgsFor(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRendering(false);
    }
  }

  function pickPrompt(p: AppPrompt) {
    if (p.arguments.length === 0) {
      void insertPrompt(p, {});
      return;
    }
    setArgs({});
    setArgsFor(p);
  }

  function attach(r: AppResource) {
    if (attachments.some((a) => a.appId === r.appId && a.uri === r.uri)) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast.error(t("attachLimit", { max: MAX_ATTACHMENTS }));
      return;
    }
    setAttachments([
      ...attachments,
      { appId: r.appId, appName: r.appName, uri: r.uri, name: r.name },
    ]);
  }

  /** 不可用的应用：单独一组，选中时说明原因。 */
  const unavailableGroup = (list: AppUnavailable[] | undefined): CommandGroup[] =>
    list && list.length > 0
      ? [
          {
            label: t("unavailableApps"),
            items: list.map((u) => ({
              id: `unavailable:${u.appId}`,
              label: `${u.appName} · ${t(`appUnavailable.${u.reason}`)}`,
              onSelect: () => toast.error(t(`appUnavailableHint.${u.reason}`, { app: u.appName })),
            })),
          },
        ]
      : [];

  const byApp = <T extends { appId: string; appName: string }>(items: T[]) => {
    const groups = new Map<string, { label: string; items: T[] }>();
    for (const it of items) {
      const g = groups.get(it.appId) ?? { label: it.appName, items: [] };
      g.items.push(it);
      groups.set(it.appId, g);
    }
    return [...groups.values()];
  };

  const groups: CommandGroup[] =
    palette === "prompts"
      ? [
          ...byApp(prompts?.items ?? []).map((g) => ({
            label: g.label,
            items: g.items.map((p) => ({
              id: `prompt:${p.appId}:${p.name}`,
              label: `${promptCommand(p)}${p.description ? ` — ${p.description}` : ""}`,
              onSelect: () => pickPrompt(p),
            })),
          })),
          ...unavailableGroup(prompts?.unavailable),
        ]
      : palette === "resources"
        ? [
            ...byApp(resources?.items ?? []).map((g) => ({
              label: g.label,
              items: g.items.map((r) => ({
                id: `resource:${r.appId}:${r.uri}`,
                label: `${r.name} · ${r.uri}`,
                onSelect: () => attach(r),
              })),
            })),
            ...unavailableGroup(resources?.unavailable),
          ]
        : [];

  const missingArgs =
    argsFor?.arguments.filter((a) => a.required && (args[a.name] ?? "").trim() === "") ?? [];

  return (
    <form onSubmit={onSubmit}>
      <Stack gap={8}>
        {attachments.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: 附件条目分组；apps/web 不能写样式，用 role=group
          <div role="group" aria-label={t("attachments")}>
            <Stack direction="row" gap={8} wrap>
              {attachments.map((a) => (
                <Stack key={`${a.appId}:${a.uri}`} direction="row" gap={4} align="center">
                  <Badge>{`@${a.name}`}</Badge>
                  <IconButton
                    size={24}
                    icon="✕"
                    label={t("removeAttachment", { name: a.name })}
                    onClick={() =>
                      setAttachments(
                        attachments.filter((x) => !(x.appId === a.appId && x.uri === a.uri)),
                      )
                    }
                  />
                </Stack>
              ))}
            </Stack>
          </div>
        )}
        <Stack direction="row" gap={8} align="end">
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
          <Button type="submit" variant="primary" disabled={pending || text.trim() === ""}>
            {t("send")}
          </Button>
        </Stack>
      </Stack>
      <CommandPalette
        open={palette !== null}
        onOpenChange={(open) => {
          if (!open) setPalette(null);
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
