"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { OrgGate } from "../../../components/OrgGate";
import { usePagePath } from "../../../components/shell/path";
import { listAgents } from "../../../lib/agents";
import { listChannels } from "../../../lib/channels";
import { useLoad } from "../../../lib/use-load";

/** `/channels`: the org's channel connections as object rows (admins); a name opens the detail. */
export default function ChannelsPage() {
  return <OrgGate>{(orgId) => <Channels key={orgId} orgId={orgId} />}</OrgGate>;
}

async function load(orgId: string) {
  const [{ channels }, agents] = await Promise.all([
    listChannels(orgId),
    // Agent names are display only: show the id when they cannot be read.
    listAgents(orgId).then(
      (r) => r.agents,
      () => [],
    ),
  ]);
  return { channels, agentNames: new Map(agents.map((a) => [a.id, a.definition.name])) };
}

function Channels({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const { state, reload } = useLoad(() => load(orgId), [orgId]);
  const [tab, setTab] = useState<"all" | "error">("all");
  const all = state.kind === "ready" ? state.data.channels : [];
  const agentNames = state.kind === "ready" ? state.data.agentNames : new Map<string, string>();
  const failing = all.filter((c) => c.status === "error");
  // A tab only when it holds something different from "all".
  const active = tab === "error" && failing.length > 0 ? "error" : "all";
  const rows = active === "error" ? failing : all;
  const header = {
    path: [...scope, { label: "channels" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/channels/new" }],
    ...(state.kind === "ready" && failing.length > 0
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
    state.kind === "error"
      ? {
          icon: "circle-alert" as const,
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && all.length === 0
        ? {
            icon: "channel" as const,
            text: t("empty"),
            action: { label: t("new"), variant: "primary" as const, href: "/channels/new" },
          }
        : undefined;
  return (
    <ListPage
      header={header}
      variant="objects"
      loading={state.kind === "loading"}
      {...(empty ? { empty } : {})}
    >
      {rows.map((c) => (
        <ObjectRow
          key={c.id}
          mark={{
            text: Array.from(c.name)[0] ?? "?",
            ...(c.status === "error" ? { tone: "warn" as const } : {}),
          }}
          name={c.name}
          href={`/channels/${c.id}`}
          chips={[{ label: c.plugin }]}
          {...(c.status === "error" && c.lastError !== null ? { description: c.lastError } : {})}
          meta={`${agentNames.get(c.agentId) ?? c.agentId} · ${t(`policy.${c.unboundPolicy}`)}`}
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
