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
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AgentSelect, PolicyRadio } from "../../../../components/ChannelFields";
import { ConfigForm } from "../../../../components/config-form/ConfigForm";
import { channelConfig } from "../../../../components/config-form/channel";
import { FormError } from "../../../../components/form-error";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { ApiClientError, configIssues, issueLines } from "../../../../lib/api";
import type { LocalizedName } from "../../../../lib/catalog";
import { createChannel, getChannelSchema, type UnboundPolicy } from "../../../../lib/channels";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import type { ConfigIssue } from "../../../../lib/json-schema";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/channels/new`：新建渠道连接（FormPage）：选插件（该组织已启用、提供 `channel@1` 的）→
 * 按插件的连接 schema 填写配置 → 绑定 agent → 未绑定策略。保存时内核先向平台校验凭据。With no
 * channel extension enabled there is nothing to create: the page is only the empty state pointing
 * at the extension settings, never a form. A create form: the primary waits until it is valid.
 * The plugins, the agents and the preset (`?agentId=&returnTo=`, from an agent page) come from the server
 * (`page.tsx`); a plugin's schema loads when it is picked.
 */
export default function NewChannelView({
  orgId,
  initial,
}: {
  orgId: string;
  initial: {
    plugins: { name: string; displayName: LocalizedName | null }[];
    agents: Agent[];
    preset: { agentId: string; returnTo: string | undefined };
  };
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
  const preset = initial.preset;
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
  const schema = useLoad(
    () =>
      plugin === "" ? Promise.resolve(null) : getChannelSchema(orgId, plugin).then((r) => r.schema),
    [orgId, plugin],
    // no plugin picked yet: no schema (nothing to read until the person picks one)
    { initial: null },
  );

  const ready = initial;
  const js = schema.state.kind === "ready" ? schema.state.data : null;
  const current = form?.plugin === plugin ? form : undefined;
  const config = current?.config ?? {};
  const configInvalid = current?.ok === false;
  const missing = [
    plugin === "",
    name.trim() === "",
    agentId === "",
    schema.state.kind !== "ready",
    configInvalid,
  ].filter(Boolean).length;
  const back = () => router.push(preset.returnTo ?? "/channels");

  async function submit() {
    if (missing > 0) return;
    setPending(true);
    setError(undefined);
    try {
      const { channel } = await createChannel(orgId, {
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
  if (ready.plugins.length === 0) {
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
              ...ready.plugins.map((p) => ({ value: p.name, label: extensionLabel(p, lang) })),
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
        ) : schema.state.kind === "loading" ? (
          <Skeleton rows={3} />
        ) : schema.state.kind === "error" ? (
          <FormError message={errorMessage(new ApiClientError(0, schema.state.code, ""))} />
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
        {ready.agents.length === 0 ? (
          <Text tone="muted">{t("form.noAgents")}</Text>
        ) : (
          <AgentSelect agents={ready.agents} value={agentId} onChange={setAgentId} />
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
