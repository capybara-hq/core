"use client";

import {
  Button,
  FormSection,
  ItemList,
  type ItemListRow,
  Skeleton,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../i18n/navigation";
import { type ChannelConnection, listChannels } from "../lib/channels";
import { newChannelHref } from "../lib/channels-preset";
import { useLoad } from "../lib/use-load";
import { navLevelOf } from "./shell/nav";
import { useSession } from "./shell/session";

/**
 * The 渠道 section of an agent page (spec §3.3.1): the channel connections bound to this agent
 * (kind, name, state). Org admins get 接入渠道, which opens the channel form with the agent preset
 * and comes back here after saving, and each row opens its connection; everyone else sees the list
 * read-only. The kernel decides who may list; when it refuses, a non-admin simply sees no section.
 */
export function AgentChannels({ orgId, agentId }: { orgId: string; agentId: string }) {
  const t = useTranslations("agents.channels");
  const tc = useTranslations("channels");
  const router = useRouter();
  const { me } = useSession();
  const admin = navLevelOf(me) === "admin";
  const { state } = useLoad(
    () => listChannels(orgId).then((r) => r.channels.filter((c) => c.agentId === agentId)),
    [orgId, agentId],
  );
  if (state.kind === "error" && !admin) return null;
  const row = (c: ChannelConnection): ItemListRow => ({
    id: c.id,
    tag: { label: c.plugin },
    title: c.name,
    meta:
      c.status === "error" && c.lastError !== null ? c.lastError : tc(`policy.${c.unboundPolicy}`),
    status: { label: tc(`status.${c.status}`) },
    ...(admin ? { href: `/channels/${c.id}` } : {}),
  });
  return (
    <FormSection id="channels" title={t("title")} description={t("hint")}>
      {state.kind === "loading" ? (
        <Skeleton rows={2} />
      ) : state.kind === "error" ? (
        <Text tone="muted">{t("loadFailed")}</Text>
      ) : (
        <ItemList label={t("title")} rows={state.data.map(row)} empty={t("empty")} />
      )}
      {admin && (
        <div>
          <Button onClick={() => router.push(newChannelHref(agentId))}>{t("connect")}</Button>
        </div>
      )}
    </FormSection>
  );
}
