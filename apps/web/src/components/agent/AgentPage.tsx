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
import { ChannelsSection } from "./ChannelsSection";
import { AgentPageContext, type AgentPageValue, useSectionNav } from "./frame";
import { ModelSection } from "./ModelSection";
import { PromptSection } from "./PromptSection";
import { QuickActionsSection } from "./QuickActionsSection";
import { SkillsSection } from "./SkillsSection";
import { SubagentsSection } from "./SubagentsSection";
import { type AgentSection, sectionOf } from "./sections";
import { ToolsSection } from "./ToolsSection";

export { type AgentPageValue, AgentSectionFrame, useAgentPage } from "./frame";

/**
 * Where a click on `a` would take the page inside the app, or null when the browser should handle
 * it as it is: a modified or non-primary click (a new tab or window), `target` other than `_self`,
 * a download, another origin, or a link to the page already open (whatever its hash).
 */
export function guardedHref(e: MouseEvent, a: Element): string | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const target = a.getAttribute("target");
  if ((target !== null && target !== "" && target !== "_self") || a.hasAttribute("download")) {
    return null;
  }
  const raw = a.getAttribute("href");
  if (raw === null) return null;
  const here = new URL(window.location.href);
  const url = new URL(raw, here);
  if (url.origin !== here.origin) return null;
  // the same page with another hash (the shell's skip link, an anchor): it leaves nothing
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
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
  const [leaving, setLeaving] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);
  const describedBy = useId();

  // While the section holds unsaved edits, any in-app link (section nav, sidebar, path, the head's
  // links) is held back before next/link sees it and asked about; a modified click (new tab) is
  // left to the browser. Closing or reloading the tab gets the browser's own prompt. Back and
  // forward are not covered (ruling).
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const a = target?.closest("a[href]");
      if (!a || a.closest('[role="dialog"]')) return;
      const to = guardedHref(e, a);
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaving(to);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // older browsers show the prompt only when returnValue is set
      e.returnValue = "";
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onUnload);
    };
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
                  router.push(to);
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

/**
 * The open section's body: the section components of agent profile design §3.2. Someone who may
 * not change the agent only reaches basics, quick actions and the model (`sectionOf`), each of
 * which draws its read-only form for them.
 */
function OpenSection({ section }: { section: AgentSection }) {
  switch (section) {
    case "basics":
      return <BasicsSection />;
    case "quick-actions":
      return <QuickActionsSection />;
    case "prompt":
      return <PromptSection />;
    case "model":
      return <ModelSection />;
    case "tools":
      return <ToolsSection />;
    case "skills":
      return <SkillsSection />;
    case "subagents":
      return <SubagentsSection />;
    case "channels":
      return <ChannelsSection />;
  }
}
