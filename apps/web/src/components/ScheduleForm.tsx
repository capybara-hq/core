"use client";

import {
  Button,
  Field,
  FormSection,
  Input,
  ItemList,
  KeyValue,
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
import { type Agent, BUILTIN_TOOLS, type ProviderModels } from "../lib/agents";
import { labelLocale } from "../lib/extension-label";
import { decodeModel, encodeModel, pickerOptions } from "../lib/models";
import { extensionToolsQuery } from "../lib/query/agents";
import { retryOnMountOf } from "../lib/query/client";
import { scheduleTargetsQuery } from "../lib/query/schedules";
import {
  connectionOf,
  PRESET_KINDS,
  type PresetKind,
  presetOf,
  presetValid,
  SCHEDULE_EFFORTS,
  type ScheduleChat,
  type ScheduleCreateBody,
  type ScheduledTask,
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
  /** `encodeModel` of the pick; "" = the agent's model. */
  model: string;
  /** "" = the agent's effort. */
  effort: string;
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
    ...(model !== null ? { model } : {}),
    ...(d.effort !== "" ? { effort: d.effort as ScheduleEffort } : {}),
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
  if (d.model !== saved.model) p.model = d.model === "" ? null : decodeModel(d.model);
  if (d.effort !== saved.effort) {
    p.effort = d.effort === "" ? null : (d.effort as ScheduleEffort);
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
}: {
  orgId: string;
  draft: ScheduleDraft;
  setDraft: SetDraft;
  agents: Agent[];
  providers: ProviderModels[];
  /** The saved task (edit): its zone, chat and expiry show. */
  existing?: ScheduledTask;
  readOnly?: boolean;
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
  const modes: ScheduleMode[] = [
    "new",
    "conversation",
    ...(draft.chat !== null ? ["chat" as const] : []),
  ];
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
            {...(agents.length === 0 ? { error: t("noAgents") } : {})}
          >
            <Select
              value={draft.agentId}
              disabled={readOnly || agentOptions.length === 0}
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
                options={[0, 5, 10, 15, 20, 30, 45].map((m) => ({
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
                options={Array.from({ length: 28 }, (_, i) => ({
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
              {t("zoneCreate", { zone: zone ?? "UTC" })}
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
          {draft.mode === "chat" && draft.chat !== null && (
            <KeyValue
              keyWidth="10ch"
              rows={[
                { k: t("chatTarget"), v: t(`chatType.${draft.chat.chatType}`) },
                { k: "ID", v: draft.chat.chatId },
              ]}
            />
          )}
          {draft.chat === null && (
            <Text variant="small" tone="muted">
              {t("chatOnlyFromChat")}
            </Text>
          )}
        </Stack>
      </FormSection>
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

/** Tools a task never approves up front: they need no approval, or never take a grant. */
const NOT_GRANTABLE = new Set(["AskUserQuestion", "ReadToolOutput", "CurrentTime", "ScheduleList"]);

/**
 * The tools a task can approve up front: the agent's builtins and the tools of the extensions on in
 * the org, less what the agent turned off (connector tools come in through a trial run or a refused
 * run's list).
 */
export function useGrantableTools(orgId: string, agent: Agent | undefined): string[] {
  const q = extensionToolsQuery(orgId);
  const ext = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data;
  const off = agent?.definition.disabledTools ?? [];
  const offBuiltin = new Set(off.flatMap((r) => (r.kind === "builtin" ? [r.name] : [])));
  const builtins = BUILTIN_TOOLS.filter((n) => !NOT_GRANTABLE.has(n) && !offBuiltin.has(n));
  const extTools = (ext?.extensions ?? []).flatMap((e) => {
    const entry = off.find((r) => r.kind === "plugin" && r.plugin === e.plugin);
    const offTools = entry?.kind === "plugin" ? entry.tools : [];
    if (offTools === "all") return [];
    return e.tools.filter((x) => !offTools.includes(x.name)).map((x) => x.key);
  });
  return [...builtins, ...extTools];
}

/**
 * The approved tools (spec §7): the granted ones with 移除, a picker to add one, and what the latest
 * runs were refused (加入预先批准的工具, or 连接 for a personal connector). `onAdd` / `onRemove` are
 * the create form's draft or the saved task's grant routes.
 */
export function ApprovedToolsSection({
  granted,
  options,
  refused,
  readOnly = false,
  pending = false,
  onAdd,
  onRemove,
}: {
  granted: string[];
  options: string[];
  refused: string[];
  readOnly?: boolean;
  pending?: boolean;
  onAdd(toolKey: string): void;
  onRemove(toolKey: string): void;
}) {
  const t = useTranslations("schedules.form");
  const [pick, setPick] = useState("");
  const open = options.filter((k) => !granted.includes(k));
  const missing = refused.filter((k) => !granted.includes(k));
  return (
    <FormSection id="tools" title={t("tools")} description={t("toolsHint")}>
      <Stack gap={12}>
        <ItemList
          label={t("toolsLabel")}
          empty={t("toolsEmpty")}
          rows={granted.map((k) => ({
            id: k,
            title: k,
            ...(readOnly
              ? {}
              : {
                  actions: (
                    <Button density="dense" disabled={pending} onClick={() => onRemove(k)}>
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
                  ...open.map((k) => ({ value: k, label: k })),
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
              return {
                id: k,
                title: slug ?? k,
                ...(readOnly
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
