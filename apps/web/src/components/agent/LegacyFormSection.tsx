"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { channelsQuery } from "../../lib/query/channels";
import { retryOnMountOf } from "../../lib/query/client";
import { AgentChannels } from "../AgentChannels";
import {
  type AgentFormData,
  type AgentFormSection,
  useAgentForm,
  useAgentFormData,
} from "../AgentForm";
import { ErrorFrame } from "../ErrorFrame";
import { AgentSectionFrame, useAgentPage } from "./frame";
import type { AgentSection } from "./sections";

/**
 * The sections the agent form still draws (prompt, model, tools, skills, sub-agents) and the
 * channels, until Task 7 gives each its own component. A form section saves only its own edits:
 * the form opens on the saved agent and draws only that section, so the rest of the definition it
 * sends is the saved one (with `expectedVersion`).
 */
export function LegacyFormSection({
  section,
}: {
  section: Exclude<AgentSection, "basics" | "quick-actions">;
}) {
  if (section === "channels") return <ChannelsSection />;
  return <FormSectionBody section={section} />;
}

function ChannelsSection() {
  const { orgId, agent } = useAgentPage();
  const q = channelsQuery(orgId);
  const channels = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  if (channels.data === undefined && channels.error === null) {
    return <AgentSectionFrame loading />;
  }
  return (
    <AgentSectionFrame>
      <AgentChannels
        agentId={agent.id}
        channels={channels.data?.channels.filter((c) => c.agentId === agent.id) ?? null}
      />
    </AgentSectionFrame>
  );
}

function FormSectionBody({ section }: { section: AgentFormSection }) {
  const { orgId, agent } = useAgentPage();
  const state = useAgentFormData(orgId, agent.id);
  // a save or a discard opens the form again on the saved agent
  const [round, setRound] = useState(0);
  if (state.kind === "error") return <ErrorFrame reset={state.retry} />;
  if (state.kind === "loading") return <AgentSectionFrame loading />;
  return (
    <SectionForm
      key={`${agent.currentVersion}-${round}`}
      section={section}
      data={state.data}
      onReset={() => setRound((r) => r + 1)}
    />
  );
}

function SectionForm({
  section,
  data,
  onReset,
}: {
  section: AgentFormSection;
  data: AgentFormData;
  onReset(): void;
}) {
  const t = useTranslations();
  const { orgId, agent } = useAgentPage();
  const form = useAgentForm(orgId, onReset, data, agent, section);
  const dirty = !form.saved && form.unsaved > 0;
  return (
    <AgentSectionFrame
      dirty={dirty}
      actionRow={
        form.saved
          ? { primary: { label: t("agents.form.continue"), onSelect: onReset } }
          : // the template's rule: the row only with changes (or while saving, or after a failure)
            !dirty && !form.pending && form.errors === 0 && !form.failed
            ? undefined
            : {
                unsaved: form.unsaved,
                errors: form.errors,
                ...(dirty
                  ? { cancel: { label: t("agents.page.discard"), onSelect: onReset } }
                  : {}),
                primary: {
                  label: t("agents.form.submit"),
                  onSelect: form.submit,
                  loading: form.pending,
                  disabled: !form.canSubmit,
                },
              }
      }
    >
      {form.sections}
    </AgentSectionFrame>
  );
}
