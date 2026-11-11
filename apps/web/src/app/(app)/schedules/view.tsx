"use client";

import { DataTable, ListPage, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import {
  DeleteScheduleDialog,
  scheduleColumns,
  useScheduleActions,
  useScheduleWords,
} from "../../../components/ScheduleParts";
import { usePagePath } from "../../../components/shell/path";
import { useRouter } from "../../../i18n/navigation";
import { agentsQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { usePageQuery } from "../../../lib/query/page-query";
import { schedulesQuery } from "../../../lib/query/schedules";
import { useWorkspace } from "../../../lib/query/workspace";
import type { ScheduledTask } from "../../../lib/schedules";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/schedules` (定时任务): my scheduled tasks (ListPage + DataTable): name, agent, the schedule in
 * words with its zone, status, next run and last result; a row opens the task, its menu pauses,
 * resumes or deletes it. Members up (guests can't create tasks: the no-access state). From the
 * query cache (the layout prefetched the list and the agents on a first load).
 */
export default function SchedulesView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Schedules orgId={ws.orgId} />;
}

function Schedules({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("schedules");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const when = useScheduleWords();
  const actions = useScheduleActions(orgId);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);
  const list = usePageQuery(schedulesQuery(orgId));
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  // Agent names are display only: the id shows when they can't be read.
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  const columns = scheduleColumns(t, when, agentName);
  const header = {
    path: [...scope, { label: "schedules" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/schedules/new" }],
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  if (list.kind === "loading") {
    return <ListPage header={header} loading={{ table: { label: t("listLabel"), columns } }} />;
  }
  const tasks = list.data.items;
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
        <DataTable<ScheduledTask>
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
