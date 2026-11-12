"use client";

import { useTranslations } from "next-intl";
import { type CalendarItemState, collapsedWords, weekdayOf } from "../lib/schedule-calendar";
import type { CalendarTask } from "../lib/schedules";

/** 「11月12日 周四」 / "Thursday 11-12" for a day (labels; the design i18n draws the grid's own). */
export function useCalendarDayLabel(): (day: string) => string {
  const t = useTranslations("schedules");
  return (day) => {
    const [, mm = "", dd = ""] = day.split("-");
    // schedules.weekday is Sunday 0 … Saturday 6
    const weekday = t(`weekday.${(weekdayOf(day) + 1) % 7}` as "weekday.0");
    return t("calendar.dayLabel", { m: Number(mm), d: Number(dd), mm, dd, weekday });
  };
}

/** The words of a calendar state and of a run's kind. */
export function useCalendarWords() {
  const t = useTranslations("schedules.calendar");
  return {
    state: (s: CalendarItemState) => t(`state.${s}`),
    collapsedSummary: (task: CalendarTask | undefined, count: number) => {
      const w = task ? collapsedWords(task.trigger) : { key: "runs" as const };
      return t(`collapsed.${w.key}`, { count, n: "n" in w ? w.n : 0 });
    },
  };
}
