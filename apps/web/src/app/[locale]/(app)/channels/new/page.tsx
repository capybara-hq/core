"use client";

import {
  Button,
  Field,
  FormPage,
  FormSection,
  Input,
  Select,
  Skeleton,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentSelect, PolicyRadio } from "../../../../../components/ChannelFields";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import {
  draftToConfig,
  initialDraft,
  type SchemaDraft,
  SchemaForm,
  schemaFields,
} from "../../../../../components/SchemaForm";
import { useRouter } from "../../../../../i18n/navigation";
import { listAgents } from "../../../../../lib/agents";
import { ApiClientError, issueLines } from "../../../../../lib/api";
import { createChannel, getChannelSchema, type UnboundPolicy } from "../../../../../lib/channels";
import { listOrgPlugins, provides } from "../../../../../lib/extensions";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/channels/new`：新建渠道连接（FormPage）：选插件（该组织已启用、提供 `channel@1` 的）→
 * 按插件的连接 schema 填写配置 → 绑定 agent → 未绑定策略。保存时内核先向平台校验凭据。
 */
export default function NewChannelPage() {
  return <OrgGate>{(orgId) => <NewChannel key={orgId} orgId={orgId} />}</OrgGate>;
}

async function loadOptions(orgId: string) {
  const [{ extensions: plugins }, { agents }] = await Promise.all([
    listOrgPlugins(orgId),
    listAgents(orgId),
  ]);
  return {
    plugins: plugins.filter((p) => p.enabled && provides(p, "channel")).map((p) => p.plugin),
    agents,
  };
}

function NewChannel({ orgId }: { orgId: string }) {
  const t = useTranslations("channels");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const options = useLoad(() => loadOptions(orgId), [orgId]);
  const [plugin, setPlugin] = useState("");
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [policy, setPolicy] = useState<UnboundPolicy>("bind");
  // 草稿属于当时所选的插件：换插件后回到新 schema 的初始草稿
  const [stored, setStored] = useState<{ plugin: string; draft: SchemaDraft }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [attempted, setAttempted] = useState(false);
  const schema = useLoad(
    () =>
      plugin === "" ? Promise.resolve(null) : getChannelSchema(orgId, plugin).then((r) => r.schema),
    [orgId, plugin],
  );

  const ready = options.state.kind === "ready" ? options.state.data : undefined;
  const js = schema.state.kind === "ready" ? schema.state.data : null;
  const draft = stored?.plugin === plugin ? stored.draft : initialDraft(js, null);
  const setDraft = (next: SchemaDraft) => setStored({ plugin, draft: next });
  const fields = schemaFields(js);
  const { config, errors: configErrors } = draftToConfig(fields, draft, "create");
  const nameError = attempted && name.trim() === "" ? t("form.nameRequired") : undefined;
  const configInvalid = Object.keys(configErrors).length > 0;
  const missing = [
    plugin === "",
    name.trim() === "",
    agentId === "",
    schema.state.kind !== "ready",
    configInvalid,
  ].filter(Boolean).length;
  const back = () => router.push("/channels");

  async function submit() {
    setAttempted(true);
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
      router.push(`/channels/${channel.id}`);
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
    <FormPage
      header={{ parent: { label: t("title"), href: "/channels" }, title: t("form.title") }}
      anchors={[
        { id: "plugin", label: t("form.pluginSection") },
        { id: "config", label: t("form.configSection"), error: attempted && configInvalid },
        { id: "agent", label: t("form.agentSection") },
        { id: "policy", label: t("form.policySection") },
      ]}
      actionRow={{
        ...(attempted && missing > 0 ? { errors: missing } : {}),
        cancel: { label: tc("cancel"), onSelect: back },
        primary: {
          label: t("form.submit"),
          onSelect: () => void submit(),
          loading: pending,
          disabled: ready === undefined,
        },
      }}
    >
      {options.state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : options.state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, options.state.code, ""))} />
      ) : (
        <>
          <FormSection
            id="plugin"
            title={t("form.pluginSection")}
            description={t("form.pluginHint")}
          >
            {ready?.plugins.length === 0 ? (
              <Stack gap={8}>
                <Text>{t("form.noPlugins")}</Text>
                <Stack direction="row">
                  <Button onClick={() => router.push("/settings/plugins")}>
                    {t("form.openPlugins")}
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Field label={t("form.pluginLabel")} required>
                <Select
                  value={plugin}
                  onChange={(e) => setPlugin(e.target.value)}
                  options={[
                    ...(plugin === "" ? [{ value: "", label: t("form.pluginPlaceholder") }] : []),
                    ...(ready?.plugins ?? []).map((p) => ({ value: p, label: p })),
                  ]}
                />
              </Field>
            )}
            <Field
              label={t("form.nameLabel")}
              required
              {...(nameError !== undefined ? { error: nameError } : {})}
            >
              <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </Field>
          </FormSection>
          <FormSection
            id="config"
            title={t("form.configSection")}
            description={t("form.configHint")}
          >
            {plugin === "" ? (
              <Text tone="muted">{t("form.pickPluginFirst")}</Text>
            ) : schema.state.kind === "loading" ? (
              <Skeleton rows={3} />
            ) : schema.state.kind === "error" ? (
              <FormError message={errorMessage(new ApiClientError(0, schema.state.code, ""))} />
            ) : (
              <SchemaForm
                schema={js}
                draft={draft}
                onChange={setDraft}
                mode="create"
                disabled={pending}
                showRequired={attempted}
              />
            )}
          </FormSection>
          <FormSection
            id="agent"
            title={t("form.agentSection")}
            description={t("form.agentSectionHint")}
          >
            {ready?.agents.length === 0 ? (
              <Text tone="muted">{t("form.noAgents")}</Text>
            ) : (
              <AgentSelect agents={ready?.agents ?? []} value={agentId} onChange={setAgentId} />
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
        </>
      )}
    </FormPage>
  );
}
