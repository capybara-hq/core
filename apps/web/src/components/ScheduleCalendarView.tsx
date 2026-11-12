"use client";

import {
  formatDateTime,
  ListPage,
  ScheduleCalendar,
  type ScheduleCalendarCollapsed,
  type ScheduleCalendarItem,
  useNow,
  useTimeZone,
} from "@capybara-hq/design";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ComponentProps, useRef } from "react";
import type { ApiClientError } from "../lib/api";
import { agentsQuery } from "../lib/query/agents";
import { retryOnMountOf } from "../lib/query/client";
import { useMemberNames } from "../lib/query/member-names";
import { scheduleCalendarQuery, schedulesQuery } from "../lib/query/schedules";
import {
  type CalendarRange,
  collapsedState,
  dayIn,
  itemInstant,
  itemRef,
  itemState,
  minuteIn,
  parseRunPanelRef,
  rangeBounds,
  rangeDays,
  rangeLabel,
  refId,
  type SchedulesUrl,
  shiftDate,
  timeIn,
} from "../lib/schedule-calendar";
import type { CalendarAnswer, CalendarTask, ScheduledTaskListItem } from "../lib/schedules";
import { browserTimeZone } from "../lib/schedules";
import { useRunPanelHash } from "../lib/schedules-url";
import { ErrorFrame } from "./ErrorFrame";
import { ScheduleRunSheet } from "./ScheduleRunSheet";
import { useCalendarDayLabel, useCalendarWords } from "./schedule-calendar-words";

type Header = ComponentProps<typeof ListPage>["header"];

/** Polling while the range holds now: runs start and finish (calendar spec §9). */
const LIVE_MS = 60_000;

/**
 * The calendar view of `/schedules` (calendar spec §4, §8, §9): ListPage with the page head's tabs
 * and `ScheduleCalendar` (week or month, the phone's agenda by CSS), the range read with the
 * previous range kept while the next one loads, a live poll while the range holds now, the admin
 * 全组织 scope and the run panel (`ScheduleRunSheet`, its item in the address hash).
 */
