"use client";

import {
  Button,
  DateTime,
  ErrorDetail,
  formatDateTime,
  ItemList,
  KeyValue,
  LinkButton,
  Sheet,
  Skeleton,
  Stack,
  Subsection,
  Text,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { retryOnMountOf } from "../lib/query/client";
import { scheduleCalendarQuery } from "../lib/query/schedules";
import {
  addDays,
  type CalendarItemState,
  itemRef,
  itemState,
  type RunPanelRef,
  startOfDay,
  timeIn,
} from "../lib/schedule-calendar";
import type { CalendarAnswer, CalendarItem, CalendarTask } from "../lib/schedules";
import { ScheduleStateMark, useScheduleWords } from "./ScheduleParts";
import { useCalendarDayLabel, useCalendarWords } from "./schedule-calendar-words";

const STATE_ICON = {
  upcoming: "clock",
  running: "spinner",
  completed: "check",
  failed: "circle-x",
  skipped: "ban",
} as const;
const STATE_TONE = {
  upcoming: "muted",
  running: "accent",
  completed: "ink",
  failed: "fail",
  skipped: "muted",
} as const;

/** A calendar state as an icon and its word (the grid's encoding, calendar spec §6.2). */
function StateWord({ state }: { state: CalendarItemState }) {
  const words = useCalendarWords();
  return (
    <Text icon={STATE_ICON[state]} tone={STATE_TONE[state]}>
      {words.state(state)}
    </Text>
  );
}

const sameRef = (a: RunPanelRef, b: RunPanelRef) =>
  (a.kind === "run" && b.kind === "run" && a.id === b.id) ||
  (a.kind === "at" &&
    b.kind === "at" &&
    a.taskId === b.taskId &&
    Date.parse(a.at) === Date.parse(b.at));

const findItem = (items: CalendarItem[], ref: RunPanelRef) =>
  items.find((it) => sameRef(itemRef(it), ref));

/**
 * The run panel of the calendar (calendar spec §4.5): a 480 Sheet with no scrim, read-only, opened
 * from a block, a chip or a Popover item and named in the address hash. A run: its status line,
 * 本次运行 (status, why it was skipped, the error and the refused tools for my own task, 试运行 /
 * 手动, 打开会话 for the task's creator only) and 任务; an occurrence: 计划运行 and why it may still
 * be skipped; a collapsed day: that task's items of the day (read with `taskId`), each opening in
 * the same Sheet with a way back. The footer opens the task page, the one place a task is changed.
 */
export function ScheduleRunSheet({
  orgId,
  accountId,
  all,
  timeZone,
  panel,
  answer,
  agentName,
  personName,
  onOpen,
}: {
  orgId: string;
  accountId: string;
  all: boolean;
  timeZone: string;
  panel: RunPanelRef | null;
  /** The drawn range's answer (null while it loads). */
  answer: CalendarAnswer | null;
  agentName(id: string): string;
  personName(id: string): string;
  onOpen(next: RunPanelRef | null): void;
}) {
  const t = useTranslations("schedules.calendar.panel");
  const dayLabel = useCalendarDayLabel();
  // A collapsed day: that task's items of the day, never collapsed (the read the panel owns).
  const day = panel?.kind === "day" ? panel : null;
  const dayQ = scheduleCalendarQuery(orgId, {
    from: new Date(startOfDay(day?.day ?? "1970-01-01", timeZone)).toISOString(),
    to: new Date(startOfDay(addDays(day?.day ?? "1970-01-01", 1), timeZone)).toISOString(),
    timeZone,
    all,
    taskId: day?.taskId ?? "",
  });
  const dayRead = useQuery({
    ...dayQ,
    enabled: day !== null,
    retryOnMount: retryOnMountOf(dayQ.queryKey),
  });

  if (panel === null || answer === null) return null;
  const close = () => onOpen(null);
  const open = panel.kind === "day" ? (panel.open ?? null) : panel;
  const taskId =
    panel.kind === "day"
      ? panel.taskId
      : panel.kind === "at"
        ? panel.taskId
        : answer.items.find((it) => it.kind === "run" && it.id === panel.id)?.taskId;
  const tasks = [...answer.tasks, ...(dayRead.data?.tasks ?? [])];
  const task = tasks.find((s) => s.id === taskId);
  // The item: in the range's answer, or (opened from a collapsed day) in the day's.
  const item =
    open === null
      ? undefined
      : (findItem(answer.items, open) ?? findItem(dayRead.data?.items ?? [], open));
  // Nothing to show for an item this range does not hold (a stale hash): no panel.
  if (task === undefined || (open !== null && item === undefined && panel.kind !== "day")) {
    return null;
  }

  // The day's read failed: say so, with a retry.
  const failedLine = (
    <Stack direction="row" gap={8} align="center">
      <Text tone="fail" icon="circle-x">
        {t("loadFailed")}
      </Text>
      <Button density="dense" onClick={() => void dayRead.refetch()}>
        {t("retry")}
      </Button>
    </Stack>
  );
  let body: ReactNode;
  if (open !== null && item !== undefined) {
    body = (
      <ItemDetail item={item} task={task} own={task.accountId === accountId} timeZone={timeZone} />
    );
  } else if (open !== null) {
    // An item of a collapsed day while the day is read.
    body = dayRead.isError ? failedLine : <Skeleton rows={3} />;
  } else {
    const dayItems = (dayRead.data?.items ?? []).filter((it) => it.taskId === task.id);
    body = dayRead.isError ? (
      failedLine
    ) : dayRead.data === undefined ? (
      <Skeleton rows={3} />
    ) : (
      <ItemList
        label={t("dayLabel", { day: dayLabel(panel.kind === "day" ? panel.day : "") })}
        empty={t("dayEmpty")}
        rows={dayItems.map((it) => {
          const state = itemState(it);
          return {
            id: it.kind === "run" ? it.id : it.scheduledFor,
            title: timeIn(Date.parse(it.scheduledFor), timeZone),
            actions: (
              <Stack direction="row" gap={8} align="center">
                <StateWord state={state} />
                <Button
                  density="dense"
                  onClick={() => panel.kind === "day" && onOpen({ ...panel, open: itemRef(it) })}
                >
                  {t("view")}
                </Button>
              </Stack>
            ),
          };
        })}
      />
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={task.name}
      footer={
        <LinkButton href={`/schedules/${encodeURIComponent(task.id)}`}>{t("openTask")}</LinkButton>
      }
    >
      <Stack gap={12}>
        {panel.kind === "day" && open !== null ? (
          <Stack direction="row">
            <Button
              density="dense"
              onClick={() => onOpen({ kind: "day", taskId: panel.taskId, day: panel.day })}
            >
              {t("back")}
            </Button>
          </Stack>
        ) : null}
        {panel.kind === "day" && open === null ? (
          <Text variant="h3">{t("day", { day: dayLabel(panel.day) })}</Text>
        ) : null}
        {body}
        <TaskRegion task={task} agentName={agentName} personName={all ? personName : null} />
      </Stack>
    </Sheet>
  );
}

/** A run's or an occurrence's status line and 本次运行. */
function ItemDetail({
  item,
  task,
  own,
  timeZone,
}: {
  item: CalendarItem;
  task: CalendarTask;
  own: boolean;
  timeZone: string;
}) {
  const t = useTranslations("schedules.calendar.panel");
  const tr = useTranslations("schedules.runs");
  const state = itemState(item);
  const at = item.kind === "run" ? (item.firedAt ?? item.scheduledFor) : item.at;
  const when = formatDateTime(at, "full", timeZone);
  const shown =
    item.kind === "occurrence" && task.jitterSeconds > 0 ? t("about", { time: when }) : when;
  const taskZone = task.trigger.timeZone;
  const elsewhere =
    taskZone !== timeZone
      ? t("taskZone", { zone: taskZone, time: formatDateTime(at, "compact", taskZone) })
      : null;
  const rows: { k: ReactNode; v: ReactNode }[] = [];
  if (item.kind === "run") {
    rows.push({ k: t("status"), v: <StateWord state={state} /> });
    rows.push({
      k: t("kind"),
      v: item.trial ? t("trial") : item.manual ? t("manual") : t("scheduled"),
    });
    if (item.skipReason !== null) {
      rows.push({ k: t("reason"), v: tr(`skip.${item.skipReason}`) });
    }
  }
  return (
    <>
      <Stack direction="row" gap={12} align="center">
        <StateWord state={state} />
        <Text>{shown}</Text>
        {elsewhere !== null ? <Text tone="muted">{elsewhere}</Text> : null}
      </Stack>
      <Subsection variant="divided" title={t("run")}>
        {item.kind === "occurrence" ? (
          <Stack gap={8}>
            <Text>{t("planned")}</Text>
            <Text variant="prose" tone="muted">
              {t("plannedHint")}
            </Text>
          </Stack>
        ) : (
          <Stack gap={12}>
            <KeyValue rows={rows} />
            {own && item.error !== null ? (
              <ErrorDetail summary={t("failed")} detail={item.error} />
            ) : null}
            {own && (item.missingGrants ?? 0) > 0 ? (
              <Stack direction="row">
                <LinkButton density="dense" href={`/schedules/${encodeURIComponent(task.id)}`}>
                  {t("missing", { n: item.missingGrants ?? 0 })}
                </LinkButton>
              </Stack>
            ) : null}
            {own && item.conversationId !== null ? (
              <Stack direction="row">
                <LinkButton
                  density="dense"
                  href={`/chat/${encodeURIComponent(item.conversationId)}`}
                >
                  {t("openConversation")}
                </LinkButton>
              </Stack>
            ) : null}
          </Stack>
        )}
      </Subsection>
    </>
  );
}

/** 任务: the schedule in words with its zone, the agent, where runs go, its status and next run. */
function TaskRegion({
  task,
  agentName,
  personName,
}: {
  task: CalendarTask;
  agentName(id: string): string;
  personName: ((id: string) => string) | null;
}) {
  const t = useTranslations("schedules.calendar.panel");
  const tf = useTranslations("schedules.form.mode");
  const when = useScheduleWords();
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("schedule"), v: when(task.trigger, task.trigger.timeZone) },
    { k: t("agent"), v: agentName(task.agentId) },
    ...(personName !== null ? [{ k: t("creator"), v: personName(task.accountId) }] : []),
    { k: t("target"), v: tf(task.mode) },
    { k: t("taskStatus"), v: <ScheduleStateMark task={task} /> },
    {
      k: t("nextRun"),
      v: task.nextRunAt !== null ? <DateTime value={task.nextRunAt} /> : t("none"),
    },
  ];
  return (
    <Subsection variant="divided" title={t("task")}>
      <KeyValue rows={rows} keyWidth="10ch" />
    </Subsection>
  );
}
