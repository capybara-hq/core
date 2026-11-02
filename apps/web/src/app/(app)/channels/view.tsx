"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePagePath } from "../../../components/shell/path";
import type { ChannelConnection } from "../../../lib/channels";

/**
 * `/channels`: the org's channel connections as object rows (admins); a name opens the detail.
 * Read on the server (`page.tsx`): the connections and the agents' names by id (display only: a
 * connection shows its agent id when the name is unknown).
 */
export default function ChannelsView({
  initial,
}: {
  initial: { channels: ChannelConnection[]; agentNames: Record<string, string> };
}) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const [tab, setTab] = useState<"all" | "error">("all");
  const all = initial.channels;
  const agentNames = initial.agentNames;
  const failing = all.filter((c) => c.status === "error");
  // A tab only when it holds something different from "all".
  const active = tab === "error" && failing.length > 0 ? "error" : "all";
  const rows = active === "error" ? failing : all;
  const header = {
    path: [...scope, { label: "channels" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/channels/new" }],
    ...(failing.length > 0
      ? {
          tabs: [
            { id: "all", label: t("tabs.all"), count: all.length, onSelect: () => setTab("all") },
            {
              id: "error",
              label: t("tabs.error"),
              count: failing.length,
              onSelect: () => setTab("error"),
            },
          ],
          activeTab: active,
        }
      : {}),
  };
  const empty =
    all.length === 0
      ? {
          text: t("empty"),
          action: { label: t("new"), variant: "primary" as const, href: "/channels/new" },
        }
      : undefined;
  return (
    <ListPage header={header} variant="objects" {...(empty ? { empty } : {})}>
      {rows.map((c) => (
        <ObjectRow
          key={c.id}
          mark={{
            text: c.name,
            ...(c.status === "error" ? { tone: "warn" as const } : {}),
          }}
          name={c.name}
          href={`/channels/${c.id}`}
          chips={[{ label: c.plugin }]}
          {...(c.status === "error" && c.lastError !== null ? { description: c.lastError } : {})}
          meta={`${agentNames[c.agentId] ?? c.agentId} · ${t(`policy.${c.unboundPolicy}`)}`}
          state={
            c.status === "active"
              ? { label: t("status.active"), tone: "ok" }
              : c.status === "error"
                ? { label: t("status.error"), tone: "fail" }
                : { label: t("status.disabled"), tone: "muted" }
          }
        />
      ))}
    </ListPage>
  );
}
