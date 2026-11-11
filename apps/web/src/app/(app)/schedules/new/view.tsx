"use client";

import { FormPage, FormSection, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import {
  ApprovedToolsSection,
  createBodyOf,
  draftValid,
  emptyDraft,
  LOADING_SECTIONS,
  type ScheduleDraft,
  ScheduleFormSections,
  useGrantableTools,
} from "../../../../components/ScheduleForm";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent, ProviderModels } from "../../../../lib/agents";
import { agentsQuery } from "../../../../lib/query/agents";
import { retryOnMountOf } from "../../../../lib/query/client";
import { modelsQuery } from "../../../../lib/query/conversation";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { browserTimeZone, createSchedule } from "../../../../lib/schedules";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/schedules/new`: a new scheduled task (FormPage, spec §10): basics, the schedule (presets that
 * write cron; the task takes my time zone), where runs go, model and effort, and the tools approved
 * up front. A create form: focus starts on the name, the primary waits for a valid form; creating
 * opens the task. Members up (guests: the no-access state). From the query cache (the layout
 * prefetched the agents and the models on a first load).
 */
export default function NewScheduleView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewSchedule orgId={ws.orgId} />;
}

function NewSchedule({ orgId }: { orgId: string }) {
  const read = usePageQuery(agentsQuery(orgId));
  const modelsQ = modelsQuery(orgId);
  const models = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data;
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const agents = read.kind === "ready" ? read.data.agents : null;
  return (
    <NewScheduleForm
      key={agents === null ? "loading" : "ready"}
      orgId={orgId}
      agents={agents}
      providers={models?.providers ?? []}
    />
  );
}

function NewScheduleForm({
  orgId,
  agents,
  providers,
}: {
  orgId: string;
  /** `null` while the agents load. */
  agents: Agent[] | null;
  providers: ProviderModels[];
}) {
  const scope = usePagePath("org");
  const t = useTranslations("schedules");
  const tc = useTranslations("common");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const list = agents ?? [];
  const loading = agents === null;
  const [draft, setDraft] = useState<ScheduleDraft>(() => emptyDraft(list[0]?.id ?? ""));
  const [grants, setGrants] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const agent = list.find((a) => a.id === draft.agentId);
  const grantable = useGrantableTools(orgId, agent);
  const create = useAppMutation({
    fn: () => createSchedule(orgId, createBodyOf(draft, grants, browserTimeZone())),
    invalidates: () => [keys.org(orgId).schedulesAll()],
  });
  const unsaved = [draft.name, draft.prompt].filter((v) => v.trim() !== "").length + grants.length;
  const valid = draftValid(draft);

  const submit = async () => {
    if (!valid) return;
    setError(null);
    try {
      const { task } = await create.mutateAsync(undefined);
      toast.success(t("actions.created"));
      router.push(`/schedules/${encodeURIComponent(task.id)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <FormPage
      create
      loading={loading}
      header={{
        path: [...scope, { label: "schedules", href: "/schedules" }, { label: "new" }],
        title: t("form.createTitle"),
      }}
      actionRow={{
        unsaved,
        cancel: { label: tc("cancel"), onSelect: () => router.push("/schedules") },
        primary: {
          label: t("form.create"),
          onSelect: () => void submit(),
          loading: create.isPending,
          disabled: create.isPending || !valid,
        },
      }}
    >
      {loading ? (
        <>
          <FormSection
            id="basic"
            title={t("form.basic")}
            description={t("form.basicHint")}
            loading={{ fields: LOADING_SECTIONS.basic }}
          />
          <FormSection
            id="schedule"
            title={t("form.schedule")}
            description={t("form.scheduleHint")}
            loading={{ fields: LOADING_SECTIONS.schedule }}
          />
        </>
      ) : (
        <>
          <ScheduleFormSections
            orgId={orgId}
            draft={draft}
            setDraft={setDraft}
            agents={list}
            providers={providers}
          />
          <ApprovedToolsSection
            granted={grants}
            options={grantable}
            refused={[]}
            onAdd={(k) => setGrants((g) => (g.includes(k) ? g : [...g, k]))}
            onRemove={(k) => setGrants((g) => g.filter((x) => x !== k))}
          />
          {error !== null ? <FormError message={error} /> : null}
        </>
      )}
    </FormPage>
  );
}
