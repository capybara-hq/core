import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { conversationTree } from "./tree.js";

/**
 * One agent of a conversation tree as the agent map shows it (agent map spec §8, §9.2): the root
 * conversation or a sub-agent at any depth.
 */
export interface AgentTreeNode {
  /** The conversation's id (a sub-agent's is its child conversation's). */
  id: string;
  /** A sub-agent's dispatched description; the root's title ("" before it has one). */
  description: string;
  /**
   * The sub-agent type (`conversations.subagent_type`, set at the first dispatch); null for the
   * root, and for a sub-agent row that has none (the column is nullable; no sentinel is invented).
   */
  agentType: string | null;
  /**
   * The latest run's status; `idle` when no run is active and the latest run completed (or the
   * conversation has no run yet).
   */
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" | "idle";
  /** The model of the latest run (a queued sub-agent's: the dispatched one); null when unknown. */
  model: { provider: string; model: string } | null;
  /** The first run's start; null until a run started. */
  startedAt: string | null;
  /** The latest run's end; null while a run is active or before any run ended. */
  finishedAt: string | null;
  /** The wall time of the conversation's own runs, summed (a running run up to now). */
  durationMs: number;
  /** The tokens of the conversation's own runs (`usage` events with a run; never descendants'). */
  tokens: number;
  /** The tool calls of the conversation's own runs (its `tool_result` events). */
  toolCalls: number;
  /** The sub-agents it dispatched, oldest first. */
  children: AgentTreeNode[];
}

const ACTIVE = new Set(["queued", "running", "waiting"]);

interface NodeRow {
  id: string;
  parent_conversation_id: string | null;
  subagent_type: string | null;
  title: string | null;
  description: string | null;
  last_status: AgentTreeNode["status"] | null;
  last_finished_at: Date | null;
  started_at: Date | null;
  duration_ms: string;
  run_model: { provider: string; model: string } | null;
  dispatched_model: { provider: string; model: string } | null;
  tool_calls: string;
  tokens: string;
}

/**
 * The agent tree of the root conversation `rootId` of org `orgId`: null when it is not a root
 * chat conversation of that org. The tree's ids come from {@link conversationTree} (one recursive
 * query); one more query reads every node's numbers. A deleted conversation, and a sub-agent
 * conversation without a dispatch row, is left out with its subtree. Call only after an access
 * check of the root.
 */
export async function readAgentTree(
  db: KernelSchemaDb,
  orgId: string,
  rootId: string,
): Promise<AgentTreeNode | null> {
  const ids = (await conversationTree(db, rootId)).map((t) => t.id);
  if (ids.length === 0) return null;
  const { rows } = await sql<NodeRow>`
    SELECT c.id, c.parent_conversation_id, c.subagent_type, c.title,
      (SELECT e.payload->>'description' FROM capybara.conversation_events e
        WHERE e.conversation_id = c.parent_conversation_id AND e.type = 'subagent_dispatched'
          AND e.payload->>'subagentId' = c.id
        ORDER BY e.seq DESC LIMIT 1) AS description,
      (SELECT e.payload->'model' FROM capybara.conversation_events e
        WHERE e.conversation_id = c.parent_conversation_id AND e.type = 'subagent_dispatched'
          AND e.payload->>'subagentId' = c.id
        ORDER BY e.seq DESC LIMIT 1) AS dispatched_model,
      (SELECT e.payload->'model' FROM capybara.conversation_events e
        WHERE e.conversation_id = c.id AND e.type = 'run_started'
        ORDER BY e.seq DESC LIMIT 1) AS run_model,
      latest.status AS last_status, latest.finished_at AS last_finished_at,
      runs.started_at, runs.duration_ms,
      (SELECT count(*) FROM capybara.conversation_events e
        WHERE e.conversation_id = c.id AND e.type = 'tool_result') AS tool_calls,
      (SELECT coalesce(sum(
          coalesce((e.payload->>'inputTokens')::bigint, 0)
          + coalesce((e.payload->>'outputTokens')::bigint, 0)
          + coalesce((e.payload->>'cacheReadTokens')::bigint, 0)
          + coalesce((e.payload->>'cacheWriteTokens')::bigint, 0)
        ), 0)
        FROM capybara.conversation_events e
        WHERE e.conversation_id = c.id AND e.type = 'usage' AND e.run_id IS NOT NULL) AS tokens
    FROM capybara.conversations c
    LEFT JOIN LATERAL (
      SELECT r.status, r.finished_at FROM capybara.runs r
      WHERE r.conversation_id = c.id
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1
    ) latest ON true
    CROSS JOIN LATERAL (
      SELECT min(r.started_at) AS started_at,
        coalesce(sum(floor(extract(epoch FROM coalesce(r.finished_at, now()) - r.started_at) * 1000))
          FILTER (WHERE r.started_at IS NOT NULL), 0)::bigint AS duration_ms
      FROM capybara.runs r WHERE r.conversation_id = c.id
    ) runs
    WHERE c.id IN (${sql.join(ids)}) AND c.org_id = ${orgId} AND c.deleted_at IS NULL
      AND (
        (c.id = ${rootId} AND c.kind = 'chat' AND c.parent_conversation_id IS NULL)
        OR (c.id <> ${rootId} AND c.kind = 'subagent' AND EXISTS (
          SELECT 1 FROM capybara.subagent_dispatches sd WHERE sd.child_conversation_id = c.id
        ))
      )
    ORDER BY c.created_at, c.id
  `.execute(db);
  const nodes = new Map<string, AgentTreeNode>();
  for (const r of rows) nodes.set(r.id, toNode(r, r.id === rootId));
  for (const r of rows) {
    if (r.id === rootId || r.parent_conversation_id === null) continue;
    const node = nodes.get(r.id);
    const parent = nodes.get(r.parent_conversation_id);
    if (node && parent) parent.children.push(node);
  }
  return nodes.get(rootId) ?? null;
}

function toNode(r: NodeRow, isRoot: boolean): AgentTreeNode {
  const active = r.last_status !== null && ACTIVE.has(r.last_status);
  const status: AgentTreeNode["status"] =
    r.last_status === null || r.last_status === "completed" ? "idle" : r.last_status;
  return {
    id: r.id,
    description: (isRoot ? r.title : (r.description ?? r.title)) ?? "",
    agentType: isRoot ? null : r.subagent_type,
    status,
    model: modelOf(r.run_model ?? r.dispatched_model),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: active ? null : (r.last_finished_at?.toISOString() ?? null),
    durationMs: Number(r.duration_ms),
    tokens: Number(r.tokens),
    toolCalls: Number(r.tool_calls),
    children: [],
  };
}

const modelOf = (m: { provider: string; model: string } | null): AgentTreeNode["model"] =>
  m ? { provider: m.provider, model: m.model } : null;
