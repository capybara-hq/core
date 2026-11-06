"use client";

import {
  Button,
  Card,
  DangerConfirm,
  DateTime,
  DetailPage,
  Field,
  Input,
  KeyValue,
  RadioGroup,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentSelect, ChannelStatusMark, PolicyRadio } from "../../../../components/ChannelFields";
import { ConfigForm } from "../../../../components/config-form/ConfigForm";
import { channelConfig, channelFormMeta } from "../../../../components/config-form/channel";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { configIssues, issueLines } from "../../../../lib/api";
import {
  type ChannelConnection,
  deleteChannel,
  type InboundMode,
  type UnboundPolicy,
  type UpdateChannelInput,
  updateChannel,
} from "../../../../lib/channels";
import type { ConfigIssue, JsonSchema } from "../../../../lib/json-schema";
import { agentsQuery } from "../../../../lib/query/agents";
import { channelQuery, channelSchemaQuery } from "../../../../lib/query/channels";
import { retryOnMountOf } from "../../../../lib/query/client";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

const TABS = ["overview", "credentials", "settings"] as const;
type Tab = (typeof TABS)[number];

/**
 * What the page shows: the connection, its plugin's connection schema (`undefined` while it is
 * read; `null` when the plugin is uninstalled or disabled: the credentials tab says so) and the
 * agents (empty when they could not be read).
 */
export interface ChannelData {
  channel: ChannelConnection;
  schema: JsonSchema | null | undefined;
  agents: Agent[];
}

/** Saves a change to the connection; resolves with the connection the kernel answered. */
type Update = (input: UpdateChannelInput) => Promise<ChannelConnection>;

/**
 * `/channels/[id]`：渠道连接详情（DetailPage）：概览（状态与最近错误、启停）、凭据（按连接 schema
 * 修改配置与轮换密钥，内核先向平台校验）、设置（改名、绑定的 agent、未绑定策略、删除）。
 * From the query cache (the layout prefetched it on a first load); a missing connection is the
 * not-found state. A change the kernel answers with the connection replaces it in the cache.
 */
export default function ChannelView({ channelId }: { channelId: string }) {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Channel key={channelId} orgId={ws.orgId} channelId={channelId} />;
}

function Channel({ orgId, channelId }: { orgId: string; channelId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const read = usePageQuery(channelQuery(orgId, channelId));
  const plugin = read.kind === "ready" ? read.data.plugin : "";
  // Sections: the schema (once the connection names its plugin) and the agents.
  const schemaQ = channelSchemaQuery(orgId, plugin);
  const schema = useQuery({
    ...schemaQ,
    retryOnMount: retryOnMountOf(schemaQ.queryKey),
    enabled: plugin !== "",
  });
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) });
  // The kernel answers a change with the connection: it replaces the cached one; the list is
  // read again when shown.
  const save = useAppMutation({
    fn: (input: UpdateChannelInput) => updateChannel(orgId, channelId, input),
    invalidates: () => [keys.org(orgId).channels()],
    onSuccess: (r) => qc.setQueryData(channelQuery(orgId, channelId).queryKey, r.channel),
  });
  const update: Update = (input) => save.mutateAsync(input).then((r) => r.channel);
  const tabs = {
    label: t("detail.tabsLabel"),
    items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
    value: tab,
    onChange: (x: string) => setTab(x as Tab),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: "channels", href: "/channels" }], title: "" }}
        tabs={tabs}
        inspectorTitle={t("detail.inspectorTitle")}
        // the inspector's six facts (extension, tenant, bot, agent, policy, created)
        loading={{ inspector: { rows: 6, keyWidth: "10ch" } }}
      />
    );
  }
  const data: ChannelData = {
    channel: read.data,
    schema: schema.data !== undefined ? schema.data : schema.error !== null ? null : undefined,
    agents: agents.data?.agents ?? [],
  };
  return (
    <DetailPage
      header={{
        path: [...scope, { label: "channels", href: "/channels" }, { label: data.channel.name }],
        title: data.channel.name,
        count: data.channel.plugin,
        status: <ChannelStatusMark status={data.channel.status} />,
      }}
      tabs={tabs}
      inspectorTitle={t("detail.inspectorTitle")}
      inspector={<Inspector data={data} />}
    >
      {tab === "overview" ? (
        <OverviewTab channel={data.channel} update={update} />
      ) : tab === "credentials" ? (
        <CredentialsTab
          key={data.channel.updatedAt}
          channel={data.channel}
          schema={data.schema}
          update={update}
        />
      ) : (
        <SettingsTab
          key={data.channel.updatedAt}
          orgId={orgId}
          channel={data.channel}
          agents={data.agents}
          update={update}
        />
      )}
    </DetailPage>
  );
}

