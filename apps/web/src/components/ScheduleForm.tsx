"use client";

import {
  Button,
  Field,
  FormSection,
  Input,
  ItemList,
  LinkButton,
  RadioGroup,
  Select,
  Stack,
  Text,
  Textarea,
  useTimeZone,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { timeZoneOptions } from "../lib/account-preferences";
import type { Agent, ProviderModels } from "../lib/agents";
import { labelLocale } from "../lib/extension-label";
import { decodeModel, encodeModel, pickerOptions } from "../lib/models";
import { retryOnMountOf } from "../lib/query/client";
import {
  chatTargetsQuery,
  grantableToolsQuery,
  scheduleTargetsQuery,
} from "../lib/query/schedules";
import {
  type ChatTarget,
  chatKey,
  connectionOf,
  dateIn,
  endOfDayIn,
  type GrantableTool,
  HOURLY_MINUTES,
  MONTH_DAYS,
  PRESET_KINDS,
  type PresetKind,
  presetOf,
  presetValid,
  SCHEDULE_EFFORTS,
  type ScheduleChat,
  type ScheduleCreateBody,
  type ScheduledTask,
  type ScheduledTaskGrant,
  type ScheduleEffort,
  type ScheduleMode,
  type SchedulePreset,
  type ScheduleUpdateBody,
  switchPreset,
  triggerOf,
} from "../lib/schedules";

/** The fields the task form edits (the approved tools are their own section). */
export interface ScheduleDraft {
  name: string;
  agentId: string;
  prompt: string;
  preset: SchedulePreset;
  /** The task's own zone (an existing task only). */
  timeZone: string | null;
  mode: ScheduleMode;
  conversationId: string;
  /** Kept as it is: a chat is set from the chat itself (through the agent's tools). */
  chat: ScheduleChat | null;
  /** `encodeModel` of the pick; "" = the agent's model. `new` mode only. */
  model: string;
  /** "" = the agent's effort. `new` mode only. */
  effort: string;
  /** The end date `YYYY-MM-DD` in the task's zone; "" = never (or the org's default on create). */
  expires: string;
}

export const emptyDraft = (agentId: string): ScheduleDraft => ({
  name: "",
  agentId,
  prompt: "",
  preset: { kind: "daily", time: "09:00" },
  timeZone: null,
  mode: "new",
  conversationId: "",
  chat: null,
  model: "",
  effort: "",
  expires: "",
});

export const draftOf = (task: ScheduledTask): ScheduleDraft => ({
  name: task.name,
  agentId: task.agentId,
  prompt: task.prompt,
  preset: presetOf(task.trigger),
  timeZone: task.trigger.timeZone,
  mode: task.mode,
  conversationId: task.conversationId ?? "",
  chat: task.chat,
  model: task.model === null ? "" : encodeModel(task.model),
  effort: task.effort ?? "",
  expires: task.expiresAt === null ? "" : dateIn(task.expiresAt, task.trigger.timeZone),
});

/** Whether the draft can be sent (the kernel checks the rest: cron, interval, target). */
export const draftValid = (d: ScheduleDraft): boolean =>
  d.name.trim() !== "" &&
  d.prompt.trim() !== "" &&
  d.agentId !== "" &&
  presetValid(d.preset) &&
  (d.mode !== "conversation" || d.conversationId !== "") &&
  (d.mode !== "chat" || d.chat !== null);

/** The create body of a draft (`grants`: the tools approved up front). */
export function createBodyOf(
  d: ScheduleDraft,
  grants: string[],
  timeZone: string | undefined,
  /** The zone the end date is read in (the creator's). */
  displayZone: string,
): ScheduleCreateBody {
  const model = d.model === "" ? null : decodeModel(d.model);
  return {
    agentId: d.agentId,
    name: d.name.trim(),
    prompt: d.prompt.trim(),
    trigger: triggerOf(d.preset),
    ...(timeZone !== undefined ? { timeZone } : {}),
    mode: d.mode,
    ...(d.mode === "conversation" ? { conversationId: d.conversationId } : {}),
    ...(d.mode === "chat" && d.chat !== null ? { chat: d.chat } : {}),
    // model and effort: a new-conversation task's only (another runs with its conversation's)
    ...(d.mode === "new" && model !== null ? { model } : {}),
    ...(d.mode === "new" && d.effort !== "" ? { effort: d.effort as ScheduleEffort } : {}),
    // an end date is a recurring task's (a one-off one has none)
    ...(d.expires !== "" && d.preset.kind !== "once"
      ? { expiresAt: endOfDayIn(d.expires, displayZone) }
      : {}),
    ...(grants.length > 0 ? { grants: grants.map((toolKey) => ({ toolKey })) } : {}),
  };
}

const sameTrigger = (a: SchedulePreset, b: SchedulePreset) =>
  JSON.stringify(triggerOf(a)) === JSON.stringify(triggerOf(b));

/** The patch of what changed between the saved task and the draft (empty: nothing). */
export function patchOf(saved: ScheduleDraft, d: ScheduleDraft): ScheduleUpdateBody {
  const p: ScheduleUpdateBody = {};
  if (d.name.trim() !== saved.name) p.name = d.name.trim();
  if (d.prompt.trim() !== saved.prompt) p.prompt = d.prompt.trim();
  if (d.agentId !== saved.agentId) p.agentId = d.agentId;
  if (!sameTrigger(saved.preset, d.preset)) p.trigger = triggerOf(d.preset);
  if (d.timeZone !== null && d.timeZone !== saved.timeZone) p.timeZone = d.timeZone;
  if (d.mode !== saved.mode) p.mode = d.mode;
  if (d.mode === "conversation" && d.conversationId !== saved.conversationId) {
    p.conversationId = d.conversationId;
  }
  // Leaving a mode clears its target
  if (d.mode !== saved.mode && saved.mode === "conversation") p.conversationId = null;
  if (d.mode !== saved.mode && saved.mode === "chat") p.chat = null;
  // model and effort: `new` mode only (leaving it, the kernel clears them)
  if (d.mode === "new") {
    if (d.model !== saved.model) p.model = d.model === "" ? null : decodeModel(d.model);
    if (d.effort !== saved.effort) {
      p.effort = d.effort === "" ? null : (d.effort as ScheduleEffort);
    }
  }
  if (d.expires !== saved.expires && d.preset.kind !== "once") {
    const zone = d.timeZone ?? saved.timeZone ?? "UTC";
    p.expiresAt = d.expires === "" ? null : endOfDayIn(d.expires, zone);
  }
  return p;
}

/** How many sections' fields differ (the ActionRow's count). */
export const changedCount = (saved: ScheduleDraft, d: ScheduleDraft): number =>
  Object.keys(patchOf(saved, d)).length;

/** The form's static field shapes while its data loads. */
export const LOADING_SECTIONS = {
  basic: [{ control: "select" as const }, {}, { control: "textarea" as const, rows: 4 }],
  schedule: [{ control: "select" as const }, {}],
  target: [{ control: "radio-cards" as const, options: 2 }],
  model: [{ control: "select" as const }, { control: "select" as const }],
};

type SetDraft = (f: (d: ScheduleDraft) => ScheduleDraft) => void;

/**
 * The task form's sections (spec §10): basics (name, agent, prompt), the schedule (presets that
 * write cron, the zone), where runs go and the model. `readOnly`: an org admin looking at another
 * member's task.
 */
export function ScheduleFormSections({
  orgId,
  draft,
  setDraft,
  agents,
  providers,
  existing,
  readOnly = false,
  minIntervalMinutes,
  createZone,
}: {
  orgId: string;
  draft: ScheduleDraft;
  setDraft: SetDraft;
  agents: Agent[];
  providers: ProviderModels[];
  /** The saved task (edit): its zone, chat and expiry show. */
  existing?: ScheduledTask;
  readOnly?: boolean;
  /** The org's shortest interval between runs (the schedule section's hint). */
  minIntervalMinutes?: number;
  /** A new task: the zone it will take (my account's, else the browser's). */
  createZone?: string;
}) {
  const t = useTranslations("schedules.form");
  const tw = useTranslations("schedules");
  const te = useTranslations("chat.effort");
  const locale = labelLocale(useLocale());
  const zone = useTimeZone();
  const set = <K extends keyof ScheduleDraft>(k: K, v: ScheduleDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const agentOptions = agents.map((a) => ({ value: a.id, label: a.definition.name || a.id }));
  if (draft.agentId !== "" && !agentOptions.some((o) => o.value === draft.agentId)) {
    agentOptions.push({ value: draft.agentId, label: draft.agentId });
  }
  const modelOptions = [
    { value: "", label: t("agentDefault") },
    ...pickerOptions(providers, locale),
  ];
  if (draft.model !== "" && !modelOptions.some((o) => o.value === draft.model)) {
    modelOptions.push({ value: draft.model, label: draft.model });
  }
  const p = draft.preset;
  const setPreset = (preset: SchedulePreset) => set("preset", preset);
  const targetsQ = chatTargetsQuery(orgId);
  const targets = useQuery({
    ...targetsQ,
    enabled: !readOnly,
    retryOnMount: retryOnMountOf(targetsQ.queryKey),
  }).data?.items;
  const offerChat = draft.chat !== null || (targets?.length ?? 0) > 0;
  const modes: ScheduleMode[] = ["new", "conversation", ...(offerChat ? ["chat" as const] : [])];
  // A chat task's agent is its connection's
  const agentFixed = draft.mode === "chat";
  return (
    <>
      <FormSection id="basic" title={t("basic")} description={t("basicHint")}>
        <Stack gap={12}>
          <Field label={t("name")} required>
            <Input
              value={draft.name}
              maxLength={200}
              disabled={readOnly}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field
            label={t("agent")}
            required
            {...(agentFixed ? { help: t("chatAgentFixed") } : {})}
            {...(agents.length === 0 ? { error: t("noAgents") } : {})}
          >
            <Select
              value={draft.agentId}
              disabled={readOnly || agentFixed || agentOptions.length === 0}
              onChange={(e) =>
                setDraft((d) => ({ ...d, agentId: e.target.value, conversationId: "" }))
              }
              options={agentOptions}
            />
          </Field>
          <Field label={t("prompt")} required help={t("promptHelp")}>
            <Textarea
              value={draft.prompt}
              rows={5}
              maxLength={20_000}
              disabled={readOnly}
              onChange={(e) => set("prompt", e.target.value)}
            />
          </Field>
        </Stack>
      </FormSection>
      <FormSection id="schedule" title={t("schedule")} description={t("scheduleHint")}>
        <Stack gap={12}>
          <Field label={t("preset")}>
            <Select
              value={p.kind}
              disabled={readOnly}
              onChange={(e) => setPreset(switchPreset(p, e.target.value as PresetKind))}
              options={PRESET_KINDS.map((k) => ({ value: k, label: t(`presets.${k}`) }))}
            />
          </Field>
          {p.kind === "hourly" && (
            <Field label={t("minute")}>
              <Select
                value={String(p.minute)}
                disabled={readOnly}
                onChange={(e) => setPreset({ kind: "hourly", minute: Number(e.target.value) })}
                options={HOURLY_MINUTES.map((m) => ({
                  value: String(m),
                  label: `:${String(m).padStart(2, "0")}`,
                }))}
              />
            </Field>
          )}
          {p.kind === "weekly" && (
            <Field label={t("weekday")}>
              <Select
                value={String(p.day)}
                disabled={readOnly}
                onChange={(e) => setPreset({ ...p, day: Number(e.target.value) })}
                options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({
                  value: String(d),
                  label: tw(`weekday.${d}` as "weekday.0"),
                }))}
              />
            </Field>
          )}
          {p.kind === "monthly" && (
            <Field label={t("dayOfMonth")}>
              <Select
                value={String(p.day)}
                disabled={readOnly}
                onChange={(e) => setPreset({ ...p, day: Number(e.target.value) })}
                options={Array.from({ length: MONTH_DAYS }, (_, i) => ({
                  value: String(i + 1),
                  label: String(i + 1),
                }))}
              />
            </Field>
          )}
          {"time" in p && (
            <Field label={t("time")}>
              <Input
                type="time"
                value={p.time}
                disabled={readOnly}
                onChange={(e) => setPreset({ ...p, time: e.target.value })}
              />
            </Field>
          )}
          {p.kind === "once" && (
            <Field label={t("at")} required>
              <Input
                type="datetime-local"
                value={p.at}
                disabled={readOnly}
                onChange={(e) => setPreset({ kind: "once", at: e.target.value })}
              />
            </Field>
          )}
          {p.kind === "custom" && (
            <Field label={t("cron")} required help={t("cronHelp")}>
              <Input
                value={p.expr}
                maxLength={200}
                disabled={readOnly}
                onChange={(e) => setPreset({ kind: "custom", expr: e.target.value })}
              />
            </Field>
          )}
          {existing === undefined ? (
            <Text variant="small" tone="muted">
              {t("zoneCreate", { zone: createZone ?? zone ?? "UTC" })}
            </Text>
          ) : (
            <Field label={t("zone")}>
              <Select
                name="timeZone"
                value={draft.timeZone ?? existing.trigger.timeZone}
                disabled={readOnly}
                onChange={(e) => set("timeZone", e.target.value)}
                options={timeZoneOptions(existing.trigger.timeZone)}
              />
            </Field>
          )}
          {p.kind !== "once" && (
            <Text variant="small" tone="muted">
              {t("jitter")}
            </Text>
          )}
          {p.kind !== "once" && minIntervalMinutes !== undefined && (
            <Text variant="small" tone="muted">
              {t("minInterval", { n: minIntervalMinutes })}
            </Text>
          )}
          {p.kind !== "once" && (
            <Field label={t("expires")} optional help={t("expiresHelp")}>
              <Input
                type="date"
                name="expires"
                value={draft.expires}
                disabled={readOnly}
                onChange={(e) => set("expires", e.target.value)}
              />
            </Field>
          )}
        </Stack>
      </FormSection>
      <FormSection id="target" title={t("target")} description={t("targetHint")}>
        <Stack gap={12}>
          <RadioGroup
            label={t("target")}
            variant="card"
            value={draft.mode}
            disabled={readOnly}
            onChange={(v) => set("mode", v as ScheduleMode)}
            options={modes.map((m) => ({
              value: m,
              label: t(`mode.${m}`),
              description: t(`mode.${m}Hint`),
            }))}
          />
          {draft.mode === "conversation" && (
            <TargetConversation
              orgId={orgId}
              agentId={draft.agentId}
              value={draft.conversationId}
              disabled={readOnly}
              onChange={(v) => set("conversationId", v)}
            />
          )}
          {draft.mode === "chat" && (
            <TargetChat
              targets={targets}
              value={draft.chat}
              disabled={readOnly}
              onChange={(c) =>
                setDraft((d) => ({
                  ...d,
                  chat: { connectionId: c.connectionId, chatId: c.chatId, chatType: c.chatType },
                  agentId: c.agentId,
                  conversationId: "",
                }))
              }
            />
          )}
          {!offerChat && !readOnly && targets !== undefined && (
            <Text variant="small" tone="muted">
              {t("noChats")}
            </Text>
          )}
        </Stack>
      </FormSection>
      {draft.mode === "new" && (
        <FormSection id="model" title={t("model")} description={t("modelHint")}>
          <Stack gap={12}>
            <Field label={t("modelLabel")}>
              <Select
                name="model"
                value={draft.model}
                disabled={readOnly}
                onChange={(e) => set("model", e.target.value)}
                options={modelOptions}
              />
            </Field>
            <Field label={t("effort")}>
              <Select
                name="effort"
                value={draft.effort}
                disabled={readOnly}
                onChange={(e) => set("effort", e.target.value)}
                options={[
                  { value: "", label: t("agentDefault") },
                  ...SCHEDULE_EFFORTS.map((e) => ({ value: e, label: te(e) })),
                ]}
              />
            </Field>
          </Stack>
        </FormSection>
      )}
    </>
  );
}

