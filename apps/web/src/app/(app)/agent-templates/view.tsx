"use client";

import { ListPage, ObjectRow, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useComponentState, useComponentSwitch } from "../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { rowActions } from "../../../components/PluginSwitch";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { type AgentTemplateView, setTemplateShareable } from "../../../lib/agents";
import { usableRows } from "../../../lib/components";
import { canUpdateOrg } from "../../../lib/org-settings";
import { agentTemplatesQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { orgComponentsQuery } from "../../../lib/query/components";
import { keys } from "../../../lib/query/keys";
import { useAppMutation } from "../../../lib/query/mutation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/agent-templates` (spec §8, §9): the agent templates the org can use (its own, 本组织) and the
 * platform ones offered to it (平台, with their state in the org: 已启用 · 平台统一 for `all`, 已启用, 未启用,
 * 插件未启用). Org admins switch platform templates (启用, 停用 with the preview of the agents using one);
 * members read the page. The org's own template (not a plugin's, whose sharing is its plugin's)
 * carries 可共享 (plugin scope phase 3): a chip when on, and the org admin's action to switch it,
 * shown only when the kernel says the template's `shareable`. A template is a sub-agent type in the
 * agent editor; creating an agent from one comes later. From the query cache (the layout prefetched
 * both lists on a first load); a switch invalidates them.
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
  const { actionsOf, dialog, error: switchError, busy } = useComponentSwitch({ orgId, admin });
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [shareError, setShareError] = useState<string>();
  // 可共享 changes the template and what the platform may offer: both lists read again
  const share = useAppMutation({
    fn: (v: { id: string; shareable: boolean }) => setTemplateShareable(orgId, v.id, v.shareable),
    invalidates: () => [keys.org(orgId).agentTemplates(), keys.org(orgId).componentsAll()],
  });
  const toggleShare = async (x: AgentTemplateView) => {
    const next = x.shareable !== true;
    setShareError(undefined);
    try {
      await share.mutateAsync({ id: x.id, shareable: next });
      toast.success(
        next ? t("share.doneOn", { name: x.name }) : t("share.doneOff", { name: x.name }),
      );
    } catch (e) {
      setShareError(errorMessage(e));
    }
  };
  const error =
    switchError ?? (shareError !== undefined ? { message: shareError, extra: [] } : undefined);
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const rows =
    list.kind === "ready" ? usableRows(list.data.templates, offered.data?.components) : [];
  const fromOf = (plugin: string | null | undefined, platform: boolean) =>
    plugin ? tc("from.plugin", { plugin }) : platform ? tc("from.platform") : tc("from.org");
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
            const sharable = x.shareable !== undefined && x.plugin === null;
            return (
              <ObjectRow
                key={x.id}
                mark={{ text: x.name }}
                name={x.name}
                mono
                chips={[
                  { label: tc("origin.org") },
                  ...(sharable && x.shareable === true ? [{ label: t("share.chip") }] : []),
                ]}
                {...(sharable && admin && !share.isPending
                  ? {
                      action: {
                        label: x.shareable === true ? t("share.off") : t("share.on"),
                        onSelect: () => void toggleShare(x),
                      },
                    }
                  : {})}
                description={x.description}
                meta={[
                  fromOf(x.plugin, false),
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
          const id = x?.id ?? c?.id ?? "";
          const name = x?.name ?? c?.name ?? "";
          return (
            <ObjectRow
              key={id}
              mark={{ text: name }}
              name={name}
              mono
              chips={[{ label: tc("origin.platform") }]}
              description={x?.description ?? c?.description ?? ""}
              meta={[
                fromOf(x?.plugin ?? c?.plugin, true),
                ...(x !== undefined ? [t("type", { type: x.type }), ta(`tier.${x.model}`)] : []),
                t("version", { version: x?.version ?? c?.version ?? "" }),
              ]}
              state={c !== undefined ? stateOf(c) : { label: tc("state.on"), tone: "ok" }}
              {...(c !== undefined && !busy ? rowActions(actionsOf(c)) : {})}
            />
          );
        })}
      </ListPage>
      {dialog}
    </>
  );
}
