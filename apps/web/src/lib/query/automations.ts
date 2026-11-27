import {
  type CalendarParams,
  getAutomation,
  getAutomationCalendar,
  listAutomationGrants,
  listAutomationRuns,
  listAutomations,
  listChatTargets,
  listConversationAutomations,
  listEventSources,
  listGrantableTools,
} from "../automations";
import { listConversations } from "../conversations";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** My automations (`all`: every task of the org; org admins, `/settings/automations`). */
export const automationsQuery = (orgId: string, scope: "mine" | "all" = "mine") =>
  defineQuery({
    key: keys.org(orgId).automations(scope),
    fn: () => listAutomations(orgId, scope === "all"),
    freshness: "live",
  });

/**
 * A calendar range of my runs and planned occurrences (`all`: the org's, org admins). Under the
 * `automationsAll()` prefix, so a pause, resume, run, edit or delete refreshes it.
 */
export const automationCalendarQuery = (orgId: string, p: CalendarParams) =>
  defineQuery({
    key: keys
      .org(orgId)
      .automationCalendar(p.all ? "all" : "mine", p.from, p.to, p.timeZone, p.taskId),
    fn: () => getAutomationCalendar(orgId, p),
    freshness: "live",
  });

/** One task (a 404 is the page's not-found). */
export const automationQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).automation(id),
    fn: () => getAutomation(orgId, id),
    freshness: "live",
  });

/** A task's latest runs (a section of the task page). */
export const automationRunsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).automationRuns(id),
    fn: () => listAutomationRuns(orgId, id),
    freshness: "live",
  });

/** A task's approved tools (a section of the task page). */
export const automationGrantsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).automationGrants(id),
    fn: () => listAutomationGrants(orgId, id),
    freshness: "live",
  });

/** My conversations with an agent: the targets a `conversation`-mode task can post into. */
export const automationTargetsQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).automationTargets(agentId),
    fn: () => listConversations(orgId, { agentId, limit: 50 }),
    freshness: "live",
  });

/** The chats a `chat` task of mine can post into (the task form's chat picker). */
export const chatTargetsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).automationChatTargets(),
    fn: () => listChatTargets(orgId),
    freshness: "live",
  });

/** An agent's tools, each grantable in advance or why not (the approved-tools picker). */
export const grantableToolsQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).automationGrantable(agentId),
    fn: () => listGrantableTools(orgId, agentId),
    freshness: "orgConfig",
  });

/** My tasks that post into a conversation (the properties panel's Automations section). */
export const conversationAutomationsQuery = (orgId: string, conversationId: string) =>
  defineQuery({
    key: keys.org(orgId).conversationAutomations(conversationId),
    fn: () => listConversationAutomations(orgId, conversationId),
    freshness: "live",
  });

/** The trigger sources that serve the org with their event declarations (the event trigger form). */
export const eventSourcesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).automationEventSources(),
    fn: () => listEventSources(orgId),
    freshness: "orgConfig",
  });
