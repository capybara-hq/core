"use client";

import { ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useContext, useState } from "react";
import { useRouter } from "../i18n/navigation";
import type { Agent } from "../lib/agents";
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
  const model = `${a.definition.model.provider} / ${a.definition.model.model}`;
  return `${a.definition.name} ${model}`.toLowerCase().includes(q);
}

/**
 * One agent as an object row: mark, name (links to the edit page for the owner and org admins),
 * scope chip, a meta line (model, skills, tools) and the row action "Chat", which opens a new
 * conversation with that agent picked (`/chat?agent=`, created on the first send). The API returns
 * no last-use time, so there is no trailing text.
 */
export function AgentRow({ agent, onChanged }: { agent: Agent; onChanged?(): void }) {
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
  const meta = [
    `${def.model.provider} / ${def.model.model}`,
    ...(skills > 0 ? [t("meta.skills", { n: skills })] : []),
    ...(tools > 0 ? [t("meta.tools", { n: tools })] : []),
  ].join(" · ");
  const editHref = `/agents/${encodeURIComponent(agent.id)}`;
  const start = () => router.push(`/chat?agent=${encodeURIComponent(agent.id)}`);
  return (
    <>
      <ObjectRow
        mark={{ text: Array.from(def.name)[0] ?? "?" }}
        name={def.name}
        {...(canEdit ? { href: editHref } : {})}
        chips={[{ label: t(`scope.${agent.visibility}`) }]}
        meta={meta}
        action={{ label: t("chat"), onSelect: start }}
        // 对话 is the row action: the menu never repeats it (spec §6.7)
        menu={[
          ...(canEdit ? [{ label: t("edit"), onSelect: () => router.push(editHref) }] : []),
          ...(admin ? [{ label: t("reassign.action"), onSelect: () => setReassigning(true) }] : []),
        ]}
      />
      {reassigning ? (
        <ReassignOwnerDialog
          orgId={agent.orgId}
          agentId={agent.id}
          ownerAccountId={agent.ownerAccountId}
          needsReassignment={agent.needsReassignment === true}
          onClose={() => setReassigning(false)}
          {...(onChanged ? { onDone: onChanged } : {})}
        />
      ) : null}
    </>
  );
}
