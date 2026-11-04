"use client";

import { Avatar, Button, Dialog, type PageHeaderProps, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { type Agent, avatarValue } from "../../lib/agents";
import { canUpdateOrg } from "../../lib/org-settings";
import { ReassignOwnerDialog } from "../ReassignOwnerDialog";
import { navLevelOf } from "../shell/nav";
import { usePagePath } from "../shell/path";
import { useSession } from "../shell/session";
import { BasicsSection } from "./BasicsSection";
import { AgentPageContext, type AgentPageValue, useAgentPage, useSectionNav } from "./frame";
import { LegacyFormSection } from "./LegacyFormSection";
import { ModelReadOnly } from "./ModelReadOnly";
import { QuickActionsSection } from "./QuickActionsSection";
import { type AgentSection, sectionHref, sectionOf } from "./sections";

export { type AgentPageValue, AgentSectionFrame, useAgentPage } from "./frame";

/** The section a nav link opens, from its `?s=`. */
function linkSection(a: Element): AgentSection | null {
  const href = a.getAttribute("href");
  if (href === null) return null;
  const s = new URL(href, "http://x").searchParams.get("s");
  return s === null ? null : sectionOf(s, true);
}

/**
 * The agent page (agent profile design §3): the head (avatar, name, description; 开始对话 for
 * everyone, 运行记录 and 重新指派负责人 for the owner and org admins), the section nav, and the open
 * section. Leaving a section with unsaved edits through the nav asks to keep or discard them.
 */
export function AgentPage({
  orgId,
  agent,
  section,
  editable,
}: {
  orgId: string;
  agent: Agent;
  section: string | undefined;
  editable: boolean;
}) {
  const scope = usePagePath("org");
  const t = useTranslations();
  const router = useRouter();
  const { me } = useSession();
  const open = sectionOf(section, editable);
  const nav = useSectionNav(agent.id, editable);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<AgentSection | null>(null);
  const [reassigning, setReassigning] = useState(false);
  const describedBy = useId();

  // A nav click while the section holds unsaved edits: held back (before next/link sees it) and
  // asked about; the template's nav links are plain links.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest('[data-part="settings-nav"] a[href]');
      if (!a || a.getAttribute("aria-current") === "page") return;
      const to = linkSection(a);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaving(to);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  const admin = canUpdateOrg(me);
  const level = navLevelOf(me);
  const canViewRuns =
    editable &&
    (level === "admin" || (level === "member" && agent.ownerAccountId === me.account.id));
  const name = agent.definition.name || t("agents.form.editTitle");
  const description = agent.profile.description;
  const header: PageHeaderProps = {
    path: [...scope, { label: "agents", href: "/agents" }, { label: name }],
    title: name,
    ...(description !== "" ? { description } : {}),
    avatar: <Avatar value={avatarValue(agent, orgId)} name={name} size={40} />,
    actions: [
      ...(canViewRuns
        ? [
            {
              label: t("agents.runHistory"),
              variant: "default" as const,
              href: `/trajectories?agentId=${encodeURIComponent(agent.id)}`,
            },
          ]
        : []),
      // agents.manage: org admins only
      ...(admin
        ? [
            {
              label: t("agents.page.reassign"),
              variant: "default" as const,
              onSelect: () => setReassigning(true),
            },
          ]
        : []),
      {
        label: t("agents.page.startChat"),
        variant: "primary" as const,
        href: `/chat?agent=${encodeURIComponent(agent.id)}`,
      },
    ],
  };
  const value: AgentPageValue = {
    orgId,
    agent,
    editable,
    section: open,
    header,
    nav,
    setDirty,
  };
  return (
    <AgentPageContext.Provider value={value}>
      <OpenSection key={open} section={open} />
      {leaving !== null ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setLeaving(null);
          }}
          title={t("agents.page.leave.title")}
          describedBy={describedBy}
          footer={
            <>
              <Button variant="ghost" onClick={() => setLeaving(null)}>
                {t("agents.page.leave.keep")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const to = leaving;
                  setLeaving(null);
                  setDirty(false);
                  router.push(sectionHref(agent.id, to));
                }}
              >
                {t("agents.page.leave.discard")}
              </Button>
            </>
          }
        >
          <span id={describedBy}>
            <Text variant="prose">{t("agents.page.leave.body")}</Text>
          </span>
        </Dialog>
      ) : null}
      {reassigning ? (
        <ReassignOwnerDialog
          orgId={orgId}
          agentId={agent.id}
          ownerAccountId={agent.ownerAccountId}
          needsReassignment={agent.needsReassignment === true}
          onClose={() => setReassigning(false)}
        />
      ) : null}
    </AgentPageContext.Provider>
  );
}

/** The open section's body: the section components of agent profile design §3.2. */
function OpenSection({ section }: { section: AgentSection }) {
  const { editable } = useAgentPage();
  if (section === "basics") return <BasicsSection />;
  if (section === "quick-actions") return <QuickActionsSection />;
  if (!editable) return <ModelReadOnly />;
  return <LegacyFormSection section={section} />;
}