/** The conversation a `conversation`-mode task posts into: one of mine with the task's agent. */
function TargetConversation({
  orgId,
  agentId,
  value,
  disabled,
  onChange,
}: {
  orgId: string;
  agentId: string;
  value: string;
  disabled: boolean;
  onChange(v: string): void;
}) {
  const t = useTranslations("schedules.form");
  const q = scheduleTargetsQuery(orgId, agentId);
  const read = useQuery({
    ...q,
    enabled: agentId !== "",
    retryOnMount: retryOnMountOf(q.queryKey),
  });
  const list = read.data?.conversations ?? [];
  const options = list.map((c) => ({ value: c.id, label: c.title ?? t("untitled") }));
  if (value !== "" && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: value });
  }
  const empty = read.data !== undefined && options.length === 0;
  return (
    <Field label={t("conversation")} required {...(empty ? { error: t("noConversations") } : {})}>
      <Select
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(e) => onChange(e.target.value)}
        options={[{ value: "", label: t("pickConversation") }, ...options]}
      />
    </Field>
  );
}

/** The chat a `chat`-mode task posts into: one of my DMs or groups (`GET …/chat-targets`). */
function TargetChat({
  targets,
  value,
  disabled,
  onChange,
}: {
  targets: ChatTarget[] | undefined;
  value: ScheduleChat | null;
  disabled: boolean;
  onChange(c: ChatTarget): void;
}) {
  const t = useTranslations("schedules.form");
  const list = targets ?? [];
  const label = (c: ChatTarget) =>
    t("chatOption", { name: c.label, type: t(`chatType.${c.chatType}`) });
  const options = list.map((c) => ({ value: chatKey(c), label: label(c) }));
  if (value !== null && !options.some((o) => o.value === chatKey(value))) {
    options.unshift({
      value: chatKey(value),
      label: t("chatOption", { name: value.chatId, type: t(`chatType.${value.chatType}`) }),
    });
  }
  return (
    <Field label={t("chatTarget")} required>
      <Select
        value={value === null ? "" : chatKey(value)}
        disabled={disabled || list.length === 0}
        onChange={(e) => {
          const c = list.find((x) => chatKey(x) === e.target.value);
          if (c) onChange(c);
        }}
        options={[{ value: "", label: t("pickChat") }, ...options]}
      />
    </Field>
  );
}

