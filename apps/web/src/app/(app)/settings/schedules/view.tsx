"use client";

import {
  DataTable,
  Field,
  FormSection,
  Input,
  RadioGroup,
  SettingsPage,
  Stack,
  SwitchField,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import {
  DeleteScheduleDialog,
  scheduleColumns,
  useScheduleActions,
  useScheduleWords,
} from "../../../../components/ScheduleParts";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  type OrgSettingsPatch,
  type OrgSettingsResponse,
  updateOrgSettings,
} from "../../../../lib/org-settings";
import { agentsQuery } from "../../../../lib/query/agents";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useMemberNames } from "../../../../lib/query/member-names";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { schedulesQuery } from "../../../../lib/query/schedules";
import { orgSettingsQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import {
  SCHEDULE_SETTINGS_DEFAULTS,
  type ScheduledTaskListItem,
  type ScheduledTasksSettings,
  splitToolKeys,
} from "../../../../lib/schedules";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/schedules` (org admins, `schedules.manage`; SettingsPage): the scheduled-task settings
 * of spec §9 (on / off, what an ask outside the grants does, the limits, the forbidden tools), saved
 * through the shared org-settings PATCH with only the changed fields, and every task of the org
 * (a row opens it read-only; its menu pauses, resumes or deletes it: admins never edit another
 * member's task). From the query cache (the layout prefetched the settings and the tasks on a first
 * load).
 */
export default function ScheduleSettingsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <ScheduleSettings orgId={ws.orgId} />;
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
type CountKey = (typeof COUNTS)[number];

type Draft = Partial<{
  enabled: boolean;
  unattendedAsk: "fail" | "wait";
  counts: Partial<Record<CountKey, string>>;
  expiry: string;
  forbidden: string;
}>;

/** A whole number of at least 1 (null otherwise). */
const count = (s: string): number | null =>
  /^\d{1,7}$/.test(s.trim()) && Number(s) >= 1 ? Number(s) : null;

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function ScheduleSettings({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("scheduleSettings");
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
    path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "schedules" }],
    title: t("title"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="schedules"
        loading={{
          sections: [
            {
              fields: [{ control: "switch" }, { control: "radio-cards", options: 2 }],
              title: t("general"),
              description: t("generalHint"),
            },
            { fields: 7, title: t("limits"), description: t("limitsHint") },
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
  const saved: ScheduledTasksSettings = {
    ...SCHEDULE_SETTINGS_DEFAULTS,
    ...read.data.settings.scheduledTasks,
  };
  const enabled = draft.enabled ?? saved.enabled;
  const ask = draft.unattendedAsk ?? saved.unattendedAsk;
  const countText = (k: CountKey) => draft.counts?.[k] ?? String(saved[k]);
  const expiryText =
    draft.expiry ?? (saved.defaultExpiryDays === null ? "" : String(saved.defaultExpiryDays));
  const forbiddenText = draft.forbidden ?? saved.forbiddenTools.join("\n");
  const forbidden = splitToolKeys(forbiddenText);
  const invalid = new Set<string>(COUNTS.filter((k) => count(countText(k)) === null));
  const expiry = expiryText.trim() === "" ? null : count(expiryText);
  if (expiryText.trim() !== "" && expiry === null) invalid.add("defaultExpiryDays");
  // Only the changed fields go in the PATCH
  const patch: Partial<ScheduledTasksSettings> = {
    ...(enabled !== saved.enabled ? { enabled } : {}),
    ...(ask !== saved.unattendedAsk ? { unattendedAsk: ask } : {}),
    ...Object.fromEntries(
      COUNTS.flatMap((k) => {
        const n = count(countText(k));
        return n !== null && n !== saved[k] ? [[k, n]] : [];
      }),
    ),
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
      await update.mutateAsync({ scheduledTasks: patch });
      setDraft({});
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
      activeNav="schedules"
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
      <FormSection id="schedules-general" title={t("general")} description={t("generalHint")}>
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
      <FormSection id="schedules-limits" title={t("limits")} description={t("limitsHint")}>
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
      <FormSection id="schedules-forbidden" title={t("forbidden")} description={t("forbiddenHint")}>
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

/** Every task of the org (a flush section holding the table), with the creator. */
function AllTasks({ orgId }: { orgId: string }) {
  const t = useTranslations("scheduleSettings");
  const ts = useTranslations("schedules");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const when = useScheduleWords();
  const actions = useScheduleActions(orgId);
  const names = useMemberNames(orgId);
  const [deleting, setDeleting] = useState<ScheduledTaskListItem | null>(null);
  const tasksQ = schedulesQuery(orgId, "all");
  const tasks = useQuery({ ...tasksQ, retryOnMount: retryOnMountOf(tasksQ.queryKey) });
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  const people = names.kind === "ready" ? names.people : {};
  const base = scheduleColumns(ts, when, agentName);
  const columns = [
    ...base.slice(0, 1),
    {
      key: "creator",
      header: ts("columns.creator"),
      cell: (s: ScheduledTaskListItem) => people[s.accountId] ?? s.accountId,
    },
    ...base.slice(1),
  ];
  const act = async (p: Promise<unknown>, done: string) => {
    try {
      await p;
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <FormSection id="schedules-tasks" title={t("tasks")} description={t("tasksHint")} flush>
      <DataTable<ScheduledTaskListItem>
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
        onOpen={(s) => router.push(`/schedules/${encodeURIComponent(s.id)}`)}
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
        <DeleteScheduleDialog
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
