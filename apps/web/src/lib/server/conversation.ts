import "server-only";
import { type Agent, listAgents, listModels, type ProviderModels } from "../agents";
import { getSandboxStatus, type SandboxStatus } from "../artifacts";
import { type AttachmentLimits, getAttachmentLimits } from "../attachments";
import { type ConnectorSummary, listConnectors } from "../connectors";
import {
  type Conversation,
  type ConversationEvent,
  type ConversationUsage,
  getConversation,
  getConversationUsage,
  getToolInfo,
  listAllEvents,
  listQueue,
  listSubagents,
  type QueueItem,
  type QueuePauseReason,
  type SubagentView,
  type ToolInfo,
} from "../conversations";
import { type FileOutput, listFiles } from "../files";
import { listMembers } from "../members";
import { type InvocableSkill, listInvocableSkills } from "../skills";
import { toolKeysOf } from "../tool-keys";
import { listUiContributions, type UiContributionItem } from "../ui";
import { optional, read, section } from "./page";

/** The most keys one `GET …/tools?keys=` takes (kernel `TOOL_INFO_MAX_KEYS`). */
const TOOL_BATCH = 100;

export interface QueueSnapshot {
  items: QueueItem[];
  paused: boolean;
  pauseReason?: QueuePauseReason;
}

/**
 * Everything the conversation page paints first (web-SSR spec §6.2), as plain JSON. The
 * conversation, its events, the agents and the models are required (a 404 is the page's
 * not-found). A secondary piece is `null` when the kernel failed or refused it (`section`), a
 * role-dependent one when it refused it (`optional`); the view then draws that section's own error
 * or empty state and never reads it after mount (ruling R5). Live changes read them again.
 */
export interface ConversationSnapshot {
  conversation: Conversation;
  /** Every event, read page by page (500 each, as `listAllEvents` does). */
  events: ConversationEvent[];
  agents: Agent[];
  providers: ProviderModels[];
  queue: QueueSnapshot | null;
  /** The sub-agents, newest first; `null` too when none was dispatched. */
  subagents: SubagentView[] | null;
  /** The tokens with the sub-agents'; `null` too when none was dispatched. */
  usage: ConversationUsage | null;
  /** Display metadata of the tools the events name. */
  tools: { keys: string[]; info: ToolInfo[] } | null;
  /** The extensions' UI contributions (title-bar panels, properties sections, inline cards). */
  contributions: UiContributionItem[] | null;
  /** The conversation's file outputs (the title-bar Files icon, the thread's chips). */
  files: FileOutput[] | null;
  /** The sandbox status (`status: null`: no sandbox) and the sandbox tool results it follows. */
  sandbox: { status: SandboxStatus | null; uses: number } | null;
  /** The org's connectors (names of the connectors used, in the Context section). */
  connectors: ConnectorSummary[] | null;
  /** The agent's invocable skills for the composer's `/` menu. */
  skills: InvocableSkill[] | null;
  limits: AttachmentLimits | null;
  /** Members' display names, only when the log has a run another account stopped. */
  members: { id: string; name: string }[] | null;
}

const dispatched = (events: readonly ConversationEvent[]) =>
  events.some((e) => e.type === "subagent_dispatched");

const sandboxUses = (events: readonly ConversationEvent[]): number =>
  events.filter((e) => e.type === "tool_result" && e.payload.toolKey.startsWith("sandbox_")).length;

async function toolInfo(
  orgId: string,
  id: string,
  keys: string[],
): Promise<{ keys: string[]; info: ToolInfo[] }> {
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += TOOL_BATCH) batches.push(keys.slice(i, i + TOOL_BATCH));
  const answers = await Promise.all(batches.map((b) => getToolInfo(orgId, id, b)));
  return { keys, info: answers.flatMap((a) => a.tools) };
}

/**
 * Reads the conversation page's snapshot: what does not depend on the log in parallel with it,
 * then what the log names (tool info, sub-agents and usage, members) and the agent's skills.
 */
export async function loadConversationSnapshot(
  orgId: string,
  id: string,
  me: { accountId: string },
): Promise<ConversationSnapshot> {
  const [
    { conversation },
    events,
    agents,
    models,
    queue,
    contributions,
    files,
    sandbox,
    connectors,
    limits,
  ] = await Promise.all([
    read(getConversation(orgId, id)),
    read(listAllEvents(orgId, id)),
    read(listAgents(orgId)),
    read(listModels(orgId)),
    section(listQueue(orgId, id)),
    section(listUiContributions(orgId)),
    section(listFiles(orgId, id)),
    section(getSandboxStatus(orgId, id).then((status) => ({ status }))),
    optional(listConnectors(orgId)),
    section(getAttachmentLimits(orgId)),
  ]);
  const withSubagents = dispatched(events);
  const stoppedByOther = events.some(
    (e) =>
      e.type === "run_aborted" &&
      e.payload.byAccountId !== null &&
      e.payload.byAccountId !== me.accountId,
  );
  // The composer lists with the conversation only when it is the caller's (its trial drafts).
  const mine = conversation.accountId === undefined || conversation.accountId === me.accountId;
  const [tools, subagents, usage, skills, members] = await Promise.all([
    section(toolInfo(orgId, id, toolKeysOf(events))),
    withSubagents ? section(listSubagents(orgId, id)) : null,
    withSubagents ? section(getConversationUsage(orgId, id)) : null,
    optional(listInvocableSkills(orgId, conversation.agentId, mine ? id : undefined)),
    stoppedByOther ? optional(listMembers(orgId)) : null,
  ]);
  return {
    conversation,
    events,
    agents: agents.agents,
    providers: models.providers,
    queue:
      queue === null
        ? null
        : {
            items: queue.items,
            paused: queue.paused,
            ...(queue.pauseReason !== undefined ? { pauseReason: queue.pauseReason } : {}),
          },
    subagents: subagents?.subagents ?? null,
    usage: usage?.usage ?? null,
    tools,
    contributions: contributions?.items ?? null,
    files,
    sandbox: sandbox === null ? null : { status: sandbox.status, uses: sandboxUses(events) },
    connectors: connectors?.connectors ?? null,
    skills: skills?.skills ?? null,
    limits,
    members:
      members?.members.map((m) => ({ id: m.account.id, name: m.account.displayName })) ?? null,
  };
}
