"use client";

import { Button, Field, Grid, Input, Repeater, Stack, Text, Textarea } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useRef, useState } from "react";
import {
  fileNameProblems,
  INSTRUCTION_FILE_LIMITS,
  type InstructionFile,
  joinInstructionFiles,
  newFileName,
} from "../../lib/instruction-files";
import { sameJson } from "./definition-parts";
import { useSectionDraft } from "./useSectionDraft";

type Entry = InstructionFile & { key: string };
type Draft = { files: Entry[] };

const draftOf = (files: readonly InstructionFile[]): Draft => ({
  files: files.map((f, i) => ({ key: `saved-${i}`, ...f })),
});
/** What a draft saves: the files in order, without their keys. */
const filesOf = (d: Draft): InstructionFile[] =>
  d.files.map(({ name, content }) => ({ name, content }));

/** What {@link useInstructionFilesEditor} gives a prompt section. */
export interface InstructionFilesEditor {
  /** The list + editor grid (spec §5.8 "List + editor"), for the section's stacked FormSection. */
  editor: ReactNode;
  /** The files as they would be saved. */
  files: InstructionFile[];
  /** 1 when the files differ from the saved ones, else 0. */
  unsaved: number;
  /** Name problems shown, plus the length problem after a save attempt. */
  errors: number;
  /** Shows every problem; true when the files may be saved. */
  check(): boolean;
  /** After a save: follow the saved files, keeping the open one open. */
  saved(): void;
  /** Drop the edits and the problems. */
  discard(): void;
}

/**
 * The prompt files' editor (agent profile design §3.3), shared by the agent page's 提示词 and the
 * template page's (ruling P4-12): the named `.md` files on the left (add, delete but never the
 * last one, reorder) and the open file's name and content on the right, with the joined
 * character count against 100 000 and the file count against 20. Names and limits are hints
 * only: the kernel judges on save. `onEdit` runs on every edit (a section takes its base version
 * then).
 */
export function useInstructionFilesEditor(
  savedFiles: readonly InstructionFile[],
  pending: boolean,
  onEdit: () => void,
): InstructionFilesEditor {
  const t = useTranslations("agents.page.prompt");
  const saved = draftOf(savedFiles);
  const draft = useSectionDraft(saved);
  const [open, setOpen] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  // the files whose name problems show: a name left (blur) or a save attempt shows them, and
  // typing in a name hides its own until it is left again
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const next = useRef(0);
  const files = draft.draft.files;
  const current = files.find((f) => f.key === open) ?? files[0];
  const index = current ? files.indexOf(current) : -1;
  const edit = (fn: (d: Draft) => Draft) => {
    onEdit();
    draft.set(fn);
  };

  const problems = fileNameProblems(files);
  const joined = joinInstructionFiles(files).length;
  const tooLong = joined > INSTRUCTION_FILE_LIMITS.joinedChars;
  const nameProblem = (i: number) => {
    const f = files[i];
    return f !== undefined && shown.has(f.key) ? (problems[i] ?? null) : null;
  };
  const show = (key: string, on: boolean) =>
    setShown((cur) => {
      if (cur.has(key) === on) return cur;
      const nextSet = new Set(cur);
      if (on) nextSet.add(key);
      else nextSet.delete(key);
      return nextSet;
    });
  const invalidCount = problems.filter((_, i) => nameProblem(i) !== null).length;
  const unsaved = draft.dirty && !sameJson(filesOf(draft.draft), filesOf(saved)) ? 1 : 0;
  const problem = index < 0 ? null : nameProblem(index);

  const editor = (
    // The form card is the one box: the open file's name is an h3 over its fields, the columns
    // split by a hairline, no editor card
    <Grid columns="list-detail" divided>
      <Stack gap={8}>
        <Repeater
          variant="rows"
          label={t("filesLabel")}
          addLabel={t("add")}
          min={1}
          max={INSTRUCTION_FILE_LIMITS.count}
          disabled={pending}
          items={files.map((f, i) => ({
            key: f.key,
            title: f.name,
            invalid: nameProblem(i) !== null,
            body: (
              <Button
                variant="ghost"
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
        <Stack gap={12}>
          <Text variant="h3">{current.name}</Text>
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
              disabled={pending}
              maxLength={67}
              value={current.name}
              onBlur={() => show(current.key, true)}
              onChange={(e) => {
                const name = e.target.value;
                show(current.key, false);
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
              disabled={pending}
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
      ) : null}
    </Grid>
  );

  return {
    editor,
    files: filesOf(draft.draft),
    unsaved,
    errors: invalidCount + (checked && tooLong ? 1 : 0),
    check() {
      setChecked(true);
      setShown(new Set(files.map((f) => f.key)));
      return !problems.some((p) => p !== null) && !tooLong;
    },
    saved() {
      draft.reset();
      setChecked(false);
      setShown(new Set());
      // the saved files are keyed by position: keep the open one open
      setOpen(`saved-${Math.max(index, 0)}`);
    },
    discard() {
      draft.reset();
      setChecked(false);
      setShown(new Set());
    },
  };
}