function Inspector({ data }: { data: ChannelData }) {
  const t = useTranslations("channels");
  const { channel } = data;
  const agent = data.agents.find((a) => a.id === channel.agentId);
  return (
    <KeyValue
      keyWidth="10ch"
      rows={[
        { k: t("inspector.plugin"), v: channel.plugin },
        { k: t("inspector.tenant"), v: channel.tenantId ?? "—" },
        { k: t("inspector.bot"), v: channel.botUserId ?? "—" },
        { k: t("inspector.agent"), v: agent?.definition.name ?? channel.agentId },
        { k: t("inspector.policy"), v: t(`policy.${channel.unboundPolicy}`) },
        { k: t("inspector.created"), v: <DateTime value={channel.createdAt} /> },
      ]}
    />
  );
}

/** 概览：状态、最近错误与启停。 */
function OverviewTab({ channel, update }: { channel: ChannelConnection; update: Update }) {
  const t = useTranslations("channels");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const active = channel.status !== "disabled";

  async function toggle() {
    setPending(true);
    try {
      // The status shows its new state where it was clicked: no success toast (spec §6 selection)
      await update({ status: active ? "disabled" : "active" });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Stack gap={16}>
      <Card title={t("detail.statusTitle")} actions={<ChannelStatusMark status={channel.status} />}>
        <Stack gap={12}>
          {channel.lastError !== null ? (
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("detail.lastError")}
              </Text>
              <Text tone="fail" icon="circle-x">
                {channel.lastError}
              </Text>
            </Stack>
          ) : (
            <Text tone="muted">{t("detail.noError")}</Text>
          )}
          <Text variant="small" tone="muted">
            {t(active ? "detail.disableHint" : "detail.enableHint")}
          </Text>
          <Stack direction="row">
            <Button
              variant={active ? "default" : "primary"}
              loading={pending}
              onClick={() => void toggle()}
            >
              {t(active ? "detail.disable" : "detail.enable")}
            </Button>
          </Stack>
        </Stack>
      </Card>
      <InboundCard key={channel.inboundMode} channel={channel} update={update} />
    </Stack>
  );
}

/**
 * Inbound mode: long connection (default) or webhook. Webhook needs plugin support and the
 * deployment's webhook base URL; the callback URL to register with the platform is read-only.
 */
