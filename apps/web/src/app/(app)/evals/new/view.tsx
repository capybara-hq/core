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
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import { createEvalSet } from "../../../../lib/evals";
import { agentsQuery } from "../../../../lib/query/agents";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/evals/new`: a new eval set (FormPage): pick an agent (from the query cache, prefetched by the
 * layout on a first load), fill in the name, description and rubric (read by the judge model,
 * English); creating opens the set and invalidates the sets list. A create form: focus starts on
 * the agent, the primary waits for an agent and a name. `wanted` is `?agentId=`: it presets the
 * agent when it is one of them (otherwise the first agent).
 */
export default function NewEvalSetView({ wanted }: { wanted: string }) {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewEvalSet orgId={ws.orgId} wanted={wanted} />;
}

/** The form's static layout while the agents load: the agent, the name, the description. */
const BASIC_FIELDS = [
  { control: "select" as const },
  {},
  { control: "textarea" as const, rows: 3 },
];

function NewEvalSet({ orgId, wanted }: { orgId: string; wanted: string }) {
  const read = usePageQuery(agentsQuery(orgId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const agents = read.kind === "ready" ? read.data.agents : null;
  const preset = agents?.some((a) => a.id === wanted) ? wanted : "";
  return (
    <NewEvalSetForm
      key={agents === null ? "loading" : "ready"}
      orgId={orgId}
      agents={agents}
      preset={preset}
    />
  );
}

function NewEvalSetForm({
  orgId,
  agents,
  preset,
}: {
  orgId: string;
  /** `null` while the agents load. */
  agents: Agent[] | null;
  preset: string;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const list = agents ?? [];
  const loading = agents === null;
  const create = useAppMutation({
    fn: (body: Parameters<typeof createEvalSet>[1]) => createEvalSet(orgId, body),
    invalidates: () => [keys.org(orgId).evalSets()],
  });
  const [agentId, setAgentId] = useState(preset);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rubric, setRubric] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first agent by default
  const chosen = agentId !== "" ? agentId : (list[0]?.id ?? "");
  const unsaved = [name, description, rubric].filter((v) => v !== "").length;
  const back = () => router.push("/evals");

  const submit = async () => {
    if (name.trim() === "" || chosen === "") return;
    setPending(true);
    setError(null);
    try {
      const { set } = await create.mutateAsync({
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
      create
      loading={loading}
      header={{
        path: [...scope, { label: "evals", href: "/evals" }, { label: "new" }],
        title: t("form.title"),
      }}
      actionRow={{
        unsaved,
        cancel: { label: tc("cancel"), onSelect: back },
        primary: {
          label: t("form.submit"),
          onSelect: () => void submit(),
          loading: pending,
          disabled: pending || chosen === "" || name.trim() === "",
        },
      }}
    >
      <FormSection
        id="basic"
        title={t("form.basic")}
        description={t("form.basicHint")}
        {...(loading ? { loading: { fields: BASIC_FIELDS } } : {})}
      >
        <Stack gap={12}>
          <Field label={t("form.agentLabel")} required>
            <Select
              value={chosen}
              onChange={(e) => setAgentId(e.target.value)}
              options={list.map((a) => ({ value: a.id, label: a.definition.name || a.id }))}
              disabled={list.length === 0}
            />
          </Field>
          {!loading && list.length === 0 ? <Text tone="muted">{t("form.noAgents")}</Text> : null}
          <Field label={t("form.nameLabel")} required>
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
      {/* The rubric needs no data: it renders for real while the agents load. */}
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
