"use client";

import { Button, CardGrid, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../i18n/navigation";
import type { ChannelConnection } from "../lib/channels";
import { newChannelHref } from "../lib/channels-preset";
import { ChannelCard } from "./ChannelCard";
import { navLevelOf } from "./shell/nav";
import { useSession } from "./shell/session";

/**
 * The 渠道 section of an agent page (spec §3.3.1; cards since the maintainer decision of
 * 2026-11-08, design spec §6.34): no card of its own, so nothing is boxed twice; the heading and its
 * description on the page ground, 接入渠道 beside them for an org admin (it opens the channel form
 * with the agent preset and comes back here after saving), then the connections bound to this agent
 * as `ChannelCard`s in a `CardGrid`, the same cards as the org 渠道 page (the agent is implicit, so
 * the meta is the unbound mode). Without connections the grid's empty state carries 接入渠道
 * instead. Everyone else sees the cards read-only, without links. `channels` is the server's read
 * (`null`: it could not be read; the kernel decides who may list, and when it refuses, a non-admin
 * simply sees no section); `loading` draws the same frame with skeleton cards.
 */
export function AgentChannels({
  agentId,
  channels,
  loading = false,
}: {
  agentId: string;
  channels: ChannelConnection[] | null;
  loading?: boolean;
}) {
  const t = useTranslations("agents.channels");
  const router = useRouter();
  const { me } = useSession();
  const admin = navLevelOf(me) === "admin";
  if (!loading && channels === null && !admin) return null;
  const connect = {
    label: t("connect"),
    variant: "default" as const,
    onSelect: () => router.push(newChannelHref(agentId)),
  };
  const empty = !loading && channels?.length === 0;
  return (
    <section id="channels" aria-label={t("title")}>
      <Stack gap={12}>
        <Stack direction="row" justify="between" align="start" gap={12} wrap>
          <Stack gap={4}>
            <Text variant="h2">{t("title")}</Text>
            <Text variant="prose" tone="muted">
              {t("hint")}
            </Text>
          </Stack>
          {admin && (loading || (channels !== null && !empty)) ? (
            <Button onClick={connect.onSelect} disabled={loading}>
              {t("connect")}
            </Button>
          ) : null}
        </Stack>
        {!loading && channels === null ? (
          <Text tone="muted">{t("loadFailed")}</Text>
        ) : (
          <CardGrid
            label={t("title")}
            {...(loading ? { loading: 3 } : {})}
            // No connections: the settings area's empty state, carrying 接入渠道 for an org admin
            {...(empty
              ? { empty: { text: t("empty"), ...(admin ? { action: connect } : {}) } }
              : {})}
          >
            {(channels ?? []).map((c) => (
              <ChannelCard key={c.id} channel={c} link={admin} />
            ))}
          </CardGrid>
        )}
      </Stack>
    </section>
  );
}
