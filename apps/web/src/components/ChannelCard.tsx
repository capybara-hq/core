"use client";

import { ObjectCard } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ChannelConnection, channelPluginLabel } from "../lib/channels";
import { labelLocale } from "../lib/extension-label";

/**
 * One channel connection as a card (design spec §6.34, maintainer decision 2026-11-08), shared by
 * the org 渠道 page and the agent page's 渠道 section so the two never drift: its plugin's icon (the
 * name's initial without one), the name as the link to its detail (`link: false`, a viewer who may
 * not open it: plain text), the platform's display name, then the bound agent (`agent`, left out
 * where it is implicit) and the unbound-person mode as the meta, and the running state. While it
 * fails the last error is the description and the platform leads the meta. A child of a `CardGrid`.
 */
export function ChannelCard({
  channel: c,
  agent,
  link = true,
}: {
  channel: ChannelConnection;
  /** The bound agent's name (its id when unknown); left out on the agent's own page. */
  agent?: string;
  link?: boolean;
}) {
  const t = useTranslations("channels");
  const lang = labelLocale(useLocale());
  const platform = channelPluginLabel(c, lang);
  const rest = [...(agent !== undefined ? [agent] : []), t(`policy.${c.unboundPolicy}`)];
  const failing = c.status === "error" && c.lastError !== null;
  return (
    <ObjectCard
      avatar={{ image: c.pluginIcon ?? null }}
      title={c.name}
      {...(link ? { href: `/channels/${c.id}` } : {})}
      {...(failing
        ? { description: c.lastError as string, meta: [platform, ...rest] }
        : { description: platform, meta: rest })}
      state={
        c.status === "active"
          ? { label: t("status.active"), tone: "ok" }
          : c.status === "error"
            ? { label: t("status.error"), tone: "fail" }
            : { label: t("status.disabled"), tone: "muted" }
      }
    />
  );
}
