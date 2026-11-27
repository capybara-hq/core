"use client";

import {
  Callout,
  CheckList,
  type Column,
  DataTable,
  Field,
  FormSection,
  Input,
  RadioGroup,
  SettingsPage,
  Stack,
  SwitchField,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  type AutomationColumnKey,
  automationColumns,
  DeleteAutomationDialog,
  useAutomationActions,
  useAutomationWords,
  useEventSourceName,
} from "../../../../components/AutomationParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { Person } from "../../../../components/Person";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  type AcceptanceMode,
  AUTOMATION_SETTINGS_DEFAULTS,
  type AutomationListItem,
  type AutomationsSettings,
  splitToolKeys,
} from "../../../../lib/automations";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { agentsQuery } from "../../../../lib/query/agents";
import { automationsQuery, eventSourcesQuery } from "../../../../lib/query/automations";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useMemberNames } from "../../../../lib/query/member-names";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/automations` (org admins, `automations.manage`; SettingsPage): the automation settings
 * of spec §9 (on / off, what an ask outside the grants does, the limits, the forbidden tools), saved
 * through the shared org-settings PATCH with only the changed fields (while the kernel flags the
 * forbidden list unreadable, a notice with its own save sends the list shown to repair it; that is
 * no pending change of the form), and every task of the org
 * (a row opens it read-only; its menu pauses, resumes or deletes it: admins never edit another
 * member's task). From the query cache (the layout prefetched the settings and the tasks on a first
 * load).
 */
export default function AutomationSettingsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <AutomationSettings orgId={ws.orgId} />;
}

/** The number fields, in the order the form shows them. */
const COUNTS = [
  "minIntervalMinutes",
  "maxTasksPerMember",
  "maxTasksPerOrg",
  "maxRunsPerHour",
  "catchUpWindowMinutes",
  "pauseAfterFailures",
] as const;
/** The event automation numbers: their own section, with the kernel's upper bounds. */
const EVENT_COUNTS = ["maxEventDepth", "coalesceSeconds", "maxEventRunsPerSubjectPerHour"] as const;
const COUNT_MAX: Partial<Record<CountKey, number>> = {
  maxEventDepth: 1000,
  coalesceSeconds: 86_400,
};
type CountKey = (typeof COUNTS)[number] | (typeof EVENT_COUNTS)[number];

type Draft = Partial<{
  enabled: boolean;
  unattendedAsk: "fail" | "wait";
  counts: Partial<Record<CountKey, string>>;
  expiry: string;
  forbidden: string;
  /** The event sources turned off, as the full list. */
  off: string[];
  /** What work assigned to a member does when they set no rule for its source. */
  directed: AcceptanceMode;
}>;

/** A whole number of at least 1, and at most `max` when given (null otherwise). */
const count = (s: string, max = Number.POSITIVE_INFINITY): number | null =>
  /^\d{1,7}$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= max ? Number(s) : null;

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The same names, in any order. */
const sameSet = (a: readonly string[], b: readonly string[]) =>
  sameList([...a].sort(), [...b].sort());

function AutomationSettings({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("automationSettings");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useOrgSettingsNav();
  const qc = useQueryClient();
  const read = usePageQuery(orgSettingsQuery(orgId));
  const [draft, setDraft] = useState<Draft>({});
  const update = useAppMutation({
    fn: (patch: OrgSettingsPatch) => updateOrgSettings(orgId, patch),
    invalidates: () => [],
    onSuccess: (res) =>
      qc.setQueryData<OrgSettingsResponse>(orgSettingsQuery(orgId).queryKey, (old) => ({
        ...old,
        ...res,
      })),
  });
  const header = {
    path: [
      ...scope,
      { label: "settings", href: "/settings/organization" },
      { label: "automations" },
    ],
    title: t("title"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="automations"
        loading={{
          sections: [
            {
              fields: [{ control: "switch" }, { control: "radio-cards", options: 2 }],
              title: t("general"),
              description: t("generalHint"),
            },
            { fields: 7, title: t("limits"), description: t("limitsHint") },
            {
              fields: [{}, {}, {}, { control: "radio-cards", options: 3 }, {}],
              title: t("events"),
              description: t("eventsHint"),
            },
            {
              fields: [{ control: "textarea", rows: 4, help: true }],
              title: t("forbidden"),
              description: t("forbiddenHint"),
            },
          ],
        }}
      />
    );
  }
  const saved: AutomationsSettings = {
    ...AUTOMATION_SETTINGS_DEFAULTS,
    ...read.data.settings.automations,
  };
  const enabled = draft.enabled ?? saved.enabled;
  const ask = draft.unattendedAsk ?? saved.unattendedAsk;
  const countText = (k: CountKey) => draft.counts?.[k] ?? String(saved[k]);
  const countOf = (k: CountKey) => count(countText(k), COUNT_MAX[k]);
  const off = draft.off ?? saved.eventSourcesOff;
  const directed = draft.directed ?? saved.directedDefault;
  const expiryText =
    draft.expiry ?? (saved.defaultExpiryDays === null ? "" : String(saved.defaultExpiryDays));
  // the stored list cannot be read (it reads []): the notice's save sends the list shown to repair it
  const unreadable = saved.forbiddenToolsUnreadable === true;
  const forbiddenText = draft.forbidden ?? saved.forbiddenTools.join("\n");
  const forbidden = splitToolKeys(forbiddenText);
  const invalid = new Set<string>([...COUNTS, ...EVENT_COUNTS].filter((k) => countOf(k) === null));
  const expiry = expiryText.trim() === "" ? null : count(expiryText);
  if (expiryText.trim() !== "" && expiry === null) invalid.add("defaultExpiryDays");
  // Only the changed fields go in the PATCH
  const patch: Partial<AutomationsSettings> = {
    ...(enabled !== saved.enabled ? { enabled } : {}),
    ...(ask !== saved.unattendedAsk ? { unattendedAsk: ask } : {}),
    ...Object.fromEntries(
      [...COUNTS, ...EVENT_COUNTS].flatMap((k) => {
        const n = countOf(k);
        return n !== null && n !== saved[k] ? [[k, n]] : [];
      }),
    ),
    ...(!sameSet(off, saved.eventSourcesOff) ? { eventSourcesOff: off } : {}),
    ...(directed !== saved.directedDefault ? { directedDefault: directed } : {}),
    ...(!invalid.has("defaultExpiryDays") && expiry !== saved.defaultExpiryDays
      ? { defaultExpiryDays: expiry }
      : {}),
    ...(!sameList(forbidden, saved.forbiddenTools) ? { forbiddenTools: forbidden } : {}),
  };
  const unsaved = Object.keys(patch).length;
  const dirty = unsaved > 0 || invalid.size > 0;

  async function save() {
    if (invalid.size > 0) return;
    try {
      await update.mutateAsync({ automations: patch });
      setDraft({});
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function repair() {
    try {
      await update.mutateAsync({ automations: { forbiddenTools: forbidden } });
      setDraft((d) => {
        const { forbidden: _, ...rest } = d;
        return rest;
      });
      toast.success(t("saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  const setCount = (k: CountKey, v: string) =>
    setDraft((d) => ({ ...d, counts: { ...d.counts, [k]: v } }));

  return (
    <SettingsPage
      header={header}
      nav={nav}
      activeNav="automations"
      {...(dirty
        ? {
            actionRow: {
              unsaved,
              errors: invalid.size,
              cancel: { label: tc("cancel"), onSelect: () => setDraft({}) },
              primary: {
                label: t("save"),
                onSelect: () => void save(),
                loading: update.isPending,
                disabled: invalid.size > 0 || unsaved === 0,
              },
            },
          }
        : {})}
    >
      {unreadable && (
        <Callout tone="warn" action={{ label: t("saveRepair"), onSelect: () => void repair() }}>
          {t("forbiddenUnreadable")}
        </Callout>
      )}
      <FormSection id="automations-general" title={t("general")} description={t("generalHint")}>
        <Stack gap={12}>
          <Field label={t("enabled")} help={t("enabledHint")}>
            <SwitchField
              label={t("enabled")}
              checked={enabled}
              onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            />
          </Field>
          <RadioGroup
            label={t("unattendedAsk")}
            variant="card"
            value={ask}
            onChange={(v) => setDraft((d) => ({ ...d, unattendedAsk: v as "fail" | "wait" }))}
            options={(["fail", "wait"] as const).map((v) => ({
              value: v,
              label: t(`ask.${v}`),
              description: t(`ask.${v}Hint`),
            }))}
          />
        </Stack>
      </FormSection>
      <FormSection id="automations-limits" title={t("limits")} description={t("limitsHint")}>
        <Stack gap={12}>
          {COUNTS.map((k) => (
            <Field
              key={k}
              label={t(k)}
              {...(k === "catchUpWindowMinutes" ? { help: t("catchUpHelp") } : {})}
              {...(invalid.has(k) ? { error: t("invalid") } : {})}
            >
              <Input
                name={k}
                inputMode="numeric"
                value={countText(k)}
                onChange={(e) => setCount(k, e.target.value)}
              />
            </Field>
          ))}
          <Field
            label={t("defaultExpiryDays")}
            help={t("defaultExpiryHelp")}
            {...(invalid.has("defaultExpiryDays") ? { error: t("invalid") } : {})}
          >
            <Input
              name="defaultExpiryDays"
              inputMode="numeric"
              value={expiryText}
              onChange={(e) => setDraft((d) => ({ ...d, expiry: e.target.value }))}
            />
          </Field>
        </Stack>
      </FormSection>
      <FormSection id="automations-events" title={t("events")} description={t("eventsHint")}>
        <Stack gap={12}>
          {EVENT_COUNTS.map((k) => (
            <Field
              key={k}
              label={t(k)}
              help={t(
                k === "maxEventDepth"
                  ? "maxEventDepthHelp"
                  : k === "coalesceSeconds"
                    ? "coalesceHelp"
                    : "maxEventRunsHelp",
              )}
              {...(invalid.has(k) ? { error: t("invalid") } : {})}
            >
              <Input
                name={k}
                inputMode="numeric"
                value={countText(k)}
                onChange={(e) => setCount(k, e.target.value)}
              />
            </Field>
          ))}
          <RadioGroup
            label={t("directedDefault")}
            variant="card"
            value={directed}
            onChange={(v) => setDraft((d) => ({ ...d, directed: v as AcceptanceMode }))}
            options={(["auto", "confirm", "off"] as const).map((v) => ({
              value: v,
              label: t(`directed.${v}`),
              description: t(`directed.${v}Hint`),
            }))}
          />
          <EventSourcesOff
            orgId={orgId}
            off={off}
            onChange={(next) => setDraft((d) => ({ ...d, off: next }))}
          />
        </Stack>
      </FormSection>
      <FormSection
        id="automations-forbidden"
        title={t("forbidden")}
        description={t("forbiddenHint")}
      >
        <Field label={t("forbiddenTools")} help={t("forbiddenHelp")}>
          <Textarea
            code
            rows={4}
            value={forbiddenText}
            onChange={(e) => setDraft((d) => ({ ...d, forbidden: e.target.value }))}
          />
        </Field>
      </FormSection>
      <AllTasks orgId={orgId} />
    </SettingsPage>
  );
}

/**
 * The event sources of the org, each checked while it may start automations. A source the org
 * switched off is no longer listed by the kernel: it stays as a row by its name until it is
 * checked again.
 */
function EventSourcesOff({
  orgId,
  off,
  onChange,
}: {
  orgId: string;
  off: string[];
  onChange(next: string[]): void;
}) {
  const t = useTranslations("automationSettings");
  const locale = labelLocale(useLocale());
  const q = eventSourcesQuery(orgId);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const sources = read.data?.items ?? [];
  const rows = [
    ...sources.map((s) => ({
      id: s.source,
      title: extensionLabel({ name: s.source, displayName: s.name }, locale),
    })),
    ...off.filter((n) => !sources.some((s) => s.source === n)).map((n) => ({ id: n, title: n })),
  ];
  if (rows.length === 0) return null;
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("eventSourcesHelp")}
      </Text>
      <CheckList
        label={t("eventSources")}
        title={t("eventSources")}
        rows={rows.map((r) => ({ ...r, checked: !off.includes(r.id) }))}
        onCheck={(id, on) => onChange(on ? off.filter((n) => n !== id) : [...off, id])}
      />
    </Stack>
  );
}

/**
 * Compact rows (below 600): the task leads, its owner under it, the agent after, the state at
 * the end.
 */
const COMPACT: Record<AutomationColumnKey, NonNullable<Column<AutomationListItem>["compact"]>> = {
  name: "title",
  agent: "meta",
  status: "trailing",
  schedule: "hidden",
  next: "hidden",
  last: "hidden",
};

/** Every task of the org (a flush section holding the table), with the creator. */
function AllTasks({ orgId }: { orgId: string }) {
  const t = useTranslations("automationSettings");
  const ts = useTranslations("automations");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const when = useAutomationWords();
  const actions = useAutomationActions(orgId);
  const names = useMemberNames(orgId);
  const [deleting, setDeleting] = useState<AutomationListItem | null>(null);
  const tasksQ = automationsQuery(orgId, "all");
  const tasks = useQuery({ ...tasksQ, retryOnMount: retryOnMountOf(tasksQ.queryKey) });
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  const refs = names.kind === "ready" ? names.refs : {};
  const sourceName = useEventSourceName(orgId, tasks.data?.items);
  const base = automationColumns(ts, when, agentName, sourceName).map((c) => ({
    ...c,
    compact: COMPACT[c.key],
  }));
  const creator: Column<AutomationListItem> = {
    key: "creator",
    header: ts("columns.creator"),
    compact: "subtitle",
    cell: (s) => <Person person={refs[s.accountId] ?? null} size={16} />,
  };
  const columns: Column<AutomationListItem>[] = [...base.slice(0, 1), creator, ...base.slice(1)];
  const act = async (p: Promise<unknown>, done: string) => {
    try {
      await p;
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <FormSection id="automations-tasks" title={t("tasks")} description={t("tasksHint")} flush>
      <DataTable<AutomationListItem>
        label={t("tasks")}
        columns={columns}
        rows={tasks.data?.items ?? []}
        rowKey={(s) => s.id}
        rowLabel={(s) => s.name}
        state={tasks.data === undefined ? (tasks.error ? "error" : "loading") : "ready"}
        {...(tasks.error
          ? { error: { code: tasks.error.code, onRetry: () => void tasks.refetch() } }
          : {})}
        empty={{ title: t("tasksEmpty") }}
        onOpen={(s) => router.push(`/automations/${encodeURIComponent(s.id)}`)}
        rowMenu={(s) => [
          s.status === "active"
            ? {
                label: ts("actions.pause"),
                onSelect: () => void act(actions.pause.mutateAsync(s.id), ts("actions.paused")),
              }
            : {
                label: ts("actions.resume"),
                disabled: s.status === "ended",
                onSelect: () => void act(actions.resume.mutateAsync(s.id), ts("actions.resumed")),
              },
          { label: ts("actions.delete"), danger: true, onSelect: () => setDeleting(s) },
        ]}
      />
      {deleting !== null && (
        <DeleteAutomationDialog
          name={deleting.name}
          onClose={() => setDeleting(null)}
          onDelete={async () => {
            await actions.remove.mutateAsync(deleting.id);
            setDeleting(null);
            toast.success(ts("actions.deleted"));
          }}
        />
      )}
    </FormSection>
  );
}
