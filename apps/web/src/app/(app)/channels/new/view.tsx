"use client";

import {
  EmptyState,
  Field,
  FormPage,
  FormSection,
  Input,
  OverviewPage,
  Select,
  Skeleton,
  Text,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AgentSelect, PolicyRadio } from "../../../../components/ChannelFields";
import { ConfigForm } from "../../../../components/config-form/ConfigForm";
import { channelConfig } from "../../../../components/config-form/channel";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { configIssues, issueLines } from "../../../../lib/api";
import type { LocalizedName } from "../../../../lib/catalog";
import { createChannel, type UnboundPolicy } from "../../../../lib/channels";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import { provides } from "../../../../lib/extensions";
import type { ConfigIssue } from "../../../../lib/json-schema";
import { agentsQuery } from "../../../../lib/query/agents";
import { channelSchemaQuery, orgExtensionsQuery } from "../../../../lib/query/channels";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/channels/new`：新建渠道连接（FormPage）：选插件（该组织已启用、提供 `channel@1` 的）→
 * 按插件的连接 schema 填写配置 → 绑定 agent → 未绑定策略。保存时内核先向平台校验凭据。With no
 * channel extension enabled there is nothing to create: the page is only the empty state pointing
 * at the extension settings, never a form. A create form: the primary waits until it is valid.
 * The plugins and the agents come from the query cache (the layout prefetched them on a first
 * load), the preset (`?agentId=&returnTo=`, from an agent page) from `page.tsx`; a plugin's schema
 * is read when it is picked.
 */
export default function NewChannelView({ preset }: { preset: ChannelPreset }) {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewChannel orgId={ws.orgId} preset={preset} />;
}

type ChannelPreset = { agentId: string; returnTo: string | undefined };

function NewChannel({ orgId, preset }: { orgId: string; preset: ChannelPreset }) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const tc = useTranslations("common");
  const extensions = usePageQuery(orgExtensionsQuery(orgId));
  const agents = usePageQuery(agentsQuery(orgId));
  const header = {
    path: [...scope, { label: "channels", href: "/channels" }, { label: "new" }],
    title: t("form.title"),
  };
  const router = useRouter();
  const back = () => router.push(preset.returnTo ?? "/channels");
  if (extensions.kind === "notFound" || agents.kind === "notFound") return <NotFound />;
  if (extensions.kind === "error") return <ErrorFrame reset={extensions.retry} />;
  if (agents.kind === "error") return <ErrorFrame reset={agents.retry} />;
  if (extensions.kind === "loading" || agents.kind === "loading") {
    return (
      <FormPage
        create
        loading
        header={header}
        actionRow={{
          cancel: { label: tc("cancel"), onSelect: back },
          primary: { label: t("form.submit"), onSelect: () => {} },
        }}
      >
        <FormSection
          id="plugin"
          title={t("form.pluginSection")}
          description={t("form.pluginHint")}
          loading={{ fields: [{ control: "select" }, { control: "input" }] }}
        />
        <FormSection
          id="config"
          title={t("form.configSection")}
          description={t("form.configHint")}
          loading={{ fields: 1 }}
        />
        <FormSection
          id="agent"
          title={t("form.agentSection")}
          description={t("form.agentSectionHint")}
          loading={{ fields: [{ control: "select" }] }}
        />
        <FormSection
          id="policy"
          title={t("form.policySection")}
          description={t("form.policySectionHint")}
          loading={{ fields: 1 }}
        />
      </FormPage>
    );
  }
  return (
    <NewChannelForm
      orgId={orgId}
      preset={preset}
      plugins={extensions.data.extensions
        .filter((p) => p.enabled && provides(p, "channel"))
        .map((p) => ({ name: p.plugin, displayName: p.displayName ?? null }))}
      agents={agents.data.agents}
    />
  );
}

function NewChannelForm({
  orgId,
  preset,
  plugins,
  agents,
}: {
  orgId: string;
  preset: ChannelPreset;
  plugins: { name: string; displayName: LocalizedName | null }[];
  agents: Agent[];
}) {
  const scope = usePagePath("org");
  const t = useTranslations("channels");
  const tc = useTranslations("common");
  const lang = labelLocale(useLocale());
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [plugin, setPlugin] = useState("");
  const [name, setName] = useState("");
  // `?agentId=<id>&returnTo=/agents/<id>`: opened from an agent page, which it returns to.
  const [agentId, setAgentId] = useState(preset.agentId);
  const [policy, setPolicy] = useState<UnboundPolicy>("bind");
  // The config belongs to the plugin picked then: another plugin starts its own form (keyed).
  const [form, setForm] = useState<{
    plugin: string;
    config: Record<string, unknown>;
    ok: boolean;
  }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[]; issues: ConfigIssue[] }>();
  // No plugin picked yet: nothing to read until the person picks one (the key's plugin is unused).
  const schema = useQuery({ ...channelSchemaQuery(orgId, plugin), enabled: plugin !== "" });
  // A new connection invalidates the org's connections (the list, an agent's channels section).
  const create = useAppMutation({
    fn: (input: Parameters<typeof createChannel>[1]) => createChannel(orgId, input),
    invalidates: () => [keys.org(orgId).channels()],
  });

  const js = schema.data ?? null;
  const current = form?.plugin === plugin ? form : undefined;
  const config = current?.config ?? {};
  const configInvalid = current?.ok === false;
  const missing = [
    plugin === "",
    name.trim() === "",
    agentId === "",
    schema.data === undefined,
    configInvalid,
  ].filter(Boolean).length;
  const back = () => router.push(preset.returnTo ?? "/channels");

  async function submit() {
    if (missing > 0) return;
    setPending(true);
    setError(undefined);
    try {
      const { channel } = await create.mutateAsync({
        plugin,
        name: name.trim(),
        agentId,
        config,
        unboundPolicy: policy,
      });
      router.push(preset.returnTo ?? `/channels/${channel.id}`);
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

  const header = {
    path: [...scope, { label: "channels", href: "/channels" }, { label: "new" }],
    title: t("form.title"),
  };
  if (plugins.length === 0) {
    return (
      <OverviewPage header={header}>
        <EmptyState
          text={t("form.noExtensions")}
          action={{
            label: t("form.openExtensions"),
            variant: "primary",
            href: "/settings/extensions",
          }}
        />
      </OverviewPage>
    );
  }

  return (
    <FormPage
      create
      header={header}
      actionRow={{
        cancel: { label: tc("cancel"), onSelect: back },
        primary: {
          label: t("form.submit"),
          onSelect: () => void submit(),
          loading: pending,
          disabled: pending || missing > 0,
        },
      }}
    >
      <FormSection id="plugin" title={t("form.pluginSection")} description={t("form.pluginHint")}>
        <Field label={t("form.pluginLabel")} required>
          <Select
            value={plugin}
            onChange={(e) => setPlugin(e.target.value)}
            options={[
              ...(plugin === "" ? [{ value: "", label: t("form.pluginPlaceholder") }] : []),
              ...plugins.map((p) => ({ value: p.name, label: extensionLabel(p, lang) })),
            ]}
          />
        </Field>
        <Field label={t("form.nameLabel")} required>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
      </FormSection>
      <FormSection id="config" title={t("form.configSection")} description={t("form.configHint")}>
        {plugin === "" ? (
          <Text tone="muted">{t("form.pickPluginFirst")}</Text>
        ) : schema.error !== null && schema.data === undefined ? (
          <FormError message={errorMessage(schema.error)} />
        ) : schema.data === undefined ? (
          <Skeleton rows={3} />
        ) : (
          <ConfigForm
            key={plugin}
            schema={js}
            value={{}}
            issues={error?.issues ?? []}
            disabled={pending}
            onChange={(value, _entries, state) =>
              setForm({ plugin, config: channelConfig(value), ok: state.problems.length === 0 })
            }
          />
        )}
      </FormSection>
      <FormSection
        id="agent"
        title={t("form.agentSection")}
        description={t("form.agentSectionHint")}
      >
        {agents.length === 0 ? (
          <Text tone="muted">{t("form.noAgents")}</Text>
        ) : (
          <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />
        )}
      </FormSection>
      <FormSection
        id="policy"
        title={t("form.policySection")}
        description={t("form.policySectionHint")}
      >
        <PolicyRadio value={policy} onChange={setPolicy} />
      </FormSection>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
    </FormPage>
  );
}
