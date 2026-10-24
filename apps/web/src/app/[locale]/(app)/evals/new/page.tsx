"use client";

import {
  Field,
  FormPage,
  FormSection,
  Input,
  Select,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useRouter } from "../../../../../i18n/navigation";
import { listAgents } from "../../../../../lib/agents";
import { createEvalSet } from "../../../../../lib/evals";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/evals/new`：新建评测集（FormPage）：选 agent，填名称、说明与评分标准（rubric，给评委模型看，英文）；
 * 创建后进评测集详情。
 */
export default function NewEvalSetPage() {
  return <OrgGate>{(orgId) => <NewEvalSet key={orgId} orgId={orgId} />}</OrgGate>;
}

function NewEvalSet({ orgId }: { orgId: string }) {
  const t = useTranslations("evals");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const agents = useLoad(() => listAgents(orgId).then((r) => r.agents), [orgId]);
  const list = agents.state.kind === "ready" ? agents.state.data : [];
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubric, setRubric] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 缺省选第一个 agent
  const chosen = agentId !== "" ? agentId : (list[0]?.id ?? "");
  const nameError = touched && name.trim() === "" ? t("form.nameRequired") : undefined;
  const unsaved = [name, description, rubric].filter((v) => v !== "").length;
  const back = () => router.push("/evals");

  const submit = async () => {
    setTouched(true);
    if (name.trim() === "" || chosen === "") return;
    setPending(true);
    setError(null);
    try {
      const { set } = await createEvalSet(orgId, {
        agentId: chosen,
        name: name.trim(),
        ...(description !== "" && { description }),
        ...(rubric.trim() !== "" && { rubric }),
      });
      router.push(`/evals/${encodeURIComponent(set.id)}`);
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <FormPage
      header={{ parent: { label: t("title"), href: "/evals" }, title: t("form.title") }}
      anchors={[
        { id: "basic", label: t("form.basic"), ...(nameError && { error: true }) },
        { id: "grading", label: t("form.grading") },
      ]}
      actionRow={{
        unsaved,
        errors: nameError ? 1 : 0,
        cancel: { label: tc("cancel"), onSelect: back },
        primary: {
          label: t("form.submit"),
          onSelect: () => void submit(),
          loading: pending,
          disabled: pending || chosen === "",
        },
      }}
    >
      <FormSection id="basic" title={t("form.basic")} description={t("form.basicHint")}>
        <Stack gap={12}>
          <Field label={t("form.agentLabel")} required>
            <Select
              value={chosen}
              onChange={(e) => setAgentId(e.target.value)}
              options={list.map((a) => ({ value: a.id, label: a.definition.name || a.id }))}
              disabled={list.length === 0}
            />
          </Field>
          {agents.state.kind === "ready" && list.length === 0 ? (
            <Text tone="muted">{t("form.noAgents")}</Text>
          ) : null}
          <Field label={t("form.nameLabel")} required {...(nameError && { error: nameError })}>
            <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("form.descriptionLabel")} optional>
            <Textarea
              value={description}
              maxLength={2000}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </Stack>
      </FormSection>
      <FormSection id="grading" title={t("form.grading")} description={t("form.gradingHint")}>
        <Field label={t("form.rubricLabel")} optional help={t("form.rubricHint")}>
          <Textarea
            value={rubric}
            maxLength={20_000}
            rows={8}
            onChange={(e) => setRubric(e.target.value)}
          />
        </Field>
        {error !== null ? <FormError message={error} /> : null}
      </FormSection>
    </FormPage>
  );
}
