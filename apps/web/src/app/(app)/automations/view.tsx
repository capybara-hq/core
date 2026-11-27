"use client";

import { type Column, DataTable, ListPage, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AutomationCalendarView } from "../../../components/AutomationCalendarView";
import {
  type AutomationColumnKey,
  automationColumns,
  DeleteAutomationDialog,
  useAutomationActions,
  useAutomationWords,
} from "../../../components/AutomationParts";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { useRouter } from "../../../i18n/navigation";
import type { AutomationsUrl } from "../../../lib/automation-calendar";
import type { AutomationListItem } from "../../../lib/automations";
import { useAutomationsUrl } from "../../../lib/automations-url";
import { roleAtLeast } from "../../../lib/members";
import { agentsQuery } from "../../../lib/query/agents";
import { automationsQuery } from "../../../lib/query/automations";
import { retryOnMountOf } from "../../../lib/query/client";
import { usePageQuery } from "../../../lib/query/page-query";
import { orgSettingsQuery } from "../../../lib/query/settings";
import { useWorkspace } from "../../../lib/query/workspace";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/automations`: my automations, as a calendar or a list (the page head's Calendar / List
 * tabs, calendar spec §4.1; the calendar is the default). The list (`?view=list`) is ListPage + DataTable: name, agent, the schedule in words
 * with its zone, status, next run and last result; a row opens the task, its menu pauses, resumes
 * or deletes it. The calendar (the bare `/automations`) is ListPage + `ScheduleCalendar`
 * (`components/AutomationCalendarView`). Members up (guests can't create tasks: the no-access
 * state). From the query cache (the layout prefetched the list, the agents and, for a remembered
 * calendar, its range on a first load). `initial` is the view `page.tsx` read from the address and
 * the `cap_automations_view` cookie.
 */
export default function AutomationsView({ initial }: { initial: AutomationsUrl }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <Automations
      orgId={ws.orgId}
      accountId={ws.me.account.id}
      admin={roleAtLeast(ws.role, "admin")}
      initial={initial}
    />
  );
}

function Automations({
  orgId,
  accountId,
  admin,
  initial,
}: {
  orgId: string;
  accountId: string;
  admin: boolean;
  initial: AutomationsUrl;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("automations");
  const [url, setUrl] = useAutomationsUrl(initial);
  const list = usePageQuery(automationsQuery(orgId));
  const settingsQ = orgSettingsQuery(orgId);
  const off =
    useQuery({ ...settingsQ, retryOnMount: retryOnMountOf(settingsQ.queryKey) }).data?.settings
      .automations.enabled === false;
  const header = {
    path: [...scope, { label: "automations" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/automations/new" }],
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
      <AutomationCalendarView
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
  return <AutomationList orgId={orgId} header={header} tasks={tasks} off={off} />;
}

/** Compact rows (below 600): the name leads, the next run under it, the state at the end. */
const COMPACT: Record<AutomationColumnKey, NonNullable<Column<AutomationListItem>["compact"]>> = {
  name: "title",
  next: "subtitle",
  agent: "meta",
  status: "trailing",
  schedule: "hidden",
  last: "hidden",
};

type Header = Parameters<typeof ListPage>[0]["header"];

function AutomationList({
  orgId,
  header,
  tasks,
  off,
}: {
  orgId: string;
  header: Header;
  tasks: AutomationListItem[] | null;
  off: boolean;
}) {
  const t = useTranslations("automations");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const when = useAutomationWords();
  const actions = useAutomationActions(orgId);
  const [deleting, setDeleting] = useState<AutomationListItem | null>(null);
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  // Agent names are display only: the id shows when they can't be read.
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  const columns = automationColumns(t, when, agentName).map((c) => {
    const compact = COMPACT[c.key];
    return compact === undefined ? c : { ...c, compact };
  });
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
                action: { label: t("new"), variant: "primary" as const, href: "/automations/new" },
              },
            }
          : {})}
      >
        <DataTable<AutomationListItem>
          label={t("listLabel")}
          columns={columns}
          rows={tasks}
          rowKey={(s) => s.id}
          rowLabel={(s) => s.name}
          state="ready"
          empty={{ title: t("empty"), hint: t("emptyHint") }}
          onOpen={(s) => router.push(`/automations/${encodeURIComponent(s.id)}`)}
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
        <DeleteAutomationDialog
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
