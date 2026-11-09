"use client";

import { SettingsPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { AgentChannels } from "../../../../components/AgentChannels";
import { AgentPage } from "../../../../components/agent/AgentPage";
import { loadingSection, useExtSections, useSectionNav } from "../../../../components/agent/frame";
import {
  builtinSection,
  READ_ONLY_FIELDS,
  SECTION_FIELDS,
  sectionOf,
} from "../../../../components/agent/sections";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import { myRole, roleAtLeast } from "../../../../lib/members";
import { canEditAgent, canUpdateOrg } from "../../../../lib/org-settings";
import { agentQuery } from "../../../../lib/query/agents";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { newConversationPath } from "../../../../lib/routes";
import type { Me } from "../../../../lib/session";
import NotFound from "../../not-found";

/**
 * `/agents/[id]`: the agent page by section (agent profile design §3): a section nav on the left,
 * the open section (`?s=`) on the right with its own save. Viewers who may use but not change the
 * agent get basics, quick actions and the model, read-only (B3). From the query cache (the layout
 * prefetched it on a first load); an agent the kernel does not find is the not-found state. Keyed
 * by the agent: the sections keep what was typed when the agent is read again.
 */
export default function AgentView({ agentId, section }: { agentId: string; section?: string }) {
  const ws = useWorkspace({ setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <AgentRoute key={agentId} orgId={ws.orgId} me={ws.me} agentId={agentId} section={section} />
  );
}

function AgentRoute({
  orgId,
  me,
  agentId,
  section,
}: {
  orgId: string;
  me: Me;
  agentId: string;
  section: string | undefined;
}) {
  const agent = usePageQuery(agentQuery(orgId, agentId));
  if (agent.kind === "notFound") return <NotFound />;
  if (agent.kind === "error") return <ErrorFrame reset={agent.retry} />;
  if (agent.kind === "loading") {
    return <AgentPageLoading orgId={orgId} agentId={agentId} section={section} />;
  }
  return (
    <AgentPage
      orgId={orgId}
      agent={agent.data}
      section={section}
      editable={canEditAgent(me, agent.data)}
    />
  );
}

/** The page while the agent is on its way: the head and the section nav, the section's skeleton. */
function AgentPageLoading({
  orgId,
  agentId,
  section,
}: {
  orgId: string;
  agentId: string;
  section: string | undefined;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("agents.page");
  const ta = useTranslations("agents");
  const tc = useTranslations("common");
  const { me } = useSession();
  // The head's actions the session already decides: the ⋯ menu with run history, change owner and
  // save as template for org admins (a member owner's run history comes with the agent), and start chat (a static
  // link). Change owner does nothing until the agent is here.
  const admin = canUpdateOrg(me);
  const chatHref = newConversationPath(agentId);
  // whether the viewer may change the agent is known only with it: members up see every section
  const editable = roleAtLeast(myRole(me), "member");
  const ext = useExtSections(orgId);
  const open = sectionOf(section, editable, ext);
  const built = builtinSection(open);
  const nav = useSectionNav(orgId, agentId, editable);
  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "agents", href: "/agents" }],
        title: "",
        // the loaded head carries the agent's avatar: keep its 40 px slot
        loading: { title: true, avatar: true },
        actions: [
          ...(admin
            ? [
                {
                  label: tc("moreActions"),
                  menu: [
                    {
                      label: ta("runHistory"),
                      href: `/trajectories?agentId=${encodeURIComponent(agentId)}`,
                    },
                    // they do nothing until the agent is here
                    { label: t("reassign"), onSelect: () => {} },
                    { label: ta("saveAs.action"), onSelect: () => {} },
                  ],
                },
              ]
            : []),
          { label: t("startChat"), variant: "primary" as const, href: chatHref },
        ],
      }}
      nav={nav}
      activeNav={open}
      // 渠道 draws its own frame (cards on the page ground), the other sections their fields
      loading={
        built === "channels" && open === built
          ? {}
          : {
              sections: [
                loadingSection(
                  built,
                  editable
                    ? SECTION_FIELDS[built]
                    : (READ_ONLY_FIELDS[built] ?? SECTION_FIELDS[built]),
                  t,
                ),
              ],
            }
      }
    >
      {built === "channels" && open === built ? (
        <AgentChannels agentId={agentId} channels={null} loading />
      ) : null}
    </SettingsPage>
  );
}
