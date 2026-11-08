"use client";

import { Button, FormSection, ItemList, type ItemListRow, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "../i18n/navigation";
import { type ChannelConnection, channelPluginLabel } from "../lib/channels";
import { newChannelHref } from "../lib/channels-preset";
import { labelLocale } from "../lib/extension-label";
import { navLevelOf } from "./shell/nav";
import { useSession } from "./shell/session";

/**
 * The 渠道 section of an agent page (spec §3.3.1): the channel connections bound to this agent
 * (their plugin's icon, else the name's initial; the name; the platform and the unbound mode, or the
 * last error; the state). Org admins get 接入渠道, which opens the channel form with the agent preset
 * and comes back here after saving, and each row opens its connection; everyone else sees the list
 * read-only. The agent's connections come from the server's read (`null`: it could not be read); the kernel
 * decides who may list, and when it refuses, a non-admin simply sees no section.
 */
export function AgentChannels({
  agentId,
  channels,
}: {
  agentId: string;
  channels: ChannelConnection[] | null;
}) {
  const t = useTranslations("agents.channels");
  const tc = useTranslations("channels");
  const router = useRouter();
  const lang = labelLocale(useLocale());
  const { me } = useSession();
  const admin = navLevelOf(me) === "admin";
  if (channels === null && !admin) return null;
  const row = (c: ChannelConnection): ItemListRow => ({
    id: c.id,
    mark: { text: c.name, image: c.pluginIcon ?? null },
    title: c.name,
    meta:
      c.status === "error" && c.lastError !== null
        ? c.lastError
        : `${channelPluginLabel(c, lang)} · ${tc(`policy.${c.unboundPolicy}`)}`,
    status: { label: tc(`status.${c.status}`) },
    ...(admin ? { href: `/channels/${c.id}` } : {}),
  });
  const connect = {
    label: t("connect"),
    variant: "default" as const,
    onSelect: () => router.push(newChannelHref(agentId)),
  };
  return (
    <FormSection id="channels" title={t("title")} description={t("hint")}>
      {channels === null ? (
        <Text tone="muted">{t("loadFailed")}</Text>
      ) : (
        // No connections: the panel empty state, carrying 接入渠道 for an org admin (spec §6.18)
        <ItemList
          label={t("title")}
          rows={channels.map(row)}
          empty={{ text: t("empty"), ...(admin ? { action: connect } : {}) }}
        />
      )}
      {admin && channels?.length !== 0 && (
        <div>
          <Button onClick={connect.onSelect}>{t("connect")}</Button>
        </div>
      )}
    </FormSection>
  );
}
