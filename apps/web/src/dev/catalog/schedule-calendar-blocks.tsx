import { ScheduleCalendar, type ScheduleCalendarProps } from "@capybara-hq/design";
import { SCHEDULE_CALENDAR_FIXTURE as F } from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// ScheduleCalendar (spec §6.40): the scheduled tasks calendar in its states. The blocks have the
// same ids and boxes as docs/design/reference/src/schedule-calendar.html.

const W = 1120;
const noop = () => {};

function calendar(over: Partial<ScheduleCalendarProps> = {}): ReactNode {
  return (
    <ScheduleCalendar
      range="week"
      days={F.week.days}
      today={F.today}
      now={F.now}
      timeZone={F.timeZone}
      items={F.week.items}
      collapsed={[]}
      rangeLabel={F.week.rangeLabel}
      footnote={F.footnote}
      onSelect={noop}
      onNavigate={noop}
      onRange={noop}
      onDay={noop}
      {...over}
    />
  );
}

function scheduleCalendarBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="schedule-calendar-week" width={W} pad>
        {calendar()}
      </RefBlock>
      <RefBlock id="schedule-calendar-week-dense" width={W} pad>
        {calendar({
          collapsed: F.week.collapsed,
          scope: { value: "all", onChange: noop, labels: F.scope },
        })}
      </RefBlock>
      <RefBlock id="schedule-calendar-month" width={W} pad>
        {calendar({
          range: "month",
          days: F.month.days,
          items: F.month.items,
          collapsed: F.month.collapsed,
          rangeLabel: F.month.rangeLabel,
        })}
      </RefBlock>
      <RefBlock id="schedule-calendar-agenda" width={390} pad>
        {calendar({ range: "agenda", collapsed: F.week.collapsed, day: F.agendaDay })}
      </RefBlock>
      <RefBlock id="schedule-calendar-loading" width={W} pad>
        {calendar({ items: [], loading: true })}
      </RefBlock>
      <RefBlock id="schedule-calendar-empty" width={W} pad>
        {calendar({
          items: [],
          empty: {
            text: F.empty.text,
            hint: F.empty.hint,
            action: { label: F.empty.action, onSelect: noop },
          },
        })}
      </RefBlock>
      <RefBlock id="schedule-calendar-failed" width={W} pad>
        {calendar({ error: { retry: noop, code: F.errorCode } })}
      </RefBlock>
      <RefBlock id="schedule-calendar-selected" width={W} pad>
        {calendar({ selectedId: F.selectedId })}
      </RefBlock>
    </>
  );
}

export const SCHEDULE_CALENDAR_BLOCKS = {
  "schedule-calendar": scheduleCalendarBlocks,
} as const;
