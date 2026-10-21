"use client";

import { type Column, DataTable, ListPage, Stack, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ChannelStatusMark } from "../../../../components/ChannelFields";
import { OrgGate } from "../../../../components/OrgGate";
import { useRouter } from "../../../../i18n/navigation";
import { listAgents } from "../../../../lib/agents";
import { type ChannelConnection, listChannels } from "../../../../lib/channels";
import { useLoad } from "../../../../lib/use-load";

/** `/[locale]/channels`：组织的渠道连接（ListPage + DataTable，管理员）。点一行进详情。 */
export default function ChannelsPage() {
  return <OrgGate>{(orgId) => <Channels key={orgId} orgId={orgId} />}</OrgGate>;
}

async function load(orgId: string) {
  const [{ channels }, agents] = await Promise.all([
    listChannels(orgId),
    // agent 名只用于显示：读不到时显示 id
    listAgents(orgId).then(
      (r) => r.agents,
      () => [],
    ),
  ]);
  return { channels, agentNames: new Map(agents.map((a) => [a.id, a.definition.name])) };
}

function Channels({ orgId }: { orgId: string }) {
  const t = useTranslations("channels");
  const router = useRouter();
  const { state, reload } = useLoad(() => load(orgId), [orgId]);
  const agentNames = state.kind === "ready" ? state.data.agentNames : new Map<string, string>();
  const columns: Column<ChannelConnection>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (c) => (
        <Stack gap={0}>
          <Text>{c.name}</Text>
          {c.status === "error" && c.lastError !== null && (
            <Text variant="small" tone="fail" truncate>
              {c.lastError}
            </Text>
          )}
        </Stack>
      ),
    },
    { key: "plugin", header: t("columns.plugin"), tone: "muted", cell: (c) => c.plugin },
    {
      key: "agent",
      header: t("columns.agent"),
      cell: (c) => agentNames.get(c.agentId) ?? c.agentId,
    },
    {
      key: "policy",
      header: t("columns.policy"),
      tone: "muted",
      width: 140,
      cell: (c) => t(`policy.${c.unboundPolicy}`),
    },
    {
      key: "status",
      header: t("columns.status"),
      width: 120,
      cell: (c) => <ChannelStatusMark status={c.status} />,
    },
  ];
  return (
    <ListPage
      header={{
        title: t("title"),
        count: state.kind === "ready" ? String(state.data.channels.length) : undefined,
        actions: [{ label: t("new"), variant: "primary", href: "/channels/new" }],
      }}
    >
      <DataTable<ChannelConnection>
        label={t("title")}
        columns={columns}
        rows={state.kind === "ready" ? state.data.channels : []}
        rowKey={(c) => c.id}
        rowLabel={(c) => c.name}
        state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
        {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        onOpen={(c) => router.push(`/channels/${c.id}`)}
      />
    </ListPage>
  );
}
