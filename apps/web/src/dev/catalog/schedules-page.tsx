"use client";

import { AppShell, useTimeZone } from "@capybara-hq/design";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import SchedulesView from "../../app/(app)/schedules/view";
import { agentsQuery } from "../../lib/query/agents";
import { membersQuery } from "../../lib/query/members";
import { scheduleCalendarQuery, schedulesQuery } from "../../lib/query/schedules";
import { orgSettingsQuery } from "../../lib/query/settings";
import { meQuery, readinessQuery } from "../../lib/query/shell";
import { addDays, type CalendarRange, rangeBounds, startOfDay } from "../../lib/schedule-calendar";
import type {
  CalendarAnswer,
  CalendarItem,
  CalendarTask,
  ScheduledTaskListItem,
} from "../../lib/schedules";
import type { Me } from "../../lib/session";
import { COMMANDS } from "./fixtures";
import { sidebarProps, statusFixture } from "./shell-fixture";

/**
 * `/dev/ui/pages/schedules-calendar[-month|-admin]`: the real `/schedules` calendar view drawn
 * from a seeded query cache (no kernel), for its screenshot and interaction specs
 * (`visual/schedules-calendar.spec.ts`). The week of 2026-11-12 (today Thursday, the spec fixes
 * the clock at 10:24) in the browser's zone: every run state, an overlap that ends in 「+N」, a
 * trial run, planned runs and an hourly task collapsed per day; the month adds the days around it;
 * the admin view adds another member's tasks (全组织).
 */
export type SchedulesPageVariant = "week" | "month" | "admin";

const ORG = "o1";
const DATE = "2026-11-12";
const T = "2026-11-01T00:00:00.000Z";

const meAs = (role: "owner" | "member"): Me => ({
  account: { id: "a1", displayName: "Grant", email: null, isSuperAdmin: false },
  via: "session",
  currentOrgId: ORG,
  memberships: [{ orgId: ORG, slug: "acme", name: "Acme", role }],
  canCreateOrg: true,
});

const AGENTS = [
  ["ag1", "研究助手"],
  ["ag2", "财务对账"],
  ["ag3", "客服助手"],
].map(([id, name]) => ({
  id: id as string,
  orgId: ORG,
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 1,
  definition: {
    name,
    instructions: "",
    model: { provider: "fake", model: "fake" },
    fallback: null,
  },
  updatedAt: T,
}));

type TaskSeed = [id: string, name: string, agentId: string, expr: string, accountId?: string];
const TASKS: TaskSeed[] = [
  ["s1", "每日简报", "ag1", "0 9 * * *"],
  ["s2", "对账检查", "ag2", "0 14 * * 1-5"],
  ["s3", "工单回顾", "ag3", "0 9 * * 2"],
  ["s4", "数据同步", "ag1", "0 * * * *"],
  ["s5", "周报汇总", "ag1", "0 17 * * 5"],
  ["s6", "库存盘点", "ag2", "10 14 * * 3"],
  ["s7", "发票核对", "ag2", "20 14 * * 3"],
  ["s8", "合同到期提醒", "ag3", "15 9 * * 2", "a2"],
  ["s9", "客户回访", "ag3", "30 11 * * *", "a2"],
];

const calTask = ([id, name, agentId, expr, accountId]: TaskSeed, zone: string): CalendarTask => ({
  id,
  name,
  agentId,
  accountId: accountId ?? "a1",
  status: "active",
  pauseReason: null,
  trigger: { kind: "cron", expr, timeZone: zone },
  mode: "new",
  jitterSeconds: 12,
  nextRunAt: null,
});

const listTask = (t: CalendarTask): ScheduledTaskListItem => ({
  ...t,
  orgId: ORG,
  prompt: "",
  conversationId: null,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  pausedBy: null,
  expiresAt: null,
  consecutiveFailures: 0,
  lastRun: null,
  createdAt: T,
  updatedAt: T,
});

/** The instant of a local day and `HH:MM` in the zone. */
const at = (day: string, time: string, zone: string) => {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(startOfDay(day, zone) + (h * 60 + m) * 60_000).toISOString();
};

