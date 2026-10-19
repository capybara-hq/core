"use client";

import { Field, RadioGroup, Select, StatusMark } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { Agent } from "../lib/agents";
import type { ChannelStatus, UnboundPolicy } from "../lib/channels";

/** 渠道连接的状态标记（`error` 为长连接最近一次失败）。 */
export function ChannelStatusMark({ status }: { status: ChannelStatus }) {
  const t = useTranslations("channels.status");
  return (
    <StatusMark
      status={status === "active" ? "success" : status === "error" ? "failed" : "cancelled"}
      label={t(status)}
    />
  );
}

/** 连接绑定的 agent。 */
export function AgentSelect({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: Agent[];
  value: string;
  onChange(id: string): void;
  disabled?: boolean;
}) {
  const t = useTranslations("channels.form");
  return (
    <Field label={t("agentLabel")} required help={t("agentHint")}>
      <Select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        options={[
          ...(value === "" ? [{ value: "", label: t("agentPlaceholder") }] : []),
          ...agents.map((a) => ({ value: a.id, label: a.definition.name })),
        ]}
      />
    </Field>
  );
}

/** 未绑定的人发来消息时：发绑定提示，或以匿名访客对话。 */
export function PolicyRadio({
  value,
  onChange,
  disabled,
}: {
  value: UnboundPolicy;
  onChange(v: UnboundPolicy): void;
  disabled?: boolean;
}) {
  const t = useTranslations("channels");
  return (
    <RadioGroup
      label={t("form.policyLabel")}
      variant="card"
      value={value}
      {...(disabled !== undefined ? { disabled } : {})}
      onChange={(v) => onChange(v as UnboundPolicy)}
      options={(["bind", "anonymous"] as const).map((v) => ({
        value: v,
        label: t(`policy.${v}`),
        description: t(`policyHint.${v}`),
      }))}
    />
  );
}
