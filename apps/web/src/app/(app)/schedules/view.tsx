"use client";

import { DataTable, ListPage, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { ScheduleCalendarView } from "../../../components/ScheduleCalendarView";
import {
  DeleteScheduleDialog,
  scheduleColumns,
  useScheduleActions,
  useScheduleWords,
} from "../../../components/ScheduleParts";
import { usePagePath } from "../../../components/shell/path";
import { useRouter } from "../../../i18n/navigation";
import { roleAtLeast } from "../../../lib/members";
import { agentsQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { usePageQuery } from "../../../lib/query/page-query";
import { schedulesQuery } from "../../../lib/query/schedules";
import { orgSettingsQuery } from "../../../lib/query/settings";
import { useWorkspace } from "../../../lib/query/workspace";
import type { SchedulesUrl } from "../../../lib/schedule-calendar";
import type { ScheduledTaskListItem } from "../../../lib/schedules";
import { useSchedulesUrl } from "../../../lib/schedules-url";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/schedules` (定时任务): my scheduled tasks, as a calendar or a list (the page head's tabs 日历 /
 * 列表, calendar spec §4.1; the calendar is the default). The list (`?view=list`) is ListPage + DataTable: name, agent, the schedule in words
 * with its zone, status, next run and last result; a row opens the task, its menu pauses, resumes
 * or deletes it. The calendar (the bare `/schedules`) is ListPage + `ScheduleCalendar`
 * (`components/ScheduleCalendarView`). Members up (guests can't create tasks: the no-access
 * state). From the query cache (the layout prefetched the list, the agents and, for a remembered
 * calendar, its range on a first load). `initial` is the view `page.tsx` read from the address and
 * the `cap_schedules_view` cookie.
 */
export default function SchedulesView({ initial }: { initial: SchedulesUrl }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <Schedules
      orgId={ws.orgId}
      accountId={ws.me.account.id}
      admin={roleAtLeast(ws.role, "admin")}
      initial={initial}
    />
  );
}

function Schedules({
  orgId,
  accountId,
  admin,
  initial,
}: {
  orgId: string;
  accountId: string;
  admin: boolean;
  initial: SchedulesUrl;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("schedules");
  const [url, setUrl] = useSchedulesUrl(initial);
  const list = usePageQuery(schedulesQuery(orgId));
  const settingsQ = orgSettingsQuery(orgId);
  const off =
    useQuery({ ...settingsQ, retryOnMount: retryOnMountOf(settingsQ.queryKey) }).data?.settings
      .scheduledTasks?.enabled === false;
  const header = {
    path: [...scope, { label: "schedules" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/schedules/new" }],
    tabs: [
      {
        id: "calendar",
        label: t("tabs.calendar"),
        onSelect: () => setUrl({ ...url, view: "calendar" }),
      },
      { id: "list", label: t("tabs.list"), onSelect: () => setUrl({ ...url, view: "list" }) },
    ],
    activeTab: url.view,
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const tasks = list.kind === "ready" ? list.data.items : null;
  if (url.view === "calendar") {
    return (
      <ScheduleCalendarView
        orgId={orgId}
        accountId={accountId}
        admin={admin}
        url={url}
        setUrl={setUrl}
        header={header}
        tasks={tasks}
        off={off}
      />
    );
  }
  return <ScheduleList orgId={orgId} header={header} tasks={tasks} off={off} />;
}

type Header = Parameters<typeof ListPage>[0]["header"];

function ScheduleList({
  orgId,
  header,
  tasks,
  off,
}: {
  orgId: string;
  header: Header;
  tasks: ScheduledTaskListItem[] | null;
  off: boolean;
}) {
  const t = useTranslations("schedules");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const when = useScheduleWords();
  const actions = useScheduleActions(orgId);
  const [deleting, setDeleting] = useState<ScheduledTaskListItem | null>(null);
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  // Agent names are display only: the id shows when they can't be read.
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  const columns = scheduleColumns(t, when, agentName);
  if (tasks === null) {
    return <ListPage header={header} loading={{ table: { label: t("listLabel"), columns } }} />;
  }
  const act = async (p: Promise<unknown>, done: string) => {
    try {
      await p;
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <>
      <ListPage
        header={header}
        {...(off ? { callout: { tone: "warn" as const, children: t("turnedOff") } } : {})}
        {...(tasks.length === 0
          ? {
              empty: {
                text: t("empty"),
                hint: t("emptyHint"),
                action: { label: t("new"), variant: "primary" as const, href: "/schedules/new" },
              },
            }
          : {})}
      >
        <DataTable<ScheduledTaskListItem>
          label={t("listLabel")}
          columns={columns}
          rows={tasks}
          rowKey={(s) => s.id}
          rowLabel={(s) => s.name}
          state="ready"
          empty={{ title: t("empty"), hint: t("emptyHint") }}
          onOpen={(s) => router.push(`/schedules/${encodeURIComponent(s.id)}`)}
          rowMenu={(s) => [
            s.status === "active"
              ? {
                  label: t("actions.pause"),
                  onSelect: () => void act(actions.pause.mutateAsync(s.id), t("actions.paused")),
                }
              : {
                  label: t("actions.resume"),
                  disabled: s.status === "ended",
                  onSelect: () => void act(actions.resume.mutateAsync(s.id), t("actions.resumed")),
                },
            { label: t("actions.delete"), danger: true, onSelect: () => setDeleting(s) },
          ]}
        />
      </ListPage>
      {deleting !== null && (
        <DeleteScheduleDialog
          name={deleting.name}
          onClose={() => setDeleting(null)}
          onDelete={async () => {
            await actions.remove.mutateAsync(deleting.id);
            setDeleting(null);
            toast.success(t("actions.deleted"));
          }}
        />
      )}
    </>
  );
}
