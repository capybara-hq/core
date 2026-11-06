"use client";

import {
  type AgentMapBackground,
  AgentMapDialog,
  type AgentMapNode,
  type AgentMapStatus,
  AgentMapTree,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import type { ProviderModels } from "../../lib/agents";
import type { AgentTreeNode, BackgroundTaskView } from "../../lib/conversations";
import { modelLabel } from "../../lib/extension-label";
import { targetName } from "../../lib/models";
import { retryOnMountOf } from "../../lib/query/client";
import { modelsQuery } from "../../lib/query/conversation";
import type { RightTarget } from "../../lib/right-area";
import { FormError } from "../form-error";
import { taskItem } from "./BackgroundSection";

/** A tree status as the map's dot: a finished agent is completed, a queued one already works. */
function statusOf(s: AgentTreeNode["status"]): AgentMapStatus {
  switch (s) {
    case "idle":
    case "completed":
      return "completed";
    case "queued":
    case "running":
      return "running";
    case "waiting":
    case "failed":
    case "aborted":
      return s;
  }
}

/**
 * The agent tree (`GET …/agent-tree`) as the map's nodes (agent map spec §9.2): `idle` reads as
 * completed, the model as `provider / model` (with the providers' display names when given), an
 * untitled root as `untitled`.
 */
export function agentTreeNodes(
  tree: AgentTreeNode,
  locale: "zh" | "en",
  opts: { untitled?: string; providers?: ProviderModels[] | undefined } = {},
): AgentMapNode {
  const model = (m: AgentTreeNode["model"]) =>
    m === null
      ? "—"
      : opts.providers
        ? targetName(opts.providers, m, locale)
        : modelLabel({ name: m.provider }, m.model, locale);
  const walk = (n: AgentTreeNode, root: boolean): AgentMapNode => ({
    id: n.id,
    description: root && n.description === "" ? (opts.untitled ?? "") : n.description,
    model: model(n.model),
    durationMs: n.durationMs,
    tokens: n.tokens,
    status: statusOf(n.status),
    children: n.children.map((c) => walk(c, false)),
  });
  return walk(tree, true);
}

const NO_TASKS: AgentMapBackground[] = [];
const NONE_STOPPING: ReadonlySet<string> = new Set();

/**
 * The agent map dialog of a root conversation (agent map spec §9), opened by the `#agents…`
 * hash: level 1 is the tree with the root's own background tasks under its column; a node opens
 * that agent (`#agents=<id>`, levels 2 and 3 come with Task C2, which until then show the tree with
 * the node selected). Closing it clears the hash.
 */
export function AgentMap({
  orgId,
  target,
  root,
  failed,
  tasks,
  untitled,
  onNavigate,
}: {
  orgId: string;
  target: Extract<RightTarget, { kind: "agents" }>;
  /** The tree; undefined while it loads (nothing is drawn yet). */
  root: AgentTreeNode | undefined;
  /** The tree's read failed (and nothing is cached). */
  failed: boolean;
  /** The background tasks of the conversation and its sub-agents (the root's are drawn). */
  tasks: readonly BackgroundTaskView[] | undefined;
  /** The root's name while the conversation has no title. */
  untitled: string;
  onNavigate(t: RightTarget | null): void;
}) {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const modelsQ = modelsQuery(orgId);
  const providers = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data
    ?.providers;
  const nodes = useMemo(
    () => (root ? agentTreeNodes(root, locale, { untitled, providers }) : undefined),
    [root, locale, untitled, providers],
  );
  const background = useMemo(
    () =>
      tasks
        ? tasks.filter((t) => t.subagentId === null).map((t) => taskItem(t, NONE_STOPPING))
        : NO_TASKS,
    [tasks],
  );
  return (
    <AgentMapDialog
      open
      level="tree"
      onOpenChange={(open) => {
        if (!open) onNavigate(null);
      }}
    >
      {nodes ? (
        <AgentMapTree
          root={nodes}
          background={background}
          {...(target.id !== undefined ? { selectedId: target.id } : {})}
          onOpen={(id) => onNavigate({ kind: "agents", id })}
        />
      ) : failed ? (
        <FormError message={t("agentMapFailed")} />
      ) : null}
    </AgentMapDialog>
  );
}