function InboundCard({ channel, update }: { channel: ChannelConnection; update: Update }) {
  const t = useTranslations("channels");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [mode, setMode] = useState<InboundMode>(channel.inboundMode);
  const [pending, setPending] = useState(false);
  const available = channel.webhookSupported && channel.webhookUrl !== null;
  // Switching is offered when webhooks are available, or to get back from webhook mode
  const switchable = available || channel.inboundMode === "webhook";

  async function save() {
    setPending(true);
    try {
      await update({ inboundMode: mode });
      toast.success(t("detail.inboundSaved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("detail.inboundTitle")}>
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("detail.inboundHint")}
        </Text>
        {channel.inboundMode === "webhook" && channel.webhookUrl === null && (
          <Text tone="warn">{`! ${t("detail.webhookNoUrlWarning")}`}</Text>
        )}
        {switchable ? (
          <RadioGroup
            label={t("detail.inboundLabel")}
            variant="card"
            value={mode}
            disabled={pending}
            onChange={(v) => setMode(v as InboundMode)}
            options={(["long_connection", "webhook"] as const).map((v) => ({
              value: v,
              label: t(`inboundMode.${v}`),
              description: t(`inboundModeHint.${v}`),
            }))}
          />
        ) : (
          <Text variant="small" tone="muted">
            {t(channel.webhookSupported ? "detail.inboundNoBaseUrl" : "detail.inboundUnsupported")}
          </Text>
        )}
        {mode === "webhook" && channel.webhookUrl !== null && (
          <Field label={t("detail.callbackUrl")} help={t("detail.callbackUrlHint")}>
            <Input value={channel.webhookUrl} readOnly />
          </Field>
        )}
        {switchable && (
          <Stack direction="row">
            <Button
              variant="primary"
              loading={pending}
              disabled={mode === channel.inboundMode}
              onClick={() => void save()}
            >
              {t("detail.saveInbound")}
            </Button>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

/** 凭据：按连接 schema 修改配置；密钥不动则保留、「替换」即轮换、「清除」删掉可选密钥。 */
function CredentialsTab({
  channel,
  schema,
  update,
}: {
  channel: ChannelConnection;
  schema: JsonSchema | null | undefined;
  update: Update;
}) {
  const t = useTranslations("channels");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [form, setForm] = useState({
    config: channelConfig(channel.config),
    ok: true,
    dirty: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[]; issues: ConfigIssue[] }>();
  if (schema === undefined) {
    return (
      <Card title={t("detail.credentialsTitle")}>
        <Skeleton rows={3} />
      </Card>
    );
  }
  if (schema === null) {
    return (
      <Card title={t("detail.credentialsTitle")}>
        <Text tone="muted">{t("detail.schemaUnavailable")}</Text>
      </Card>
    );
  }

  async function save() {
    setPending(true);
    setError(undefined);
    try {
      await update({ config: form.config });
      toast.success(t("detail.credentialsSaved"));
    } catch (e) {
      const issues = configIssues(e);
      setError({
        message: errorMessage(e),
        extra: issues.length > 0 ? [] : issueLines(e),
        issues,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("detail.credentialsTitle")}>
      <Stack gap={16}>
        <Text variant="prose" tone="muted">
          {t("detail.credentialsHint")}
        </Text>
        <ConfigForm
          schema={schema}
          value={channel.config ?? {}}
          meta={channelFormMeta(channel.secrets)}
          issues={error?.issues ?? []}
          disabled={pending}
          onChange={(value, _entries, state) =>
            setForm({
              config: channelConfig(value),
              ok: state.problems.length === 0,
              dirty: state.dirty,
            })
          }
        />
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        <Stack direction="row">
          <Button
            variant="primary"
            loading={pending}
            disabled={!form.dirty || !form.ok}
            onClick={() => void save()}
          >
            {t("detail.saveCredentials")}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

/** 设置：改名、绑定的 agent、未绑定策略；危险区删除。 */
function SettingsTab({
  orgId,
  channel,
  agents,
  update,
}: {
  orgId: string;
  channel: ChannelConnection;
  agents: Agent[];
  update: Update;
}) {
  const t = useTranslations("channels");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(channel.name);
  const [agentId, setAgentId] = useState(channel.agentId);
  const [policy, setPolicy] = useState<UnboundPolicy>(channel.unboundPolicy);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // A delete invalidates the org's connections (the list this page goes back to) and forgets the
  // connection once this page is left.
  const remove = useAppMutation({
    fn: () => deleteChannel(orgId, channel.id),
    invalidates: () => [keys.org(orgId).channels()],
    forgetsOnLeave: () => [keys.org(orgId).channel(channel.id)],
  });
  const dirty =
    name.trim() !== channel.name || agentId !== channel.agentId || policy !== channel.unboundPolicy;

  async function save() {
    if (name.trim() === "") return;
    setPending(true);
    try {
      await update({
        ...(name.trim() !== channel.name ? { name: name.trim() } : {}),
        ...(agentId !== channel.agentId ? { agentId } : {}),
        ...(policy !== channel.unboundPolicy ? { unboundPolicy: policy } : {}),
      });
      toast.success(t("detail.saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Stack gap={16}>
      <Card title={t("detail.settingsTitle")}>
        <Stack gap={12}>
          <Field label={t("form.nameLabel")} required>
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />
          <PolicyRadio value={policy} onChange={setPolicy} />
          <Stack direction="row">
            <Button
              variant="primary"
              loading={pending}
              disabled={!dirty || name.trim() === ""}
              onClick={() => void save()}
            >
              {t("detail.save")}
            </Button>
          </Stack>
        </Stack>
      </Card>
      <Card tone="danger" title={t("detail.dangerTitle")}>
        <Stack gap={12}>
          <Text variant="prose" tone="muted">
            {t("detail.deleteHint")}
          </Text>
          <Stack direction="row">
            <Button variant="danger" onClick={() => setConfirm(true)}>
              {t("detail.delete")}
            </Button>
          </Stack>
        </Stack>
      </Card>
      <DangerConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={t("detail.deleteTitle", { name: channel.name })}
        description={t("detail.deleteHint")}
        confirmName={channel.name}
        confirmLabel={t("detail.delete")}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(undefined);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          setConfirm(false);
          router.push("/channels");
        }}
      />
    </Stack>
  );
}