/** The answer for a range: runs before today 10:24, planned runs after, mine or the org's. */
function answerFor(range: CalendarRange, all: boolean, zone: string): CalendarAnswer {
  const tasks = TASKS.filter((t) => all || t.length < 5).map((t) => calTask(t, zone));
  let n = 0;
  const run = (
    taskId: string,
    day: string,
    time: string,
    status: "completed" | "failed" | "skipped" | "running",
    over: Partial<Extract<CalendarItem, { kind: "run" }>> = {},
  ): CalendarItem => {
    const scheduledFor = at(day, time, zone);
    const other = tasks.find((t) => t.id === taskId)?.accountId !== "a1";
    return {
      kind: "run",
      taskId,
      id: `tr${++n}`,
      scheduledFor,
      firedAt: scheduledFor,
      status,
      skipReason: status === "skipped" ? "overlap" : null,
      trial: false,
      manual: false,
      conversationId: other ? null : `c${n}`,
      error: status === "failed" && !other ? "The model refused the request." : null,
      missingGrants: other ? null : 0,
      ...over,
    };
  };
  const planned = (taskId: string, day: string, time: string): CalendarItem => {
    const scheduledFor = at(day, time, zone);
    return { kind: "occurrence", taskId, scheduledFor, at: scheduledFor };
  };
  const week = ["2026-11-09", "2026-11-10", "2026-11-11"];
  const items: CalendarItem[] = [
    ...week.map((d) => run("s1", d, "09:00", "completed")),
    run("s1", DATE, "09:00", "completed"),
    run("s2", "2026-11-09", "14:00", "failed"),
    run("s2", "2026-11-10", "14:00", "completed"),
    run("s2", "2026-11-11", "14:00", "completed"),
    run("s3", "2026-11-10", "09:00", "completed"),
    run("s6", "2026-11-11", "14:10", "completed"),
    run("s7", "2026-11-11", "14:20", "skipped"),
    run("s1", "2026-11-11", "16:30", "completed", { trial: true }),
    run("s5", DATE, "10:00", "running", { manual: true }),
    planned("s2", DATE, "14:00"),
    planned("s1", "2026-11-13", "09:00"),
    planned("s2", "2026-11-13", "14:00"),
    planned("s5", "2026-11-13", "17:00"),
    planned("s1", "2026-11-14", "09:00"),
    planned("s1", "2026-11-15", "09:00"),
    ...(all
      ? [
          run("s8", "2026-11-10", "09:15", "completed"),
          run("s9", "2026-11-11", "11:30", "failed"),
          planned("s9", "2026-11-13", "11:30"),
        ]
      : []),
    ...(range === "month"
      ? [
          run("s1", "2026-11-05", "09:00", "completed"),
          run("s2", "2026-11-05", "14:00", "failed"),
          run("s6", "2026-11-05", "14:10", "completed"),
          run("s7", "2026-11-05", "14:20", "completed"),
          planned("s1", "2026-11-20", "09:00"),
          planned("s1", "2026-11-27", "09:00"),
        ]
      : []),
  ].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const days = range === "month" ? ["2026-11-05", ...week, DATE] : [...week, DATE];
  const collapsed = [...days, "2026-11-13"].map((day) => {
    const past = day < DATE;
    const today = day === DATE;
    return {
      taskId: "s4",
      day,
      count: 24,
      upcoming: past ? 0 : today ? 13 : 24,
      running: today ? 1 : 0,
      completed: past ? (day === "2026-11-11" ? 22 : 24) : today ? 10 : 0,
      failed: day === "2026-11-11" ? 2 : 0,
      skipped: 0,
      first: at(day, "00:00", zone),
      last: at(day, "23:00", zone),
    };
  });
  return {
    tasks,
    items,
    collapsed,
    horizon: new Date(startOfDay(addDays(DATE, 42), zone)).toISOString(),
    truncated: false,
  };
}

/** A query cache holding the page's answers, never read again (no kernel behind the catalog). */
function seeded(variant: SchedulesPageVariant, zone: string): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  const admin = variant === "admin";
  qc.setQueryData(meQuery().queryKey, meAs(admin ? "owner" : "member"));
  qc.setQueryData(readinessQuery(ORG).queryKey, { modelProvider: "ready", agents: 3 });
  qc.setQueryData(agentsQuery(ORG).queryKey, { agents: AGENTS });
  qc.setQueryData(orgSettingsQuery(ORG).queryKey, { settings: {} });
  const mine = TASKS.filter((t) => t.length < 5).map((t) => listTask(calTask(t, zone)));
  qc.setQueryData(schedulesQuery(ORG).queryKey, { items: mine });
  qc.setQueryData(schedulesQuery(ORG, "all").queryKey, {
    items: TASKS.map((t) => listTask(calTask(t, zone))),
  });
  qc.setQueryData(membersQuery(ORG).queryKey, {
    members: [
      { account: { id: "a1", displayName: "Grant", email: null }, role: "owner", joinedAt: T },
      { account: { id: "a2", displayName: "张三", email: null }, role: "member", joinedAt: T },
    ],
  });
  for (const range of ["week", "month"] as const) {
    for (const all of [false, true]) {
      qc.setQueryData(
        scheduleCalendarQuery(ORG, { ...rangeBounds(range, DATE, zone), timeZone: zone, all })
          .queryKey,
        answerFor(range, all, zone),
      );
    }
  }
  return qc;
}

/** The schedules page in the workspace shell. */
export function SchedulesPageCatalog({ variant }: { variant: SchedulesPageVariant }) {
  // the zone the page draws in (the server render's from `cb-tz`, as the view reads it)
  const zone = useTimeZone() ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [client] = useState(() => seeded(variant, zone));
  const { onOpenCommands: _, ...sidebar } = sidebarProps({ active: "schedules" }, () => "#");
  return (
    <QueryClientProvider client={client}>
      <AppShell sidebar={sidebar} commands={COMMANDS} status={statusFixture("/schedules")}>
        <SchedulesView
          initial={{
            view: "calendar",
            range: variant === "month" ? "month" : "week",
            date: DATE,
            scope: variant === "admin" ? "all" : "mine",
          }}
        />
      </AppShell>
    </QueryClientProvider>
  );
}