/**
 * The agent's tools as the grant picker offers them (`GET …/grantable-tools`), each grantable or
 * why not by the kernel's rule; undefined while they load.
 */
export function useGrantableTools(orgId: string, agentId: string): GrantableTool[] | undefined {
  const q = grantableToolsQuery(orgId, agentId);
  return useQuery({ ...q, enabled: agentId !== "", retryOnMount: retryOnMountOf(q.queryKey) }).data
    ?.items;
}

/**
 * The approved tools (spec §7): the granted ones with 移除 (an out-of-date one says so), a picker of
 * the agent's grantable tools, and what the latest runs were refused: 加入预先批准的工具 when it can
 * be, why not otherwise (needs a role, forbidden, always asks), or 连接 for a personal connector.
 * `onAdd` / `onRemove` are the create form's draft or the saved task's grant routes.
 */
export function ApprovedToolsSection({
  granted,
  tools,
  refused,
  readOnly = false,
  pending = false,
  onAdd,
  onRemove,
}: {
  granted: Pick<ScheduledTaskGrant, "toolKey" | "stale">[];
  /** The agent's tools with their flags; undefined while they load. */
  tools: GrantableTool[] | undefined;
  refused: string[];
  readOnly?: boolean;
  pending?: boolean;
  onAdd(toolKey: string): void;
  onRemove(toolKey: string): void;
}) {
  const t = useTranslations("schedules.form");
  const [pick, setPick] = useState("");
  const keys = granted.map((g) => g.toolKey);
  const byKey = new Map((tools ?? []).map((x) => [x.key, x]));
  const name = (k: string) => byKey.get(k)?.title ?? k;
  const open = (tools ?? []).filter((x) => x.grantable && !keys.includes(x.key));
  const missing = refused.filter((k) => !keys.includes(k));
  const why = (k: string): string | null => {
    const tool = byKey.get(k);
    if (tool === undefined) return tools === undefined ? null : t("refusal.not_available");
    return tool.grantable ? null : t(`refusal.${tool.reason ?? "not_available"}`);
  };
  return (
    <FormSection id="tools" title={t("tools")} description={t("toolsHint")}>
      <Stack gap={12}>
        <ItemList
          label={t("toolsLabel")}
          empty={t("toolsEmpty")}
          rows={granted.map((g) => ({
            id: g.toolKey,
            title: name(g.toolKey),
            ...(g.stale === true ? { status: { label: t("stale"), tone: "accent" as const } } : {}),
            ...(readOnly
              ? {}
              : {
                  actions: (
                    <Button density="dense" disabled={pending} onClick={() => onRemove(g.toolKey)}>
                      {t("remove")}
                    </Button>
                  ),
                }),
          }))}
        />
        {!readOnly && open.length > 0 && (
          <Stack direction="row" gap={8} align="end">
            <Field label={t("addTool")}>
              <Select
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                options={[
                  { value: "", label: t("pickTool") },
                  ...open.map((x) => ({ value: x.key, label: x.title ?? x.key })),
                ]}
              />
            </Field>
            <Button
              disabled={pick === "" || pending}
              onClick={() => {
                onAdd(pick);
                setPick("");
              }}
            >
              {t("add")}
            </Button>
          </Stack>
        )}
        {missing.length > 0 && (
          <ItemList
            label={t("missingTitle")}
            rows={missing.map((k) => {
              const slug = connectionOf(k);
              const refusal = slug === null ? why(k) : null;
              return {
                id: k,
                title: slug ?? name(k),
                ...(refusal !== null ? { status: { label: refusal } } : {}),
                ...(readOnly || refusal !== null || (slug === null && tools === undefined)
                  ? {}
                  : {
                      actions:
                        slug !== null ? (
                          <LinkButton href="/account/connections" density="dense">
                            {t("connect", { slug })}
                          </LinkButton>
                        ) : (
                          <Button density="dense" disabled={pending} onClick={() => onAdd(k)}>
                            {t("addMissing")}
                          </Button>
                        ),
                    }),
              };
            })}
          />
        )}
      </Stack>
    </FormSection>
  );
}
