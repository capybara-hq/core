import { listConversations } from "../conversations";
import {
  type CalendarParams,
  getSchedule,
  getScheduleCalendar,
  listChatTargets,
  listConversationSchedules,
  listGrantableTools,
  listScheduleGrants,
  listScheduleRuns,
  listSchedules,
} from "../schedules";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** My scheduled tasks (`all`: every task of the org; org admins, `/settings/schedules`). */
export const schedulesQuery = (orgId: string, scope: "mine" | "all" = "mine") =>
  defineQuery({
    key: keys.org(orgId).schedules(scope),
    fn: () => listSchedules(orgId, scope === "all"),
    freshness: "live",
  });

/**
 * A calendar range of my runs and planned occurrences (`all`: the org's, org admins). Under the
 * `schedulesAll()` prefix, so a pause, resume, run, edit or delete refreshes it.
 */
export const scheduleCalendarQuery = (orgId: string, p: CalendarParams) =>
  defineQuery({
    key: keys
      .org(orgId)
      .scheduleCalendar(p.all ? "all" : "mine", p.from, p.to, p.timeZone, p.taskId),
    fn: () => getScheduleCalendar(orgId, p),
    freshness: "live",
  });

/** One task (a 404 is the page's not-found). */
export const scheduleQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).schedule(id),
    fn: () => getSchedule(orgId, id),
    freshness: "live",
  });

/** A task's latest runs (a section of the task page). */
export const scheduleRunsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).scheduleRuns(id),
    fn: () => listScheduleRuns(orgId, id),
    freshness: "live",
  });

/** A task's approved tools (a section of the task page). */
export const scheduleGrantsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).scheduleGrants(id),
    fn: () => listScheduleGrants(orgId, id),
    freshness: "live",
  });

/** My conversations with an agent: the targets a `conversation`-mode task can post into. */
export const scheduleTargetsQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).scheduleTargets(agentId),
    fn: () => listConversations(orgId, { agentId, limit: 50 }),
    freshness: "live",
  });

/** The chats a `chat` task of mine can post into (the task form's chat picker). */
export const chatTargetsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).scheduleChatTargets(),
    fn: () => listChatTargets(orgId),
    freshness: "live",
  });

/** An agent's tools, each grantable in advance or why not (the approved-tools picker). */
export const grantableToolsQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).scheduleGrantable(agentId),
    fn: () => listGrantableTools(orgId, agentId),
    freshness: "orgConfig",
  });

/** My tasks that post into a conversation (the properties panel's 定时任务 section). */
export const conversationSchedulesQuery = (orgId: string, conversationId: string) =>
  defineQuery({
    key: keys.org(orgId).conversationSchedules(conversationId),
    fn: () => listConversationSchedules(orgId, conversationId),
    freshness: "live",
  });
