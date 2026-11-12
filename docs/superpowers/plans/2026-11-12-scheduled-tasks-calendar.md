# Scheduled Tasks Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with the
> wave-planned-subagent-development layer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a week / month calendar of scheduled task runs on `/schedules` (recorded runs, planned
occurrences from the scheduler's own ticker, dense tasks collapsed), with its kernel range API and
Platform operation, a new design component and the web page.

**Spec:** `docs/superpowers/specs/2026-11-12-scheduled-tasks-calendar-design.md` (read it first;
section numbers below are the spec's; §15 records the maintainer's answers). Issue #209.

**Branches (each PR against `main`, each `Refs #209`, the last `Closes #209`):**

| Phase | Branch | Worktree | Content |
|---|---|---|---|
| docs | `docs/schedules-calendar-plan` | `docs-schedules-calendar-plan` | the decisions in the spec + this plan |
| 1 | `feat/schedules-calendar-kernel` | `pnpm wt:new … --from origin/main` | Tasks 1–2 |
| 2 | `feat/schedules-calendar-design` | same | Task 3 |
| 3 | `feat/schedules-calendar-web` | same, after 1 and 2 are merged | Task 4 |

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 `ticksIn` + scanner parity | — | `packages/kernel/src/schedules/schedule-math.ts`, its test | high (the calendar must equal what fires) | 1 | alone, most capable |
| 2 calendar read, route, Platform op | 1 | `schedules/` service, schemas, controller, `platform/ops/schedules.ops.ts`, tests | high (who sees which runs; admin redaction) | 1 (same implementer as 1, after it) | alone, most capable (with 1) |
| 3 `ScheduleCalendar` component | — (props are plain data, spec §6.1) | `packages/design`, `docs/design/spec.md`, `docs/design/tokens.json`, `docs/design/reference/src`, `apps/web/src/dev/catalog`, `apps/web/reference/render.spec.ts`, `apps/web/visual/accepted.ts` | normal | 1 (own worktree) | batched, mid |
| 4 web page | 2, 3 merged | `apps/web/src` (schedules page, lib, query, routes, messages), `apps/web/test`, `apps/web/visual` | normal | 2 | batched, mid; final review most capable |

Tasks 1–2 and 3 touch disjoint files and run in parallel in separate worktrees.

## Global constraints

- AGENTS.md applies; read `writing-kernel-api` (Tasks 1–2) and `writing-web-ui` (Tasks 3–4) first.
- No migration, no new table, no config option. The horizon (42 days), the range bound (43 days),
  the collapse threshold (> 6 per local day), the tick budget (20,000) and the item cap (3,000) are
  named constants in `packages/kernel/src/schedules/calendar.ts`.
- Changesets: kernel and web changes `@capybara-hq/capybara` patch; the design component
  `@capybara-hq/design` patch (see `1c8fd1204` TrendChart for the shape of a design addition).
- Run single tests from the repo root: `pnpm exec vitest run <path>`. Before each PR:
  `pnpm lint`, `pnpm typecheck`, `pnpm check`, and the touched packages' tests (`pnpm verify`).
- UI copy through i18n zh + en; zh says 智能体; dates through `formatDateTime` / `DateTime`; no
  `toLocaleString`, no `Date.now()` in render (`useNow`).
- Parallel implementers stage only their own paths (`git add <paths>`), never `-A` / `-a`.
- Commits: `git -c user.name=Grant -c user.email=284885069@qq.com commit`, Conventional Commits,
  body lines ≤ 100, ending with the `Co-Authored-By` line. Never force push, never bare `git stash`.

## Shared interface (Tasks 2 and 4)

The answer of `GET /api/v1/orgs/:orgId/schedules/calendar` (spec §5.1), exported from
`packages/kernel/src/schedules/calendar.ts` and mirrored by hand in `apps/web/src/lib/schedules.ts`:

```ts
export interface CalendarTask {
  id: string; name: string; agentId: string; accountId: string;
  status: ScheduleStatus; pauseReason: SchedulePauseReason | null;
  trigger: ScheduleTrigger; mode: ScheduleMode; jitterSeconds: number; nextRunAt: string | null;
}
export type CalendarItem =
  | { kind: "run"; taskId: string; id: string; scheduledFor: string; firedAt: string | null;
      status: TaskRunStatus; skipReason: TaskRunSkipReason | null; trial: boolean; manual: boolean;
      /** Null for another member's run (admin `all`, spec §15 Q3), as `error` and `missingGrants`. */
      conversationId: string | null; error: string | null; missingGrants: number | null }
  | { kind: "occurrence"; taskId: string; scheduledFor: string; at: string };
export interface CalendarCollapsed {
  taskId: string; day: string; count: number;
  upcoming: number; running: number; completed: number; failed: number; skipped: number;
  first: string; last: string;
}
export interface CalendarAnswer {
  tasks: CalendarTask[]; items: CalendarItem[]; collapsed: CalendarCollapsed[];
  horizon: string; truncated: boolean;
}
```

Query: `from`, `to` (ISO with offset), `timeZone` (IANA, required), `all` (`"true" | "false"`),
`taskId` (optional). Errors: `validation_failed` for a bad range (`from >= to`, > 43 days, > 2 days
with `taskId`), `forbidden` for `all` without `schedules.manage`, `schedule.not_found` for a
`taskId` the caller may not see.

---

## Task 1: `ticksIn` and the scanner parity test

**Files:** `packages/kernel/src/schedules/schedule-math.ts`, `packages/kernel/test/schedules/schedule-math.test.ts`.

- [ ] Export `ticksIn(t: ScheduleTrigger, after: Date, until: Date, max: number): { ticks: Date[]; exhausted: boolean }`
  built on the private `ticker(t)` (the same closure `nextTick` and `dueTicks` use): the ticks in
  `(after, until]`, at most `max`; `exhausted` true when `max` stopped it. A `once` trigger yields
  its one tick when inside the window.
- [ ] Tests: `ticksIn` equals repeated `nextTick`; a parity test that simulates the scanner
  (`dueTicks` + `nextTick` as `scan.job.ts` calls them, jitter applied, minute by minute or by
  jumping to each `next_run_at`) over a 10-day window per case and asserts the fired ticks equal
  `ticksIn`'s, for: daily 09:00 and hourly in `Asia/Shanghai`, `America/New_York` and
  `Europe/London` across their DST changes (02:30 daily in New York on the spring-forward day
  fires nothing that day; 01:30 on the fall-back day fires once), weekly, `*/15`, `once` inside a
  gap, and a task with `expires_at` inside the window.
- [ ] Commit: `feat(kernel): ticksIn from the scheduler's own ticker`.

## Task 2: the calendar read, route and Platform operation

**Files:** new `packages/kernel/src/schedules/calendar.ts` (constants, types, the pure assembly:
occurrences, dedupe, collapse, cut), `scheduled-tasks.service.ts` (`calendar()` method: role,
reads, redaction), `schedules.schemas.ts` (`ScheduleCalendarQuery` + DTO + `SCHEDULE_ROUTES`
entry), `schedules.controller.ts` (`@Get("calendar")` declared before `@Get(":id")`),
`platform/ops/schedules.ops.ts` (`schedules.calendar`), tests
`packages/kernel/test/schedules/calendar.test.ts` (pure assembly) and additions to
`service.test.ts` / `schedules-reads.http.test.ts`; `.changeset/schedules-calendar-kernel.md`.

- [ ] Role and scope as `list()`: `org.read` route, the service's `liveRole`; `all` needs
  `schedules.manage` (`forbidden`). `taskId`: the task must be one the caller may see (own, or any
  for an admin) else `schedule.not_found`.
- [ ] Runs: `scheduled_task_runs` of the selected live tasks (`deleted_at IS NULL`),
  `scheduled_for` in `[from, to)`, trial included. Redaction (spec §5.1, §15 Q3): for a task whose
  `account_id` is not the caller, `conversationId`, `error` and `missingGrants` are `null`.
  `missingGrants` is the array length for own runs.
- [ ] Occurrences (spec §5.2): only `active` tasks, none when the org's
  `scheduledTasks.enabled` is false (`effectiveScheduleSettings`). Start at
  `nextRunAt - jitterSeconds`; that tick itself is included; then `ticksIn` up to
  `min(to, now + 42 days, expiresAt)`. A tick older than `now - catchUpWindowMinutes` is dropped; a
  tick with a run row (any status, non-trial) is not repeated. `at = scheduledFor + jitter`.
- [ ] Collapse (spec §5.4): per task and local day of `timeZone`, more than 6 items (runs +
  occurrences) become one `CalendarCollapsed`; never with `taskId`.
- [ ] Cut (spec §5.5): walk local days in order; a day is added whole; when adding the next day
  would pass 20,000 tick evaluations or 3,000 entries (`items.length + collapsed.length`), stop,
  set `truncated` and `horizon` to the start of that day. Count tick evaluations through
  `ticksIn`'s `max`.
- [ ] `tasks` holds every task an entry names. Answer ordered by `scheduledFor`, then `taskId`.
- [ ] Platform op `schedules.calendar`: `confirm: "read"`, `authz: { orgAction: "org.read" }`,
  `mirrors: ["GET /api/v1/orgs/:orgId/schedules/calendar"]`, input the route's query schema,
  output with `tasks` trimmed to `{ id, name, agentId, status }`; errors with `next` hints. The
  description of spec §5.6.
- [ ] Tests: member own only; member `all` → 403; admin `all` sees others with the three fields
  null; guest creator reads own; deleted task hidden; paused / ended: runs, no occurrences; org off:
  no occurrences; first occurrence = `nextRunAt - jitter`; a due unrecorded tick stays, one older
  than the catch-up window does not; a recorded pending tick not duplicated; `0 * * * *` collapses,
  `0 8,12,18 * * *` does not, `taskId` never collapses; a cut at a whole day with `truncated`
  (lower the constants through an exported test seam or a parameter of the pure function, not
  env); range validation; HTTP route through `schedules-reads.http.test.ts`; `platform-parity`
  and `pnpm check:platform-ops` pass.
- [ ] Commit: `feat(kernel): scheduled task calendar read and schedules.calendar`.

**Review:** Tasks 1–2 alone on the most capable model: scheduler parity (every place the calendar
could disagree with `scan.job.ts`) and permissions / redaction. Then PR, CI, merge.

## Task 3: `ScheduleCalendar` (design)

**Files:** `docs/design/spec.md` (§6.40 with the paragraph, `<!-- states: schedule-calendar -->`,
`<!-- size-table: schedule-calendar -->`), `docs/design/tokens.json` (+ `pnpm gen:tokens`: the
four `layout.calendar-*` sizes of spec §6.2 and the `contrast` pairs `fail` on `selected`, `ink`
and `muted` on `hover` where missing), `packages/design/src/display/schedule-calendar.tsx`
(exported from `display/index.ts`), `packages/design/src/styles/display.css` (or a new
`schedule-calendar.css` imported in `layer(design)`), `packages/design/src/i18n.ts`,
`packages/design/src/fixtures/index.ts`, `packages/design/test/schedule-calendar.test.tsx`,
`docs/design/reference/src/schedule-calendar.html` (+ `index.html`, `reference.css`),
`apps/web/src/dev/catalog/schedule-calendar-blocks.tsx`, `reference-blocks.tsx`, `routes.tsx`,
`apps/web/reference/render.spec.ts`, `apps/web/visual/accepted.ts`,
`.changeset/schedule-calendar-design.md`. Pattern: commit `1c8fd1204` (TrendChart).

- [ ] Props exactly as spec §6.1 (`range: "week" | "month" | "agenda"`, `days`, `today`, `now`,
  `timeZone`, `items`, `collapsed`, `selectedId`, `onSelect`, `onNavigate`, `onRange`,
  `rangeLabel`, `scope?`, `footnote?`, `loading?`, `empty?`, `error?`, plus `notLoadedFrom?: string`
  for a cut, spec §5.5). The component reads no clock and no zone.
- [ ] Week (§4.3): Monday-first headers, 0–24 axis with `muted` labels, now line (accent, 1 px,
  `aria-hidden`), blocks at `minute` with the fixed half-hour height, up to three side by side
  then 「+N」 (a Popover of buttons), the collapsed lane, vertical scroll inside the box, scrolled
  to 07:00 or an hour before the earliest item. Month (§4.4): 6 × 7 cells, three lines then
  「+N 项」 Popover, the day number a button (`onDay?(day)`). Agenda (§7): day buttons row (40 px)
  and the selected day's rows (40 px); the component draws grid and agenda and CSS shows one
  below 640 (`range="agenda"` forces the agenda at every width).
- [ ] States (§6.2): the item-state table with existing color tokens only; selected block 1 px
  `line-strong`; `forced-colors` rules.
- [ ] Keyboard and a11y (§6.3): roving tabindex, the keys, full labels from `label`, the polite live
  region with `rangeLabel`.
- [ ] Loading (skeleton blocks, `aria-busy`), `empty` (`EmptyState` style `panel` over the grid
  body), `error` (load-failed line with 重试).
- [ ] Reference states `week`, `week-dense`, `month`, `agenda`, `loading`, `empty`, `failed`,
  `selected`, dark and light, with matching `/dev/ui` `RefBlock`s; size table rows use the new
  tokens.
- [ ] jsdom tests: each state, keys, labels, live region, `findNestedBoxes` empty, no color literal.
- [ ] `pnpm check:tokens`, `pnpm check:web-ui`, `pnpm vitest run --project design`.
- [ ] Commit: `feat(design): ScheduleCalendar`. PR; then
  `gh workflow run 397190212 --ref main -f branch=feat/schedules-calendar-design` (reference-update),
  then `gh workflow run 388429628 --ref main -f branch=feat/schedules-calendar-design`
  (visual-update); after each bot commit, pull and push an empty `ci:` commit to rerun CI. Compare
  (`COMPARE=schedule-calendar`) against the rendered references and fix severe / moderate
  differences before merging.

## Task 4: the web page

**Files:** `apps/web/src/lib/schedules.ts` (types + `getScheduleCalendar`), new
`apps/web/src/lib/schedule-calendar.ts` (pure: range bounds per `range` + `date` + zone, item
placement, labels, collapsed labels from the trigger, the cookie value), `lib/query/keys.ts`
(`scheduleCalendar` under `schedulesAll()`), `lib/query/schedules.ts` (`scheduleCalendarQuery`),
`lib/query/routes.ts` (`/schedules` entry), `app/(app)/schedules/page.tsx` (reads `searchParams`
and the `cap_schedules_view` cookie, passes the effective view), `app/(app)/schedules/view.tsx`
(tabs 列表 / 日历, the calendar, the Sheet), a new `components/ScheduleCalendarView.tsx` and
`components/ScheduleRunSheet.tsx`, `apps/web/messages/{zh,en}.json` (`schedules.calendar.*`),
tests `apps/web/test/schedule-calendar-lib.test.ts` and `apps/web/test/schedules-calendar.test.tsx`,
`apps/web/visual/*` (a calendar page spec and an interaction / JS-off phone case),
`.changeset/schedules-calendar-web.md`.

- [ ] Tabs, URL and cookie (§4.1): `?view=calendar&range=&date=&scope=`; `router.replace` on
  change; the cookie written on each change (`SameSite=Lax`, a year, path `/`); `scope=all` only
  for admins (`useWorkspace` role), never remembered.
- [ ] Reads (§9): `scheduleCalendarQuery` with `placeholderData: keepPreviousData`, freshness
  `live`, `refetchInterval` 60 s while the range holds now; the route entry prefetches the
  calendar when the view is the calendar and the server knows the zone (`cb-tz`), else nothing.
- [ ] Panel (§4.5): `Sheet` 480 with the hash (`#run=`, `#at=`, `#day=`); regions as spec; 打开会话
  only when `conversationId` is present; 打开任务 `LinkButton`; the collapsed day list reads the
  calendar with `taskId` and a one-day range.
- [ ] States (§8): loading, page empty, range empty with 跳到下一次运行, all paused, org off
  callout, truncated callout, range error line.
- [ ] i18n zh + en (§10); `pnpm check:i18n`.
- [ ] Tests (§12 web): the lib across a viewer DST day and a task in another zone; first render from
  the hydrated cache makes no browser read; empty cache shows loading then data; cookie restores the
  calendar; tabs switch without a read; prev / next change the key; a pause invalidates the
  calendar; the Sheet opens from the hash; admin scope; a member sees no scope control.
- [ ] Visual: page baselines for week, month, admin, the Sheet and the 390 agenda (dark and light)
  through `visual-update` (`388429628`) on the branch; an interaction case for the keyboard path;
  a JS-off phone case for no horizontal scroll.
- [ ] Commit: `feat(web): scheduled tasks calendar`. PR `Closes #209`; final review on the most
  capable model; CI; merge.
