"use client";

import {
  Button,
  Callout,
  FormSection,
  ItemList,
  ItemListItem,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Agent } from "../../lib/agents";
import type { LocalizedName } from "../../lib/catalog";
import { canManageConnectors } from "../../lib/connectors";
import {
  entryOfPending,
  type PendingEntry,
  requestPendingConnectors,
} from "../../lib/pending-connectors";
import { orgCatalogItemQuery } from "../../lib/query/catalog";
import { retryOnMountOf } from "../../lib/query/client";
import { orgComponentsQuery } from "../../lib/query/components";
import { setupRequestQuery } from "../../lib/query/from-template";
import { inboxChangeKeys } from "../../lib/query/inbox";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { useSession } from "../shell/session";
import {
  PendingConnectorDialog,
  useEntryLabel,
  useEntrySource,
  useEntryTools,
} from "./PendingConnectorDialog";

/** The agent's pending connectors as the notice and the dialog show them. */
export const pendingEntriesOf = (agent: Agent): PendingEntry[] =>
  (agent.definition.pendingConnectors ?? []).map(entryOfPending);

/**
 * The entries with each template entry's display name (both languages) filled in from the
 * connector templates: the org component names the template's catalog item and id, the item's
 * detail its display name. Unreadable or unknown: the entry keeps its label.
 */
function useTemplateDisplayNames(orgId: string, entries: PendingEntry[]): PendingEntry[] {
  const ids = entries.flatMap((e) => (e.source.kind === "template" ? [e.source.templateId] : []));
  const compQ = orgComponentsQuery(orgId, { kind: "connector_template" });
  const comps = useQuery({
    ...compQ,
    enabled: ids.length > 0,
    retryOnMount: retryOnMountOf(compQ.queryKey),
  });
  const refs = ids.flatMap((id) => {
    const c = comps.data?.components.find((x) => x.id === id);
    return c?.itemId != null ? [{ id, itemId: c.itemId, name: c.name }] : [];
  });
  const itemIds = [...new Set(refs.map((r) => r.itemId))];
  const items = useQueries({
    queries: itemIds.map((itemId) => {
      const q = orgCatalogItemQuery(orgId, itemId);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  const names = new Map<string, LocalizedName>();
  for (const r of refs) {
    const tpl = items[itemIds.indexOf(r.itemId)]?.data?.templates.find((x) => x.id === r.name);
    if (tpl?.displayName) names.set(r.id, tpl.displayName);
  }
  return entries.map((e) => {
    if (e.source.kind !== "template") return e;
    const displayName = names.get(e.source.templateId);
    return displayName === undefined ? e : { ...e, source: { ...e.source, displayName } };
  });
}

/**
 * The 待配置 notice of the Tools section (rulings P4-6, P4-7), for whoever may change the agent:
 * a flush card listing the pending connectors, then, by role,
 * - org admins (`connectors.manage`): 配置 on each, opening {@link PendingConnectorDialog};
 * - the owner who may not configure connectors: the request state in a Callout above the card:
 *   已申请 · 等待组织管理员, a rejection with its reason and 重新申请, or 申请 when none is open
 *   (a request opened at create may have failed, or the agent was handed over).
 * Nothing when no connector waits.
 */
export function PendingConnectorsNotice({ orgId, agent }: { orgId: string; agent: Agent }) {
  const t = useTranslations("agents.pending");
  const { me } = useSession();
  const entries = useTemplateDisplayNames(orgId, pendingEntriesOf(agent));
  const manager = canManageConnectors(me);
  const source = useEntrySource();
  const toolsOf = useEntryTools();
  const labelOf = useEntryLabel();
  const [open, setOpen] = useState<string | null>(null);
  if (entries.length === 0) return null;
  return (
    <>
      {!manager && <RequestState orgId={orgId} agentId={agent.id} />}
      <FormSection
        id="pending"
        flush
        title={t("title", { n: entries.length })}
        description={manager ? t("hintManager") : t("hintOwner")}
      >
        <ItemList label={t("listLabel")} inset="flush">
          {entries.map((e) => (
            <ItemListItem
              key={e.key}
              title={labelOf(e)}
              marks={
                <Text variant="small" tone="warn">
                  {t("state")}
                </Text>
              }
              meta={
                <>
                  <Text variant="small" tone="muted">
                    {source(e)}
                  </Text>
                  <Text variant="small" tone="muted">
                    {toolsOf(e)}
                  </Text>
                </>
              }
              {...(manager
                ? {
                    actions: (
                      <Button density="dense" onClick={() => setOpen(e.key)}>
                        {t("configure")}
                      </Button>
                    ),
                  }
                : {})}
            />
          ))}
        </ItemList>
      </FormSection>
      {open !== null && (
        <PendingConnectorDialog
          orgId={orgId}
          agentId={agent.id}
          agentName={agent.definition.name}
          entries={entries}
          initialKey={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** The owner's request state (a Callout above the notice's card). */
function RequestState({ orgId, agentId }: { orgId: string; agentId: string }) {
  const t = useTranslations("agents.pending.request");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const q = setupRequestQuery(orgId, agentId);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const ask = useAppMutation({
    fn: () => requestPendingConnectors(orgId, agentId),
    invalidates: () => [keys.org(orgId).setupRequest(agentId), ...inboxChangeKeys(orgId)],
    onSuccess: () => toast.success(t("sent")),
  });
  const send = () => void ask.mutateAsync(undefined).catch((e) => toast.error(errorMessage(e)));
  if (read.data === undefined) {
    return read.error !== null ? (
      <Callout tone="fail" action={{ label: t("retry"), onSelect: () => void read.refetch() }}>
        {t("failed")}
      </Callout>
    ) : null;
  }
  const r = read.data.request;
  if (r?.status === "pending") return <Callout tone="info">{t("pending")}</Callout>;
  if (r?.status === "rejected") {
    return (
      <Callout tone="warn" action={{ label: t("again"), onSelect: send }}>
        {r.reason !== null && r.reason !== ""
          ? t("rejectedReason", { reason: r.reason })
          : t("rejected")}
      </Callout>
    );
  }
  return (
    <Callout tone="warn" action={{ label: t("ask"), onSelect: send }}>
      {t("none")}
    </Callout>
  );
}

/** The plain notice for someone who may only use the agent (its read-only Basics). */
export function PendingConnectorsPlain({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.pending");
  const n = (agent.definition.pendingConnectors ?? []).length;
  if (n === 0) return null;
  return <Callout tone="info">{t("plain", { n })}</Callout>;
}