export function ScheduleCalendarView({
  orgId,
  accountId,
  admin,
  url,
  setUrl,
  header,
  tasks,
  off,
}: {
  orgId: string;
  accountId: string;
  admin: boolean;
  url: SchedulesUrl;
  setUrl(next: SchedulesUrl): void;
  header: Header;
  /** My tasks (the list); null while it loads. */
  tasks: ScheduledTaskListItem[] | null;
  off: boolean;
}) {
  const t = useTranslations("schedules");
  const tc = useTranslations("schedules.calendar");
  const words = useCalendarWords();
  const dayLabel = useCalendarDayLabel();
  const timeZone = useTimeZone() ?? browserTimeZone() ?? "UTC";
  const now = useNow(LIVE_MS);
  const today = dayIn(now, timeZone);
  const date = url.date ?? today;
  const all = admin && url.scope === "all";
  const bounds = rangeBounds(url.range, date, timeZone);
  const holdsNow = Date.parse(bounds.from) <= now && now < Date.parse(bounds.to);
  const calQ = scheduleCalendarQuery(orgId, { ...bounds, timeZone, all });
  const cal = useQuery({
    ...calQ,
    placeholderData: keepPreviousData,
    refetchInterval: holdsNow ? LIVE_MS : false,
    retryOnMount: retryOnMountOf(calQ.queryKey),
  });
  // The range the drawn answer belongs to: while the next range loads the previous one stays
  // drawn (its days and items), with the next range's label and a spinner (calendar spec §8).
  const shown = useRef<{ range: CalendarRange; date: string; answer: CalendarAnswer } | null>(null);
  if (cal.data !== undefined && !cal.isPlaceholderData) {
    shown.current = { range: url.range, date, answer: cal.data };
  }
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  // 全组织: the org's tasks (the empty state's next run) and who created them.
  const allQ = schedulesQuery(orgId, "all");
  const allTasks = useQuery({
    ...allQ,
    enabled: all,
    retryOnMount: retryOnMountOf(allQ.queryKey),
  }).data?.items;
  const names = useMemberNames(orgId, all);
  const people = all && names.kind === "ready" ? names.people : {};
  const [panel, setPanel] = useRunPanelHash();

  const go = (next: Partial<SchedulesUrl>) => setUrl({ ...url, ...next });
  const scope = admin
    ? {
        value: url.scope,
        onChange: (v: "mine" | "all") => go({ scope: v }),
        labels: { mine: tc("mine"), all: tc("all") },
      }
    : undefined;

  // A failed first read is the page's error state; a failed range change keeps the grid.
  const failed = cal.isError ? (cal.error as ApiClientError | null) : null;
  if (failed !== null && shown.current === null) {
    return <ErrorFrame reset={() => void cal.refetch()} />;
  }
  // Nothing at all yet (no task of mine and no org-wide scope to switch to): the list's empty state.
  if (tasks !== null && tasks.length === 0 && !admin) {
    return (
      <ListPage
        header={header}
        {...(off ? { callout: { tone: "warn" as const, children: t("turnedOff") } } : {})}
        empty={{
          text: t("empty"),
          hint: t("emptyHint"),
          action: { label: t("new"), variant: "primary" as const, href: "/schedules/new" },
        }}
      />
    );
  }

  const drawn =
    failed !== null
      ? null
      : cal.isPlaceholderData
        ? shown.current
        : cal.data !== undefined
          ? { range: url.range, date, answer: cal.data }
          : null;
  const loading = drawn === null && failed === null;
  const answer = drawn?.answer ?? null;
  const drawnRange = drawn?.range ?? url.range;
  const days = rangeDays(drawnRange, drawn?.date ?? date);
  const taskOf = new Map((answer?.tasks ?? []).map((task) => [task.id, task]));
  const meta = (task: CalendarTask | undefined) => {
    if (task === undefined) return undefined;
    const agent = agentName(task.agentId);
    return all
      ? tc("metaWithCreator", { agent, person: people[task.accountId] ?? task.accountId })
      : agent;
  };

  const items: ScheduleCalendarItem[] = (answer?.items ?? []).map((it) => {
    const ms = itemInstant(it);
    const task = taskOf.get(it.taskId);
    const state = itemState(it);
    const day = dayIn(ms, timeZone);
    const time = timeIn(ms, timeZone);
    const title = task?.name ?? it.taskId;
    const m = meta(task);
    const mark =
      it.kind === "run"
        ? it.trial
          ? tc("trial")
          : it.manual
            ? tc("manual")
            : undefined
        : undefined;
    const label = tc("itemLabel", {
      title,
      meta: m ?? "",
      day: dayLabel(day),
      time,
      state: words.state(state),
    });
    return {
      id: refId(itemRef(it)),
      day,
      minute: minuteIn(ms, timeZone),
      time,
      title,
      ...(m !== undefined ? { meta: m } : {}),
      state,
      ...(mark !== undefined ? { mark } : {}),
      label: mark !== undefined ? tc("itemMarkLabel", { label, mark }) : label,
    };
  });
  const collapsed: ScheduleCalendarCollapsed[] = (answer?.collapsed ?? []).map((c) => {
    const task = taskOf.get(c.taskId);
    const title = task?.name ?? c.taskId;
    const summary = words.collapsedSummary(task, c.count);
    const day = dayLabel(c.day);
    return {
      id: refId({ kind: "day", taskId: c.taskId, day: c.day }),
      day: c.day,
      title,
      summary,
      ...(c.failed > 0 ? { failed: tc("collapsedFailed", { n: c.failed }) } : {}),
      state: collapsedState(c),
      label:
        c.failed > 0
          ? tc("collapsedFailedLabel", { title, summary, day, n: c.failed })
          : tc("collapsedLabel", { title, summary, day }),
    };
  });

  const horizonMs = answer ? Date.parse(answer.horizon) : Number.POSITIVE_INFINITY;
  const horizonDay = answer ? dayIn(horizonMs, timeZone) : null;
  const toMs = Date.parse(rangeBounds(drawnRange, drawn?.date ?? date, timeZone).to);
  const footnote = [
    tc("zone", { zone: timeZone }),
    answer && !answer.truncated && horizonMs < toMs && horizonDay !== null
      ? tc("horizon", { day: horizonDay.slice(5) })
      : null,
  ]
    .filter((s) => s !== null)
    .join(" ");

  // Empty range: the next planned run (of the scope's tasks) and a way to it, or "all paused".
  const scopeTasks = all ? allTasks : (tasks ?? undefined);
  let empty: ComponentProps<typeof ScheduleCalendar>["empty"];
  if (answer && !cal.isPlaceholderData && items.length === 0 && collapsed.length === 0) {
    const active = (scopeTasks ?? []).filter((s) => s.status === "active");
    if (scopeTasks !== undefined && scopeTasks.length > 0 && active.length === 0) {
      empty = {
        text: tc("allPaused"),
        hint: tc("allPausedHint"),
        action: { label: tc("showList"), onSelect: () => go({ view: "list" }) },
      };
    } else {
      const next = active
        .map((s) => (s.nextRunAt === null ? Number.NaN : Date.parse(s.nextRunAt)))
        .filter((ms) => Number.isFinite(ms) && ms >= toMs)
        .sort((a, b) => a - b)[0];
      empty = {
        text: tc(drawnRange === "month" ? "emptyMonth" : "emptyWeek"),
        ...(next !== undefined
          ? {
              hint: tc("nextRun", { at: formatDateTime(new Date(next), "full", timeZone) }),
              action: {
                label: tc("jumpToNext"),
                onSelect: () => go({ date: dayIn(next, timeZone) }),
              },
            }
          : {}),
      };
    }
  }

  const callout = off
    ? { tone: "warn" as const, children: t("turnedOff") }
    : answer?.truncated && horizonDay !== null
      ? {
          tone: "warn" as const,
          children: tc(drawnRange === "month" ? "truncatedMonth" : "truncatedWeek", {
            day: horizonDay.slice(5),
          }),
        }
      : undefined;

  const selected =
    panel === null
      ? undefined
      : refId(panel.kind === "day" ? { kind: "day", taskId: panel.taskId, day: panel.day } : panel);

  return (
    <>
      <ListPage header={header} {...(callout ? { callout } : {})}>
        <ScheduleCalendar
          range={drawnRange}
          days={days}
          today={today}
          now={now}
          timeZone={timeZone}
          items={items}
          collapsed={collapsed}
          {...(selected !== undefined ? { selectedId: selected } : {})}
          onSelect={(id) => setPanel(parseRunPanelRef(id))}
          onNavigate={(to) =>
            go({ date: to === "today" ? null : shiftDate(url.range, date, to === "prev" ? -1 : 1) })
          }
          onRange={(range) => go({ range })}
          rangeLabel={rangeLabel(url.range, date)}
          {...(scope ? { scope } : {})}
          footnote={footnote}
          loading={loading}
          refreshing={cal.isPlaceholderData && cal.isFetching}
          {...(empty ? { empty } : {})}
          {...(failed !== null
            ? {
                error: {
                  retry: () => void cal.refetch(),
                  ...(failed.code ? { code: failed.code } : {}),
                },
              }
            : {})}
          {...(answer?.truncated && horizonDay !== null ? { notLoadedFrom: horizonDay } : {})}
          onDay={(day) => {
            // A month's day number opens its week; a phone's agenda day button only picks the day
            // (read at the tap: the agenda is the CSS layout below 640).
            const phone = window.matchMedia("(max-width: 639px)").matches;
            go(phone || url.range === "week" ? { date: day } : { range: "week", date: day });
          }}
          day={date}
        />
      </ListPage>
      <ScheduleRunSheet
        orgId={orgId}
        accountId={accountId}
        all={all}
        timeZone={timeZone}
        panel={panel}
        answer={answer}
        agentName={agentName}
        personName={(id) => people[id] ?? id}
        onOpen={setPanel}
      />
    </>
  );
}
