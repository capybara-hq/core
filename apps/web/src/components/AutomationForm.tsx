"use client";

import {
  Button,
  CheckList,
  Field,
  FormSection,
  Input,
  ItemList,
  LinkButton,
  RadioGroup,
  Repeater,
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
import {
  AUTOMATION_EFFORTS,
  type Automation,
  type AutomationChat,
  type AutomationCreateBody,
  type AutomationEffort,
  type AutomationGrant,
  type AutomationMode,
  type AutomationPreset,
  type AutomationUpdateBody,
  type ChatTarget,
  chatKey,
  clauseOf,
  connectionOf,
  dateIn,
  type EventDraft,
  type EventFilterClause,
  type EventSource,
  emptyEventDraft,
  endOfDayIn,
  eventBodyOf,
  eventDraftOf,
  eventDraftValid,
  type FilterableFact,
  type FilterRowDraft,
  filterableFacts,
  type GrantableTool,
  HOURLY_MINUTES,
  MONTH_DAYS,
  newRowKey,
  opsOf,
  PRESET_KINDS,
  type PresetKind,
  presetOf,
  presetValid,
  selectableTypes,
  switchPreset,
  triggerOf,
  type UnattendedAsk,
  zoneOf,
} from "../lib/automations";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import { decodeModel, encodeModel, pickerOptions } from "../lib/models";
import {
  allowHostProblem,
  NETWORK_GRANT_PREFIX,
  networkGrantHost,
  normalizeHost,
} from "../lib/network-hosts";
import {
  automationTargetsQuery,
  chatTargetsQuery,
  eventSourcesQuery,
  grantableToolsQuery,
} from "../lib/query/automations";
import { retryOnMountOf } from "../lib/query/client";
import { ApiErrorDetail } from "./ApiErrorDetail";

/** The fields the task form edits (the approved tools are their own section). */
export interface AutomationDraft {
  name: string;
  agentId: string;
  prompt: string;
  /** What starts a run: the clock (the preset) or events (the event part). */
  triggerKind: "time" | "event";
  preset: AutomationPreset;
  /** The event trigger; used when `triggerKind` is `event`. */
  event: EventDraft;
  /** What a question in an unattended run does; "" = the org's default. */
  unattendedAsk: "" | UnattendedAsk;
  /** The task's own zone (an existing task only). */
  timeZone: string | null;
  mode: AutomationMode;
  conversationId: string;
  /** Kept as it is: a chat is set from the chat itself (through the agent's tools). */
  chat: AutomationChat | null;
  /** `encodeModel` of the pick; "" = the agent's model. `new` mode only. */
  model: string;
  /** "" = the agent's effort. `new` mode only. */
  effort: string;
  /** The end date `YYYY-MM-DD` in the task's zone; "" = never (or the org's default on create). */
  expires: string;
}

/** The modes whose runs start their own conversations: they take a model and effort. */
const withPick = (mode: AutomationMode): boolean => mode === "new" || mode === "subject";

export const emptyDraft = (agentId: string): AutomationDraft => ({
  name: "",
  agentId,
  prompt: "",
  triggerKind: "time",
  preset: { kind: "daily", time: "09:00" },
  event: emptyEventDraft(),
  unattendedAsk: "",
  timeZone: null,
  mode: "new",
  conversationId: "",
  chat: null,
  model: "",
  effort: "",
  expires: "",
});

// an event automation has no schedule or zone: its time part starts from the default schedule,
// read in UTC (it matters only if the person switches the trigger to a schedule)
export const draftOf = (task: Automation): AutomationDraft => ({
  name: task.name,
  agentId: task.agentId,
  prompt: task.prompt,
  triggerKind: task.trigger.kind === "event" ? "event" : "time",
  preset: task.trigger.kind === "event" ? { kind: "daily", time: "09:00" } : presetOf(task.trigger),
  event: task.trigger.kind === "event" ? eventDraftOf(task.trigger) : emptyEventDraft(),
  unattendedAsk: task.unattendedAsk ?? "",
  timeZone: zoneOf(task.trigger),
  mode: task.mode,
  conversationId: task.conversationId ?? "",
  chat: task.chat,
  model: task.model === null ? "" : encodeModel(task.model),
  effort: task.effort ?? "",
  expires: task.expiresAt === null ? "" : dateIn(task.expiresAt, zoneOf(task.trigger) ?? "UTC"),
});

/** Whether the draft can be sent (the kernel checks the rest: cron, interval, target). */
export const draftValid = (d: AutomationDraft): boolean =>
  d.name.trim() !== "" &&
  d.prompt.trim() !== "" &&
  d.agentId !== "" &&
  (d.triggerKind === "event" ? eventDraftValid(d.event) : presetValid(d.preset)) &&
  // `subject` needs events, `chat` needs the clock
  (d.triggerKind === "event" ? d.mode !== "chat" : d.mode !== "subject") &&
  (d.mode !== "conversation" || d.conversationId !== "") &&
  (d.mode !== "chat" || d.chat !== null);

/** The create body of a draft (`grants`: the tools approved up front). */
export function createBodyOf(
  d: AutomationDraft,
  grants: string[],
  timeZone: string | undefined,
  /** The zone the end date is read in (the creator's). */
  displayZone: string,
): AutomationCreateBody {
  const model = d.model === "" ? null : decodeModel(d.model);
  const event = d.triggerKind === "event";
  return {
    agentId: d.agentId,
    name: d.name.trim(),
    prompt: d.prompt.trim(),
    trigger: event ? eventBodyOf(d.event) : triggerOf(d.preset),
    // an event automation has no zone
    ...(timeZone !== undefined && !event ? { timeZone } : {}),
    mode: d.mode,
    ...(d.unattendedAsk !== "" ? { unattendedAsk: d.unattendedAsk } : {}),
    ...(d.mode === "conversation" ? { conversationId: d.conversationId } : {}),
    ...(d.mode === "chat" && d.chat !== null ? { chat: d.chat } : {}),
    // model and effort: a new-conversation task's only (another runs with its conversation's)
    ...(withPick(d.mode) && model !== null ? { model } : {}),
    ...(withPick(d.mode) && d.effort !== "" ? { effort: d.effort as AutomationEffort } : {}),
    // an end date is a recurring task's (a one-off one has none, nor does an event one here)
    ...(d.expires !== "" && !event && d.preset.kind !== "once"
      ? { expiresAt: endOfDayIn(d.expires, displayZone) }
      : {}),
    ...(grants.length > 0 ? { grants: grants.map((toolKey) => ({ toolKey })) } : {}),
  };
}

const sameTrigger = (a: AutomationPreset, b: AutomationPreset) =>
  JSON.stringify(triggerOf(a)) === JSON.stringify(triggerOf(b));

/**
 * The patch of what changed between the saved task and the draft (empty: nothing). `fallbackZone`: the zone
 * an event automation takes when its trigger becomes a schedule (the kernel wants both together).
 */
export function patchOf(
  saved: AutomationDraft,
  d: AutomationDraft,
  fallbackZone = "UTC",
): AutomationUpdateBody {
  const p: AutomationUpdateBody = {};
  if (d.name.trim() !== saved.name) p.name = d.name.trim();
  if (d.prompt.trim() !== saved.prompt) p.prompt = d.prompt.trim();
  if (d.agentId !== saved.agentId) p.agentId = d.agentId;
  if (d.triggerKind === "event") {
    const body = eventBodyOf(d.event);
    if (
      saved.triggerKind !== "event" ||
      JSON.stringify(body) !== JSON.stringify(eventBodyOf(saved.event))
    ) {
      p.trigger = body;
    }
  } else if (saved.triggerKind === "event") {
    // from events to a schedule: the new trigger and its zone go together
    p.trigger = triggerOf(d.preset);
    p.timeZone = d.timeZone ?? fallbackZone;
  } else {
    if (!sameTrigger(saved.preset, d.preset)) p.trigger = triggerOf(d.preset);
    if (d.timeZone !== null && d.timeZone !== saved.timeZone) p.timeZone = d.timeZone;
  }
  if (d.unattendedAsk !== saved.unattendedAsk) {
    p.unattendedAsk = d.unattendedAsk === "" ? null : d.unattendedAsk;
  }
  if (d.mode !== saved.mode) p.mode = d.mode;
  if (d.mode === "conversation" && d.conversationId !== saved.conversationId) {
    p.conversationId = d.conversationId;
  }
  // Leaving a mode clears its target
  if (d.mode !== saved.mode && saved.mode === "conversation") p.conversationId = null;
  if (d.mode !== saved.mode && saved.mode === "chat") p.chat = null;
  // model and effort: `new` and `subject` modes (leaving them, the kernel clears them)
  if (withPick(d.mode)) {
    if (d.model !== saved.model) p.model = d.model === "" ? null : decodeModel(d.model);
    if (d.effort !== saved.effort) {
      p.effort = d.effort === "" ? null : (d.effort as AutomationEffort);
    }
  }
  if (d.expires !== saved.expires && d.triggerKind === "time" && d.preset.kind !== "once") {
    const zone = d.timeZone ?? saved.timeZone ?? "UTC";
    p.expiresAt = d.expires === "" ? null : endOfDayIn(d.expires, zone);
  }
  return p;
}

/** How many sections' fields differ (the ActionRow's count). */
export const changedCount = (saved: AutomationDraft, d: AutomationDraft): number =>
  Object.keys(patchOf(saved, d)).length;

/** The form's static field shapes while its data loads. */
export const LOADING_SECTIONS = {
  basic: [{ control: "select" as const }, {}, { control: "textarea" as const, rows: 4 }],
  schedule: [{ control: "select" as const }, {}],
  target: [{ control: "radio-cards" as const, options: 2 }],
  model: [{ control: "select" as const }, { control: "select" as const }],
};

type SetDraft = (f: (d: AutomationDraft) => AutomationDraft) => void;

/**
 * The task form's sections (spec §10): basics (name, agent, prompt), the schedule (presets that
 * write cron, the zone), where runs go and the model. `readOnly`: an org admin looking at another
 * member's task.
 */
export function AutomationFormSections({
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
  draft: AutomationDraft;
  setDraft: SetDraft;
  agents: Agent[];
  providers: ProviderModels[];
  /** The saved task (edit): its zone, chat and expiry show. */
  existing?: Automation;
  readOnly?: boolean;
  /** The org's shortest interval between runs (the schedule section's hint). */
  minIntervalMinutes?: number;
  /** A new task: the zone it will take (my account's, else the browser's). */
  createZone?: string;
}) {
  const t = useTranslations("automations.form");
  const tw = useTranslations("automations");
  const te = useTranslations("chat.effort");
  const locale = labelLocale(useLocale());
  const zone = useTimeZone();
  const set = <K extends keyof AutomationDraft>(k: K, v: AutomationDraft[K]) =>
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
  const setPreset = (preset: AutomationPreset) => set("preset", preset);
  const targetsQ = chatTargetsQuery(orgId);
  const targets = useQuery({
    ...targetsQ,
    enabled: !readOnly,
    retryOnMount: retryOnMountOf(targetsQ.queryKey),
  }).data?.items;
  const offerChat = draft.chat !== null || (targets?.length ?? 0) > 0;
  const isEvent = draft.triggerKind === "event";
  // `subject` needs events and `chat` needs the clock
  const modes: AutomationMode[] = [
    "new",
    "conversation",
    ...(isEvent ? ["subject" as const] : offerChat ? ["chat" as const] : []),
  ];
  const setKind = (kind: "time" | "event") =>
    setDraft((d) => ({
      ...d,
      triggerKind: kind,
      // a mode the new trigger cannot have falls back to a new conversation per run
      ...(kind === "event" && d.mode === "chat"
        ? { mode: "new" as const, chat: null }
        : kind === "time" && d.mode === "subject"
          ? { mode: "new" as const }
          : {}),
    }));
  // A chat task's agent is its connection's
  const agentFixed = draft.mode === "chat" && !isEvent;
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
          <RadioGroup
            label={t("triggerKind")}
            value={draft.triggerKind}
            disabled={readOnly}
            onChange={(v) => setKind(v as "time" | "event")}
            options={[
              { value: "time", label: t("kind.time") },
              { value: "event", label: t("kind.event") },
            ]}
          />
          {isEvent && (
            <EventTriggerFields
              orgId={orgId}
              event={draft.event}
              disabled={readOnly}
              onChange={(f) => setDraft((d) => ({ ...d, event: f(d.event) }))}
            />
          )}
          {!isEvent && (
            <>
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
              {existing === undefined || zoneOf(existing.trigger) === null ? (
                <Text variant="small" tone="muted">
                  {t("zoneCreate", { zone: createZone ?? zone ?? "UTC" })}
                </Text>
              ) : (
                <Field label={t("zone")}>
                  <Select
                    name="timeZone"
                    value={draft.timeZone ?? zoneOf(existing.trigger) ?? "UTC"}
                    disabled={readOnly}
                    onChange={(e) => set("timeZone", e.target.value)}
                    options={timeZoneOptions(zoneOf(existing.trigger) ?? "UTC")}
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
            </>
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
            onChange={(v) => set("mode", v as AutomationMode)}
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
          <Field label={t("unattendedAsk")} help={t("unattendedAskHelp")}>
            <Select
              name="unattendedAsk"
              value={draft.unattendedAsk}
              disabled={readOnly}
              onChange={(e) => set("unattendedAsk", e.target.value as "" | UnattendedAsk)}
              options={[
                { value: "", label: t("orgDefault") },
                { value: "fail", label: t("ask.fail") },
                { value: "wait", label: t("ask.wait") },
              ]}
            />
          </Field>
          {!offerChat && !isEvent && !readOnly && targets !== undefined && (
            <Text variant="small" tone="muted">
              {t("noChats")}
            </Text>
          )}
        </Stack>
      </FormSection>
      {withPick(draft.mode) && (
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
                  ...AUTOMATION_EFFORTS.map((e) => ({ value: e, label: te(e) })),
                ]}
              />
            </Field>
          </Stack>
        </FormSection>
      )}
    </>
  );
}

/**
 * The event trigger (collaboration spec §4.1, §4.3): the source (a trigger source that serves the
 * org), its event types (not the directed ones) and a filter of rows built from the selected
 * types' filterable facts. The sources load when the trigger is events.
 */
function EventTriggerFields({
  orgId,
  event,
  disabled,
  onChange,
}: {
  orgId: string;
  event: EventDraft;
  disabled: boolean;
  onChange(f: (e: EventDraft) => EventDraft): void;
}) {
  const t = useTranslations("automations.form");
  const locale = labelLocale(useLocale());
  const q = eventSourcesQuery(orgId);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const sources = read.data?.items;
  const source = sources?.find((x) => x.source === event.source);
  const sourceOptions = (sources ?? []).map((x) => ({
    value: x.source,
    label: extensionLabel({ name: x.source, displayName: x.name }, locale),
  }));
  if (event.source !== "" && !sourceOptions.some((o) => o.value === event.source)) {
    sourceOptions.push({ value: event.source, label: event.source });
  }
  const types = selectableTypes(source);
  const facts = filterableFacts(source, event.types);
  const noSources = sources !== undefined && sources.length === 0;
  const pickTypes = (id: string, on: boolean) =>
    onChange((e) => {
      const next = on ? [...e.types.filter((x) => x !== id), id] : e.types.filter((x) => x !== id);
      // a row stays while its fact is still filterable on every selected type, as the same type
      const kept = filterableFacts(source, next);
      return {
        ...e,
        types: next,
        filter: e.filter.filter((r) =>
          kept.some((f) => f.fact === r.fact && f.type === r.factType),
        ),
      };
    });
  return (
    <Stack gap={12}>
      <Field
        label={t("eventSource")}
        required
        {...(noSources ? { error: t("noEventSources") } : {})}
      >
        <Select
          value={event.source}
          disabled={disabled || sourceOptions.length === 0}
          placeholder={t("pickEventSource")}
          onChange={(e) => onChange(() => ({ source: e.target.value, types: [], filter: [] }))}
          options={sourceOptions}
        />
      </Field>
      {source !== undefined && (
        <CheckList
          label={t("eventTypes")}
          title={t("eventTypes")}
          disabled={disabled}
          rows={types.map((e) => ({
            id: e.type,
            title: extensionLabel({ name: e.type, displayName: e.name }, locale),
            description: e.type,
            checked: event.types.includes(e.type),
          }))}
          onCheck={pickTypes}
        />
      )}
      {source !== undefined && event.types.length > 0 && (
        <FilterRows rows={event.filter} facts={facts} disabled={disabled} onChange={onChange} />
      )}
    </Stack>
  );
}

/** The filter rows: a fact, an operator that fits its type and a value (all must match). */
function FilterRows({
  rows,
  facts,
  disabled,
  onChange,
}: {
  rows: FilterRowDraft[];
  facts: FilterableFact[];
  disabled: boolean;
  onChange(f: (e: EventDraft) => EventDraft): void;
}) {
  const t = useTranslations("automations.form");
  const locale = labelLocale(useLocale());
  const setRow = (key: string, f: (r: FilterRowDraft) => FilterRowDraft) =>
    onChange((e) => ({ ...e, filter: e.filter.map((r) => (r.key === key ? f(r) : r)) }));
  const rowFor = (fact: FilterableFact): FilterRowDraft => ({
    key: newRowKey(),
    fact: fact.fact,
    factType: fact.type,
    op: opsOf(fact.type)[0] ?? "eq",
    value: fact.type === "boolean" ? "true" : "",
  });
  const factName = (fact: string) => {
    const f = facts.find((x) => x.fact === fact);
    return f === undefined ? fact : extensionLabel({ name: fact, displayName: f.name }, locale);
  };
  const first = facts[0];
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("filterHint")}
      </Text>
      <Repeater
        variant="rows"
        label={t("filter")}
        addLabel={t("addFilter")}
        empty={t("filterEmpty")}
        disabled={disabled || (first === undefined && rows.length === 0)}
        items={rows.map((r) => ({
          key: r.key,
          title: factName(r.fact),
          invalid: clauseOf(r) === null,
          body: (
            <Stack direction="row" gap={8} align="end">
              <Select
                aria-label={t("filterFact")}
                value={r.fact}
                disabled={disabled}
                onChange={(e) => {
                  const f = facts.find((x) => x.fact === e.target.value);
                  if (f !== undefined) setRow(r.key, () => ({ ...rowFor(f), key: r.key }));
                }}
                options={[
                  ...facts.map((f) => ({
                    value: f.fact,
                    label: extensionLabel({ name: f.fact, displayName: f.name }, locale),
                  })),
                  ...(facts.some((f) => f.fact === r.fact)
                    ? []
                    : [{ value: r.fact, label: r.fact }]),
                ]}
              />
              <Select
                aria-label={t("filterOp")}
                value={r.op}
                disabled={disabled}
                onChange={(e) =>
                  setRow(r.key, (x) => ({ ...x, op: e.target.value as EventFilterClause["op"] }))
                }
                options={opsOf(r.factType).map((op) => ({ value: op, label: t(`op.${op}`) }))}
              />
              {r.factType === "boolean" ? (
                <Select
                  aria-label={t("filterValue")}
                  value={r.value}
                  disabled={disabled}
                  onChange={(e) => setRow(r.key, (x) => ({ ...x, value: e.target.value }))}
                  options={[
                    { value: "true", label: t("yes") },
                    { value: "false", label: t("no") },
                  ]}
                />
              ) : (
                <Input
                  aria-label={t("filterValue")}
                  value={r.value}
                  maxLength={500}
                  disabled={disabled}
                  placeholder={r.op === "in" ? t("filterListPlaceholder") : ""}
                  onChange={(e) => setRow(r.key, (x) => ({ ...x, value: e.target.value }))}
                />
              )}
            </Stack>
          ),
        }))}
        onAdd={() => {
          if (first !== undefined)
            onChange((e) => ({ ...e, filter: [...e.filter, rowFor(first)] }));
        }}
        onRemove={(key) => {
          let before: FilterRowDraft[] = [];
          onChange((e) => {
            before = e.filter;
            return { ...e, filter: e.filter.filter((r) => r.key !== key) };
          });
          return () => onChange((e) => ({ ...e, filter: before }));
        }}
      />
    </Stack>
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
  const t = useTranslations("automations.form");
  const q = automationTargetsQuery(orgId, agentId);
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
  value: AutomationChat | null;
  disabled: boolean;
  onChange(c: ChatTarget): void;
}) {
  const t = useTranslations("automations.form");
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
  granted: grantedAll,
  tools,
  refused: refusedAll,
  readOnly = false,
  pending = false,
  onAdd,
  onRemove,
}: {
  granted: Pick<AutomationGrant, "toolKey" | "stale">[];
  /** The agent's tools with their flags; undefined while they load. */
  tools: GrantableTool[] | undefined;
  refused: string[];
  readOnly?: boolean;
  pending?: boolean;
  onAdd(toolKey: string): void;
  onRemove(toolKey: string): void;
}) {
  const t = useTranslations("automations.form");
  const [pick, setPick] = useState("");
  // domains (`network:<host>`) are the Network access section's
  const granted = grantedAll.filter((g) => networkGrantHost(g.toolKey) === null);
  const refused = refusedAll.filter((k) => networkGrantHost(k) === null);
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

/**
 * Network access (network ask spec §8.1): the domains the task's unattended runs may reach on its
 * device without asking, each a `network:<host>` grant (exact hosts), with 移除; an add field; the
 * domains the latest runs were refused with 加入. The kernel refuses a domain outside the org's
 * network (only an admin can add it) or any domain when the task's device takes no network
 * changes; `error` is that refusal, shown with the kernel's reason.
 */
export function NetworkAccessSection({
  granted,
  refused,
  readOnly = false,
  pending = false,
  error = null,
  onAdd,
  onRemove,
}: {
  /** Grant keys; only the `network:<host>` ones are listed. */
  granted: string[];
  /** What the latest runs were refused; only the `network:<host>` keys are listed. */
  refused: string[];
  readOnly?: boolean;
  pending?: boolean;
  error?: unknown;
  onAdd(key: string): void;
  onRemove(key: string): void;
}) {
  const t = useTranslations("automations.form");
  const [host, setHost] = useState("");
  const [problem, setProblem] = useState<string>();
  const keys = granted.filter((k) => networkGrantHost(k) !== null);
  const missing = refused.filter((k) => networkGrantHost(k) !== null && !keys.includes(k));
  const add = () => {
    const h = normalizeHost(host);
    const why = allowHostProblem(h, { wildcard: false });
    if (why !== null) {
      setProblem(t(why === "wildcard" ? "networkWildcard" : "networkInvalid"));
      return;
    }
    setProblem(undefined);
    setHost("");
    if (!keys.includes(NETWORK_GRANT_PREFIX + h)) onAdd(NETWORK_GRANT_PREFIX + h);
  };
  return (
    <FormSection id="network" title={t("network")} description={t("networkHint")}>
      <Stack gap={12}>
        <ItemList
          label={t("networkLabel")}
          empty={t("networkEmpty")}
          rows={keys.map((k) => ({
            id: k,
            title: networkGrantHost(k) ?? k,
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
        {!readOnly && (
          <Stack direction="row" gap={8} align="end">
            <Field
              label={t("domain")}
              help={t("addDomainHelp")}
              {...(problem !== undefined ? { error: problem } : {})}
            >
              <Input
                value={host}
                maxLength={253}
                placeholder="files.example.com"
                onChange={(e) => {
                  setHost(e.target.value);
                  setProblem(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </Field>
            <Button disabled={host.trim() === "" || pending} onClick={add}>
              {t("addDomain")}
            </Button>
          </Stack>
        )}
        {missing.length > 0 && (
          <ItemList
            label={t("networkMissing")}
            rows={missing.map((k) => ({
              id: k,
              title: networkGrantHost(k) ?? k,
              ...(readOnly
                ? {}
                : {
                    actions: (
                      <Button density="dense" disabled={pending} onClick={() => onAdd(k)}>
                        {t("addMissing")}
                      </Button>
                    ),
                  }),
            }))}
          />
        )}
        {error !== null && error !== undefined && (
          <ApiErrorDetail
            error={error}
            open
            summaries={{ "automation.grant_not_allowed": t("networkRefused") }}
          />
        )}
      </Stack>
    </FormSection>
  );
}
