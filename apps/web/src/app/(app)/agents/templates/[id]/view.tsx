"use client";

import { Callout, EmptyState, OverviewPage, SettingsPage } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useTemplateSource } from "../../../../../components/AgentTemplateCards";
import { CreateFromTemplateDialog } from "../../../../../components/agent/CreateFromTemplateDialog";
import {
  TEMPLATE_SECTION_FIELDS,
  templateSectionOf,
  useTemplateNav,
} from "../../../../../components/agent-template/frame";
import {
  TEMPLATES_TAB_HREF,
  TemplatePage,
} from "../../../../../components/agent-template/TemplatePage";
import { useComponentSwitch } from "../../../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { ownerSide } from "../../../../../lib/catalog";
import { type OrgComponent, unavailableComponent } from "../../../../../lib/components";
import { canUpdateOrg } from "../../../../../lib/org-settings";
import { agentTemplateQuery } from "../../../../../lib/query/agents";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { orgComponentsQuery } from "../../../../../lib/query/components";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useWorkspace } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

/**
 * `/agents/templates/[id]` (rulings P4-12, P4-14): members up (guests cannot create agents, so
 * templates are not theirs). From the query cache. A template the kernel does not serve (404) is
 * the not-found state, unless it is a platform template offered to the org but switched off
 * there: then the designed off state (未在本组织启用, the switch for org admins). Keyed by the
 * template: the sections keep what was typed when it is read again.
 */
export default function TemplateView({ id, section }: { id: string; section?: string }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <TemplateRoute
      key={id}
      orgId={ws.orgId}
      admin={canUpdateOrg(ws.me)}
      id={id}
      section={section}
    />
  );
}

function TemplateRoute({
  orgId,
  admin,
  id,
  section,
}: {
  orgId: string;
  admin: boolean;
  id: string;
  section: string | undefined;
}) {
  const detail = usePageQuery(agentTemplateQuery(orgId, id));
  const cq = orgComponentsQuery(orgId, {});
  const offered = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const [creating, setCreating] = useState(false);
  if (detail.kind === "notFound") {
    // still reading the offered components: the frame keeps its place until they answer
    if (offered.data === undefined && offered.error === null) {
      return <TemplateLoading id={id} section={section} />;
    }
    const off = unavailableComponent(offered.data?.components, "agent_template", id);
    return off === undefined ? (
      <NotFound />
    ) : (
      <OffTemplate orgId={orgId} admin={admin} component={off} />
    );
  }
  if (detail.kind === "error") return <ErrorFrame reset={detail.retry} />;
  if (detail.kind === "loading") return <TemplateLoading id={id} section={section} />;
  return (
    <>
      <TemplatePage
        orgId={orgId}
        template={detail.data}
        section={section}
        admin={admin}
        offered={offered.data?.components}
        onCreate={() => setCreating(true)}
      />
      {creating ? (
        <CreateFromTemplateDialog
          orgId={orgId}
          template={{ id: detail.data.id, name: detail.data.name }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}

/** The page while the template is on its way: the head's path and nav, the section's skeleton. */
function TemplateLoading({ id, section }: { id: string; section: string | undefined }) {
  const scope = usePagePath("org");
  const t = useTranslations("agents.templatePage");
  const nav = useTemplateNav(id);
  const open = templateSectionOf(section);
  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "agents", href: "/agents" },
          { label: "templates", href: TEMPLATES_TAB_HREF },
        ],
        title: "",
        loading: { title: true, avatar: true, actions: 1 },
      }}
      nav={nav}
      activeNav={open}
      loading={{
        sections: [{ fields: TEMPLATE_SECTION_FIELDS[open], title: t(`sections.${open}`) }],
      }}
    />
  );
}

/**
 * A platform template offered to the org but switched off there (the kernel serves no detail
 * then): its head from the offered component (name, description, source · v), and one page
 * EmptyState saying it is not on here, with 启用 for an org admin who may switch it (the
 * component switch, rule 5), else who to ask. Turning it on reads the template again.
 */
function OffTemplate({
  orgId,
  admin,
  component,
}: {
  orgId: string;
  admin: boolean;
  component: OrgComponent;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("agents.templatePage.off");
  const source = useTemplateSource();
  const { actionsOf, dialog, error } = useComponentSwitch({ orgId, admin });
  const enable = actionsOf(component).find((a) => a.id === "enable");
  const plugin = actionsOf(component).find((a) => a.id === "plugin");
  const owner = ownerSide(component.owner, orgId);
  return (
    <>
      <OverviewPage
        header={{
          path: [
            ...scope,
            { label: "agents", href: "/agents" },
            { label: "templates", href: TEMPLATES_TAB_HREF },
            { label: component.name },
          ],
          title: component.name,
          ...(component.description ? { description: component.description } : {}),
          count: `${source(component.plugin, owner)} · v${component.version}`,
          ...(error !== undefined
            ? {
                notice: (
                  <Callout tone="fail">
                    <FormError message={error.message} extra={error.extra} />
                  </Callout>
                ),
              }
            : {}),
        }}
      >
        <EmptyState
          text={t("title")}
          hint={
            enable !== undefined
              ? t("hintAdmin")
              : plugin !== undefined
                ? t("hintPlugin")
                : admin
                  ? t("hintLocked")
                  : t("hintMember")
          }
          {...(enable?.onSelect !== undefined
            ? {
                action: {
                  label: enable.label,
                  variant: "primary" as const,
                  onSelect: enable.onSelect,
                  ...(enable.loading === true && { loading: true }),
                },
              }
            : plugin?.href !== undefined
              ? { action: { label: plugin.label, variant: "default" as const, href: plugin.href } }
              : {})}
        />
      </OverviewPage>
      {dialog}
    </>
  );
}
