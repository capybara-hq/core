"use client";

import {
  Button,
  Card,
  Field,
  Grid,
  Input,
  Repeater,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { Agent } from "../../lib/agents";
import {
  fileNameProblems,
  INSTRUCTION_FILE_LIMITS,
  type InstructionFile,
  joinInstructionFiles,
  newFileName,
  readInstructionFiles,
} from "../../lib/instruction-files";
import { sameJson, savedDefinition } from "./definition-parts";
import { SaveFeedback, useDefinitionSave, useSectionActionRow } from "./definition-save";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { useSectionDraft } from "./useSectionDraft";

type Entry = InstructionFile & { key: string };
type Draft = { files: Entry[] };

const draftOf = (a: Agent): Draft => ({
  files: readInstructionFiles(a.definition).map((f, i) => ({ key: `saved-${i}`, ...f })),
});
/** What a draft saves: the files in order, without their keys. */
const filesOf = (d: Draft): InstructionFile[] =>
  d.files.map(({ name, content }) => ({ name, content }));

/**
 * 提示词 Prompt (agent profile design §3.3): the agent's named `.md` files, the list on the left
 * (add, delete but never the last one, reorder) and the open file's name and content on the
 * right, with the joined character count against 100 000 and the file count against 20. An agent
 * saved without files (every old version) shows one `AGENTS.md` holding its instructions. Save
 * sends `instructionFiles` and no `instructions` (the kernel derives it; a stale one next to the
 * files would be refused). The names and limits are checked here only as hints: the kernel judges.
 */
export function PromptSection() {
  const t = useTranslations("agents.page.prompt");
  const { agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const saved = draftOf(agent);
  const draft = useSectionDraft(saved);
  const [open, setOpen] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const next = useRef(0);
  const files = draft.draft.files;
  const current = files.find((f) => f.key === open) ?? files[0];
  const index = current ? files.indexOf(current) : -1;
  const edit = (fn: (d: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  const problems = fileNameProblems(files);
  const joined = joinInstructionFiles(files).length;
  const tooLong = joined > INSTRUCTION_FILE_LIMITS.joinedChars;
  // a name problem shows once the name is edited away from the saved one, or after a save attempt
  const nameProblem = (i: number) => {
    const p = problems[i] ?? null;
    if (p === null) return null;
    const f = files[i];
    return checked || saved.files.every((s) => s.name !== f?.name) ? p : null;
  };
  const invalidCount = problems.filter((_, i) => nameProblem(i) !== null).length;
  const unsaved = draft.dirty && !sameJson(filesOf(draft.draft), filesOf(saved)) ? 1 : 0;

  async function onSave() {
    if (save.pending) return;
    setChecked(true);
    if (problems.some((p) => p !== null) || tooLong) return;
    const { instructions: _derived, ...rest } = savedDefinition(agent);
    const r = await save.send({ ...rest, instructionFiles: filesOf(draft.draft) });
    if (r.saved) {
      draft.reset();
      setChecked(false);
      // the saved files are keyed by position: keep the open one open
      setOpen(`saved-${Math.max(index, 0)}`);
    }
  }

  function discard() {
    draft.reset();
    save.clear();
    setChecked(false);
  }

  const problem = index < 0 ? null : nameProblem(index);
  return (
    <AgentSectionFrame
      dirty={unsaved > 0}
      actionRow={actionRow({
        unsaved,
        errors: invalidCount + (checked && tooLong ? 1 : 0) + (save.error ? 1 : 0),
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} />
        <Text variant="small" tone="muted">
          {t("hint")}
        </Text>
        <Grid columns="form">
          <Stack gap={8}>
            <Repeater
              variant="rows"
              label={t("filesLabel")}
              addLabel={t("add")}
              min={1}
              max={INSTRUCTION_FILE_LIMITS.count}
              disabled={save.pending}
              items={files.map((f, i) => ({
                key: f.key,
                title: f.name,
                invalid: nameProblem(i) !== null,
                body: (
                  <Button
                    variant="ghost"
                    density="dense"
                    aria-pressed={f.key === current?.key}
                    onClick={() => setOpen(f.key)}
                  >
                    {f.name}
                  </Button>
                ),
              }))}
              onAdd={() => {
                next.current += 1;
                const key = `new-${next.current}`;
                edit((d) =>
                  d.files.length >= INSTRUCTION_FILE_LIMITS.count
                    ? d
                    : { files: [...d.files, { key, name: newFileName(d.files), content: "" }] },
                );
                setOpen(key);
              }}
              onRemove={(key) => {
                const before = files;
                edit((d) =>
                  d.files.length <= 1 ? d : { files: d.files.filter((f) => f.key !== key) },
                );
                return () => edit(() => ({ files: before }));
              }}
              onMove={(key, to) =>
                edit((d) => {
                  const from = d.files.findIndex((f) => f.key === key);
                  if (from < 0) return d;
                  const list = [...d.files];
                  const [moved] = list.splice(from, 1);
                  if (moved) list.splice(to, 0, moved);
                  return { files: list };
                })
              }
            />
            <Text variant="small" tone={tooLong ? "fail" : "muted"}>
              {t("count", {
                chars: joined,
                maxChars: INSTRUCTION_FILE_LIMITS.joinedChars,
                files: files.length,
                maxFiles: INSTRUCTION_FILE_LIMITS.count,
              })}
            </Text>
            {checked && tooLong ? (
              <Text variant="small" tone="fail">
                {t("tooLong", { max: INSTRUCTION_FILE_LIMITS.joinedChars })}
              </Text>
            ) : null}
          </Stack>
          {current ? (
            <Card title={current.name}>
              <Stack gap={12}>
                <Field
                  label={t("nameLabel")}
                  required
                  help={t("nameHelp")}
                  {...(problem === "duplicate"
                    ? { error: t("nameDuplicate") }
                    : problem === "invalid"
                      ? { error: t("nameInvalid") }
                      : {})}
                >
                  <Input
                    name="file-name"
                    disabled={save.pending}
                    maxLength={67}
                    value={current.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      edit((d) => ({
                        files: d.files.map((f) => (f.key === current.key ? { ...f, name } : f)),
                      }));
                    }}
                  />
                </Field>
                <Field label={t("contentLabel")} help={t("contentHelp")}>
                  <Textarea
                    code
                    name="file-content"
                    disabled={save.pending}
                    rows={16}
                    maxLength={INSTRUCTION_FILE_LIMITS.joinedChars}
                    value={current.content}
                    onChange={(e) => {
                      const content = e.target.value;
                      edit((d) => ({
                        files: d.files.map((f) => (f.key === current.key ? { ...f, content } : f)),
                      }));
                    }}
                  />
                </Field>
              </Stack>
            </Card>
          ) : null}
        </Grid>
      </Stack>
    </AgentSectionFrame>
  );
}
