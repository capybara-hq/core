"use client";

import {
  Avatar,
  Button,
  Callout,
  Dialog,
  type HeaderAction,
  type MenuItem,
  type PageHeaderProps,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { definitionOf } from "../../lib/agent-templates";
import {
  type AgentTemplateDetail,
  deleteAgentTemplate,
  setAgentTemplateShareable,
} from "../../lib/agents";
import type { OrgComponent } from "../../lib/components";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { TemplateDeleteDialog } from "../AgentTemplateCards";
import { guardedHref } from "../agent/AgentPage";
import { useComponentSwitch } from "../ComponentSwitch";
import { FormError } from "../form-error";
import { usePagePath } from "../shell/path";
import {
  BasicsEdit,
  ConnectorsEdit,
  ModelEdit,
  PromptEdit,
  QuickActionsEdit,
  SkillsEdit,
  SubagentsEdit,
  ToolsEdit,
} from "./EditSections";
import {
  TemplatePageContext,
  type TemplatePageValue,
  type TemplateSection,
  templateSectionOf,
  useTemplateNav,
} from "./frame";
import { useTemplateSource } from "./labels";
import {
  BasicsRead,
  ConnectorsRead,
  ModelRead,
  PromptRead,
  QuickActionsRead,
  SkillsRead,
  SubagentsRead,
  ToolsRead,
} from "./ReadSections";

/** The breadcrumb's templates segment: the 模板 tab of the 智能体 page (ruling P4-14). */
export const TEMPLATES_TAB_HREF = "/agents?tab=templates";

/**
 * The component the template stands for among the ones offered to the org (on or off): by its id
 * or a linked copy's, else (the owner's promoted template) the plugin-less one of the same name the
 * org owns. Only the switch's 启用 / 停用 read it; whether the template is usable is the detail's.
 */
export const offeredComponentOf = (
  offered: readonly OrgComponent[] | undefined,
  t: { id: string; name: string },
  orgId: string,
): OrgComponent | undefined => {
  const mine = (offered ?? []).filter((c) => c.kind === "agent_template");
  return (
    mine.find((c) => c.id === t.id || (c.linkedIds ?? []).includes(t.id)) ??
    mine.find(
      (c) =>
        c.plugin === null &&
        c.name === t.name &&
        c.owner?.kind === "org" &&
        c.owner.orgId === orgId,
    )
  );
};

/**
 * The template page `/agents/templates/<id>` (rulings P4-12, P4-14): the head (the initial square,
 * the name, the description, source · v; 用它创建 as the primary on a template usable in the org;
 * ⋯ with 设为可共享 / 取消共享 and 删除 for owner-org admins, the org admin's switch on a platform
 * template), the section nav, and the open section: read-only for members, the editor for
 * owner-org admins (each save a new version). A template switched off in the org (only its owner
 * reads it then) carries the 未在本组织启用 notice, with 启用 for org admins. Leaving a section
 * with unsaved edits asks first, as on the agent page.
 */
export function TemplatePage({
  orgId,
  template,
  section,
  admin,
  offered,
  onCreate,
}: {
  orgId: string;
  template: AgentTemplateDetail;
  section: string | undefined;
  admin: boolean;
  offered: readonly OrgComponent[] | undefined;
  /** Opens the 用它创建 dialog (phase 4 Task 8's). */
  onCreate(): void;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("agents.templatePage");
  const tt = useTranslations("agents.templates");
  const tc = useTranslations("common");
  const tl = useTranslations("agents.page.leave");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const source = useTemplateSource();
  const open: TemplateSection = templateSectionOf(section);
  const nav = useTemplateNav(template.id);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const describedBy = useId();
  const editable = admin && template.owned;
  const component = offeredComponentOf(offered, template, orgId);
  // not usable here (only its owner reads it, switched off in its own org): the kernel says so
  const off = template.usable === false;
  const { actionsOf, dialog, error: switchError } = useComponentSwitch({ orgId, admin });
  const switchActions = component !== undefined ? actionsOf(component) : [];
  const enable = switchActions.find((a) => a.id === "enable");
  const k = keys.org(orgId);
  const share = useAppMutation({
    fn: (shareable: boolean) => setAgentTemplateShareable(orgId, template.id, shareable),
    invalidates: () => [k.agentTemplateAll(), k.agentTemplates(), k.componentsAll()],
  });
  const remove = useAppMutation({
    fn: () => deleteAgentTemplate(orgId, template.id),
    invalidates: () => [k.agentTemplates(), k.componentsAll()],
    // removed once the page is left, so Back never paints the deleted template
    forgetsOnLeave: () => [k.agentTemplateAll(), k.agentTemplateDeletePreview(template.id)],
  });

  // As on the agent page: in-app links are held back while a section has unsaved edits.
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
      e.returnValue = "";
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [dirty]);

  const toggleShare = (next: boolean) =>
    void share.mutateAsync(next).then(
      () => toast.success(tt(next ? "shareOn" : "shareOff", { name: template.name })),
      (e: unknown) => toast.error(errorMessage(e)),
    );

  const menu: MenuItem[] = [
    ...(editable
      ? [
          template.shareable
            ? { label: tt("unshare"), onSelect: () => toggleShare(false) }
            : { label: tt("share"), onSelect: () => toggleShare(true) },
        ]
      : []),
    // the org admin's switch of a platform template (停用 previewed; 启用 is the notice's)
    ...switchActions
      .filter((a) => a !== enable)
      .map((a) =>
        a.href !== undefined
          ? { label: a.label, href: a.href }
          : {
              label: a.label,
              ...(a.danger === true && { danger: true }),
              onSelect: a.onSelect ?? (() => {}),
            },
      ),
    ...(editable ? [{ label: tt("delete"), danger: true, onSelect: () => setDeleting(true) }] : []),
  ];
  const actions: HeaderAction[] = [
    ...(menu.length > 0 ? [{ label: tc("moreActions"), menu }] : []),
    ...(!off ? [{ label: tt("create"), variant: "primary" as const, onSelect: onCreate }] : []),
  ];
  const definition = definitionOf(template);
  const header: PageHeaderProps = {
    path: [
      ...scope,
      { label: "agents", href: "/agents" },
      { label: "templates", href: TEMPLATES_TAB_HREF },
      { label: template.name },
    ],
    title: template.name,
    ...(definition.description !== "" ? { description: definition.description } : {}),
    avatar: <Avatar value={null} name={template.name} size={40} />,
    count: `${source(template, orgId)} · v${template.version}`,
    actions,
  };
  const notice: ReactNode =
    switchError !== undefined ? (
      <Callout tone="fail">
        <FormError message={switchError.message} extra={switchError.extra} />
      </Callout>
    ) : off ? (
      <Callout
        tone="warn"
        {...(enable?.onSelect !== undefined
          ? { action: { label: enable.label, onSelect: enable.onSelect } }
          : {})}
      >
        {admin ? t("off.ownerAdmin") : t("off.owner")}
      </Callout>
    ) : null;
  const value: TemplatePageValue = {
    orgId,
    template,
    definition,
    editable,
    section: open,
    header,
    nav,
    notice,
    setDirty,
  };
  return (
    <TemplatePageContext.Provider value={value}>
      <OpenSection key={open} section={open} editable={editable} />
      {dialog}
      {editable && deleting ? (
        <TemplateDeleteDialog
          orgId={orgId}
          id={template.id}
          name={template.name}
          onClose={() => setDeleting(false)}
          onDelete={async (outcome) => {
            await remove.mutateAsync(undefined);
            setDeleting(false);
            toast.success(
              outcome === "transferred"
                ? tt("deletedTransferred", { name: template.name })
                : tt("deleted", { name: template.name }),
            );
            router.push(TEMPLATES_TAB_HREF);
          }}
        />
      ) : null}
      {leaving !== null ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setLeaving(null);
          }}
          title={tl("title")}
          describedBy={describedBy}
          footer={
            <>
              <Button variant="ghost" onClick={() => setLeaving(null)}>
                {tl("keep")}
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
                {tl("discard")}
              </Button>
            </>
          }
        >
          <span id={describedBy}>
            <Text variant="prose">{tl("body")}</Text>
          </span>
        </Dialog>
      ) : null}
    </TemplatePageContext.Provider>
  );
}

function OpenSection({ section, editable }: { section: TemplateSection; editable: boolean }) {
  switch (section) {
    case "basics":
      return editable ? <BasicsEdit /> : <BasicsRead />;
    case "quick-actions":
      return editable ? <QuickActionsEdit /> : <QuickActionsRead />;
    case "prompt":
      return editable ? <PromptEdit /> : <PromptRead />;
    case "model":
      return editable ? <ModelEdit /> : <ModelRead />;
    case "tools":
      return editable ? <ToolsEdit /> : <ToolsRead />;
    case "skills":
      return editable ? <SkillsEdit /> : <SkillsRead />;
    case "connectors":
      return editable ? <ConnectorsEdit /> : <ConnectorsRead />;
    case "subagents":
      return editable ? <SubagentsEdit /> : <SubagentsRead />;
  }
}
