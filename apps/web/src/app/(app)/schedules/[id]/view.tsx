"use client";

import {
  type Column,
  DangerZone,
  DangerZoneItem,
  DataTable,
  DateTime,
  ErrorDetail,
  FormPage,
  FormSection,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import {
  ApprovedToolsSection,
  changedCount,
  draftOf,
  draftValid,
  LOADING_SECTIONS,
  patchOf,
  type ScheduleDraft,
  ScheduleFormSections,
  useGrantableTools,
} from "../../../../components/ScheduleForm";
import {
  DeleteScheduleDialog,
  ScheduleStateMark,
  useScheduleActions,
} from "../../../../components/ScheduleParts";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { ProviderModels } from "../../../../lib/agents";
import { roleAtLeast } from "../../../../lib/members";
import { agentsQuery } from "../../../../lib/query/agents";
import { retryOnMountOf } from "../../../../lib/query/client";
import { modelsQuery } from "../../../../lib/query/conversation";
import { inboxChangeKeys } from "../../../../lib/query/inbox";
import { keys } from "../../../../lib/query/keys";
import { useMemberNames } from "../../../../lib/query/member-names";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import {
  scheduleGrantsQuery,
  scheduleQuery,
  scheduleRunsQuery,
} from "../../../../lib/query/schedules";
import { useWorkspace } from "../../../../lib/query/workspace";
import {
  addScheduleGrants,
  removeScheduleGrant,
  type ScheduledTask,
  type TaskRun,
  updateSchedule,
} from "../../../../lib/schedules";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/schedules/[id]`: one scheduled task (FormPage, spec §10): the task's fields (basics, schedule
 * with its zone, where runs go, model and effort), its approved tools (added or removed at once,
 * with what the latest runs were refused) and its run history. The head runs it now, runs a trial
 * (its approvals become the task's grants) and pauses or resumes it; the danger zone deletes it.
 * An org admin opening another member's task sees it read-only and may only pause, resume or delete
 * it. Members up (guests: the no-access state). From the query cache (the layout prefetched the
 * task, its runs and grants on a first load).
 */
export default function ScheduleView({ id }: { id: string }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <Schedule
      orgId={ws.orgId}
      id={id}
      me={ws.me.account.id}
      admin={roleAtLeast(ws.role, "admin")}
    />
  );
}

function Schedule({
  orgId,
  id,
  me,
  admin,
}: {
  orgId: string;
  id: string;
  me: string;
  admin: boolean;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("schedules");
  const read = usePageQuery(scheduleQuery(orgId, id));
  const agentsQ = agentsQuery(orgId);
  const agentsRead = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) });
  // The agents name the picker's options; when they can't be read the task's own id shows
  const agents = agentsRead.data ?? (agentsRead.error ? { agents: [] } : undefined);
  const modelsQ = modelsQuery(orgId);
  const models = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data;
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading" || agents === undefined) {
    return (
      <FormPage
        loading
        header={{
          path: [...scope, { label: "schedules", href: "/schedules" }, { label: id }],
          title: t("title"),
          loading: { title: true, actions: 3 },
        }}
        actionRow={{ unsaved: 0, primary: { label: t("form.save"), onSelect: () => {} } }}
      >
        <FormSection
          id="basic"
          title={t("form.basic")}
          description={t("form.basicHint")}
          loading={{ fields: LOADING_SECTIONS.basic }}
        />
        <FormSection
          id="schedule"
          title={t("form.schedule")}
          description={t("form.scheduleHint")}
          loading={{ fields: LOADING_SECTIONS.schedule }}
        />
      </FormPage>
    );
  }
  const task = read.data.task;
  return (
    <ScheduleForm
      // a saved change starts the draft over from the answer
      key={task.updatedAt}
      orgId={orgId}
      task={task}
      agents={agents.agents}
      providers={models?.providers ?? []}
      own={task.accountId === me}
      admin={admin}
    />
  );
}

function ScheduleForm({
  orgId,
  task,
  agents,
  providers,
  own,
  admin,
}: {
  orgId: string;
  task: ScheduledTask;
  agents: Parameters<typeof ScheduleFormSections>[0]["agents"];
  providers: ProviderModels[];
  /** The task is mine: I edit it; else I am an org admin looking at it. */
  own: boolean;
  admin: boolean;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("schedules");
  const tc = useTranslations("common");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const names = useMemberNames(orgId);
  const actions = useScheduleActions(orgId);
  const saved = draftOf(task);
  const [draft, setDraft] = useState<ScheduleDraft>(saved);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const readOnly = !own;
  const touched = [
    keys.org(orgId).schedulesAll(),
    keys.org(orgId).schedule(task.id),
    ...inboxChangeKeys(orgId),
  ];
  const save = useAppMutation({
    fn: () => updateSchedule(orgId, task.id, patchOf(saved, draft)),
    invalidates: () => touched,
  });
  const grantsQ = scheduleGrantsQuery(orgId, task.id);
  const grants = useQuery({ ...grantsQ, retryOnMount: retryOnMountOf(grantsQ.queryKey) }).data;
  const runsQ = scheduleRunsQuery(orgId, task.id);
  const runs = useQuery({ ...runsQ, retryOnMount: retryOnMountOf(runsQ.queryKey) });
  const addGrant = useAppMutation({
    fn: (toolKey: string) => addScheduleGrants(orgId, task.id, [toolKey]),
    invalidates: () => [keys.org(orgId).scheduleGrants(task.id), ...inboxChangeKeys(orgId)],
  });
  const removeGrant = useAppMutation({
    fn: (toolKey: string) => removeScheduleGrant(orgId, task.id, toolKey),
    invalidates: () => [keys.org(orgId).scheduleGrants(task.id)],
  });
  const agent = agents.find((a) => a.id === draft.agentId);
  const grantable = useGrantableTools(orgId, agent);
  const unsaved = readOnly ? 0 : changedCount(saved, draft);
  const valid = draftValid(draft);
  const granted = (grants?.items ?? []).map((g) => g.toolKey);
  // What the latest runs were refused and the task still lacks
  const refused = [...new Set((runs.data?.items ?? []).flatMap((r) => r.missingGrants))];

  const act = async (p: Promise<unknown>, done: string) => {
    try {
      await p;
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const submit = async () => {
    if (!valid || unsaved === 0) return;
    setError(null);
    try {
      await save.mutateAsync(undefined);
      toast.success(t("actions.saved"));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const busy = actions.pause.isPending || actions.resume.isPending || actions.run.isPending;
  const toggle =
    task.status === "active"
      ? {
          label: t("actions.pause"),
          onSelect: () => void act(actions.pause.mutateAsync(task.id), t("actions.paused")),
          loading: actions.pause.isPending,
        }
      : {
          label: t("actions.resume"),
          onSelect: () => void act(actions.resume.mutateAsync(task.id), t("actions.resumed")),
          loading: actions.resume.isPending,
        };
  const creator =
    names.kind === "ready" ? (names.people[task.accountId] ?? t("form.creatorUnknown")) : "";
  return (
    <>
      <FormPage
        header={{
          path: [...scope, { label: "schedules", href: "/schedules" }, { label: task.name }],
          title: task.name,
          status: <ScheduleStateMark task={task} />,
          ...(readOnly ? { description: t("form.readOnly", { name: creator }) } : {}),
          // An org admin on another member's task: pause or resume only (no run, no edit)
          actions: readOnly
            ? []
            : [
                {
                  label: t("actions.runNow"),
                  variant: "default" as const,
                  disabled: busy || task.status === "ended",
                  loading: actions.run.isPending && actions.run.variables?.trial === false,
                  onSelect: () =>
                    void act(
                      actions.run.mutateAsync({ id: task.id, trial: false }),
                      t("actions.started"),
                    ),
                },
                {
                  label: t("actions.trialRun"),
                  variant: "default" as const,
                  disabled: busy,
                  loading: actions.run.isPending && actions.run.variables?.trial === true,
                  onSelect: () =>
                    void act(
                      actions.run.mutateAsync({ id: task.id, trial: true }),
                      t("actions.trialStarted"),
                    ),
                },
                ...(task.status === "ended"
                  ? []
                  : [{ ...toggle, variant: "default" as const, disabled: busy }]),
              ],
        }}
        actionRow={
          readOnly
            ? {
                // What an org admin may do with another member's task
                primary: { ...toggle, disabled: busy || task.status === "ended" },
              }
            : {
                unsaved,
                cancel: { label: tc("cancel"), onSelect: () => setDraft(saved) },
                primary: {
                  label: t("form.save"),
                  onSelect: () => void submit(),
                  loading: save.isPending,
                  disabled: save.isPending || unsaved === 0 || !valid,
                },
              }
        }
      >
        <ScheduleFormSections
          orgId={orgId}
          draft={draft}
          setDraft={setDraft}
          agents={agents}
          providers={providers}
          existing={task}
          readOnly={readOnly}
        />
        <ApprovedToolsSection
          granted={granted}
          options={grantable}
          refused={refused}
          readOnly={readOnly}
          pending={addGrant.isPending || removeGrant.isPending}
          onAdd={(k) => void act(addGrant.mutateAsync(k), t("actions.toolAdded"))}
          onRemove={(k) => void act(removeGrant.mutateAsync(k), t("actions.toolRemoved"))}
        />
        <RunHistory runs={runs.data?.items ?? null} />
        {error !== null ? <FormError message={error} /> : null}
        {(own || admin) && (
          <DangerZone title={t("actions.danger")}>
            <DangerZoneItem
              title={t("actions.danger")}
              description={t("actions.deleteDescription")}
              action={{ label: t("actions.delete"), onSelect: () => setDeleting(true) }}
            />
          </DangerZone>
        )}
      </FormPage>
      {deleting && (
        <DeleteScheduleDialog
          name={task.name}
          onClose={() => setDeleting(false)}
          onDelete={async () => {
            await actions.remove.mutateAsync(task.id);
            toast.success(t("actions.deleted"));
            router.push(own ? "/schedules" : "/settings/schedules");
          }}
        />
      )}
    </>
  );
}

/** The latest runs (a flush section holding the table): time, kind, status and what happened. */
function RunHistory({ runs }: { runs: TaskRun[] | null }) {
  const t = useTranslations("schedules.runs");
  const router = useRouter();
  const columns: Column<TaskRun>[] = [
    {
      key: "at",
      header: t("columns.scheduledFor"),
      fit: true,
      cell: (r) => <DateTime value={r.firedAt ?? r.scheduledFor} />,
    },
    {
      key: "kind",
      header: t("columns.kind"),
      tone: "muted",
      fit: true,
      cell: (r) => t(r.trial ? "kind.trial" : "kind.scheduled"),
    },
    {
      key: "status",
      header: t("columns.status"),
      fit: true,
      cell: (r) => (
        <StatusMark
          status={
            r.status === "completed"
              ? "success"
              : r.status === "failed"
                ? "failed"
                : r.status === "running"
                  ? "running"
                  : r.status === "pending"
                    ? "queued"
                    : "cancelled"
          }
          label={t(`status.${r.status}`)}
        />
      ),
    },
    {
      key: "detail",
      header: t("columns.detail"),
      wrap: true,
      cell: (r) => {
        if (r.skipReason !== null) return <Text tone="muted">{t(`skip.${r.skipReason}`)}</Text>;
        if (r.missingGrants.length > 0) {
          return <Text tone="warn">{t("missing", { tools: r.missingGrants.join(", ") })}</Text>;
        }
        return r.error !== null ? <ErrorDetail summary={t("failed")} detail={r.error} /> : null;
      },
    },
  ];
  return (
    <FormSection id="runs" title={t("title")} description={t("hint")} flush>
      <DataTable<TaskRun>
        label={t("label")}
        columns={columns}
        rows={runs ?? []}
        rowKey={(r) => r.id}
        state={runs === null ? "loading" : "ready"}
        empty={{ title: t("empty") }}
        onOpen={(r) => {
          if (r.conversationId !== null)
            router.push(`/chat/${encodeURIComponent(r.conversationId)}`);
        }}
        isDisabled={(r) => r.conversationId === null}
      />
    </FormSection>
  );
}
