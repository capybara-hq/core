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
import { FormError } from "../../../../components/form-error";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { createEvalSet } from "../../../../lib/evals";
import { useErrorMessage } from "../../../../lib/use-error-message";

/**
 * `/evals/new`: a new eval set (FormPage): pick an agent (the list comes from the server), fill in
 * the name, description and rubric (read by the judge model, English); creating opens the set.
 */
export default function NewEvalSet({ orgId, agents }: { orgId: string; agents: Agent[] }) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const list = agents;
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubric, setRubric] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first agent by default
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
      header={{
        path: [...scope, { label: "evals", href: "/evals" }, { label: "new" }],
        title: t("form.title"),
      }}
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
          {list.length === 0 ? <Text tone="muted">{t("form.noAgents")}</Text> : null}
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
