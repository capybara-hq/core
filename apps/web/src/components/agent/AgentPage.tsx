"use client";

import {
  Avatar,
  Button,
  Dialog,
  type PageHeaderProps,
  SettingsPage,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { type Agent, avatarValue } from "../../lib/agents";
import { canUpdateOrg } from "../../lib/org-settings";
import { newConversationPath } from "../../lib/routes";
import { ExtensionSlot } from "../extension-ui/ExtensionSlot";
import { ReassignOwnerDialog } from "../ReassignOwnerDialog";
import { SaveAsTemplateDialog } from "../SaveAsTemplateDialog";
import { navLevelOf } from "../shell/nav";
import { usePagePath } from "../shell/path";
import { useSession } from "../shell/session";
import { AttributionSection } from "./AttributionSection";
import { BasicsSection } from "./BasicsSection";
import { ChannelsSection } from "./ChannelsSection";
import {
  AgentPageContext,
  type AgentPageValue,
  useAgentPage,
  useExtSections,
  useSectionNav,
} from "./frame";
import { ModelSection } from "./ModelSection";
import { PromptSection } from "./PromptSection";
import { QuickActionsSection } from "./QuickActionsSection";
import { SkillsSection } from "./SkillsSection";
import { SubagentsSection } from "./SubagentsSection";
import { type AgentSectionId, extSectionId, sectionOf } from "./sections";
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
 * everyone, then a ⋯ menu with 运行记录 for the owner and org admins and 更改所有者 for org
 * admins), the section nav, and the open
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
  const ext = useExtSections(orgId);
  const open = sectionOf(section, editable, ext);
  const nav = useSectionNav(orgId, agent.id, editable);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
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
    // 开始对话 is the primary; 运行记录, 更改所有者 and 另存为模板 (agents.manage: org admins only) share the ⋯
    // menu beside it (a lone one is a button: no menu of one)
    actions: [
      {
        label: t("common.moreActions"),
        menu: [
          ...(canViewRuns
            ? [
                {
                  label: t("agents.runHistory"),
                  href: `/trajectories?agentId=${encodeURIComponent(agent.id)}`,
                },
              ]
            : []),
          ...(admin
            ? [
                { label: t("agents.page.reassign"), onSelect: () => setReassigning(true) },
                // 另存为模板 (agents.manage: org admins, ruling P4-9)
                { label: t("agents.saveAs.action"), onSelect: () => setSavingAs(true) },
              ]
            : []),
        ],
      },
      {
        label: t("agents.page.startChat"),
        variant: "primary" as const,
        href: newConversationPath(agent.id),
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
      {savingAs ? (
        <SaveAsTemplateDialog orgId={orgId} agent={agent} onClose={() => setSavingAs(false)} />
      ) : null}
    </AgentPageContext.Provider>
  );
}

/**
 * The open section's body: the section components of agent profile design §3.2. Someone who may
 * not change the agent only reaches basics, quick actions, the model and attribution (`sectionOf`),
 * each of which draws its read-only form for them.
 */
function OpenSection({ section }: { section: AgentSectionId }) {
  if (section.startsWith("ext.")) return <ExtensionSection section={section} />;
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
    case "attribution":
      return <AttributionSection />;
    case "channels":
      return <ChannelsSection />;
    default:
      return <BasicsSection />;
  }
}

/** An extension's section (`agent.detail.section`): its view in the page's frame, with no save bar. */
function ExtensionSection({ section }: { section: AgentSectionId }) {
  const page = useAgentPage();
  const c = useExtSections(page.orgId).find((x) => extSectionId(x) === section);
  return (
    <SettingsPage header={page.header} nav={page.nav} activeNav={section}>
      {c ? (
        <ExtensionSlot
          slot="agent.detail.section"
          args={{ orgId: page.orgId, agentId: page.agent.id }}
          select={{ plugin: c.plugin, id: c.id }}
        />
      ) : null}
    </SettingsPage>
  );
}
