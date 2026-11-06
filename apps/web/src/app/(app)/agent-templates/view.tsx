"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useOwnerLabel } from "../../../components/CatalogParts";
import { useComponentState, useComponentSwitch } from "../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { rowActions } from "../../../components/PluginSwitch";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { type OwnerSide, ownerSide } from "../../../lib/catalog";
import { usableRows } from "../../../lib/components";
import { canUpdateOrg } from "../../../lib/org-settings";
import { agentTemplatesQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { orgComponentsQuery } from "../../../lib/query/components";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/agent-templates` (spec §8, §9): the agent templates the org can use (its own, 本组织) and the
 * platform ones offered to it (平台, with their state in the org: 已启用 · 平台统一 for `all`, 已启用,
 * 未启用, 插件未启用). Org admins switch platform templates (启用, 停用 with the preview of the
 * agents using one); members read the page. A template is a sub-agent type in the agent editor;
 * creating an agent from one comes later. From the query cache (the layout prefetched both lists
 * on a first load); a switch invalidates them.
 */
export default function AgentTemplatesView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <AgentTemplates orgId={ws.orgId} />;
}

function AgentTemplates({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("agentTemplates");
  const tc = useTranslations("orgComponents");
  const ta = useTranslations("agents.form.subagents");
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const list = usePageQuery(agentTemplatesQuery(orgId));
  const cq = orgComponentsQuery(orgId, { kind: "agent_template" });
  const offered = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const stateOf = useComponentState();
  const { actionsOf, dialog, error } = useComponentSwitch({ orgId, admin });
  const ownerLabel = useOwnerLabel(orgId);
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const rows =
    list.kind === "ready" ? usableRows(list.data.templates, offered.data?.components) : [];
  // Where it came from: its plugin, else whose upload it is (the same owner as the chip)
  const fromOf = (plugin: string | null | undefined, owner: OwnerSide) =>
    plugin
      ? tc("from.plugin", { plugin })
      : owner.kind === "platform"
        ? tc("from.platform")
        : owner.kind === "self"
          ? tc("from.org")
          : tc("from.orgNamed", { org: owner.name });
  return (
    <>
      <ListPage
        header={{
          path: [...scope, { label: "agent-templates" }],
          title: t("title"),
          description: t("description"),
        }}
        variant="objects"
        listLabel={t("listLabel")}
        {...(error !== undefined
          ? {
              callout: {
                tone: "fail" as const,
                children: <FormError message={error.message} extra={error.extra} />,
              },
            }
          : offered.data === undefined && offered.error !== null
            ? // the offered components could not be read: the platform ones that are off and
              // their switches are missing until a retry
              {
                callout: {
                  tone: "warn" as const,
                  children: tc("listUnavailable"),
                  action: { label: tc("retry"), onSelect: () => void offered.refetch() },
                },
              }
            : {})}
        {...(list.kind === "loading"
          ? { loading: true }
          : rows.length === 0
            ? { empty: { text: t("empty") } }
            : {})}
      >
        {rows.map((r) => {
          if (r.kind === "own") {
            const x = r.item;
            return (
              <ObjectRow
                key={x.id}
                mark={{ text: x.name }}
                name={x.name}
                mono
                chips={[{ label: tc("origin.org") }]}
                description={x.description}
                meta={[
                  fromOf(x.plugin, { kind: "self" }),
                  t("type", { type: x.type }),
                  ta(`tier.${x.model}`),
                  t("version", { version: x.version }),
                ]}
                state={{ label: tc("state.on"), tone: "ok" }}
              />
            );
          }
          const x = r.item;
          const c = r.component;
          // The owner from owner_org_id: 本组织 for the org's own upload, else the owner org or 平台
          const owner = c?.owner;
          const id = x?.id ?? c?.id ?? "";
          const name = x?.name ?? c?.name ?? "";
          return (
            <ObjectRow
              key={id}
              mark={{ text: name }}
              name={name}
              mono
              chips={[{ label: ownerLabel(owner) }]}
              description={x?.description ?? c?.description ?? ""}
              meta={[
                fromOf(x?.plugin ?? c?.plugin, ownerSide(owner, orgId)),
                ...(x !== undefined ? [t("type", { type: x.type }), ta(`tier.${x.model}`)] : []),
                t("version", { version: x?.version ?? c?.version ?? "" }),
              ]}
              state={c !== undefined ? stateOf(c) : { label: tc("state.on"), tone: "ok" }}
              {...(c !== undefined ? rowActions(actionsOf(c)) : {})}
            />
          );
        })}
      </ListPage>
      {dialog}
    </>
  );
}
