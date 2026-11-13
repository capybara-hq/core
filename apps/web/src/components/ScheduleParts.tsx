"use client";

import {
  Button,
  CellTitle,
  type Column,
  DateTime,
  Dialog,
  Stack,
  StatusMark,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import { inboxChangeKeys } from "../lib/query/inbox";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import {
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  runSchedule,
  type ScheduledTask,
  type ScheduledTaskListItem,
  type ScheduleTrigger,
  scheduleState,
  scheduleWords,
  type TriggerInput,
} from "../lib/schedules";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** A schedule in words, with its zone when given ("Every day at 09:00 (Asia/Shanghai)"). */
export function useScheduleWords(): (
  trigger: ScheduleTrigger | TriggerInput,
  zone?: string,
) => string {
  const t = useTranslations("schedules");
  return (trigger, zone) => {
    const w = scheduleWords(trigger);
    const values =
      w.key === "weekly"
        ? { ...w.values, day: t(`weekday.${w.values.day}` as "weekday.0") }
        : w.values;
    const when = t(`when.${w.key}`, values);
    return zone === undefined ? when : t("withZone", { when, zone });
  };
}

/** The status mark of a task: its state, or why it is paused. */
export function ScheduleStateMark({
  task,
}: {
  task: Pick<ScheduledTask, "status" | "pauseReason">;
}) {
  const t = useTranslations("schedules.state");
  const state = scheduleState(task);
  const status: ComponentProps<typeof StatusMark>["status"] =
    state === "active"
      ? "success"
      : state === "ended" || state === "paused.expired"
        ? "cancelled"
        : state === "paused.creator" || state === "paused.admin"
          ? "waiting"
          : "failed";
  return <StatusMark status={status} label={t(state)} />;
}

/**
 * A task's actions (pause, resume, run, delete): each invalidates the task lists, the task and,
 * since the creator's inbox derives attention from the task, the inbox.
 */
export function useScheduleActions(orgId: string) {
  const touched = (id: string) => [
    keys.org(orgId).schedulesAll(),
    keys.org(orgId).schedule(id),
    ...inboxChangeKeys(orgId),
  ];
  const pause = useAppMutation({
    fn: (id: string) => pauseSchedule(orgId, id),
    invalidates: (id) => touched(id),
  });
  const resume = useAppMutation({
    fn: (id: string) => resumeSchedule(orgId, id),
    invalidates: (id) => touched(id),
  });
  const run = useAppMutation({
    fn: (v: { id: string; trial: boolean }) => runSchedule(orgId, v.id, v.trial),
    invalidates: (v) => [keys.org(orgId).scheduleRuns(v.id), keys.org(orgId).schedulesAll()],
  });
  const remove = useAppMutation({
    fn: (id: string) => deleteSchedule(orgId, id),
    invalidates: () => [keys.org(orgId).schedulesAll(), ...inboxChangeKeys(orgId)],
    forgetsOnLeave: (id) => [keys.org(orgId).schedule(id)],
  });
  return { pause, resume, run, remove };
}

/** Delete a task: asks first (a dangerous dialog that starts on Cancel). */
export function DeleteScheduleDialog({
  name,
  onClose,
  onDelete,
}: {
  name: string;
  onClose(): void;
  onDelete(): Promise<void>;
}) {
  const t = useTranslations("schedules.actions");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onDelete();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("deleteConfirm", { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("delete")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("deleteConfirmBody")}</Text>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

type ScheduleT = ReturnType<typeof useTranslations<"schedules">>;

/** A task table's columns (the loading table draws the same header). */
export function scheduleColumns(
  t: ScheduleT,
  when: ReturnType<typeof useScheduleWords>,
  agentName: (id: string) => string,
): Column<ScheduledTaskListItem>[] {
  return [
    { key: "name", header: t("columns.name"), cell: (s) => <CellTitle title={s.name} /> },
    { key: "agent", header: t("columns.agent"), cell: (s) => agentName(s.agentId) },
    {
      key: "schedule",
      header: t("columns.schedule"),
      tone: "muted",
      cell: (s) => when(s.trigger, s.trigger.timeZone),
    },
    { key: "status", header: t("columns.status"), cell: (s) => <ScheduleStateMark task={s} /> },
    {
      key: "next",
      header: t("columns.nextRun"),
      tone: "muted",
      fit: true,
      cell: (s) => (s.nextRunAt === null ? "—" : <DateTime value={s.nextRunAt} />),
    },
    {
      key: "last",
      header: t("columns.lastResult"),
      fit: true,
      cell: (s) => {
        const r = s.lastRun;
        if (r === null) return <Text tone="muted">{t("noResult")}</Text>;
        const label =
          r.status === "skipped" && r.skipReason !== null
            ? t(`runs.skip.${r.skipReason}`)
            : t(`runs.status.${r.status}`);
        const failed =
          r.status === "failed" && s.consecutiveFailures > 1
            ? t("failedInARow", { n: s.consecutiveFailures })
            : label;
        return (
          <StatusMark
            status={
              r.status === "completed" ? "success" : r.status === "failed" ? "failed" : "cancelled"
            }
            label={failed}
          />
        );
      },
    },
  ];
}
