import { z } from "zod";
import { ApiError } from "../errors.js";
import { CONTROL_OR_HIDDEN_RE } from "../text.js";
import type { AgentDefinition } from "./definition.js";

/**
 * Prompt files (spec 2026-11-04 §3.3): the authoring form of an agent's system prompt. The kernel
 * joins them into `instructions` on save, and `instructions` stays the one model-visible field
 * (build.ts, the sub-agent copy, eval candidates and replay keep reading it), so no log event
 * changes shape and replay needs no new `DriftReason`.
 */
export type InstructionFile = { name: string; content: string };

/** The default and first file. */
export const AGENTS_MD = "AGENTS.md";

export const INSTRUCTION_FILE_LIMITS = {
  /** At most this many files, at least one. */
  count: 20,
  /** The joined text, the same bound as `instructions`. */
  joinedChars: 100_000,
} as const;

/** A file name: 1–64 characters without `/` or `\`, then `.md`. */
export const INSTRUCTION_FILE_NAME_RE = /^[^/\\]{1,64}\.md$/;

/**
 * The starter prompt of a new agent created without one (model-visible once saved; English like
 * every model-facing text).
 */
export const AGENTS_MD_STARTER = [
  "You are an assistant for this team. Help people get their work done accurately and efficiently.",
  "",
  "- Tone: clear, friendly and concise. Use plain language, keep answers short, and add detail when asked.",
  "- When a request is unclear or missing key details, ask one short clarifying question before acting.",
  "  If you go ahead anyway, say what you assumed.",
  "- If you don't know something or can't do it, say so instead of guessing.",
].join("\n");

/**
 * The model-visible join: one file gives exactly its content (so an old agent edited without
 * adding files sends the same text as before); several files give `# <name>\n\n<content>` each,
 * in order, joined by `\n\n`.
 */
export function joinInstructionFiles(files: readonly InstructionFile[]): string {
  if (files.length === 1) return files[0]?.content ?? "";
  return files.map((f) => `# ${f.name}\n\n${f.content}`).join("\n\n");
}

/** The files of a definition; a definition without them (every old version) is one `AGENTS.md`. */
export function readInstructionFiles(
  def: Pick<AgentDefinition, "instructions" | "instructionFiles">,
): InstructionFile[] {
  return def.instructionFiles ?? [{ name: AGENTS_MD, content: def.instructions }];
}

export const InstructionFileSchema = z
  .object({
    name: z
      .string()
      .regex(INSTRUCTION_FILE_NAME_RE, "a file name is 1–64 characters without / or \\, then .md")
      .refine(
        (n) => !CONTROL_OR_HIDDEN_RE.test(n),
        "a file name must not contain control or format characters",
      ),
    content: z.string().max(INSTRUCTION_FILE_LIMITS.joinedChars),
  })
  .strict();

/**
 * 1–20 files, names unique ignoring case (`AGENTS.md` and `agents.md` would collide on a
 * case-insensitive file system), a joined total of at most 100 000 characters.
 */
export const InstructionFilesSchema = z
  .array(InstructionFileSchema)
  .min(1)
  .max(INSTRUCTION_FILE_LIMITS.count)
  .superRefine((files, ctx) => {
    const seen = new Set<string>();
    files.forEach((f, i) => {
      const key = f.name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: [i, "name"], message: `duplicate file ${f.name}` });
      }
      seen.add(key);
    });
    const joined = joinInstructionFiles(files).length;
    if (joined > INSTRUCTION_FILE_LIMITS.joinedChars) {
      ctx.addIssue({
        code: "custom",
        message: `the joined files are ${joined} characters, more than ${INSTRUCTION_FILE_LIMITS.joinedChars}`,
      });
    }
  });

/** A definition as a save request gives it: `instructions` may be left out. */
export type AgentDefinitionInput = Omit<AgentDefinition, "instructions"> & {
  instructions?: string | undefined;
};

/**
 * Derives the stored definition of a save. With `instructionFiles`, `instructions` is their join
 * (a differing `instructions` given with them → 400 `agent.instructions_mismatch`). With only
 * `instructions` (old clients) the current files are kept while it equals their join, else the
 * definition is stored as given, without files. Given neither,
 * an update keeps the `current` version's prompt, and a new agent (`current` null) gets the
 * `AGENTS.md` starter.
 */
export function deriveInstructions(
  def: AgentDefinitionInput,
  current: Pick<AgentDefinition, "instructions" | "instructionFiles"> | null,
): AgentDefinition {
  const { instructions, instructionFiles, ...rest } = def;
  if (instructionFiles !== undefined) {
    const joined = joinInstructionFiles(instructionFiles);
    if (instructions !== undefined && instructions !== joined) {
      throw new ApiError(
        "agent.instructions_mismatch",
        "instructions differs from the join of instructionFiles; send only instructionFiles",
      );
    }
    return { ...rest, instructions: joined, instructionFiles };
  }
  if (instructions !== undefined) {
    // an old client re-sending the same joined text (an unrelated edit) keeps the files
    const files = current?.instructionFiles;
    if (files !== undefined && instructions === joinInstructionFiles(files)) {
      return { ...rest, instructions, instructionFiles: files };
    }
    return { ...rest, instructions };
  }
  if (current !== null) {
    return {
      ...rest,
      instructions: current.instructions,
      ...(current.instructionFiles !== undefined && { instructionFiles: current.instructionFiles }),
    };
  }
  return {
    ...rest,
    instructions: AGENTS_MD_STARTER,
    instructionFiles: [{ name: AGENTS_MD, content: AGENTS_MD_STARTER }],
  };
}
