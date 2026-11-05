/**
 * Prompt files (agent profile design §3.3), mirrored from the kernel's
 * `agents/instruction-files.ts` for the editor's hints only: the kernel is the judge on save.
 */
export type InstructionFile = { name: string; content: string };

/** The default and first file. */
export const AGENTS_MD = "AGENTS.md";

export const INSTRUCTION_FILE_LIMITS = {
  /** At most this many files, at least one. */
  count: 20,
  /** The joined text, headers included (the bound of `instructions`). */
  joinedChars: 100_000,
} as const;

/** A file name: 1–64 characters without `/` or `\`, then `.md`. */
const NAME_RE = /^[^/\\]{1,64}\.md$/;
/** Control and format characters (ZWJ / ZWNJ allowed), as the kernel's `CONTROL_OR_HIDDEN_RE`. */
const CONTROL_OR_HIDDEN_RE = /(?![‌‍])[\p{Cc}\p{Cf}]/u;

/**
 * The model-visible join: one file gives exactly its content; several give `# <name>\n\n<content>`
 * each, in order, joined by `\n\n`.
 */
export function joinInstructionFiles(files: readonly InstructionFile[]): string {
  if (files.length === 1) return files[0]?.content ?? "";
  return files.map((f) => `# ${f.name}\n\n${f.content}`).join("\n\n");
}

/** The files of a definition; one without them (every old version) is one `AGENTS.md`. */
export function readInstructionFiles(def: {
  instructions: string;
  instructionFiles?: InstructionFile[] | undefined;
}): InstructionFile[] {
  return def.instructionFiles ?? [{ name: AGENTS_MD, content: def.instructions }];
}

export type FileNameProblem = "invalid" | "duplicate";

/**
 * What the kernel would refuse about each name: not `<1–64 characters>.md` or with a control,
 * bidi or format character (`invalid`), or the same as another file's ignoring case
 * (`duplicate`, on every file that shares it). One entry per file, null when the name is fine.
 */
export function fileNameProblems(files: readonly InstructionFile[]): (FileNameProblem | null)[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const key = f.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return files.map((f) => {
    if (!NAME_RE.test(f.name) || CONTROL_OR_HIDDEN_RE.test(f.name)) return "invalid";
    return (counts.get(f.name.toLowerCase()) ?? 0) > 1 ? "duplicate" : null;
  });
}

/** A new file's name: `untitled.md`, else `untitled-2.md`, … (unique ignoring case). */
export function newFileName(files: readonly InstructionFile[]): string {
  const taken = new Set(files.map((f) => f.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "untitled.md" : `untitled-${n}.md`;
    if (!taken.has(name)) return name;
  }
}
