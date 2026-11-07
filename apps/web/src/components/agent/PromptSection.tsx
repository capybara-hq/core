"use client";

import { FormSection, Stack } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { readInstructionFiles } from "../../lib/instruction-files";
import { savedDefinition } from "./definition-parts";
import { SaveFeedback, useDefinitionSave, useSectionActionRow } from "./definition-save";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { useInstructionFilesEditor } from "./InstructionFilesEditor";

/**
 * 提示词 Prompt (agent profile design §3.3): the agent's named `.md` files in the shared
 * {@link useInstructionFilesEditor}. An agent saved without files (every old version) shows one
 * `AGENTS.md` holding its instructions. Save sends `instructionFiles` and no `instructions` (the
 * kernel derives it; a stale one next to the files would be refused). The names and limits are
 * checked here only as hints: the kernel judges.
 */
export function PromptSection() {
  const t = useTranslations("agents.page.prompt");
  const tp = useTranslations("agents.page");
  const { agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const files = useInstructionFilesEditor(
    readInstructionFiles(agent.definition),
    save.pending,
    save.begin,
  );

  async function onSave() {
    if (save.pending) return;
    if (!files.check()) return;
    const { instructions: _derived, ...rest } = savedDefinition(agent);
    const r = await save.send({ ...rest, instructionFiles: files.files });
    if (r.saved) files.saved();
  }

  function discard() {
    files.discard();
    save.clear();
  }

  return (
    <AgentSectionFrame
      dirty={files.unsaved > 0}
      actionRow={actionRow({
        unsaved: files.unsaved,
        errors: files.errors + (save.error ? 1 : 0),
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} />
        <FormSection
          id="prompt"
          layout="stacked"
          title={tp("sections.prompt")}
          description={t("hint")}
        >
          {files.editor}
        </FormSection>
      </Stack>
    </AgentSectionFrame>
  );
}
