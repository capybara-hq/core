"use client";

import {
  Button,
  Card,
  DangerConfirm,
  DetailPage,
  Field,
  Input,
  KeyValue,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AgentSelect, ChannelStatusMark, PolicyRadio } from "../../../../components/ChannelFields";
import { FormError } from "../../../../components/form-error";
import {
  changedCount,
  draftToConfig,
  initialDraft,
  SchemaForm,
  schemaFields,
} from "../../../../components/SchemaForm";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { issueLines } from "../../../../lib/api";
import {
  type ChannelConnection,
  deleteChannel,
  type InboundMode,
  type UnboundPolicy,
  updateChannel,
} from "../../../../lib/channels";
import type { JsonSchema } from "../../../../lib/json-schema";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useServerState } from "../../../../lib/use-server-state";

const TABS = ["overview", "credentials", "settings"] as const;
type Tab = (typeof TABS)[number];

/**
 * What the server read (`page.tsx`): the connection, its plugin's connection schema (`null` when the
 * plugin is uninstalled or disabled: the credentials tab says so) and the agents (empty when they
 * could not be read).
 */
export interface ChannelData {
  channel: ChannelConnection;
  schema: JsonSchema | null;
  agents: Agent[];
}

/**
 * `/channels/[id]`：渠道连接详情（DetailPage）：概览（状态与最近错误、启停）、凭据（按连接 schema
 * 修改配置与轮换密钥，内核先向平台校验）、设置（改名、绑定的 agent、未绑定策略、删除）。
 * A change the kernel answers with the connection replaces it here.
 */
export default function ChannelView({ orgId, initial }: { orgId: string; initial: ChannelData }) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const [data, set] = useServerState(initial);
  const [tab, setTab] = useState<Tab>("overview");
  const saved = (channel: ChannelConnection) => set({ ...data, channel });
  return (
    <DetailPage
      header={{
        path: [...scope, { label: "channels", href: "/channels" }, { label: data.channel.name }],
        title: data.channel.name,
        count: data.channel.plugin,
        status: <ChannelStatusMark status={data.channel.status} />,
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
        value: tab,
        onChange: (x) => setTab(x as Tab),
      }}
      inspectorTitle={t("detail.inspectorTitle")}
      inspector={<Inspector data={data} />}
    >
      {tab === "overview" ? (
        <OverviewTab orgId={orgId} channel={data.channel} onSaved={saved} />
      ) : tab === "credentials" ? (
        <CredentialsTab
          key={data.channel.updatedAt}
          orgId={orgId}
          channel={data.channel}
          schema={data.schema}
          onSaved={saved}
        />
      ) : (
        <SettingsTab
          key={data.channel.updatedAt}
          orgId={orgId}
          channel={data.channel}
          agents={data.agents}
          onSaved={saved}
        />
      )}
    </DetailPage>
  );
}

function Inspector({ data }: { data: ChannelData }) {
  const t = useTranslations("channels");
  const locale = useLocale();
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
        { k: t("inspector.created"), v: new Date(channel.createdAt).toLocaleString(locale) },
      ]}
    />
  );
}

/** 概览：状态、最近错误与启停。 */
function OverviewTab({
  orgId,
  channel,
  onSaved,
}: {
  orgId: string;
  channel: ChannelConnection;
  onSaved(c: ChannelConnection): void;
}) {
  const t = useTranslations("channels");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const active = channel.status !== "disabled";

  async function toggle() {
    setPending(true);
    try {
      const { channel: next } = await updateChannel(orgId, channel.id, {
        status: active ? "disabled" : "active",
      });
      onSaved(next);
      toast.success(t(active ? "detail.disabledToast" : "detail.enabledToast"));
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
      <InboundCard key={channel.inboundMode} orgId={orgId} channel={channel} onSaved={onSaved} />
    </Stack>
  );
}

/**
 * Inbound mode: long connection (default) or webhook. Webhook needs plugin support and the
 * deployment's webhook base URL; the callback URL to register with the platform is read-only.
 */
function InboundCard({
  orgId,
  channel,
  onSaved,
}: {
  orgId: string;
  channel: ChannelConnection;
  onSaved(c: ChannelConnection): void;
}) {
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
      const { channel: next } = await updateChannel(orgId, channel.id, { inboundMode: mode });
      onSaved(next);
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
        <Text tone="muted">{t("detail.inboundHint")}</Text>
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
  orgId,
  channel,
  schema,
  onSaved,
}: {
  orgId: string;
  channel: ChannelConnection;
  schema: JsonSchema | null;
  onSaved(c: ChannelConnection): void;
}) {
  const t = useTranslations("channels");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [baseline] = useState(() => initialDraft(schema, channel.config));
  const [draft, setDraft] = useState(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  if (schema === null) {
    return (
      <Card title={t("detail.credentialsTitle")}>
        <Text tone="muted">{t("detail.schemaUnavailable")}</Text>
      </Card>
    );
  }
  const fields = schemaFields(schema);
  const { config, errors } = draftToConfig(fields, draft, "edit", channel.secrets);
  const dirty = changedCount(draft, baseline);

  async function save() {
    setPending(true);
    setError(undefined);
    try {
      const { channel: next } = await updateChannel(orgId, channel.id, { config });
      onSaved(next);
      toast.success(t("detail.credentialsSaved"));
    } catch (e) {
      setError({
        message: errorMessage(e),
        extra: issueLines(e),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("detail.credentialsTitle")}>
      <Stack gap={16}>
        <Text tone="muted">{t("detail.credentialsHint")}</Text>
        <SchemaForm
          schema={schema}
          draft={draft}
          onChange={setDraft}
          mode="edit"
          secrets={channel.secrets}
          disabled={pending}
          showRequired={dirty > 0}
        />
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        <Stack direction="row">
          <Button
            variant="primary"
            loading={pending}
            disabled={dirty === 0 || Object.keys(errors).length > 0}
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
  onSaved,
}: {
  orgId: string;
  channel: ChannelConnection;
  agents: Agent[];
  onSaved(c: ChannelConnection): void;
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
  const dirty =
    name.trim() !== channel.name || agentId !== channel.agentId || policy !== channel.unboundPolicy;

  async function save() {
    if (name.trim() === "") return;
    setPending(true);
    try {
      const { channel: next } = await updateChannel(orgId, channel.id, {
        ...(name.trim() !== channel.name ? { name: name.trim() } : {}),
        ...(agentId !== channel.agentId ? { agentId } : {}),
        ...(policy !== channel.unboundPolicy ? { unboundPolicy: policy } : {}),
      });
      onSaved(next);
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
          <Text tone="muted">{t("detail.deleteHint")}</Text>
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
            await deleteChannel(orgId, channel.id);
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
