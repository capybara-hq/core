"use client";

import { Stack } from "@capybara-hq/design";
import type { AgentToolRef } from "../../lib/agents";
import { AGENT_TOOL, useSubagentsForm } from "../AgentSubagents";
import { replaceToolRefs, savedDefinition } from "./definition-parts";
import {
  SaveFeedback,
  useDefinitionSave,
  useSectionActionRow,
  WithFormData,
} from "./definition-save";
import type { AgentFormData } from "./form-data";
import { AgentSectionFrame, useAgentPage } from "./frame";

const isAgentTool = (r: AgentToolRef) => r.kind === "builtin" && r.name === AGENT_TOOL;

/**
 * 子 Agent Sub-agents (agent profile design §3.2): the `Agent` tool and the `subagents` block.
 * The rules that depend on who can see the agent (the "shared more widely" warning) read the
 * **saved** visibility. Its save sends the saved definition with only the `Agent` tool reference
 * and `subagents` changed (no block when there is nothing and there was nothing).
 */
export function SubagentsSection() {
  return <WithFormData>{(data) => <SubagentsEdit data={data} />}</WithFormData>;
}

function SubagentsEdit({ data }: { data: AgentFormData }) {
  const { agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const form = useSubagentsForm(agent, agent.visibility, data.subagents, save.begin);

  async function onSave() {
    if (save.pending) return;
    const { subagents: _old, ...rest } = savedDefinition(agent);
    form.showProblems(undefined);
    const r = await save.send({
      ...rest,
      tools: replaceToolRefs(
        agent.definition.tools ?? [],
        isAgentTool,
        form.agentTool ? [{ kind: "builtin", name: AGENT_TOOL }] : [],
      ),
      ...(form.value !== undefined ? { subagents: form.value } : {}),
    });
    if (r.saved) form.reset();
    else form.showProblems(r.error);
  }

  function discard() {
    form.reset();
    save.clear();
  }

  return (
    <AgentSectionFrame
      dirty={form.dirty}
      actionRow={actionRow({
        unsaved: form.unsaved,
        errors: form.errors + (save.error ? 1 : 0),
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} />
        {form.section}
      </Stack>
    </AgentSectionFrame>
  );
}
