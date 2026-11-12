# Scheduled tasks: a calendar view

- Date: 2026-11-12, written against `origin/main` at `859a6639`.
- Status: approved by the maintainer on 2026-11-12 with every recommendation of §15 (Q1–Q5, recorded
  there); implemented by `docs/superpowers/plans/2026-11-12-scheduled-tasks-calendar.md`.
- Related: scheduled tasks (`2026-11-11-scheduled-tasks-design.md`, merged as core#179; "the tasks
  spec" below, cited by section), the design system (`docs/design/spec.md`, "the design spec"), the
  web query cache (`2026-11-03-web-query-cache-design.md`), the `writing-web-ui` and
  `writing-kernel-api` skills.
- Markers: **(decided)** is the direction the maintainer agreed before this doc; **(designer's
  call)** is decided here and may be overturned in review; **Qn** (§15) needs the maintainer's
  answer. Unmarked items restate current code or rules.

## 1. Why

`/schedules` is a table of tasks: name, agent, the schedule in words, status, next run, last result.
It answers "what tasks do I have" but not "what happens on Thursday", "did last night's runs
succeed" or "why does my morning look crowded". A person who owns a daily brief, a weekly report and
a sync every two hours has to open each task and read its run history to see the week. The
maintainer asked for a calendar: past runs and the coming runs on one time grid, the way a person
already thinks about their own schedule.

Success: a member opens `/schedules`, switches to 日历, and in one look sees which of this week's
runs failed, what runs tomorrow morning, and opens the failed run's conversation in two clicks. The
calendar never shows a run that will not happen while the task stays as it is, and never hides one
that will.

## 2. Goals, non-goals, anti-goals

Goals:
- A 列表 / 日历 switch on `/schedules`; the list stays the default (decided).
- A week view (default) and a month view of runs (decided): recorded runs in the past, computed
  occurrences in the future up to a horizon of about six weeks (decided).
- A run opens a panel with the task's details, that run's result and its conversation (decided).
- Dense recurring tasks collapse instead of flooding the grid (decided).
- 只看我的 / 全组织 for org admins (decided).
- A day or agenda list on phones; keyboard and screen-reader use equal to the mouse.

Non-goals (this version):
- Editing from the calendar: no drag to reschedule, no click on an empty slot to create a task, no
  "skip this one occurrence". The task page stays the one place a task is edited.
- A day view on wide screens, a year view, ICS export or subscription.
- Predicting skips: an occurrence is what the schedule says; overlap, the rate limit, an offline
  device or a paused queue can still skip it at fire time (tasks spec §6). The panel says so.
- Showing a run's reply text: the panel links to the conversation instead (Q4).

Anti-goals (a failure even if it works):
- The calendar disagreeing with the scheduler: an occurrence at a time the task will not fire, or a
  tick the scanner will fire missing from the grid (DST days included).
- A five-minute task drawing 2,000 blocks, or a month view request that takes seconds.
- A member seeing another member's tasks or runs; an admin's org-wide view leaking a conversation
  they cannot open.
- State told by color alone, or color used outside the design system's status rules.
- A page-local calendar improvised in `apps/web` with its own styles.

## 3. What exists (summary)

- A **task** (`capybara.scheduled_tasks`) has a trigger `{ kind: "cron", expr, timeZone }` or
  `{ kind: "once", at, timeZone }` (5-field cron evaluated in an IANA zone; DST: a skipped local
  time does not fire, a repeated one fires once; a `once` time in a gap fires at the first valid
  instant after it), a fixed `jitter_seconds` per task (at most 10 % of the interval, at most
  300 s), `next_run_at` (the next tick plus jitter, null unless `active`), `expires_at`, `status`
  `active | paused | ended`, a mode `new | conversation | chat` and an agent (tasks spec §4, §5).
- A **task run** (`scheduled_task_runs`) is one tick: `scheduled_for` (the tick before jitter, or
  the request time for "Run now"), `fired_at`, `trial`, `manual`, `status`
  `pending | running | completed | failed | skipped`, `skip_reason`, `error`, `missing_grants`,
  `conversation_id`, `run_id`. A catch-up after an outage records all missed ticks as **one**
  skipped run at the first missed tick (`missed`).
- The scanner (`scan.job.ts`) and the schedule math (`schedule-math.ts`: `nextTick`, `dueTicks`,
  one private `ticker(trigger)` that both use) decide every tick; `next_run_at` is advanced from
  `nextTick(trigger, …) + jitter`.
- HTTP: `GET /api/v1/orgs/:orgId/schedules` (own tasks, `?all=true` for `schedules.manage`) with
  `lastRun`; `GET …/:id/runs?limit` (≤ 200 latest). Every route has a Platform operation
  (`schedules.*`).
- Web: `/schedules` is `ListPage` + `DataTable` (`app/(app)/schedules/view.tsx`, members up),
  `/schedules/<id>` the task page, `/settings/schedules` the org admins' settings and every task.
  Queries in `lib/query/schedules.ts`, keys under `keys.org(orgId).schedulesAll()`; every task
  mutation already invalidates that prefix.
- Design: there is **no** calendar, time-grid or date-picker component (`docs/design/spec.md` §6).
  `Segmented`, `Sheet`, `Popover`, `EmptyState`, `Skeleton`, `StatusMark` and the status table
  (§2.4) exist.

## 4. The page

### 4.1 Switch and URL

- The page head of `/schedules` keeps its title, description and 新建定时任务 primary. Its **tab
  row** holds 列表 / 日历 (decided, Q1): the design spec's tab row is the pattern for "pages
  with views" (§4.2 row 4), while `Segmented` is a control inside content (§6.4). The tabs change the
  view with `onSelect` and a `router.replace` of the query, no reload.
- URL: `/schedules` (list), `/schedules?view=calendar` (calendar), plus `&range=week|month`
  (absent = `week`), `&date=YYYY-MM-DD` (any day of the shown week or month, in the viewer's zone;
  absent = today) and `&scope=all` (admins; absent = mine). Every state is a URL, so a reload, Back
  and a shared link show the same view.
- **Remembered view** (decided: URL plus a per-viewer convenience; a cookie, Q5): the last chosen tab and range are
  stored in a cookie `cap_schedules_view` (`list | calendar`, `week | month`; `SameSite=Lax`,
  one year, not `HttpOnly` since only the client writes it). `page.tsx` reads the
  cookie and `searchParams` (no kernel read, allowed by `web-query-page-read`) and passes the
  effective view to the view, so the first paint is already the remembered view; `localStorage` is
  not used because a server render cannot read it and the page would flash the list first. An
  explicit `?view=` always wins and is written back to the cookie.
- The admin 全组织 scope is not remembered (designer's call): an admin returns to 只看我的, the
  scope that matches the list's default.

### 4.2 Layout

The calendar view is `ListPage` (the head, its tab row, the `callout` for 定时任务已被组织关闭 and the
page `empty` state as today) whose child is the new design component **`ScheduleCalendar`** (§6),
drawn on the page ground as one box (designer's call). Inside the content width (1120), from top to
bottom:

1. The calendar's own toolbar (a row of `default` controls, like a DataTable toolbar): 今天, the
   previous / next icon buttons (`chevron-left` / `chevron-right`, named 上一周 / 下一周 or 上个月 /
   下个月), the range label (「2026-11-09 – 11-15」 / 「2026-11」, mono), then at the right end a
   `Segmented` 周 / 月 and, for org admins only, a `Segmented` 只看我的 / 全组织.
2. The grid (§4.3 / §4.4) on the `panel` ground with the `line-card` hairline.
3. Under the grid, a `small` `muted` line: the zone the grid is drawn in (「时间按 Asia/Shanghai
   显示」) and, when the range passes the horizon, 「只显示到 12-24 的计划运行」.

Guests get the existing no-access state (members up, as the list). The page's other states are in §8.

### 4.3 Week view (default)

- Seven day columns, **Monday first** in both locales (designer's call), headed 「周四 11-12」;
  today's heading is `ink` 500 with the date in a `selected` chip, the others `muted`.
- A left time axis 00–24 with an hour label every hour (`small` `muted`, §6.2) and a `line-soft` hairline per hour. The grid scrolls vertically inside its box; on open it
  scrolls to 07:00 or to one hour before the earliest item of the week, whichever is earlier
  (designer's call). The day header row and the dense lane stay pinned while it scrolls.
- **Now line**: a 1 px `accent` line across today's column with a 6 px square at the axis end (the
  accent's text role, "something is happening now", design spec §2.3), moved by `useNow(60_000)`.
  Not drawn when today is outside the range.
- **Blocks**: one per run or occurrence, placed at its tick (`scheduled_for`, before jitter; a
  manual run at its request time), a fixed height of one half-hour slot (runs last minutes and the
  task run row has no end time; designer's call). A block shows the state icon, the time (mono),
  the task name (one line, ellipsis) and, when the height allows, the agent's name (`small`
  `muted`). In 全组织 the creator's name joins the agent (「研究助手 · 张三」).
- **Overlap**: blocks whose half-hour slots overlap share the column side by side, up to two; a
  cluster that needs more keeps one block and draws one 「+N」 in the second place, at the first
  hidden item's slot, opening a Popover listing the hidden ones as buttons (designer's call;
  coordinator decision 2026-11-13: three side by side left about 51 px each at the 1120 content
  width, only an icon and a clipped time 「09:0」).
- **Dense lane**: under the day headers, one lane per day for collapsed tasks (§5.4). Each collapsed
  task-day is a one-line chip 「每小时 · 24 次」 / 「每 15 分钟 · 96 次」 with a state summary
  (「· 2 次失败」 in `fail` with `circle-x` when any failed). The lane is drawn only when the week
  has a collapsed task.
- Clicking (or ↵ / Space on) a block or chip opens the run panel (§4.5).

### 4.4 Month view

- A 6 × 7 grid of day cells (Monday first), days outside the month with `muted` numbers and their
  items still drawn (designer's call: a run on the 1st of the next month is real). Today's number
  in the `selected` chip.
- A cell lists up to **3** items (decided) by time, each one line: state icon, time, task name.
  Collapsed tasks are one line each (「每小时 · 24 次」, decided) and count toward the three. More
  than three: the third line becomes 「+N 项」, a button opening a Popover with the whole day as
  buttons (designer's call; the day number itself links to that day's week).
- No now line; past and future cells are not tinted differently (the state icons already tell
  recorded from planned).

### 4.5 The run panel

A `Sheet` (480, no scrim, the grid stays usable) opened from a block, a chip or a Popover item;
its open item is in the URL hash (`#run=<taskRunId>`, `#at=<taskId>/<ISO tick>` for an occurrence,
`#day=<taskId>/<YYYY-MM-DD>` for a collapsed chip) so a reload keeps it (designer's call). Content,
as `Subsection variant="divided"` regions (design spec §6.7, one box, no cards):

- **Status line** (no title): the state mark (icon + word) and the time in the viewer's zone, plus
  the task's zone when it differs (「11-12 09:00 · 任务时区 America/New_York 20:00」), 「约」 when the
  task has jitter.
- **本次运行**: for a recorded run: status, why it was skipped (the existing skip-reason copy),
  the error as an `ErrorDetail` (own tasks only, §5.1), missing grants as a count linking to the task page, 试运行 / 手动
  marks, and a `LinkButton` 打开会话 to `/chat/<conversationId>` when the viewer is the task's
  creator (an admin viewing another member's run sees no link: the conversation is the creator's;
  decided, Q3). For an occurrence: 「计划运行」 and one `prose-small` `muted` sentence:
  「到时如遇上次运行未结束、组织运行上限或设备离线，本次会跳过。」.
- **任务**: the schedule in words with its zone (the existing `useScheduleWords`), the agent, where
  runs go (new conversation / the conversation / the chat), the task status and its next run.
- For a collapsed chip: the day's items of that task as an `ItemList` of buttons (time, state),
  each opening that item in the same Sheet (Back returns to the day).
- Footer: 打开任务 (`LinkButton` to `/schedules/<id>`). No pause, run-now or delete here (designer's
  call): one place for task actions keeps the panel read-only and avoids a second copy of the task
  page's confirmations.

## 5. Kernel

### 5.1 The route

`GET /api/v1/orgs/:orgId/schedules/calendar` (designer's call: under the existing controller,
declared before `:id`):

| Query | Meaning |
|---|---|
| `from`, `to` | ISO 8601 instants with offset, `from < to`, `to - from ≤ 43 days` (a 6-week month grid plus a DST hour); else `validation_failed` |
| `timeZone` | The viewer's IANA zone (`IanaTimeZone`), used only to bucket collapsed tasks by local day (§5.4) |
| `all` | `true`: every task of the org (`schedules.manage`, else 403 `forbidden`, the list's rule) |
| `taskId` | Optional: only this task, and never collapsed (the panel's day list; then `to - from ≤ 2 days`) |

Answer:

```ts
{
  tasks: CalendarTask[];        // every task an item below names: id, name, agentId, accountId,
                                // status, pauseReason, trigger, mode, jitterSeconds, nextRunAt
  items: (
    | { kind: "run"; taskId; id; scheduledFor; firedAt; status; skipReason; trial; manual;
        conversationId; error; missingGrants: number }
    | { kind: "occurrence"; taskId; scheduledFor; at /* scheduledFor + jitter */ }
  )[];                          // ordered by scheduledFor, then taskId
  collapsed: { taskId; day /* YYYY-MM-DD in timeZone */; count;
               upcoming; completed; failed; skipped; running; first; last }[];
  horizon: string;              // ISO: nothing is returned after it (42 days ahead, or the cut)
  truncated: boolean;           // a limit cut the range at a whole day (§5.5)
}
```

- `@OrgAction("org.read")` like the list (a creator demoted to guest can still read their own runs
  through the API or Platform; the web page stays members up like the list, so a guest gets the
  existing no-access state there); the service decides by the live role. Members see their own tasks only; `all=true` is org-wide for
  `schedules.manage` (decided). Human users only, as the rest of the controller.
- Run rows come from `scheduled_task_runs` joined to live tasks (`deleted_at IS NULL`; a deleted
  task's runs are hidden: its panel would have nothing to open; designer's call), `scheduled_for`
  in `[from, to)`, trial runs included and marked (designer's call). `missingGrants` is a count; the
  task page lists them. The read uses `scheduled_task_runs_task_idx (task_id, scheduled_for DESC)`
  per task id list. `conversationId` and `error` are returned only for the viewer's own tasks: an
  admin's 全组织 answer carries `null` there for another member's run (Q3: the id itself is the
  creator's), and the Platform operation does the same. No new index is expected, the plan confirms with `EXPLAIN` on 200 tasks × 42
  days of hourly runs.
- No new table, no migration, no write.

### 5.2 Occurrences come from the scheduler's code path

The calendar must not be a second implementation of cron (anti-goal 1). In `schedule-math.ts`, a
new export built on the same private `ticker(trigger)` the scanner uses through `nextTick` and
`dueTicks`:

```ts
/** The ticks in (after, until], at most `max`, from the scanner's own ticker. */
export function ticksIn(t: ScheduleTrigger, after: Date, until: Date, max: number): Date[];
```

For each **active** task (designer's call: a paused or ended task has no future occurrences; it
will not fire until someone resumes it):
- start from the scanner's next due tick, `next_run_at - jitter_seconds`, so the first occurrence is
  exactly the tick the scanner will fire next (a tick the scanner already passed is a run row, or
  nothing when it was missed and not recorded yet);
- continue with `ticksIn` up to `min(to, horizon, expires_at)`; a `once` task has its one tick;
- keep a tick that is already due but not yet recorded (the scanner writes the run row only once
  `tick + jitter <= now`, at its next minute): it stays an occurrence (shown as 即将运行, the
  `upcoming` state) until its run row exists, so nothing the scanner will fire disappears in the
  gap. A due tick older than the org's `catchUpWindowMinutes` is dropped: the scanner will record it
  as part of one `missed` run, not fire it. Then drop ticks before `from`; a tick whose run row
  already exists (the scan recorded it, the fire job is pending) is shown as the run, never twice;
- skip all occurrences when the org has scheduled tasks turned off (`scheduledTasks.enabled`
  false): none would fire (designer's call; the page shows the existing callout).

The **horizon** is `now + 42 days` (decided: "about 6 weeks"); it is a constant next to the route,
not a config option (designer's call).

The scanner's decision for one due task is a pure function in `schedule-math.ts`, `scanStep`
(the first missed tick, the tick to fire, the next `next_run_at` or why the task ends); `scan.job.ts`
applies its result, and the calendar calls the same function for a task that is already due but not
yet scanned, so both share one implementation. A parity test (§10) drives `scanStep` minute by
minute (on time and late) and by jumps to each `next_run_at`, with jitter, over 10-day windows, and
asserts the ticks it fires equal `ticksIn`'s list, across DST in `Asia/Shanghai` (no DST),
`America/New_York` and `Europe/London`, for daily, hourly, weekly, `*/15`, `once`-in-a-gap and an
expiring task.

### 5.3 Time zones and DST

- Every instant on the wire is UTC ISO. The kernel evaluates each trigger in **the task's zone**
  (the scanner's rule); the web draws it in **the viewer's browser zone**, the zone every other
  date in the web uses (`useTimeZone()`: the `cb-tz` cookie the web writes from the browser, read by
  the root layout for the server render; `apps/web/src/components/design-root.tsx`,
  `packages/design/src/clock.tsx`). The account's `time_zone` setting is not used here: it decides
  the zone of runs and of new tasks, not how the web draws dates (designer's call, consistent with
  the rest of the web). A task in `America/New_York` at 09:00 sits at 22:00 for a viewer in
  `Asia/Shanghai`; the panel shows both (§4.5).
- The web computes `from` / `to` as the viewer-local start of the first shown day and of the day
  after the last, so a DST week is 167 or 169 hours; the 43-day bound covers that.
- The week grid's axis is the viewer's wall clock 00–24. On a viewer-local DST day the repeated
  hour's two instants land on the same rows (they overlap like any two blocks); the skipped hour
  holds nothing. No 23- or 25-row day is drawn (designer's call).
- A task-zone DST gap already removes the tick (the scanner skips it); a repeated hour fires once;
  the calendar shows exactly that because it uses the same ticker.

### 5.4 Dense tasks

- A task-day is **collapsed** when the task has more than **6** items (runs plus occurrences) on that
  local day of `timeZone` (designer's call: hourly and finer always collapse, as decided; a
  workday-hours cron such as `0 9-17 * * *` collapses too; `0 8,12,18 * * *` stays three blocks).
  Its items are left out of `items` and summarized in `collapsed` with the per-state counts and the
  first and last instants.
- The web labels a collapsed chip from the trigger: a fixed step (`*/15 * * * *`, `0 * * * *`)
  reads 「每 15 分钟 · 96 次」 / 「每小时 · 24 次」; anything else 「24 次运行」 (designer's call).
- With `taskId`, nothing collapses: the panel's day list gets every item of that task and day
  (at most 288 for the 5-minute platform floor).

### 5.5 Caps and cost

- A range is at most 43 days, an org at most `maxTasksPerOrg` tasks (platform ceiling), so there is
  no pagination (designer's call): one request answers one view.
- **Tick cost (measured 2026-11-12).** One tick evaluation of the scheduler's ticker (cron's
  `getNextDateFrom` plus the DST check) costs about 150–340 µs on a developer laptop: `*/5` about
  160 µs, hourly about 260 µs, daily about 300 µs, weekly about 340 µs, with the ticker built once
  per task (`tickerOf`; rebuilding it per call added about 15 %). Ticks dominate the request time.
- Three limits per request, all named constants in `schedules/calendar.ts`: a **tick budget** of
  3,000 ticks taken across all tasks (collapsed task-days need their count, so their ticks are
  taken too; each task's one lookahead past its window end and `scanStep`'s search for a task
  already due are not counted, at most about 2 × tasks evaluations more), an **item cap** of 3,000
  entries in `items` + `collapsed`, and a **run-row cap** of 20,000 run rows read. The budget was
  chosen so a worst-case request stays near one second. The platform ceiling for tasks per org is
  2,000 (`schedules.maxTasksPerOrgCap`), so a month of 2,000 daily tasks (84,000 ticks) cannot fit,
  and the answer must say so instead of dropping items silently. A month of 200 daily tasks (the
  default org cap, about 8,400 ticks) is cut too, after about two weeks; the week view of the same
  org fits.
- **The first day is always returned.** The first requested local day is returned whole, outside
  the three limits, so a view is never empty because of them. Only safety caps stop it: 10,000 ticks
  and 20,000 run rows on that day; past either, the answer is empty with `truncated: true` and
  `horizon` equal to `from`. `horizon` is never before `from`.
- **One cut rule** (designer's call): the kernel walks the range day by day (viewer-local days of
  `timeZone`), adding each day's runs and occurrences for every task (planned ticks are taken in
  time order across all tasks); when the next day would pass any limit, it stops, returns the whole days so far and sets `truncated: true` with `horizon`
  moved back to the cut. Nothing inside a returned day is ever dropped or uncounted. The page shows
  a `warn` callout 「运行太多，只显示到 12-03，请切到周视图」 and the grid draws the days after the cut
  as not loaded (no items, a `muted` 「未加载」 in their header). A week at the platform ceiling of
  2,000 daily tasks (14,000 items) is also cut; such an org reads the calendar with 只看我的 or the
  list.
- Response time (measured 2026-11-12, the pure assembly with no database, viewer in
  `Asia/Shanghai`): a week of 200 daily tasks about 250 ms; a 42-day month of 200 daily tasks about
  780 ms (cut after about two weeks); 20 hourly tasks over a month about 650 ms (cut); 200 hourly
  tasks over a week about 650 ms (cut); 2,000 daily tasks over a month about 880 ms (cut). A first
  day that reaches its 10,000-tick safety cap would take about 1.5–3.4 s. The 300 ms target of the
  first draft is not reachable with the scheduler's own ticker; the kernel tests assert the counts
  and the cuts, not the time.

### 5.6 Platform operation

`schedules.calendar`, mirroring the route (designer's call: an operation, not an exclusion, because
"what runs this week and what failed" is a natural agent question, the route is a read, and
`check:platform-ops` wants either). Confirm class none (a read), `authz: { orgAction: "org.read" }`,
input from the route's exported query schema (so `platform-parity.test.ts` holds), output the same
shape with `tasks` trimmed to `{ id, name, agentId, status }`. Description: "Your scheduled task
runs and planned occurrences between two instants (at most 43 days): recorded runs with their
status, planned runs computed from each active task's schedule up to 42 days ahead, and dense tasks
summarized per day. Org admins see every task with all=true." Errors are the route's, with `next`
hints ("Narrow the range to 43 days or less.").

## 6. Design component

No calendar exists in `packages/design`, so this spec adds one (writing-web-ui "Adding a component
or template": spec, tokens, reference blocks, implementation, catalog, compare, `ACCEPTED`).

### 6.1 `ScheduleCalendar` (design spec §6.40, new)

Named for its one use (designer's call): a generic calendar would grow event durations, all-day
events and editing that nothing here needs. Plain props, no kernel types:

```ts
ScheduleCalendar({
  range: "week" | "month" | "agenda";        // the page passes "agenda" below 640 (§7)
  days: string[];                            // YYYY-MM-DD, the viewer-local days shown
  today: string;
  now: number;                               // epoch ms (useNow), for the now line
  timeZone: string;
  items: { id; day; minute /* 0..1439, viewer-local */; time /* "09:00" */; title; meta?;
           state: "upcoming" | "running" | "completed" | "failed" | "skipped";
           mark?: string /* 试运行 */; label /* full accessible name */ }[];
  collapsed: { id; day; title; summary; state; label }[];
  selectedId?: string;
  onSelect(id: string): void;
  onNavigate(to: "prev" | "next" | "today"): void;
  onRange(r: "week" | "month"): void;
  rangeLabel: string;
  scope?: { value: "mine" | "all"; onChange(v): void; labels };   // admins only
  footnote?: string;                          // the zone and horizon line
  loading?: boolean;
  empty?: { text; hint?; action? };           // drawn over the grid (§8)
  error?: { retry(): void; code?: string };
  // added in implementation (2026-11-12):
  refreshing?: boolean;                       // a range change in flight: a spinner by the label (§8)
  notLoadedFrom?: string;                     // days at or after it drawn as not loaded (§5.5)
  onDay?(day: string): void;                  // a month day number, an agenda day button
  day?: string;                               // the agenda's chosen day (the page's date=)
})
```

`collapsed` entries also take `failed?` (「2 次失败」), drawn in `fail` with `circle-x` after the
summary.

The page builds `day` / `minute` from instants in the viewer's zone (`lib/schedule-calendar.ts`,
pure, unit-tested); the component never reads a clock or a zone itself (design spec §2.2 rule).

### 6.2 States and status encoding

Run states follow the design spec's status table (§2.4) and principle 3 ("color only for what needs
attention"): success is not colored. Every block carries its icon and its full label, so no state
is told by color alone.

| Item state | Icon | Block | Text |
|---|---|---|---|
| `upcoming` (occurrence) | `clock` | no ground, 1 px dashed `line` border | `muted` |
| `running` (`pending` / `running` run) | `spinner` in `accent` (text role) | `selected` ground | `ink` |
| `completed` | `check` in `muted` | `selected` ground | `ink` |
| `failed` | `circle-x` in `fail` | `selected` ground, 2 px `fail` left marker | `ink`, time in `fail` |
| `skipped` | `ban` in `muted` | `hover` ground | `muted` |

- Selected block: a 1 px `line-strong` border (the neutral selection inside a control, §2.3), never
  the accent.
- Succeeded runs are not colored (decided, Q2): the table keeps the system's rule.
- **Tokens**: all colors above are existing tokens; no new color token (designer's call). New
  `contrast` pairs in `docs/design/tokens.json`: `fail` on `selected` (4.5) and `ink` / `muted` on `hover`
  where missing, checked by `check:tokens`. New size tokens: `layout.calendar-axis` (48),
  `layout.calendar-hour` (48, one hour row; a block is half of it, 24 px, the tap-target floor of
  §6.3), `layout.calendar-day-min` (76, the narrowest day column: 7 × 76 + 48 fits the 640 content
  width), `layout.calendar-cell` (112, a month cell's minimum height: the date row and three 24 px
  lines). Contrast pairs over the `panel` ground the grid sits on (the translucent light grounds
  composited over `panel`): `ink`, `muted` on `hover`; `ink`, `fail` (4.5) and `accent` (3) on
  `selected`; `fail` on `selected` composited over `bg` would be 4.42:1 in light, so the pair names
  the real surface.
- Hour labels: `small` in `muted` (not `faint`: they carry information, §2.1).

### 6.3 Keyboard and accessibility

- The grid is a `group` named by the range label; each day is a `group` named 「11月12日 周四」 with a
  visually hidden heading; blocks and chips are `button`s in time order, one tab stop for the grid
  (roving `tabindex`, the current item first, else the first item of today, else the first item).
- Keys inside the grid: ↑ / ↓ previous / next item in the day (month: the week above / below),
  ← / → the nearest item in time on the previous / next day, Home / End first / last item of the
  range, PageUp / PageDown the previous / next range (focus kept on the same weekday), `t` today,
  ↵ / Space open. The toolbar is ordinary tab order before the grid.
- Each button's accessible name is the full label: 「每日简报，研究助手，11月12日 周四 09:00，已完成」;
  a collapsed chip 「数据同步，每小时，11月12日 周四 24 次，其中 2 次失败」. 「+N」 reads 「另外 3 项，
  11月12日 周四」.
- Navigating the range announces the new range label in a polite live region. The now line is
  decorative (`aria-hidden`).
- `forced-colors`: borders `CanvasText`, the failed marker and the now line `Highlight`.
- Tap targets: blocks are at least 24 px high on pointer screens; the phone agenda rows are 40 px.
- `prefers-reduced-motion`: the spinner is static (existing rule); scrolling to 07:00 is instant.

## 7. Phones and narrow widths

- **≥ 960**: as §4. **640–960**: the same week grid, day columns at least `layout.calendar-day-min`;
  the block shows the time and name only.
- **< 640** (design spec §4.3, checked at 390 × 844): the page passes `range="agenda"` (designer's
  call, decided direction "a day or agenda list"): the toolbar keeps 今天 and prev / next (stepping a
  week) and folds 周 / 月 and the scope into one options button opening a Menu (the range choices,
  a separator, the scope choices; implementation review 2026-11-12: a Menu, not a bottom Sheet); a row of seven
  day buttons (「一 9」 … 「日 15」, today marked, the selected day `selected`, a dot under a day with
  a failed run, 40 px high); under it the selected day's items as a list, one 40 px row each (state
  icon, time, name, agent), collapsed tasks as one row. A month on a phone is the same agenda; the
  day row then pages by week (designer's call: a 6 × 7 month grid at 390 px cannot hold readable
  items). The selected day is in the URL (`date=`).
- The first paint follows the window through CSS (writing-web-ui "First paint follows the window"):
  the component renders both the grid and the agenda and CSS shows one below 640, so a phone never
  paints the grid first. No horizontal page scroll at any width (JS-off visual case).

## 8. Loading, empty and error states

- **First load / navigation with nothing cached**: `ListPage` keeps the head and tab row real; the
  calendar draws its toolbar for real and the grid frame with skeleton blocks (`aria-busy`, one busy
  region, design spec §6.29). A range change keeps the previous range's grid until the new answer
  lands (`placeholderData: keepPreviousData`) with the toolbar's range label already updated and a
  dense `spinner` beside it, so the grid never flashes empty (designer's call).
- **No tasks at all**: the page `EmptyState` as on the list (「还没有定时任务」 + 新建定时任务); the
  tabs still switch.
- **Tasks, but nothing in the range**: the grid is drawn empty with a `panel` `EmptyState` centered
  over the grid body: 「本周没有运行」 / 「本月没有运行」, hint with the next planned run when there is
  one (from the tasks' `nextRunAt`), and the action 跳到下一次运行 that navigates to its range.
  When every task is paused: 「所有定时任务都已暂停」 with 查看列表.
- **Org turned scheduled tasks off**: the existing `warn` callout; past runs still show, no
  occurrences (§5.2).
- **Error**: a failed first read is the page's `ErrorFrame`; a failed range change keeps the grid
  with the in-grid load-failed line (「加载失败」 in `fail`, code · request id, 重试).
- **Truncated**: the `warn` callout of §5.5.

## 9. Web wiring

- `lib/schedules.ts`: `getScheduleCalendar(orgId, { from, to, timeZone, all, taskId? })`.
- `lib/query/schedules.ts`: `scheduleCalendarQuery(orgId, params)`, key
  `keys.org(orgId).scheduleCalendar(scope, from, to, timeZone, taskId?)` **under the
  `schedulesAll()` prefix**, so every existing task mutation (pause, resume, run, delete, update)
  refreshes the calendar with no new invalidation code. Freshness `live`; `refetchInterval` 60 s only
  while the range contains now (polling as a query option, never a timer).
- `lib/query/routes.ts`, `/schedules`: when the effective view is the calendar, `queries` adds the
  calendar read for the range the view will ask for, computed from `search` and the zone the root layout
  read from the `cb-tz` cookie; on a first visit without that cookie the server does not know the
  browser's zone, so the entry prefetches nothing and the view reads on mount behind the loading
  state (designer's call). The list's reads stay (the tabs switch without a
  read).
- `lib/schedule-calendar.ts` (pure): range bounds from `date` + `range` + zone, item placement
  (`day`, `minute`), labels, the collapsed label from the trigger. Unit-tested.
- `view.tsx`: the tab switch, the cookie write, the scope (`scope=all` only when `useWorkspace`
  says admin; otherwise ignored), the Sheet and its hash.
- No `className`, `style` or color literal in `apps/web`; `pnpm check:web-ui` passes with the
  calendar drawn by `@capybara-hq/design` alone.

## 10. i18n

- Page copy in `apps/web/messages/{zh,en}.json` under `schedules.calendar.*`: 列表 / List, 日历 /
  Calendar, 只看我的 / Mine, 全组织 / Whole org, 计划运行 / Planned, 运行中 / Running, 已完成 /
  Succeeded, 失败 / Failed, 已跳过 / Skipped, 试运行 / Trial, 手动 / Manual, 打开会话 / Open
  conversation, 打开任务 / Open task, the empty, horizon, zone and truncated lines, the collapsed
  labels (「每小时 · {count} 次」 / "Hourly · {count} runs", plural forms in en).
- The component's own strings (weekday names, 今天 / Today, 上一周 / Previous week, 「+N 项」 / "+N
  more", the live-region text) go through the design package's i18n.
- zh says 智能体, never `agent` (`pnpm check:i18n`). Dates follow design spec §2.2: mono
  `MM-DD HH:mm` / `HH:mm` in blocks, `formatDateTime` in the panel; weekday names come from the design
  i18n, not `toLocaleString`.

## 11. Reference set and visual baselines

- Reference blocks in `docs/design/reference/src/` (dark and light, from `@capybara-hq/design/fixtures`
  with a fixed clock), state list `<!-- states: schedule-calendar -->`:
  `week` (all five item states, overlaps that end in a 「+N」, the now line), `week-dense` (the
  collapsed lane), `month` (three items and 「+N 项」, days outside the month), `agenda` (390 wide),
  `loading`, `empty`, `failed` (load-failed line), `selected`. A size table per §9.2 with the new
  layout tokens. PNGs are rendered only by the `reference-update` workflow.
- `/dev/ui` catalog page for the component with a `RefBlock` per state; compare with
  `COMPARE=schedule-calendar` in the pinned Linux Playwright image, judged by a blind image reviewer
  dispatched by the controller; then `ACCEPTED` in `apps/web/visual/accepted.ts`.
- Page baselines: `/schedules?view=calendar` week and month, an admin 全组织, the open run Sheet and
  the 390 agenda, dark and light, through the `visual-update` workflow on the PR branch; an
  interaction spec for the keyboard path and a JS-off phone case for "no horizontal scroll".

## 12. Tests

Kernel (`packages/kernel`):
- `schedule-math`: `ticksIn` equals repeated `nextTick`; the scanner-parity test of §5.2 across DST
  in three zones, `once` in a gap, expiry, jitter.
- Service `calendar`: member sees own only; `all` 403 for a member, org-wide for an admin; a guest
  creator sees own; deleted tasks hidden; paused and ended tasks have runs but no occurrences; org
  turned off gives no occurrences; a recorded pending tick is not duplicated as an occurrence; the
  first occurrence equals `next_run_at - jitter`; a due tick the scan has not recorded yet stays an
  occurrence, one older than the catch-up window does not; an admin's `all` answer has null
  `conversationId` / `error` for other members' runs; the >6 per day collapse and `taskId` never
  collapsing; either limit cuts at a whole day with `truncated` and no partial day; range validation (`from ≥ to`, > 43 days, `taskId` > 2 days).
- Controller / e2e on the dual-replica harness for one read; `platform-parity.test.ts` and
  `check:platform-ops` for `schedules.calendar`.

Design (`packages/design/test`, jsdom): every state renders; roving focus and every key of §6.3;
full accessible names; the live region; `findNestedBoxes` finds nothing; the agenda below 640; no
color literal (`design-color-literal`).

Web (`apps/web/test`): `schedule-calendar.ts` placement across a viewer DST day and a task in another
zone; `/schedules?view=calendar` "a first render from the hydrated cache makes no browser read" and
"an empty cache shows the template's loading state, then the data"; the cookie restores the
calendar on a document load; the tabs switch without reading; prev / next change the key; a pause
from another tab invalidates the calendar (key under `schedulesAll`); the Sheet opens from the hash;
an admin's scope switch; a member never sees the scope control.

## 13. Phasing

1. **Kernel**: `ticksIn`, the service method, the route, `schedules.calendar`, tests. Independent of
   the UI; merges alone.
2. **Design** (parallel with 1): spec §6.40, tokens, reference blocks (workflow), the component, its
   tests, the catalog, compare and `ACCEPTED`. Reviewed as a design-spec diff first (§10 change
   process).
3. **Web**: the tabs, the cookie, the queries and route entry, the Sheet, i18n, tests, page
   baselines (workflow).

Each phase is one PR referencing the issue; the plan splits 1 and 2 into parallel waves.

## 14. What is left to the builder

The SQL shape of the run read; where `ticksIn` checks the budget; the cookie helper's module; the
exact skeleton shape of the loading grid; the Popover's max height; the scroll-to-07:00 mechanics;
the collapsed label parser for step crons (anything it cannot name falls back to 「N 次运行」).

## 15. Decided questions

All five were answered by the maintainer on 2026-11-12, each with the recommendation:

- **Q1. The 列表 / 日历 switch** (decided): the page head's tab row, not a `Segmented`.
- **Q2. Succeeded runs** (decided): not colored; the run states follow the design system's status
  rules (§6.2): failed in `fail`, running in the accent's text role, upcoming as a dashed outline,
  succeeded and skipped neutral, every state with its icon and words.
- **Q3. Admins and other members' runs** (decided): in 全组织 an admin gets a run's status and skip
  reason only: no 打开会话 link, and the kernel returns no conversation id and no error text for
  another member's run (route and Platform operation alike, §5.1).
- **Q4. The run's reply in the panel** (decided): not in this version; the panel links to the
  conversation (own runs only).
- **Q5. Remembering the view** (decided): a per-browser cookie (`cap_schedules_view`, §4.1); no
  kernel preference and no migration.
