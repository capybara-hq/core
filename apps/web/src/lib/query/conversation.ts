import type { QueryClient } from "@tanstack/react-query";
import { listModels } from "../agents";
import { ApiClientError } from "../api";
import { getSandboxStatus } from "../artifacts";
import { getAttachmentLimits } from "../attachments";
import { listConnectors } from "../connectors";
import {
  type ConversationEvent,
  getConversation,
  getConversationUsage,
  getToolInfo,
  listAllEvents,
  listQueue,
  listSubagents,
  type ToolInfo,
} from "../conversations";
import { listFiles } from "../files";
import { listInvocableSkills } from "../skills";
import { listUiContributions } from "../ui";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * The conversation page's reads (web query cache spec §5, §6): the row and the event log, the
 * pieces outside the log (queue, files, sandbox, sub-agents, usage, tool info) and the org's
 * configuration the page shows (models, connectors, contributions, limits, skills).
 */

/** The conversation row (title, agent, selection). */
export const conversationQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).row(),
    fn: () => getConversation(orgId, id).then((r) => r.conversation),
    freshness: "live",
  });

/** Every event of the log, in seq order; the stream appends to it ({@link appendEvents}). */
export const eventsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).events(),
    fn: () => listAllEvents(orgId, id),
    freshness: "events",
  });

/** The queued messages and whether the queue is paused (and why). */
export const queueQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).queue(),
    fn: () =>
      listQueue(orgId, id).then((r) => ({
        items: r.items,
        paused: r.paused,
        ...(r.pauseReason !== undefined ? { pauseReason: r.pauseReason } : {}),
      })),
    freshness: "live",
  });

/** The conversation's file outputs (the kernel's order: newest first by first delivery). */
export const filesQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).files(),
    fn: () => listFiles(orgId, id),
    freshness: "live",
  });

/** The sandbox's status; `null` without a sandbox. */
export const sandboxQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).sandbox(),
    fn: () => getSandboxStatus(orgId, id),
    freshness: "live",
  });

/** The sub-agents, newest first (read once one was dispatched). */
export const subagentsQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).subagents(),
    fn: () => listSubagents(orgId, id).then((r) => r.subagents),
    freshness: "live",
  });

/** The tokens with the sub-agents' (read once one was dispatched). */
export const usageQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).conversation(id).usage(),
    fn: () => getConversationUsage(orgId, id).then((r) => r.usage),
    freshness: "live",
  });

/** The most keys one `GET …/tools?keys=` takes (kernel `TOOL_INFO_MAX_KEYS`). */
const TOOL_BATCH = 100;

/** Display metadata of the tools `toolKeys` name (in batches); the key holds them sorted. */
export const toolInfoQuery = (orgId: string, id: string, toolKeys: readonly string[]) => {
  const sorted = [...toolKeys].sort();
  return defineQuery<ToolInfo[]>({
    key: keys.org(orgId).conversation(id).toolInfo(sorted),
    fn: async () => {
      const batches: string[][] = [];
      for (let i = 0; i < sorted.length; i += TOOL_BATCH)
        batches.push(sorted.slice(i, i + TOOL_BATCH));
      const answers = await Promise.all(batches.map((b) => getToolInfo(orgId, id, b)));
      return answers.flatMap((a) => a.tools);
    },
    freshness: "orgConfig",
  });
};

/**
 * The agent's invocable skills for the composer's `/` menu, with the conversation's trial drafts
 * when `conversationId` is the caller's own. A conversation the caller cannot read lists without it.
 */
export const invocableSkillsQuery = (orgId: string, agentId: string, conversationId?: string) =>
  defineQuery({
    key: keys.org(orgId).invocableSkills(agentId, conversationId ?? null),
    fn: () =>
      listInvocableSkills(orgId, agentId, conversationId)
        .catch((e: unknown) => {
          if (
            conversationId !== undefined &&
            e instanceof ApiClientError &&
            e.code === "conversation.not_found"
          )
            return listInvocableSkills(orgId, agentId);
          throw e;
        })
        .then((r) => r.skills),
    freshness: "orgConfig",
  });

/** The extensions' UI contributions (title-bar panels, properties sections, inline cards). */
export const contributionsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).contributions(),
    fn: () => listUiContributions(orgId).then((r) => r.items),
    freshness: "orgConfig",
  });

/** The org's connectors (`{ connectors }`, as the kernel answers). */
export const connectorsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).connectors(),
    fn: () => listConnectors(orgId),
    freshness: "orgConfig",
  });

/** The attachment limits the composer checks files against. */
export const attachmentLimitsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).attachmentLimits(),
    fn: () => getAttachmentLimits(orgId),
    freshness: "orgConfig",
  });

/** The org's models by provider (`{ providers }`, as the kernel answers). */
export const modelsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).models(),
    fn: () => listModels(orgId),
    freshness: "orgConfig",
  });

/**
 * Merges `events` into the cached log of the conversation by `seq`: none twice, in ascending
 * order. Returns how many were new. Nothing happens while the log is not cached (the stream opens
 * only once it is).
 */
export function appendEvents(
  qc: QueryClient,
  orgId: string,
  id: string,
  events: readonly ConversationEvent[],
): { added: number } {
  let added = 0;
  qc.setQueryData<ConversationEvent[]>(keys.org(orgId).conversation(id).events(), (cur) => {
    if (cur === undefined || events.length === 0) return cur;
    const last = cur.at(-1)?.seq ?? 0;
    const incoming = [...events].sort((a, b) => a.seq - b.seq);
    // The stream's usual case: everything is newer than the log's end.
    if ((incoming[0] as ConversationEvent).seq > last) {
      const fresh = incoming.filter((e, i) => i === 0 || e.seq !== incoming[i - 1]?.seq);
      added = fresh.length;
      return [...cur, ...fresh];
    }
    const seen = new Set(cur.map((e) => e.seq));
    const fresh: ConversationEvent[] = [];
    for (const e of incoming) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      fresh.push(e);
    }
    added = fresh.length;
    if (added === 0) return cur;
    return [...cur, ...fresh].sort((a, b) => a.seq - b.seq);
  });
  return { added };
}

/**
 * What a reopened stream's catch-up makes stale when it delivered events (spec §6, "Returning to
 * a conversation"): the queue, files, sandbox, sub-agents, usage, the row, the tool info and the
 * conversation's extension views. Otherwise they follow their freshness class.
 */
export const CONVERSATION_SIDE_KEYS = (orgId: string, id: string): (readonly unknown[])[] => {
  const c = keys.org(orgId).conversation(id);
  return [
    c.queue(),
    c.files(),
    c.sandbox(),
    c.subagents(),
    c.usage(),
    c.row(),
    c.toolInfoAll(),
    keys.org(orgId).uiViews(id),
  ];
};
