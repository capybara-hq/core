"use client";

import { ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useContext, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { type Agent, avatarValue } from "../lib/agents";
import { modelLabel } from "../lib/extension-label";
import { canUpdateOrg } from "../lib/org-settings";
import { ReassignOwnerDialog } from "./ReassignOwnerDialog";
import { navLevelOf } from "./shell/nav";
import { SessionContext } from "./shell/session";

export type AgentScope = "all" | "mine" | "shared";

/** Whether the agent belongs to the "mine" / "shared" tab (the kernel decides who can see what). */
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
 * One agent as an object row: mark, name (links to the edit page for the owner and org admins),
 * scope chip, a meta line (model, skills, tools) and the row action "Start conversation", which opens a new
 * conversation with that agent picked (`/chat?agent=`, created on the first send). The API returns
 * no last-use time, so there is no trailing text.
 */
export function AgentRow({ agent }: { agent: Agent }) {
  const t = useTranslations("agents");
  const router = useRouter();
  const session = useContext(SessionContext);
  const [reassigning, setReassigning] = useState(false);
  // The kernel lets the owner (agents.create: members up) or an org admin change an agent;
  // 更换负责人 is agents.manage (org admins).
  const admin = session !== null && canUpdateOrg(session.me);
  const canEdit =
    session !== null &&
    navLevelOf(session.me) !== "guest" &&
    (agent.ownerAccountId === session.me.account.id || admin);
  const def = agent.definition;
  const skills = def.skills?.orgSkills.length ?? 0;
  const tools = def.tools?.length ?? 0;
  // Visibility is plain metadata (mono muted meta text), never a chip.
  const meta = [
    t(`scope.${agent.visibility}`),
    // The list has no providers list (it would cost a vendor call): the provider id stands in.
    modelLabel({ name: def.model.provider }, def.model.model, "en"),
    ...(skills > 0 ? [t("meta.skills", { n: skills })] : []),
    ...(tools > 0 ? [t("meta.tools", { n: tools })] : []),
  ].join(" · ");
  const editHref = `/agents/${encodeURIComponent(agent.id)}`;
  const start = () => router.push(`/chat?agent=${encodeURIComponent(agent.id)}`);
  return (
    <>
      <ObjectRow
        mark={{ text: def.name, avatar: avatarValue(agent, agent.orgId) }}
        name={def.name}
        {...(canEdit ? { href: editHref } : {})}
        meta={meta}
        action={{ label: t("chat"), onSelect: start }}
        // The row action starts a conversation and the name already opens the edit page, so the
        // menu repeats neither (spec §6.7): it holds only 更换负责人, for org admins.
        menu={admin ? [{ label: t("reassign.action"), onSelect: () => setReassigning(true) }] : []}
      />
      {reassigning ? (
        <ReassignOwnerDialog
          orgId={agent.orgId}
          agentId={agent.id}
          ownerAccountId={agent.ownerAccountId}
          needsReassignment={agent.needsReassignment === true}
          onClose={() => setReassigning(false)}
        />
      ) : null}
    </>
  );
}
