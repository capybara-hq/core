"use client";

import { ObjectCard } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type Agent, avatarValue } from "../lib/agents";
import { modelLabel } from "../lib/extension-label";
import { canEditAgent, canUpdateOrg } from "../lib/org-settings";
import { newConversationPath } from "../lib/routes";
import type { Me } from "../lib/session";
import { SaveAsTemplateDialog } from "./SaveAsTemplateDialog";
import { navLevelOf } from "./shell/nav";

export type AgentScope = "all" | "mine" | "shared";

/** Whether the agent belongs to the "mine" / "shared" filter (the kernel decides who can see what). */
export function inScope(a: Agent, scope: AgentScope, accountId: string | undefined): boolean {
  if (scope === "mine") return a.ownerAccountId === accountId;
  if (scope === "shared") return a.visibility !== "private";
  return true;
}

/** Name or model matches the search text (case-insensitive). */
export function matchesAgent(a: Agent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  // The definition stores only the provider id, so the search matches the id.
  const model = modelLabel({ name: a.definition.model.provider }, a.definition.model.model, "en");
  return `${a.definition.name} ${model}`.toLowerCase().includes(q);
}

/**
 * One agent as a card (rulings P4-15, P4-16): avatar, name (the whole card opens the agent's page,
 * read-only for whoever may only use it), the description, the meta line owner · 可见范围, the
 * primary 开始会话 (`/?agent=`, a new conversation with that agent picked, created on the first
 * send) and the ⋯ menu as the agent page's: 设置 (whoever may change it), 运行记录 (org admins, and
 * a member who owns it). The owner is changed on the agent page only, never from the list
 * (acceptance item P; ruling P4-16 as amended). 另存为模板 (org admins, ruling P4-9) opens the
 * agent page's dialog.
 * `ownerName` is the owner's display name when the members list is readable (members up).
 */
export function AgentCard({
  agent,
  me,
  ownerName,
}: {
  agent: Agent;
  me: Me;
  ownerName: string | undefined;
}) {
  const t = useTranslations("agents");
  const [saving, setSaving] = useState(false);
  const level = navLevelOf(me);
  const mine = agent.ownerAccountId === me.account.id;
  const editable = canEditAgent(me, agent);
  // As the agent page: its run history for org admins and for a member who owns it
  const canViewRuns = editable && (level === "admin" || (level === "member" && mine));
  const name = agent.definition.name;
  const page = `/agents/${encodeURIComponent(agent.id)}`;
  const owner = mine ? t("ownerMe") : ownerName;
  const description = agent.profile.description;
  return (
    <>
      <ObjectCard
        avatar={avatarValue(agent, agent.orgId)}
        title={name}
        href={page}
        {...(description !== "" ? { description } : {})}
        // Visibility is plain metadata, never a chip; the owner only when it can be named
        meta={[...(owner !== undefined ? [owner] : []), t(`scope.${agent.visibility}`)]}
        primary={{ label: t("chat"), href: newConversationPath(agent.id) }}
        menu={[
          ...(editable ? [{ label: t("settings"), href: page }] : []),
          ...(canViewRuns
            ? [
                {
                  label: t("runHistory"),
                  href: `/trajectories?agentId=${encodeURIComponent(agent.id)}`,
                },
              ]
            : []),
          ...(canUpdateOrg(me)
            ? [{ label: t("saveAs.action"), onSelect: () => setSaving(true) }]
            : []),
        ]}
      />
      {saving ? (
        <SaveAsTemplateDialog orgId={agent.orgId} agent={agent} onClose={() => setSaving(false)} />
      ) : null}
    </>
  );
}
