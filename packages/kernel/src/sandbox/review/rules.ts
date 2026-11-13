/**
 * Command review, stage 1: the pure rule table of the auto-mode spec §5.2.
 *
 * `reviewRules` parses a shell command line without spawning anything and applies every rule; the
 * strictest outcome wins (`deny` > `ask` > `unsure` > `allow`). `reviewWrite` applies the same
 * table to a file-tool write, where there is a path instead of a command.
 *
 * The parser is deliberately small and conservative: it understands quoting, pipes, `&&` / `;`
 * chains and redirections, and unwraps `bash -c` / `sh -c` / `eval` one level. Anything it cannot
 * read with confidence — heredocs, backslash obfuscation, `base64` fed into an interpreter — is
 * `unsure`, never a guess: the classifier (spec §5.3) decides those. No shell-parser dependency
 * (P-D10).
 *
 * The table is best-effort, not a security boundary (the device owner's machine is reachable by the
 * agent in auto mode; the spec says so). Accepted, documented gaps: a git value inspection is
 * shallow, so `ssh -o ProxyCommand=…`, `ssh -F FILE` (whose file can hold a ProxyCommand) and
 * `ssh -o LocalCommand=…` inside `core.sshCommand`/`GIT_SSH_COMMAND`, and a pager or editor value
 * such as `PAGER='less ~/.ssh/id_rsa'` or `EDITOR='vim ~/.aws/credentials'`, are not inspected
 * (only shell metacharacters and a few network/decoder programs are); `git --config-env=…` is not
 * read; an alias defined outside the reviewed line (`git pwn` alone) runs as a plain git command;
 * LESSOPEN and similar interpreter hooks on non-git programs are not inspected; tar still needs
 * `-c` before `-f` for the archive target; and variable state is tracked linearly across `&&` /
 * `||`.
 */
import type {
  ParsedCommand,
  Redirect,
  ReviewFacts,
  ReviewResult,
  RuleHit,
  RuleOutcome,
  SimpleCommand,
} from "./types.js";

export type {
  ParsedCommand,
  Redirect,
  ReviewFacts,
  ReviewResult,
  RuleHit,
  RuleOutcome,
  SimpleCommand,
} from "./types.js";

/* -------------------------------------------------------------------------------------------- *
 * Parser
 * -------------------------------------------------------------------------------------------- */

type Op = "|" | "&&" | "||" | ";" | "&" | "\n" | ">" | ">>" | "<" | ">&" | "<&" | "<<";

interface WordToken {
  kind: "word";
  value: string;
  /** A substitution or a variable: the word's value is not literally known. */
  dynamic: boolean;
  /** Commands found inside `$(...)` / backticks in this word. */
  subs: SimpleCommand[][];
}

interface OpToken {
  kind: "op";
  op: Op;
}

type Token = WordToken | OpToken;

type ParseSuccess<T> = { ok: true; value: T };
type ParseFailure = { ok: false; unsure: string };

/** Operators the tokenizer recognizes, longest first (`&>` and `>&` are different). */
const OPERATORS: ReadonlyArray<readonly [string, Op]> = [
  ["&&", "&&"],
  ["||", "||"],
  ["&>>", ">>"],
  ["&>", ">"],
  [">>", ">>"],
  ["<<-", "<<"],
  ["<<", "<<"],
  [">&", ">&"],
  ["<&", "<&"],
  [">|", ">"],
  ["|&", "|"],
  [";;", ";"],
  [";", ";"],
  ["|", "|"],
  ["&", "&"],
  [">", ">"],
  ["<", "<"],
];

const WORD_END = new Set([" ", "\t", "\n", "\r", "|", "&", ";", "<", ">", "(", ")"]);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlphaNum = (c: string): boolean => /[A-Za-z0-9]/.test(c);

/** The public parser: the parsed command, or null when the tokenizer is not confident. */
export function parseCommand(command: string): ParsedCommand | null {
  const parsed = parseDetailed(command);
  return parsed.ok ? { commands: parsed.value } : null;
}

type DetailedParse = ParseSuccess<SimpleCommand[]> | ParseFailure;

function parseDetailed(command: string): DetailedParse {
  const raw = parseRaw(command, 0);
  if (!raw.ok) return raw;
  const unwrapped = unwrapOneLevel(raw.value);
  if (!unwrapped.ok) return unwrapped;
  const dynamic = rejectDynamicPaths(unwrapped.value);
  if (!dynamic.ok) return dynamic;
  const obfuscated = rejectObfuscation(unwrapped.value);
  if (!obfuscated.ok) return obfuscated;
  return { ok: true, value: unwrapped.value };
}

const MAX_SUB_DEPTH = 3;

function parseRaw(command: string, depth: number): DetailedParse {
  if (depth > MAX_SUB_DEPTH) return { ok: false, unsure: "nested command substitution" };
  const tokenized = tokenize(command, depth);
  if (!tokenized.ok) return tokenized;
  return buildCommands(tokenized.value);
}

function tokenize(text: string, depth: number): ParseSuccess<Token[]> | ParseFailure {
  const tokens: Token[] = [];
  let unsure: string | null = null;
  let i = 0;

  while (i < text.length) {
    const c = text[i] as string;
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += text[i + 1] === "\n" ? 2 : 1;
      tokens.push({ kind: "op", op: "\n" });
      continue;
    }
    if (c === "\n") {
      tokens.push({ kind: "op", op: "\n" });
      i += 1;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (isDigit(c)) {
      // `2>`, `2>>`, `2>&1`: drop the fd number, let the redirection be read below.
      let j = i;
      while (j < text.length && isDigit(text[j] as string)) j += 1;
      if (text[j] === ">" || text[j] === "<") {
        i = j;
        continue;
      }
    }
    const operator = matchOperator(text, i);
    if (operator !== null) {
      if (operator.text === "<<" || operator.text === "<<-") {
        unsure ??= "heredoc";
        tokens.push({ kind: "op", op: ";" });
      } else {
        tokens.push({ kind: "op", op: operator.op });
      }
      i += operator.text.length;
      continue;
    }
    const word = readWord(text, i, depth);
    if (!word.ok) {
      unsure ??= word.unsure;
      break;
    }
    if (word.value === null) {
      // A stray `(`, `)`, `{` or `}`: a group boundary, not a word.
      i += 1;
      continue;
    }
    tokens.push(word.value.token);
    i = word.value.end;
  }

  if (unsure !== null) return { ok: false, unsure };
  return { ok: true, value: tokens };
}

function matchOperator(text: string, at: number): { text: string; op: Op } | null {
  for (const [needle, op] of OPERATORS) {
    if (text.startsWith(needle, at)) return { text: needle, op };
  }
  return null;
}

type WordRead =
  | { ok: true; value: { token: WordToken; end: number } | null }
  | { ok: false; unsure: string };

function readWord(text: string, start: number, depth: number): WordRead {
  let i = start;
  let value = "";
  let dynamic = false;
  const subs: SimpleCommand[][] = [];
  let started = false;

  while (i < text.length) {
    const c = text[i] as string;
    if (WORD_END.has(c)) break;
    started = true;

    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return { ok: false, unsure: "unterminated single quote" };
      value += text.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (c === '"') {
      const quoted = readDoubleQuoted(text, i + 1, depth);
      if (!quoted.ok) return quoted;
      value += quoted.value.text;
      dynamic ||= quoted.value.dynamic;
      subs.push(...quoted.value.subs);
      i = quoted.value.end;
      continue;
    }

    if (c === "$" && text[i + 1] === "'") {
      const ansi = readAnsiCQuoted(text, i + 2);
      if (!ansi.ok) return ansi;
      value += ansi.value.text;
      i = ansi.value.end;
      continue;
    }

    if (c === "$" && text[i + 1] === "(") {
      const sub = readSubstitution(text, i, depth);
      if (!sub.ok) return sub;
      subs.push(sub.value.commands);
      value += `$(${sub.value.source})`;
      dynamic = true;
      i = sub.value.end;
      continue;
    }

    if (c === "`") {
      const sub = readBacktick(text, i, depth);
      if (!sub.ok) return sub;
      subs.push(sub.value.commands);
      value += `$(${sub.value.source})`;
      dynamic = true;
      i = sub.value.end;
      continue;
    }

    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return { ok: false, unsure: "trailing backslash" };
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (isAlphaNum(next)) return { ok: false, unsure: "backslash obfuscation" };
      value += next;
      i += 2;
      continue;
    }

    if (c === "$" && (text[i + 1] === "{" || isAlphaNum(text[i + 1] ?? ""))) {
      dynamic = true;
      value += c;
      i += 1;
      continue;
    }

    value += c;
    i += 1;
  }

  if (!started) return { ok: true, value: null };
  return { ok: true, value: { token: { kind: "word", value, dynamic, subs }, end: i } };
}

interface QuotedText {
  text: string;
  dynamic: boolean;
  subs: SimpleCommand[][];
  end: number;
}

function readDoubleQuoted(
  text: string,
  start: number,
  depth: number,
): ParseSuccess<QuotedText> | ParseFailure {
  let i = start;
  let out = "";
  let dynamic = false;
  const subs: SimpleCommand[][] = [];

  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') return { ok: true, value: { text: out, dynamic, subs, end: i + 1 } };
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return { ok: false, unsure: "unterminated double quote" };
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        out += next;
        i += 2;
        continue;
      }
      out += `\\${next}`;
      i += 2;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const sub = readSubstitution(text, i, depth);
      if (!sub.ok) return sub;
      subs.push(sub.value.commands);
      out += `$(${sub.value.source})`;
      dynamic = true;
      i = sub.value.end;
      continue;
    }
    if (c === "`") {
      const sub = readBacktick(text, i, depth);
      if (!sub.ok) return sub;
      subs.push(sub.value.commands);
      out += `$(${sub.value.source})`;
      dynamic = true;
      i = sub.value.end;
      continue;
    }
    if (c === "$" && (text[i + 1] === "{" || isAlphaNum(text[i + 1] ?? ""))) dynamic = true;
    out += c;
    i += 1;
  }
  return { ok: false, unsure: "unterminated double quote" };
}

function readAnsiCQuoted(
  text: string,
  start: number,
): ParseSuccess<{ text: string; end: number }> | ParseFailure {
  let i = start;
  let out = "";
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'") return { ok: true, value: { text: out, end: i + 1 } };
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return { ok: false, unsure: "unterminated ANSI-C quote" };
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "\\") out += "\\";
      else if (next === "'") out += "'";
      else if (next === '"') out += '"';
      else return { ok: false, unsure: "ANSI-C escape obfuscation" };
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return { ok: false, unsure: "unterminated ANSI-C quote" };
}

function readSubstitution(
  text: string,
  at: number,
  depth: number,
): ParseSuccess<{ commands: SimpleCommand[]; end: number; source: string }> | ParseFailure {
  // `at` points at `$`, `text[at + 1] === "("`.
  let i = at + 1;
  let nested = 0;
  let quote: "'" | '"' | null = null;
  while (i < text.length) {
    const c = text[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      i += 1;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "(") {
      nested += 1;
      i += 1;
      continue;
    }
    if (c === ")") {
      nested -= 1;
      if (nested === 0) {
        const inner = text.slice(at + 2, i);
        const parsed = parseRaw(inner, depth + 1);
        if (!parsed.ok)
          return { ok: false, unsure: `unparseable command substitution: ${parsed.unsure}` };
        return { ok: true, value: { commands: parsed.value, end: i + 1, source: inner } };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return { ok: false, unsure: "unterminated command substitution" };
}

function readBacktick(
  text: string,
  at: number,
  depth: number,
): ParseSuccess<{ commands: SimpleCommand[]; end: number; source: string }> | ParseFailure {
  let i = at + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const inner = text.slice(at + 1, i);
      const parsed = parseRaw(inner, depth + 1);
      if (!parsed.ok)
        return { ok: false, unsure: `unparseable command substitution: ${parsed.unsure}` };
      return { ok: true, value: { commands: parsed.value, end: i + 1, source: inner } };
    }
    i += 1;
  }
  return { ok: false, unsure: "unterminated command substitution" };
}

function buildCommands(tokens: Token[]): DetailedParse {
  const commands: SimpleCommand[] = [];
  let argv: string[] = [];
  let redirects: Redirect[] = [];
  let subs: SimpleCommand[] = [];
  let pending: { op: Redirect["op"] } | null = null;
  let pendingDup: ">&" | "<&" | null = null;
  let pipeline = 0;

  const flush = (): void => {
    for (const sub of subs) sub.pipeline = pipeline;
    commands.push(...subs);
    if (argv.length > 0 || redirects.length > 0) commands.push({ argv, redirects, pipeline });
    argv = [];
    redirects = [];
    subs = [];
    pending = null;
    pendingDup = null;
  };

  for (const token of tokens) {
    if (token.kind === "op") {
      if (token.op === ">" || token.op === ">>" || token.op === "<") {
        pending = { op: token.op };
        continue;
      }
      if (token.op === ">&" || token.op === "<&") {
        pendingDup = token.op;
        continue;
      }
      flush();
      if (token.op !== "|") pipeline += 1;
      continue;
    }
    if (pendingDup !== null) {
      // `2>&1` / `>&-` duplicate or close a descriptor; `echo x >& file` is `&> file`, a write.
      pendingDup = null;
      if (/^\d+$/.test(token.value) || token.value === "-") continue;
      redirects.push({ op: ">", target: token.value });
      continue;
    }
    if (pending !== null) {
      redirects.push({ op: pending.op, target: token.value });
      pending = null;
      continue;
    }
    argv.push(token.value);
    for (const group of token.subs) subs.push(...group);
  }

  if (pending !== null) return { ok: false, unsure: "redirection without a target" };
  flush();
  return { ok: true, value: commands };
}

/* -------------------------------------------------------------------------------------------- *
 * Wrappers and invocations
 * -------------------------------------------------------------------------------------------- */

/** Shell reserved words: a command line with one is a control structure the parser does not model. */
const RESERVED_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "{",
  "}",
  "[[",
  "]]",
  "!",
]);

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

interface Invocation {
  /** The program's basename, e.g. `rm` for `/bin/rm`. */
  program: string;
  /** The program's token as written (to spot `./scripts/run`). */
  raw: string;
  args: string[];
  argv: string[];
  /** A `git -C DIR` directory the subcommand runs in. */
  dir?: string;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Neutral prefixes that run another command: they are stripped to find the real program. */
function stripNeutral(argv: string[]): Invocation | null {
  let rest = argv.slice();
  for (;;) {
    while (rest.length > 0 && ENV_ASSIGNMENT.test(rest[0] as string)) rest = rest.slice(1);
    const head = rest[0];
    if (head === undefined) return null;
    const program = baseName(head);
    if (program === "env") {
      const after = skipEnv(rest.slice(1));
      if (after.length === 0) return { program: "env", raw: "env", args: [], argv: ["env"] };
      rest = after;
      continue;
    }
    if (["nohup", "command", "builtin", "noglob"].includes(program)) {
      rest = rest.slice(1);
      continue;
    }
    if (program === "nice" || program === "stdbuf") {
      rest = skipLeadingOptions(rest.slice(1), [
        "-n",
        "-t",
        "-s",
        "-o",
        "-e",
        "-d",
        "-q",
        "-i",
        "-p",
        "-c",
      ]);
      continue;
    }
    if (program === "timeout") {
      rest = skipTimeout(rest.slice(1));
      continue;
    }
    if (program === "xargs") {
      rest = skipXargs(rest.slice(1));
      continue;
    }
    // `git -C dir clone ...`: the subcommand follows the global options.
    if (program === "git") {
      const git = gitSubcommandArgs(rest.slice(1));
      return git.dir === undefined
        ? { program, raw: head, args: git.args, argv: rest }
        : { program, raw: head, args: git.args, argv: rest, dir: git.dir };
    }
    return { program, raw: head, args: rest.slice(1), argv: rest };
  }
}

/** Git's global options before the subcommand, with their values removed. */
function gitSubcommandArgs(args: string[]): { args: string[]; dir?: string } {
  let i = 0;
  let dir: string | undefined;
  const chdir = (value: string): void => {
    dir = dir === undefined || value.startsWith("/") ? value : `${dir}/${value}`;
  };
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "-C") {
      const value = args[i + 1];
      if (value === undefined) return { args: [] };
      chdir(value);
      i += 2;
      continue;
    }
    if (a.startsWith("-C") && a.length > 2) {
      chdir(a.slice(2));
      i += 1;
      continue;
    }
    if (
      ["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(a)
    ) {
      i += 2;
      continue;
    }
    if (
      a.startsWith("--git-dir=") ||
      a.startsWith("--work-tree=") ||
      a.startsWith("--namespace=") ||
      a.startsWith("--exec-path=") ||
      a.startsWith("--config-env=") ||
      (a.startsWith("-c") && a.length > 2)
    ) {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  const rest = args.slice(i);
  return dir === undefined ? { args: rest } : { args: rest, dir };
}

function skipEnv(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (
      ENV_ASSIGNMENT.test(a) ||
      a === "-i" ||
      a === "--ignore-environment" ||
      a === "-0" ||
      a === "--null"
    ) {
      i += 1;
      continue;
    }
    if (a === "-u" || a === "--unset") {
      i += 2;
      continue;
    }
    if (a.startsWith("--unset=") || (a.startsWith("-u") && a.length > 2)) {
      i += 1;
      continue;
    }
    if (a === "--") i += 1;
    break;
  }
  return args.slice(i);
}

function skipLeadingOptions(args: string[], optionsWithValue: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "--") {
      i += 1;
      break;
    }
    if (!a.startsWith("-")) break;
    if (optionsWithValue.includes(a)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return args.slice(i);
}

function skipTimeout(args: string[]): string[] {
  const rest = skipLeadingOptions(args, ["-s", "--signal", "-k", "--kill-after"]);
  return rest.length > 0 ? rest.slice(1) : [];
}

const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-n",
  "--max-args",
  "-I",
  "--replace",
  "-P",
  "--max-procs",
  "-L",
  "--max-lines",
  "-s",
  "--max-chars",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-a",
  "--arg-file",
  "-e",
  "--eof-str",
]);

function skipXargs(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "--") {
      i += 1;
      break;
    }
    if (!a.startsWith("-")) break;
    i += XARGS_OPTIONS_WITH_VALUE.has(a) ? 2 : 1;
  }
  return args.slice(i);
}

function baseName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash < 0 ? token : token.slice(slash + 1);
}

/** Every command an invocation runs: the outer program plus the one behind `sudo` / `doas`. */
function invocationsOf(command: SimpleCommand): Invocation[] {
  const stripped = stripNeutral(command.argv);
  if (stripped === null) return [];
  const out: Invocation[] = [stripped];
  if (["sudo", "doas", "pkexec"].includes(stripped.program)) {
    const inner = stripNeutral(skipSudoOptions(stripped.args));
    if (inner !== null) out.push(inner);
  }
  return out;
}

function skipSudoOptions(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "--") {
      i += 1;
      break;
    }
    if (!a.startsWith("-")) break;
    if (
      [
        "-u",
        "--user",
        "-g",
        "--group",
        "-p",
        "--prompt",
        "-c",
        "--close-from",
        "-r",
        "-t",
        "--other-user",
        "-U",
        "-h",
      ].includes(a)
    ) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return args.slice(i);
}

/** The wrapper command's script (`bash -c ...`), or null when the command is not a wrapper. */
function wrapperScript(inv: Invocation): { kind: "shell" | "eval" | "su"; script: string } | null {
  if (inv.program === "eval") return { kind: "eval", script: inv.args.join(" ") };
  if (inv.program === "su") {
    const c = inv.args.indexOf("-c");
    if (c >= 0 && inv.args[c + 1] !== undefined)
      return { kind: "su", script: inv.args[c + 1] as string };
    return null;
  }
  if (!SHELLS.has(inv.program)) return null;
  for (let i = 0; i < inv.args.length; i += 1) {
    const a = inv.args[i] as string;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a) && inv.args[i + 1] !== undefined) {
      return { kind: "shell", script: inv.args[i + 1] as string };
    }
    if (a === "--command" && inv.args[i + 1] !== undefined) {
      return { kind: "shell", script: inv.args[i + 1] as string };
    }
  }
  return null;
}

function unwrapOneLevel(commands: SimpleCommand[]): DetailedParse {
  const out: SimpleCommand[] = [];
  let wrapperBlock = 0;
  for (const command of commands) {
    const inv = stripNeutral(command.argv);
    let wrapper = inv === null ? null : wrapperScript(inv);
    if (wrapper === null && inv !== null && ["sudo", "doas", "pkexec"].includes(inv.program)) {
      // `sudo bash -c '...'`: the wrapper is behind the privilege command.
      const inner = stripNeutral(skipSudoOptions(inv.args));
      if (inner !== null) wrapper = wrapperScript(inner);
    }
    if (wrapper === null) {
      out.push(command);
      continue;
    }
    if (isDynamicScript(wrapper.script)) {
      return { ok: false, unsure: "a shell wrapper runs a dynamic script" };
    }
    const inner = parseRaw(wrapper.script, 1);
    if (!inner.ok)
      return { ok: false, unsure: `a shell wrapper's script is unparseable: ${inner.unsure}` };
    for (const nested of inner.value) {
      const nestedInv = stripNeutral(nested.argv);
      if (nestedInv !== null && wrapperScript(nestedInv) !== null) {
        return { ok: false, unsure: "nested shell wrapper" };
      }
    }
    // Keep the script's own pipes apart from the rest of the line (a unique block per wrapper),
    // and remember that the wrapper's stdout feeds its outer pipeline.
    const block = wrapperBlock;
    wrapperBlock += 1;
    for (const nested of inner.value) {
      nested.pipeline = block * 1_000_000 + nested.pipeline;
      nested.flow = command.pipeline;
      nested.block = block;
    }
    if (inv !== null && ["su", "sudo", "doas", "pkexec"].includes(inv.program)) {
      // Keep the privilege command itself so the `ask.sudo` rule still sees it.
      out.push({ argv: [inv.program], redirects: [], pipeline: command.pipeline });
    }
    if (inner.value.length === 0) {
      out.push({ ...command, argv: command.argv.slice(0, 1) });
      continue;
    }
    const first = inner.value[0] as SimpleCommand;
    first.redirects = [...first.redirects, ...command.redirects];
    for (const nested of inner.value) {
      out.push(nested.wrapper === undefined ? { ...nested, wrapper: wrapper.kind } : nested);
    }
  }
  return { ok: true, value: out };
}

function isDynamicScript(script: string): boolean {
  return script.includes("$(") || script.includes("`") || /\$\{?[A-Za-z_]/.test(script);
}

/* -------------------------------------------------------------------------------------------- *
 * Path helpers
 * -------------------------------------------------------------------------------------------- */

interface ResolvedFacts {
  workspace: string;
  cwd: string;
  home: string | null;
}

function homeOf(workspace: string): string | null {
  const parts = workspace.split("/").filter((p) => p.length > 0);
  if ((parts[0] === "home" || parts[0] === "Users") && parts.length >= 2)
    return `/${parts[0]}/${parts[1]}`;
  if (parts[0] === "root") return "/root";
  return null;
}

function resolveFacts(facts: ReviewFacts): ResolvedFacts {
  const workspace = normalizePath(facts.workspace);
  const cwd = facts.cwd === undefined ? workspace : normalizePath(facts.cwd);
  return { workspace, cwd, home: homeOf(workspace) };
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || "/";
}

const NO_VARS: ReadonlyMap<string, string | null> = new Map();

/** Replace `$X` / `${X}` from the tracked table; null when a variable has no known value. */
function substituteVariables(
  value: string,
  vars: ReadonlyMap<string, string | null>,
): string | null {
  let unresolved = false;
  const out = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      const known = vars.get(name);
      if (known === undefined || known === null) {
        unresolved = true;
        return "";
      }
      return known;
    },
  );
  return unresolved ? null : out;
}

/** `~` / `$HOME` / tracked variables expanded and relative paths made absolute; null if unknown. */
function expandPath(
  path: string,
  facts: ResolvedFacts,
  cwd: string = facts.cwd,
  vars: ReadonlyMap<string, string | null> = NO_VARS,
): string | null {
  let p = path;
  if (p === "~" || p.startsWith("~/")) {
    if (facts.home !== null) p = facts.home + p.slice(1);
  } else {
    const homeRef = /^\$(?:\{HOME\}|HOME)(?=\/|$)/.exec(p);
    if (homeRef !== null) {
      const rest = p.slice(homeRef[0].length);
      // Without a known home, keep the path in `~` form so the secret/persistence checks match it
      // symbolically (`$HOME/.ssh/...` is the same file as `~/.ssh/...`).
      p = facts.home === null ? `~${rest}` : facts.home + rest;
    }
  }
  const substituted = substituteVariables(p, vars);
  if (substituted === null) return null;
  p = substituted;
  // An unresolved variable anywhere in the path (including command substitution) cannot be
  // resolved: never treat `$HOME/$(echo .ssh)/id_rsa` as a harmless absolute path.
  if (/[$`]/.test(p)) return null;
  if (p.startsWith("/") || p.startsWith("~")) return normalizePath(p);
  return normalizePath(`${cwd}/${p}`);
}

function inside(child: string, root: string): boolean {
  if (child === root) return true;
  if (root === "/") return child.startsWith("/");
  return child.startsWith(`${root}/`);
}

function isAncestor(ancestor: string, child: string): boolean {
  if (ancestor === child) return false;
  if (ancestor === "/") return child.startsWith("/");
  return child.startsWith(`${ancestor}/`);
}

function tildeForm(path: string, facts: ResolvedFacts): string {
  if (facts.home !== null && inside(path, facts.home)) {
    return path === facts.home ? "~" : `~${path.slice(facts.home.length)}`;
  }
  return path;
}

const TMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];
const tmpRootOf = (path: string): boolean => TMP_ROOTS.some((root) => inside(path, root));

const SECRET_HOME_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.git-credentials",
  "~/.config/gh/hosts.yml",
];

function isSecretPath(path: string, facts: ResolvedFacts): boolean {
  const t = tildeForm(path, facts);
  if (SECRET_HOME_PATHS.some((secret) => t === secret || t.startsWith(`${secret}/`))) return true;
  const base = baseName(path);
  return base.startsWith(".env") && !inside(path, facts.workspace);
}

function isPersistencePath(path: string, facts: ResolvedFacts): boolean {
  const t = tildeForm(path, facts);
  if (t === "~/.gitconfig" || t.startsWith("~/.gitconfig.")) return true;
  if (
    /^~\/\.(bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|tcshrc|cshrc|kshrc)$/.test(
      t,
    )
  ) {
    return true;
  }
  if (t === "~/.config/fish/config.fish" || t.startsWith("~/.config/fish/conf.d/")) return true;
  if (t === "~/.ssh" || t.startsWith("~/.ssh/")) return true;
  if (t.startsWith("~/Library/LaunchAgents") || t.startsWith("~/Library/LaunchDaemons"))
    return true;
  if (t.startsWith("/Library/LaunchAgents") || t.startsWith("/Library/LaunchDaemons")) return true;
  if (
    [
      "/etc/profile",
      "/etc/bashrc",
      "/etc/bash.bashrc",
      "/etc/zshrc",
      "/etc/zshenv",
      "/etc/paths",
    ].includes(t) ||
    t.startsWith("/etc/profile.d/")
  ) {
    return true;
  }
  if (t === "/etc/crontab" || t.startsWith("/var/spool/cron") || t.startsWith("/etc/cron."))
    return true;
  if (t.startsWith("~/.config/systemd")) return true;
  return isGitHook(path);
}

const DEVICE_DIRS = [
  "~/.config/capybara-device",
  "~/.capybara-device",
  "~/.local/share/capybara-device",
  "~/Library/Application Support/capybara-device",
  "/etc/capybara-device",
  "/var/lib/capybara-device",
];

function isDevicePath(path: string, facts: ResolvedFacts): boolean {
  const t = tildeForm(path, facts);
  if (DEVICE_DIRS.some((dir) => t === dir || t.startsWith(`${dir}/`))) return true;
  // The device binary, its unit file and its launch agent anywhere on disk.
  return isDeviceIdentifier(baseName(t));
}

const isGitHook = (path: string): boolean =>
  path.includes("/.git/hooks/") || path.endsWith("/.git/hooks");

function looksLikePath(token: string): boolean {
  if (token.length === 0 || token === "-" || token.startsWith("-")) return false;
  return (
    token.startsWith("/") ||
    token.startsWith("~") ||
    token.startsWith(".") ||
    token.startsWith("$HOME") ||
    token.includes("/")
  );
}

/** A whole-word variable reference (`$KUBECONFIG`, `${AWS_CONFIG_FILE}`): a dynamic path value. */
const BARE_VARIABLE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

/** Curl strips one matching surrounding `"…"` pair from an `@file` / `<file` / upload value. */
function stripQuotePair(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** A path argument as written: plain, `@file` (curl), `file=@path`, or `--flag=value`. */
function pathCandidates(token: string): string[] {
  const out: string[] = [];
  const add = (value: string): void => {
    const fromAt = value.startsWith("@") || value.includes("@");
    let candidate = value.startsWith("@") ? value.slice(1) : value;
    // `-F file=@path`, `-d@path`: the file is after the first `@`.
    const at = candidate.indexOf("@");
    if (at >= 0) candidate = candidate.slice(at + 1);
    // A nested pair of quotes around the value (`@"/home/dev/.ssh/id_rsa"`) is not part of the
    // path: curl strips it, and a quoted path is what a reviewer must treat as the file it names.
    candidate = stripQuotePair(candidate);
    // An `@file` is a file even without a slash (`@$FILE` names one just as `@./file` does).
    if (
      (fromAt || looksLikePath(candidate)) &&
      candidate.length > 0 &&
      candidate !== "-" &&
      !out.includes(candidate)
    ) {
      out.push(candidate);
    }
  };
  if (token.startsWith("@") && token.length > 1) add(token.slice(1));
  // Attached short-option values that name files: `-d@file`, `-Tfile`, `-Ffile=@path`, `-ofile`,
  // `awk -fprog`, `sed -fscript`.
  const attached = /^-(?:d|f|T|F|o|D|O)(.+)$/.exec(token);
  if (attached !== null && attached[1] !== undefined) add(attached[1]);
  const eq = token.indexOf("=");
  if (eq > 0) add(token.slice(eq + 1));
  const literal = stripQuotePair(token);
  if (looksLikePath(literal)) out.push(literal);
  // A whole-word variable names whatever path it holds (`cat $KUBECONFIG`): dynamic, not a literal
  // word. It is carried as a candidate so the rules can treat an unresolved value as uncertain.
  if (BARE_VARIABLE.test(token) && !out.includes(token)) out.push(token);
  return out;
}

/** Secret-looking path components: a dynamic word containing one is never a confident read. */
const SECRET_LOOKING =
  /(^|\/)(\.ssh|\.aws|\.config\/gcloud|\.azure|\.kube|\.docker|\.netrc|\.git-credentials|\.env)/;

/**
 * Whether a word is a concrete file path worth resolving statically for a read. Ordinary shell
 * patterns (`grep "src/.*$" src/`), command substitutions (`cat $(pwd)/package.json`) and URLs are
 * not: their unresolved text must not turn routine reads into `unsure`. A `$HOME`-leading word or
 * one that names a secret component still is.
 */
function isConcretePathWord(candidate: string): boolean {
  // A URL is not a local file path; `rg "http://$host/api"` stays a read.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || /^https?:/i.test(candidate)) return false;
  if (candidate.startsWith("/") || candidate.startsWith("~")) return true;
  if (candidate.startsWith("./") || candidate.startsWith("../")) return true;
  if (/^\$(?:\{HOME\}|HOME)(?=\/|$)/.test(candidate)) return true;
  // A whole-word variable is a path word whose value is dynamic (`cat $KUBECONFIG`); when it cannot
  // be resolved the read is uncertain, never a confident allow.
  if (BARE_VARIABLE.test(candidate)) return true;
  if (SECRET_LOOKING.test(candidate)) return true;
  // A path-like word with a simple variable is concrete: if the variable is unresolved, the read
  // falls to `unsure` rather than `allow` (`cat $X/config`).
  if (
    /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(candidate) &&
    (candidate.includes("/") || candidate.startsWith("."))
  ) {
    return true;
  }
  if (/[*?[\]{}|&;<>()$`\\'"\s]/.test(candidate)) return false;
  return candidate.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate);
}

function cwdOf(command: SimpleCommand, facts: ResolvedFacts): string {
  return command.cwd ?? facts.cwd;
}

function secretTokens(command: SimpleCommand, facts: ResolvedFacts): string[] {
  const found = new Set<string>();
  for (const token of command.argv) {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, facts, cwdOf(command, facts), command.vars);
      if (resolved !== null && isSecretPath(resolved, facts)) found.add(resolved);
    }
  }
  for (const redirect of command.redirects) {
    const resolved = expandPath(redirect.target, facts, cwdOf(command, facts), command.vars);
    if (resolved !== null && isSecretPath(resolved, facts)) found.add(resolved);
  }
  return [...found];
}

function persistenceTokens(command: SimpleCommand, facts: ResolvedFacts): string[] {
  const found = new Set<string>();
  for (const token of command.argv) {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, facts, cwdOf(command, facts), command.vars);
      if (resolved !== null && isPersistencePath(resolved, facts)) found.add(resolved);
    }
  }
  for (const redirect of command.redirects) {
    const resolved = expandPath(redirect.target, facts, cwdOf(command, facts), command.vars);
    if (resolved !== null && isPersistencePath(resolved, facts)) found.add(resolved);
  }
  return [...found];
}

function deviceTokens(command: SimpleCommand, facts: ResolvedFacts): string[] {
  const found = new Set<string>();
  for (const token of command.argv) {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, facts, cwdOf(command, facts), command.vars);
      if (resolved !== null && isDevicePath(resolved, facts)) found.add(resolved);
    }
  }
  for (const redirect of command.redirects) {
    const resolved = expandPath(redirect.target, facts, cwdOf(command, facts), command.vars);
    if (resolved !== null && isDevicePath(resolved, facts)) found.add(resolved);
  }
  return [...found];
}

/* -------------------------------------------------------------------------------------------- *
 * Command classification helpers
 * -------------------------------------------------------------------------------------------- */

const READ_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "sed",
  "awk",
  "gawk",
  "ls",
  "ll",
  "tree",
  "find",
  "stat",
  "file",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "strings",
  "od",
  "xxd",
  "hexdump",
  "jq",
  "yq",
  "column",
  "nl",
  "pwd",
  "printenv",
  "which",
  "whereis",
  "type",
  "date",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "du",
  "df",
  "id",
  "whoami",
  "uname",
  "hostname",
  "env",
  "ps",
  "lsof",
  "netstat",
  "ss",
  "free",
  "uptime",
  "top",
  "htop",
  "kill",
  "pgrep",
  "pidof",
  "launchctl",
  "crontab",
]);

const DEV_PROGRAMS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "pipenv",
  "cargo",
  "rustc",
  "rustup",
  "go",
  "gofmt",
  "make",
  "cmake",
  "ninja",
  "bazel",
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "biome",
  "eslint",
  "prettier",
  "ruff",
  "black",
  "isort",
  "mypy",
  "pyright",
  "pylint",
  "pytest",
  "tox",
  "nox",
  "python",
  "python3",
  "ruby",
  "bundle",
  "rake",
  "composer",
  "php",
  "dotnet",
  "swift",
  "swiftc",
  "clang",
  "clang++",
  "gcc",
  "g++",
  "cc",
  "javac",
  "java",
  "kotlin",
  "kotlinc",
  "scala",
  "sbt",
  "mix",
  "elixir",
  "erl",
  "Rscript",
  "julia",
  "perl",
  "lua",
  "base64",
  "basenc",
  "source",
  ".",
  "next",
  "vite",
  "nuxt",
  "ng",
  "flask",
  "rails",
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "alias",
  "unalias",
  "umask",
  "wait",
  "true",
  "false",
  "test",
  "[",
  ":",
  "sleep",
  "seq",
]);

const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

const SAFE_SERVE_PROGRAMS = new Set([
  "open",
  "xdg-open",
  "sensible-browser",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "firefox",
  "safari",
  "http-server",
  "serve",
  "nodemon",
  "uvicorn",
  "gunicorn",
  "hypercorn",
  "daphne",
]);

const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "nc",
  "netcat",
  "ncat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "lftp",
  "telnet",
  "socat",
  "openssl",
  "dig",
  "nslookup",
  "host",
  "ping",
  "ping6",
  "traceroute",
  "tracepath",
]);

const INSTALLERS = new Set([
  "brew",
  "port",
  "snap",
  "flatpak",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "zypper",
  "apk",
  "pacman",
]);

const KEYCHAIN_DUMP = /^(find-.*password|dump-keychain)$/;

const LAUNCHCTL_CHANGES = [
  "load",
  "unload",
  "submit",
  "bootstrap",
  "bootout",
  "enable",
  "disable",
  "kickstart",
  "start",
  "stop",
  "remove",
];

function hasArg(args: string[], ...values: string[]): boolean {
  return args.some((a) => values.includes(a) || values.some((v) => a.startsWith(`${v}=`)));
}

function hasInPlace(args: string[]): boolean {
  return args.some(
    (a) =>
      a === "--in-place" ||
      a.startsWith("--in-place=") ||
      a === "-i" ||
      (a.startsWith("-i") && !a.startsWith("--")),
  );
}

function nonOptionArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

/** Options of cp/mv/install/ln/git-clone that consume the next word as their value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-t",
  "--target-directory",
  "-S",
  "--suffix",
  "-m",
  "--mode",
  "-o",
  "--owner",
  "-g",
  "--group",
  "--depth",
  "--branch",
  "-b",
  "--origin",
  "--upload-pack",
  "-u",
  "--reference",
  "--separate-git-dir",
  "--config",
  "-c",
  "--filter",
  "--jobs",
  "--template",
  "--shallow-since",
  "--shallow-exclude",
  "--revision",
]);

/**
 * The positional operands of an argument list, skipping options and the values of
 * {@link VALUE_OPTIONS} (`cp -t /etc/profile.d evil.sh` has one operand, `evil.sh`).
 */
function operands(args: string[], valueOptions: ReadonlySet<string> = VALUE_OPTIONS): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (afterDashDash) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      afterDashDash = true;
      continue;
    }
    if (a.startsWith("--")) {
      // `--target-directory=/etc` carries its value inline; `--depth 1` does not.
      if (!a.includes("=") && valueOptions.has(a)) i += 1;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      // GNU clustering: in `-rt DIR` / `-Dt DIR` the value-taking letter is last and the next word
      // is its value; `-tDIR` carries the value inline.
      const letters = a.slice(1);
      const index = [...letters].findIndex((letter) => valueOptions.has(`-${letter}`));
      if (index >= 0 && index === letters.length - 1) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `cp -t DIR` / `cp -rt DIR` / `cp --target-directory=DIR`: a copy-like command's destination. */
function targetDirectory(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--target-directory" && args[i + 1] !== undefined) return args[i + 1] as string;
    if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
    // `-t DIR`, `-rt DIR`, `-Dt DIR` (GNU clustering: the value-taking `t` is last).
    if (/^-[A-Za-z]*t$/.test(a) && args[i + 1] !== undefined) return args[i + 1] as string;
    // `-tDIR`, `-rtDIR`: the value is attached.
    const attached = /^-[A-Za-z]*t(.+)$/.exec(a);
    if (attached !== null) return attached[1] as string;
  }
  return null;
}

function venvBinary(raw: string): boolean {
  return /(^|\/)\.?venv\/bin\//.test(raw) || /(^|\/)env\/bin\//.test(raw);
}

function globalInstallOf(program: string, args: string[], venv: boolean): boolean {
  if (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun") {
    const global = args.includes("-g") || args.includes("--global") || args.includes("global");
    if (!global) return false;
    const sub = args.find((a) => !a.startsWith("-"));
    if (program === "yarn" && sub === "global" && args.includes("add")) return true;
    return ["install", "i", "add", "upgrade", "update", "link"].includes(sub ?? "");
  }
  if (program === "pip" || program === "pip3") {
    if (!["install", "uninstall", "remove"].includes(args[0] ?? "")) return false;
    return !venv;
  }
  if (program === "python" || program === "python3") {
    const m = args.indexOf("-m");
    const module = m >= 0 ? args[m + 1] : undefined;
    if (module !== "pip" && module !== "pip3") return false;
    return !venv;
  }
  if (program === "uv")
    return args.includes("pip") && args.includes("install") && args.includes("--system");
  if (program === "cargo") return args[0] === "install";
  if (program === "go") return args[0] === "install";
  if (INSTALLERS.has(program)) {
    const sub = args.find((a) => !a.startsWith("-"));
    return ["install", "reinstall", "upgrade", "update", "remove", "uninstall", "add"].includes(
      sub ?? "",
    );
  }
  return false;
}

function commandLineActivatesVenv(commands: SimpleCommand[]): boolean {
  return commands.some((command) =>
    command.argv.some(
      (token) => /(^|\/)\.?venv\/bin\/activate$/.test(token) || /\/bin\/activate$/.test(token),
    ),
  );
}

function gitPushKind(args: string[]): "force" | "remote-destroy" | "protected" | null {
  if (hasArg(args, "--delete", "--prune") || args.includes("-d")) return "remote-destroy";
  let forced = false;
  const positional: string[] = [];
  for (const a of args) {
    if (
      a === "--force" ||
      a === "-f" ||
      a === "--force-with-lease" ||
      a.startsWith("--force-with-lease=") ||
      a === "--force-if-includes" ||
      a === "--mirror" ||
      a === "--all"
    ) {
      forced = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const refs = positional.slice(1);
  for (const ref of refs) {
    if (ref.startsWith(":")) return "remote-destroy";
    if (ref.startsWith("+")) forced = true;
  }
  for (const ref of refs) {
    const destination = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
    const branch = destination
      .replace(/^\+/, "")
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\/[^/]+\//, "");
    if (branch === "main" || branch === "master" || branch.startsWith("release/"))
      return "protected";
  }
  return forced ? "force" : null;
}

function ghIsSafe(args: string[]): boolean {
  const cleaned = args.filter((a) => !a.startsWith("-"));
  const sub = cleaned[0];
  const action = cleaned[1];
  if (sub === undefined || sub === "api" || sub === "search") return true;
  if (sub === "auth")
    return ["login", "logout", "status", "switch", "setup-git", "token"].includes(action ?? "");
  if (sub === "pr") {
    return [
      "create",
      "edit",
      "comment",
      "view",
      "list",
      "diff",
      "checks",
      "status",
      "ready",
      "review",
    ].includes(action ?? "");
  }
  if (sub === "issue") return ["view", "list", "status"].includes(action ?? "");
  if (sub === "repo") return ["view", "list", "clone"].includes(action ?? "");
  if (sub === "release") return ["view", "list", "download"].includes(action ?? "");
  if (sub === "run") return ["view", "list", "watch", "download"].includes(action ?? "");
  if (sub === "workflow") return ["view", "list", "run"].includes(action ?? "");
  if (sub === "secret" || sub === "variable") return action === "list";
  if (sub === "config") return ["get", "list"].includes(action ?? "");
  if (["label", "gist", "extension", "cache", "ruleset", "org", "project"].includes(sub)) {
    return ["list", "view"].includes(action ?? "");
  }
  return false;
}

function hostValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === flag) return args[i + 1] ?? null;
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return null;
}

/** docker/pflag short options that take a value (used to walk a short-option cluster). */
const DOCKER_SHORT_VALUE_LETTERS: ReadonlySet<string> = new Set([
  "a",
  "c",
  "e",
  "h",
  "l",
  "m",
  "p",
  "u",
  "v",
  "w",
]);

/**
 * The value `-X` carries in a docker short-option cluster: the rest of the cluster (`-vHOST`,
 * `-itvHOST`, `-v=HOST`) or `""` when the value is the next word (`-v HOST`). `undefined` when the
 * cluster has no `-X` (its first value-taking letter belongs to another option, e.g. `-eFOO=v`).
 */
function dockerShortValue(arg: string, letter: string): string | undefined {
  const chars = arg.slice(1);
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] as string;
    if (!DOCKER_SHORT_VALUE_LETTERS.has(c)) continue;
    if (c !== letter) return undefined;
    return chars.slice(i + 1).replace(/^=/, "");
  }
  return undefined;
}

function volumeHostPaths(args: string[]): Array<string | null> {
  const out: Array<string | null> = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    let spec: string | null = null;
    let isMount = false;
    if (a === "-v" || a === "--volume") spec = args[i + 1] ?? null;
    else if (a.startsWith("--volume=")) spec = a.slice("--volume=".length);
    else if (a === "--mount") {
      spec = args[i + 1] ?? null;
      isMount = true;
    } else if (a.startsWith("--mount=")) {
      spec = a.slice("--mount=".length);
      isMount = true;
    } else if (a.startsWith("-") && !a.startsWith("--")) {
      // `-vHOST`, `-v=HOST` and clusters (`-itvHOST:CTR`); an empty value means the next word.
      const short = dockerShortValue(a, "v");
      if (short !== undefined) spec = short.length > 0 ? short : (args[i + 1] ?? null);
    }
    if (spec === null) continue;
    if (isMount) {
      const fields = spec.split(",");
      const type = fields.find((f) => f.startsWith("type="))?.slice(5);
      if (type !== undefined && type !== "bind") continue;
      const source = fields.find((f) => f.startsWith("source=") || f.startsWith("src="));
      if (source !== undefined) out.push(source.slice(source.indexOf("=") + 1));
      continue;
    }
    const host = spec.split(":")[0] ?? "";
    // A named volume (`mydata:/data`) has no host path. Absolute, `~`-, `.`- and `$`-rooted
    // sources are host paths; a variable is resolved by the caller (`$HOME/.ssh`, `${HOME}/.ssh`).
    out.push(
      host.startsWith("/") || host.startsWith("~") || host.startsWith(".") || host.startsWith("$")
        ? host
        : null,
    );
  }
  return out;
}

function dockerPrivileged(
  args: string[],
  facts: ResolvedFacts,
  cwd: string,
  vars: ReadonlyMap<string, string | null> = NO_VARS,
): string | null {
  if (args.some((a) => a === "--privileged" || a.startsWith("--privileged="))) {
    return "runs a container with --privileged";
  }
  if (["--pid", "--ipc", "--userns"].some((flag) => hostValue(args, flag) === "host")) {
    return "runs a container in the host's namespace (--pid/--ipc/--userns host)";
  }
  if (hostValue(args, "--net") === "host" || hostValue(args, "--network") === "host") {
    return "runs a container on the host's network (--net host)";
  }
  if (hasArg(args, "--device")) return "passes a host device into a container (--device)";
  for (const volume of volumeHostPaths(args)) {
    if (volume === null) continue;
    // `$(pwd)` is the run's own directory (a run-time substitution, but a known one); `$PWD` is
    // already in the variable table. Everything else must resolve statically.
    const ownDirectory = /^\$\(\s*pwd\s*\)(?=\/|$)/;
    const normalized = ownDirectory.test(volume) ? volume.replace(ownDirectory, cwd) : volume;
    const resolved = expandPath(normalized, facts, cwd, vars);
    // A host path that cannot be resolved (`-v $SECRET_DIR:/data`) may point outside the
    // workspace, so it is never treated as a harmless mount.
    if (resolved === null) {
      return `mounts a host path that cannot be resolved (${volume})`;
    }
    if (!inside(resolved, facts.workspace)) {
      return `mounts a host path outside the workspace (${volume})`;
    }
  }
  return null;
}

function isSecurityToolDisable(inv: Invocation): boolean {
  const { program, args } = inv;
  if (program === "pfctl" && hasArg(args, "-d", "-F", "-f", "-e")) return true;
  if (program === "spctl" && hasArg(args, "--master-disable", "--global-disable")) return true;
  if (program === "csrutil" && args.includes("disable")) return true;
  if (
    (program === "iptables" || program === "ip6tables") &&
    hasArg(args, "-F", "--flush", "-X", "--delete-chain")
  ) {
    return true;
  }
  if (program === "nft" && args.join(" ").includes("flush ruleset")) return true;
  if (program === "ufw" && args.includes("disable")) return true;
  if (program === "setenforce" && args.includes("0")) return true;
  return false;
}

/** The device's own program, unit and launch-agent names. */
const DEVICE_IDENTIFIER =
  /(^|\/)(capybara-device(\.service|\.plist)?|top\.capybara\.device(\.service|\.plist)?)$/;

const isDeviceIdentifier = (value: string): boolean => DEVICE_IDENTIFIER.test(value);

/** Service subcommands that change state; status/show/list/is-active are reads. */
const SERVICE_EDIT_ACTIONS: ReadonlySet<string> = new Set([
  "stop",
  "start",
  "restart",
  "reload",
  "daemon-reload",
  "enable",
  "disable",
  "mask",
  "unmask",
  "kill",
  "load",
  "unload",
  "bootstrap",
  "bootout",
  "submit",
  "kickstart",
  // `systemctl edit UNIT` writes a drop-in; `launchctl remove LABEL` (deprecated) unloads it.
  "edit",
  "remove",
]);

function isDeviceServiceCommand(inv: Invocation): boolean {
  if (!["launchctl", "systemctl", "service", "pkill", "killall", "kill"].includes(inv.program)) {
    return false;
  }
  // Match the device's own program or launch agent, not a substring of an unrelated name.
  if (!inv.args.some((arg) => isDeviceIdentifier(arg))) return false;
  if (["pkill", "killall", "kill"].includes(inv.program)) return true;
  const positional = inv.args.filter((arg) => !arg.startsWith("-"));
  // `service NAME ACTION`: the action is the second operand.
  const action = inv.program === "service" ? positional[1] : positional[0];
  return action !== undefined && SERVICE_EDIT_ACTIONS.has(action);
}

/* -------------------------------------------------------------------------------------------- *
 * Write targets
 * -------------------------------------------------------------------------------------------- */

const WRITE_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "mkdir",
  "touch",
  "truncate",
  "tee",
  "chmod",
  "chown",
  "chgrp",
  "mv",
  "cp",
  "install",
  "ln",
  "dd",
  "sed",
  "perl",
]);

/** The programs some rule understands; an unknown program is never certified by a redirect alone. */
const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([
  ...READ_PROGRAMS,
  ...DEV_PROGRAMS,
  ...SHELL_PROGRAMS,
  ...NETWORK_PROGRAMS,
  ...SAFE_SERVE_PROGRAMS,
  ...WRITE_PROGRAMS,
  "git",
  "gh",
  "docker",
  "kill",
  "pkill",
  "killall",
  "launchctl",
  "crontab",
  "security",
  "find",
  "tar",
  "unzip",
  "zip",
  "gzip",
  "gunzip",
  "vim",
  "nano",
]);

function isKnownCommand(command: SimpleCommand): boolean {
  return eachInvocation([command], (inv) => KNOWN_PROGRAMS.has(inv.program)).length > 0;
}

/** tar short options that consume an argument: the rest of the cluster, or the next word. */
const TAR_VALUE_LETTERS: ReadonlySet<string> = new Set([
  "b",
  "C",
  "f",
  "F",
  "g",
  "H",
  "I",
  "K",
  "L",
  "N",
  "T",
  "V",
  "X",
]);

function writeTargetsOf(inv: Invocation): string[] {
  const { program, args } = inv;
  const positional = nonOptionArgs(args);
  switch (program) {
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred":
    case "mkdir":
    case "touch":
    case "truncate":
    case "tee":
      return positional;
    case "chmod":
    case "chown":
    case "chgrp":
      return positional.slice(1);
    case "mv": {
      // The sources are deleted as well as the destination being written.
      const destination = targetDirectory(args);
      const sources = operands(args);
      return destination === null ? sources : [...sources, destination];
    }
    case "cp":
    case "install":
    case "ln": {
      const destination = targetDirectory(args);
      if (destination !== null) return [destination];
      const ops = operands(args);
      return ops.length > 0 ? [ops[ops.length - 1] as string] : [];
    }
    case "dd":
      return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    case "sed":
    case "perl":
      return hasInPlace(args) ? positional.slice(1) : [];
    case "curl": {
      const out: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i] as string;
        if (
          ["-o", "--output", "-D", "--dump-header", "--output-dir"].includes(a) &&
          args[i + 1] !== undefined
        ) {
          if (args[i + 1] !== "-") out.push(args[i + 1] as string);
        } else if (
          a.startsWith("--output=") ||
          a.startsWith("--dump-header=") ||
          a.startsWith("--output-dir=")
        ) {
          out.push(a.slice(a.indexOf("=") + 1));
        }
      }
      return out;
    }
    case "wget": {
      const out: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i] as string;
        if (
          ["-O", "--output-document", "-P", "--directory-prefix"].includes(a) &&
          args[i + 1] !== undefined
        ) {
          if (args[i + 1] !== "-") out.push(args[i + 1] as string);
        } else if (a.startsWith("--output-document=") || a.startsWith("--directory-prefix=")) {
          out.push(a.slice(a.indexOf("=") + 1));
        }
      }
      return out;
    }
    case "scp":
    case "sftp":
    case "rsync": {
      const last = positional[positional.length - 1];
      // `host:path` and `rsync://...` are remote: the command writes there, not here.
      return last !== undefined && !isRemoteSpec(last) ? [last] : [];
    }
    case "tar": {
      // `-C DIR` extracts into DIR; `-cf ARCHIVE` writes ARCHIVE. `-C` on create only selects
      // the files read, so it is not a write target there.
      const targets: string[] = [];
      let directory: string | null = null;
      let extract = false;
      let create = false;
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i] as string;
        if (a === "-C" || a === "--directory") {
          directory = args[i + 1] ?? null;
          i += 1;
          continue;
        }
        if (a.startsWith("--")) {
          // GNU/bsdtar accept any unambiguous prefix of `--directory` (`--dir`, `--direc`,
          // `--d`); it takes the next word or an `=`-attached value.
          const eq = a.indexOf("=");
          const name = a.slice(2, eq < 0 ? undefined : eq);
          if (name.length > 0 && "directory".startsWith(name)) {
            if (eq >= 0) {
              directory = a.slice(eq + 1);
            } else {
              directory = args[i + 1] ?? null;
              i += 1;
            }
            continue;
          }
        }
        if (a === "--extract" || a === "--get") extract = true;
        if (a === "--create") create = true;
        if (a === "-f" || a === "--file") {
          const value = args[i + 1];
          if (value !== undefined && create) targets.push(value);
          i += 1;
          continue;
        }
        if (a.startsWith("--file=")) {
          if (create) targets.push(a.slice("--file=".length));
          continue;
        }
        if (a.startsWith("-") && !a.startsWith("--")) {
          // Short options cluster (`-xvf`, `-xC/etc`, `-xvC DIR`). A letter that takes an argument
          // consumes the rest of the cluster, or the next word when it is last (`-xC/etc` and
          // `-xC /etc` both put `/etc` in DIR). Later letters are then part of that value, which is
          // why `-xvfC DIR` makes the archive `C` and does not extract into `DIR`.
          const cluster = a.slice(1);
          for (let j = 0; j < cluster.length; j += 1) {
            const letter = cluster[j] as string;
            if (letter === "x") {
              extract = true;
              continue;
            }
            if (letter === "c") {
              create = true;
              continue;
            }
            if (!TAR_VALUE_LETTERS.has(letter)) continue;
            const attachedValue = cluster.slice(j + 1);
            let value: string | undefined;
            if (attachedValue.length > 0) {
              value = attachedValue;
            } else {
              value = args[i + 1];
              if (value !== undefined) i += 1;
            }
            if (letter === "C") directory = value ?? null;
            if (letter === "f" && create && value !== undefined) targets.push(value);
            break;
          }
        }
      }
      if (extract) targets.push(directory ?? ".");
      return targets;
    }
    case "unzip": {
      // `-d/etc` is attached, `-d /etc` is separate; both name the extraction directory.
      const dirs: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i] as string;
        if (a === "-d") {
          if (args[i + 1] !== undefined) dirs.push(args[i + 1] as string);
          i += 1;
          continue;
        }
        if (/^-[A-Za-z]*d$/.test(a) && args[i + 1] !== undefined) {
          dirs.push(args[i + 1] as string);
          i += 1;
          continue;
        }
        const attached = /^-[A-Za-z]*d(.+)$/.exec(a);
        if (attached !== null && attached[1] !== undefined) dirs.push(attached[1]);
      }
      return dirs.length > 0 ? dirs : ["."];
    }
    case "git": {
      if (args[0] !== "clone") return [];
      // `git clone [opts] <url> [dest]`: option values are skipped, so `--depth 1` does not shift
      // the destination into the URL's place.
      const pos = operands(args.slice(1));
      // `git -C DIR clone <url>` writes `<DIR>/<repo>` when no destination is given; a relative
      // destination is relative to `-C`, not to the run's cwd.
      const destination = (dest: string): string => {
        if (dest.startsWith("/") || dest.startsWith("~") || inv.dir === undefined) return dest;
        return `${inv.dir.replace(/\/$/, "")}/${dest}`;
      };
      if (pos.length >= 2) return [destination(pos[1] as string)];
      if (inv.dir === undefined) return []; // the default destination is inside cwd (the workspace)
      const repo = pos[0];
      const name = repo === undefined ? undefined : repoName(repo);
      return name === undefined ? [] : [destination(name)];
    }
    default:
      return [];
  }
}

function isIgnoredDevice(path: string): boolean {
  return (
    path === "-" ||
    ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero", "/dev/random"].includes(
      path,
    )
  );
}

/** `host:path`, `user@host:path` or a URL: scp/sftp/rsync write to the remote, not locally. */
function isRemoteSpec(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~")
  )
    return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return true;
  return /^[^/]*:/.test(path);
}

/** The directory `git clone <url>` creates by default (`https://host/x/y.git` -> `y`). */
function repoName(url: string): string | undefined {
  const cleaned = url.replace(/\/+$/, "");
  const tail = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  const name = tail.slice(tail.lastIndexOf(":") + 1).replace(/\.git$/, "");
  return name.length > 0 ? name : undefined;
}

function writeTargets(command: SimpleCommand): string[] {
  const out: string[] = [];
  for (const redirect of command.redirects) {
    if (redirect.op !== "<" && !isIgnoredDevice(redirect.target)) out.push(redirect.target);
  }
  for (const inv of invocationsOf(command)) {
    for (const target of writeTargetsOf(inv)) {
      if (!isIgnoredDevice(target)) out.push(target);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- *
 * Rules
 * -------------------------------------------------------------------------------------------- */

interface RuleContext {
  facts: ResolvedFacts;
  commands: SimpleCommand[];
  unsure: string | null;
  venv: boolean;
}

/** A rule's verdict plus the commands it covered (a command no rule covers makes the line unsure). */
interface RuleMatch {
  reason: string;
  commands: SimpleCommand[];
  /** The subset whose command itself the rule certifies (a redirect alone certifies only the write). */
  covered?: SimpleCommand[];
}

type RuleCheck = (ctx: RuleContext) => RuleMatch | null;

interface Rule {
  id: string;
  outcome: RuleOutcome;
  check: RuleCheck;
}

/** Every command an invocation of which satisfies `visit`; used to mark commands as covered. */
function eachInvocation(
  commands: SimpleCommand[],
  visit: (inv: Invocation, command: SimpleCommand) => boolean,
): SimpleCommand[] {
  const matched: SimpleCommand[] = [];
  for (const command of commands) {
    for (const inv of invocationsOf(command)) {
      if (visit(inv, command)) {
        matched.push(command);
        break;
      }
    }
  }
  return matched;
}

function isSecretOwner(program: string, paths: string[], facts: ResolvedFacts): boolean {
  for (const path of paths) {
    const t = tildeForm(path, facts);
    // Only ssh's own use of ~/.ssh is its credential; scp / sftp / rsync treat those files as
    // ordinary sources (a local copy is printed-then-copied and asks; a remote one is sent).
    if (
      (t === "~/.ssh" || t.startsWith("~/.ssh/")) &&
      ["git", "ssh", "ssh-add"].includes(program)
    ) {
      return true;
    }
    if (
      (t === "~/.gitconfig" || t === "~/.gitconfig." || t === "~/.git-credentials") &&
      program === "git"
    )
      return true;
    if (t === "~/.config/gh/hosts.yml" && program === "gh") return true;
    if (t.startsWith("~/.aws") && program === "aws") return true;
    if (t.startsWith("~/.config/gcloud") && program === "gcloud") return true;
    if (t.startsWith("~/.azure") && program === "az") return true;
    if (t === "~/.kube/config" && program === "kubectl") return true;
    if (t === "~/.docker/config.json" && program === "docker") return true;
  }
  return false;
}

/** A command that reads a secret path rather than using it as its own tool's credential. */
/** A path word that cannot be resolved but names (or is rooted at) a secret location. */
function isUnresolvedSecretWord(
  candidate: string,
  command: SimpleCommand,
  ctx: RuleContext,
): boolean {
  if (expandPath(candidate, ctx.facts, cwdOf(command, ctx.facts), command.vars) !== null) {
    return false;
  }
  // A bare variable can hold the path of a credential or config file (`$KUBECONFIG`,
  // `$AWS_CONFIG_FILE`, `$DOTENV`); its unresolved value is treated as possibly secret. A variable
  // the line itself assigned (even with an unresolved value) is a shell-local, not evidence of a
  // credential file, so it stays `unsure` rather than asking.
  const bare = BARE_VARIABLE.exec(candidate);
  if (bare !== null) {
    const name = candidate.replace(/^\$\{?/, "").replace(/\}$/, "");
    return command.vars === undefined || !command.vars.has(name);
  }
  return SECRET_LOOKING.test(candidate) || /^(?:\$HOME|\$\{HOME\})(?:\/|$)/.test(candidate);
}

function commandHasUnresolvedSecret(command: SimpleCommand, ctx: RuleContext): boolean {
  // A write target is not read or printed; its own rule judges it (`ask.outside-write`). A value in
  // a known non-path position (`git commit -m $MSG`, a grep pattern) is text, not a file.
  const written = new Set(writeTargets(command));
  const nonPath = nonPathTokens(command);
  const tokens = [...command.argv, ...command.redirects.map((redirect) => redirect.target)];
  return tokens.some((token) => {
    if (written.has(token) || consumeNonPath(nonPath, token)) return false;
    return pathCandidates(token).some((candidate) =>
      isUnresolvedSecretWord(candidate, command, ctx),
    );
  });
}

function readsSecret(command: SimpleCommand, ctx: RuleContext): boolean {
  const tokens = secretTokens(command, ctx.facts);
  if (tokens.length > 0) {
    const owner = eachInvocation([command], (inv) => isSecretOwner(inv.program, tokens, ctx.facts));
    if (owner.length === 0) return true;
  }
  if (commandHasUnresolvedSecret(command, ctx)) return true;
  return (
    eachInvocation(
      [command],
      (inv) => inv.program === "security" && inv.args.some((a) => KEYCHAIN_DUMP.test(a)),
    ).length > 0
  );
}

/**
 * Whether a secret read *earlier* in the line reaches the command at `index` through a pipe: the
 * commands share a pipeline, or the earlier one is inside a wrapper whose stdout feeds it.
 */
function secretFlowsInto(ctx: RuleContext, index: number): boolean {
  const target = ctx.commands[index];
  if (target === undefined) return false;
  const targetFlow = target.flow ?? target.pipeline;
  for (let i = 0; i < index; i += 1) {
    const other = ctx.commands[i] as SimpleCommand;
    if (!readsSecret(other, ctx)) continue;
    // The same pipe inside the line or a wrapper.
    if (other.pipeline === target.pipeline) return true;
    // Output of an earlier command/pipeline feeding the target's wrapper stdin. Commands inside
    // the target's own wrapper share `flow` too, but their own pipes are `pipeline`; only a
    // command from another (or no) wrapper feeds this one.
    if ((other.flow ?? other.pipeline) === targetFlow && other.block !== target.block) return true;
  }
  return false;
}

/** Flags whose value names a credential file the network tool uses (it is not sent as data). */
function isCredentialFlag(program: string, flag: string): boolean {
  if (
    ["ssh", "scp", "sftp"].includes(program) &&
    ["-i", "--identity", "-F", "--ssh-config"].includes(flag)
  ) {
    return true;
  }
  if (program === "rsync" && ["--password-file", "-e", "--rsh"].includes(flag)) return true;
  if (
    program === "curl" &&
    ["--netrc-file", "--config", "--cacert", "--cert", "--key"].includes(flag)
  ) {
    return true;
  }
  if (program === "wget" && ["--netrc-file", "--ca-certificate", "--certificate"].includes(flag)) {
    return true;
  }
  return false;
}

/** Flags whose value is a local file uploaded or posted as data. */
const FILE_SEND_FLAGS: ReadonlySet<string> = new Set([
  "-T",
  "--upload-file",
  "--post-file",
  "--body-file",
]);

/** Flags whose `@file` / `name=@file` value is a local file; their bare value is data. */
const DATA_SEND_FLAGS: ReadonlySet<string> = new Set([
  "-d",
  "--data",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-F",
  "--form",
  // `--json @file` reads the request body from a local file, like `-d @file`.
  "--json",
]);

const isUrlLike = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^https?:/i.test(value);

/**
 * The local files a send value names: `@file`, `name=@file`, curl's form `name=<file`, or a file
 * flag's bare value. Form parameters (`;type=...`) follow the file name. Only curl strips a
 * matching surrounding quote pair from such a value (`@"/path"`); wget and scp do not.
 */
function sendPathCandidates(value: string, bareIsFile: boolean, stripQuotes = false): string[] {
  // `@` and curl form's `<` both mark a value read from a local file.
  const marker = value.search(/[@<]/);
  let candidate =
    marker >= 0 ? (value.slice(marker + 1).split(";")[0] ?? "") : bareIsFile ? value : "";
  if (stripQuotes) candidate = stripQuotePair(candidate);
  if (candidate.length === 0 || candidate === "-") return [];
  if (isUrlLike(candidate) || isRemoteSpec(candidate)) return [];
  if (marker < 0 && !looksLikePath(candidate) && !/\$\{?[A-Za-z_]/.test(candidate)) return [];
  return [candidate];
}

/**
 * Whether an unresolved send value can plausibly be a secret. A URL, a remote path or a path
 * rooted at the run's cwd (`$(pwd)/...`, `$PWD/...`) cannot; `$HOME`, absolute paths, `../`,
 * secret-looking components and unknown variables can.
 */
function unresolvedSendMatters(candidate: string): boolean {
  if (isUrlLike(candidate) || isRemoteSpec(candidate)) return false;
  if (/^(?:\$\(\s*pwd\s*\)|\$\{?PWD\}?)(?:\/|$)/.test(candidate)) return false;
  if (/^(?:\$HOME|\$\{HOME\})(?:\/|$)/.test(candidate)) return true;
  if (SECRET_LOOKING.test(candidate)) return true;
  if (candidate.startsWith("/") || candidate.startsWith("../")) return true;
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(candidate);
}

/** A secret path a network command sends (as data), not one it uses as a credential. */
function networkSendsSecret(inv: Invocation, command: SimpleCommand, ctx: RuleContext): boolean {
  const sendsPath = (candidate: string): boolean => {
    const resolved = expandPath(candidate, ctx.facts, cwdOf(command, ctx.facts), command.vars);
    if (resolved !== null) return isSecretPath(resolved, ctx.facts);
    return unresolvedSendMatters(candidate);
  };
  const sends = (flag: string, value: string): boolean => {
    const bareIsFile = FILE_SEND_FLAGS.has(flag);
    if (!bareIsFile && !DATA_SEND_FLAGS.has(flag)) return false;
    return sendPathCandidates(value, bareIsFile, inv.program === "curl").some(sendsPath);
  };

  if (["scp", "sftp", "rsync"].includes(inv.program)) {
    // The local sources are what the command sends; the last operand is the remote destination.
    // Without a remote last operand (`scp KEY /tmp/`, `rsync -a DIR /tmp/x/`) the command copies
    // locally: the secret never leaves the machine, so only the secret-read rules apply.
    const sources: string[] = [];
    for (let i = 0; i < inv.args.length; i += 1) {
      const a = inv.args[i] as string;
      if (isCredentialFlag(inv.program, a)) {
        i += 1;
        continue;
      }
      if (a.startsWith("-")) continue;
      sources.push(a);
    }
    const destination = sources[sources.length - 1];
    if (destination === undefined || !isRemoteSpec(destination)) return false;
    sources.pop();
    return sources.some((source) => sendPathCandidates(source, true).some(sendsPath));
  }

  const { args } = inv;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (isCredentialFlag(inv.program, flag)) {
      if (!a.includes("=")) i += 1;
      continue;
    }
    if (eq > 0 && sends(flag, a.slice(eq + 1))) return true;
    if (args[i + 1] !== undefined && sends(a, args[i + 1] as string)) {
      i += 1;
      return true;
    }
    const attached = /^-(?:d|T|F)(.+)$/.exec(a);
    if (attached !== null && attached[1] !== undefined && sends(a.slice(0, 2), attached[1])) {
      return true;
    }
  }
  return false;
}

/** Secret files a command uses as its own tool's credential (`curl --netrc-file`, `ssh -i`). */
function credentialSecretTokens(command: SimpleCommand, ctx: RuleContext): Set<string> {
  const out = new Set<string>();
  for (const inv of invocationsOf(command)) {
    for (let i = 0; i < inv.args.length; i += 1) {
      const a = inv.args[i] as string;
      const eq = a.indexOf("=");
      const flag = eq > 0 ? a.slice(0, eq) : a;
      if (!isCredentialFlag(inv.program, flag)) continue;
      const value = eq > 0 ? a.slice(eq + 1) : inv.args[i + 1];
      if (value === undefined) continue;
      const resolved = expandPath(value, ctx.facts, cwdOf(command, ctx.facts), command.vars);
      if (resolved !== null) out.add(resolved);
    }
  }
  return out;
}

/** docker options that take a value, so its positional operands can be found. */
const DOCKER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-a",
  "--attach",
  "-c",
  "--cpu-shares",
  "--cidfile",
  "--cpuset-cpus",
  "--device",
  "-e",
  "--env",
  "--env-file",
  "--entrypoint",
  "-f",
  "--file",
  "-h",
  "--hostname",
  "-l",
  "--label",
  "--label-file",
  "--log-driver",
  "--log-opt",
  "-m",
  "--memory",
  "--mount",
  "--name",
  "--net",
  "--net-alias",
  "--network",
  "-p",
  "--publish",
  "--platform",
  "--restart",
  "--runtime",
  "--security-opt",
  "--stop-signal",
  "--stop-timeout",
  "--target",
  "-t",
  "--tag",
  "--tmpfs",
  "-u",
  "--user",
  "-v",
  "--volume",
  "--volumes-from",
  "-w",
  "--workdir",
]);

/** sed options that take a value (so its script operand can be found). */
const SED_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-e", "--expression", "-f", "--file"]);

/** awk options that take a value (so its program operand can be found). */
const AWK_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-f", "--file", "-v", "-F"]);

/** grep options that take a value (so its pattern operand can be found). */
const GREP_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-m",
  "--max-count",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-d",
  "--directories",
  "-D",
  "--devices",
  "--include",
  "--exclude",
  "--exclude-dir",
]);

/**
 * Raw argument values in a clearly non-path position of a known program: a commit message, a
 * branch/ref name, a script name, a search pattern, a header, a data payload or a URL. An
 * unresolved variable there is ordinary text, so it must not turn a routine command into ask or
 * unsure. A value that names a file (`@file`, `<file`, sed/awk `-f FILE`) is never listed. Values
 * are counted, so the same word in a file position (`git commit -m $X -F $X`) is still checked.
 */
function nonPathArguments(inv: Invocation): Map<string, number> {
  const out = new Map<string, number>();
  const { program, args } = inv;
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    if (value.includes("@") || value.includes("<")) return;
    out.set(value, (out.get(value) ?? 0) + 1);
  };
  // `-x VALUE`, `-xVALUE`, `--long VALUE`, `--long=VALUE`.
  const values = (flags: readonly string[]): void => {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] as string;
      for (const flag of flags) {
        if (a === flag) {
          add(args[i + 1]);
        } else if (flag.startsWith("--") && a.startsWith(`${flag}=`)) {
          add(a.slice(flag.length + 1));
        } else if (!flag.startsWith("--") && a.startsWith(flag) && a.length > flag.length) {
          add(a.slice(flag.length));
        }
      }
    }
  };
  const positional = (): string[] => args.filter((a) => !a.startsWith("-"));
  // An attached short `-fVALUE` (sed/awk/grep read a file) is not a script/pattern operand.
  const hasAttachedFile = (letter: string): boolean =>
    args.some((a) => a.startsWith(`-${letter}`) && !a.startsWith("--") && a.length > 2);

  if (program === "git") {
    values(["-m", "--message", "-b", "--branch", "--author"]);
    // `-c NAME=VALUE` / `--config NAME=VALUE`: a config value, not a local file path.
    for (let i = 0; i < inv.argv.length; i += 1) {
      const a = inv.argv[i] as string;
      if ((a === "-c" || a === "--config") && inv.argv[i + 1] !== undefined) add(inv.argv[i + 1]);
      else if (a.startsWith("--config=")) add(a.slice("--config=".length));
      else if (a.startsWith("-c") && a.length > 2) add(a.slice(2));
    }
    const sub = positional()[0];
    // Refs and remotes of these subcommands are not local file paths.
    if (
      [
        "checkout",
        "switch",
        "branch",
        "push",
        "pull",
        "fetch",
        "merge",
        "rebase",
        "tag",
        "remote",
        "cherry-pick",
        "revert",
        "reset",
      ].includes(sub ?? "")
    ) {
      for (const p of positional().slice(1)) add(p);
    }
    // `git clone <repo> [dir]`: the repository is a URL or a remote spec.
    if (sub === "clone") add(operands(args.slice(1))[0]);
    return out;
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    const pos = positional();
    const run = pos.indexOf("run") >= 0 ? pos.indexOf("run") : pos.indexOf("run-script");
    if (run >= 0) add(pos[run + 1]);
    return out;
  }
  if (["grep", "egrep", "fgrep", "rg", "ag", "ack"].includes(program)) {
    const explicit = args.some(
      (a) =>
        ["-e", "--regexp", "-f", "--file"].includes(a) ||
        a.startsWith("--regexp=") ||
        a.startsWith("--file="),
    );
    values(["-e", "--regexp"]);
    if (!explicit && !hasAttachedFile("f")) add(operands(args, GREP_VALUE_OPTIONS)[0]);
    return out;
  }
  if (program === "sed") {
    const explicit = args.some(
      (a) =>
        a === "-e" ||
        a === "--expression" ||
        a === "-f" ||
        a === "--file" ||
        a.startsWith("--expression=") ||
        a.startsWith("--file="),
    );
    values(["-e", "--expression"]);
    if (!explicit && !hasAttachedFile("f")) add(operands(args, SED_VALUE_OPTIONS)[0]);
    return out;
  }
  if (program === "awk" || program === "gawk") {
    const explicit = args.some((a) => a === "-f" || a === "--file" || a.startsWith("--file="));
    if (!explicit && !hasAttachedFile("f")) add(operands(args, AWK_VALUE_OPTIONS)[0]);
    return out;
  }
  if (program === "curl" || program === "wget") {
    // The last operand is the URL; an earlier one is an option value (`-o FILE`, `-T FILE`).
    const pos = positional();
    add(pos[pos.length - 1]);
    values([
      "-H",
      "--header",
      "-X",
      "--request",
      "-A",
      "--user-agent",
      "-e",
      "--referer",
      "-u",
      "--user",
      "-b",
      "--cookie",
      "--url",
      "-w",
      "--write-out",
      "--post-data",
      "--body-data",
      "--method",
    ]);
    values([
      "-d",
      "--data",
      "--data-binary",
      "--data-raw",
      "--data-urlencode",
      "-F",
      "--form",
      "--json",
    ]);
    return out;
  }
  if (program === "gh") {
    // `--body-file` and other file flags are not listed: they name a file gh reads.
    values([
      "-t",
      "--title",
      "-b",
      "--body",
      "-H",
      "--head",
      "-B",
      "--base",
      "-R",
      "--repo",
      "-l",
      "--label",
      "-a",
      "--assignee",
      "--reviewer",
      "-m",
      "--milestone",
    ]);
    return out;
  }
  if (program === "docker") {
    // docker's positional operands are images, container commands and arguments, not local paths.
    for (const p of operands(args, DOCKER_VALUE_OPTIONS)) add(p);
    values([
      "-t",
      "--tag",
      "--name",
      "-e",
      "--env",
      "-l",
      "--label",
      "-p",
      "--publish",
      "-u",
      "--user",
      "-w",
      "--workdir",
      "--network",
      "--net",
      "--platform",
      "--entrypoint",
      "--restart",
    ]);
    return out;
  }
  if (program === "echo" || program === "printf") {
    for (const a of args) add(a);
  }
  return out;
}

/** Every non-path argument value of a command, with how many times it may be subtracted. */
function nonPathTokens(command: SimpleCommand): Map<string, number> {
  const out = new Map<string, number>();
  for (const inv of invocationsOf(command)) {
    for (const [value, count] of nonPathArguments(inv)) {
      out.set(value, (out.get(value) ?? 0) + count);
    }
  }
  return out;
}

/** Subtract one allowlisted occurrence of `token`; false when it has none left. */
function consumeNonPath(allowed: Map<string, number>, token: string): boolean {
  const count = allowed.get(token) ?? 0;
  if (count <= 0) return false;
  allowed.set(token, count - 1);
  return true;
}

/* -------------------------------------------------------------------------------------------- *
 * Git commands that run arbitrary programs
 * -------------------------------------------------------------------------------------------- */

const SHELL_METACHARS = /[|;&<>$`]/;

/** The value is a single plain program from `allowed` (options allowed, no shell syntax). */
function plainProgram(value: string, allowed: ReadonlySet<string>): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_METACHARS.test(trimmed)) return false;
  const first = baseName(trimmed.split(/\s+/)[0] ?? "");
  if (!allowed.has(first)) return false;
  // A sub-program named later (`ssh -o ProxyCommand=...`) makes the value an execution surface.
  if (/(?:^|\s)(?:curl|wget|nc|ncat|netcat|socat|telnet|base64|xxd|eval)(?:\s|$)/.test(trimmed)) {
    return false;
  }
  return !trimmed.includes("/dev/tcp");
}

const SSH_PROGRAMS: ReadonlySet<string> = new Set(["ssh"]);
const PAGER_PROGRAMS: ReadonlySet<string> = new Set(["cat", "less", "more", "most", "delta"]);
const EDITOR_PROGRAMS: ReadonlySet<string> = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "code",
  "ed",
]);

const GIT_ENV_SSH: ReadonlySet<string> = new Set(["GIT_SSH_COMMAND", "GIT_SSH"]);
const GIT_ENV_ALWAYS: ReadonlySet<string> = new Set([
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CONFIG_PARAMETERS",
  "GIT_EXTERNAL_DIFF",
]);
const GIT_ENV_PAGER: ReadonlySet<string> = new Set(["PAGER", "GIT_PAGER"]);
const GIT_ENV_EDITOR: ReadonlySet<string> = new Set([
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "VISUAL",
]);

/** An environment assignment whose value is a program git runs on its behalf. */
function gitEnvIsDangerous(token: string): boolean {
  const match = ASSIGNMENT.exec(token);
  if (match === null) return false;
  const name = match[1] as string;
  const value = match[2] ?? "";
  if (GIT_ENV_SSH.has(name)) return !plainProgram(value, SSH_PROGRAMS);
  if (GIT_ENV_PAGER.has(name)) return !plainProgram(value, PAGER_PROGRAMS);
  if (GIT_ENV_EDITOR.has(name)) return !plainProgram(value, EDITOR_PROGRAMS);
  if (GIT_ENV_ALWAYS.has(name)) return true;
  return (
    name === "GIT_CONFIG_COUNT" ||
    name.startsWith("GIT_CONFIG_KEY_") ||
    name.startsWith("GIT_CONFIG_VALUE_")
  );
}

/** A config setting that names a program git runs (or an alias that is a shell command). */
function gitConfigIsDangerous(key: string, value: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith("alias.")) return value.trimStart().startsWith("!");
  if (k === "core.sshcommand") return !plainProgram(value, SSH_PROGRAMS);
  if (k === "core.pager") return !plainProgram(value, PAGER_PROGRAMS);
  if (k === "core.editor" || k === "sequence.editor") {
    return !plainProgram(value, EDITOR_PROGRAMS);
  }
  if (k === "core.askpass" || k === "diff.external" || /^http\..*\.cmd$/.test(k)) return true;
  return false;
}

/**
 * Whether a git command makes git run a program the review did not see: an executing `-c` config
 * value (`core.sshCommand`, `core.pager`, `diff.external`, `http.*.cmd`, `alias.*=!…`), a config
 * write of one, or an environment override (`GIT_SSH_COMMAND`, `GIT_ASKPASS`, `PAGER`, editors).
 * A value that is a plain ssh/pager/editor command is the tool's own transport and stays allowed.
 */
function gitRunsArbitraryProgram(command: SimpleCommand): boolean {
  let isGit = false;
  for (const inv of invocationsOf(command)) {
    if (inv.program !== "git") continue;
    isGit = true;
    for (let i = 0; i < inv.argv.length; i += 1) {
      const a = inv.argv[i] as string;
      let setting: string | undefined;
      if ((a === "-c" || a === "--config") && inv.argv[i + 1] !== undefined) {
        setting = inv.argv[i + 1];
      } else if (a.startsWith("--config=")) {
        setting = a.slice("--config=".length);
      } else if (a.startsWith("-c") && a.length > 2) {
        setting = a.slice(2);
      }
      if (setting === undefined) continue;
      const eq = setting.indexOf("=");
      if (eq <= 0) continue;
      if (gitConfigIsDangerous(setting.slice(0, eq), setting.slice(eq + 1))) return true;
    }
    if (inv.args[0] === "config") {
      const configOperands = inv.args.slice(1).filter((a) => !a.startsWith("-"));
      const key = configOperands[0];
      const value = configOperands[1];
      if (key !== undefined && value !== undefined && gitConfigIsDangerous(key, value)) return true;
    }
  }
  if (!isGit) return false;
  // Only the environment prefix (before the git program) can override git's subprocesses; a
  // `PAGER=...` value in `git commit -m PAGER=...` is data.
  const gitIndex = command.argv.findIndex((token) => baseName(token) === "git");
  const prefix = gitIndex < 0 ? [] : command.argv.slice(0, gitIndex);
  return prefix.some((token) => gitEnvIsDangerous(token));
}

/* -------------------------------------------------------------------------------------------- *
 * Fail-closed floor for dynamic arguments
 * -------------------------------------------------------------------------------------------- */

/** Programs whose non-option arguments name files (so a dynamic value there is a path). */
const FILE_READERS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "sed",
  "awk",
  "gawk",
  "find",
  "stat",
  "file",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "strings",
  "od",
  "xxd",
  "hexdump",
  "jq",
  "yq",
  "column",
  "nl",
  "realpath",
  "readlink",
  "du",
  "ls",
  "tree",
  "unzip",
  "zip",
  "gzip",
  "gunzip",
  "tar",
]);
const FILE_ARGUMENT_PROGRAMS: ReadonlySet<string> = new Set([...FILE_READERS, ...WRITE_PROGRAMS]);

/** A value that, after `$(pwd)` / `$PWD`, has no unresolved part left to fear. */
function knownPathRoot(candidate: string, cwd: string): boolean {
  const staticized = candidate.replace(/\$\(\s*pwd\s*\)/g, cwd).replace(/\$\{?PWD\}?/g, cwd);
  return !/[$`]/.test(staticized);
}

/** A dynamic value that names a path: a bare variable, a separator, a relative root or a suffix. */
function isPathLikeDynamic(candidate: string): boolean {
  if (isUrlLike(candidate) || isRemoteSpec(candidate)) return false;
  if (BARE_VARIABLE.test(candidate)) return true;
  if (candidate.includes("/") || candidate.startsWith("~") || candidate.startsWith(".")) {
    return true;
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(candidate);
}

/** Long options whose `--name=VALUE` value names a local file to read or write. */
const FILE_LONG_OPTIONS: ReadonlySet<string> = new Set([
  "--file",
  "--output",
  "--upload-file",
  "--post-file",
  "--body-file",
  "--directory",
  "--input",
]);

/**
 * The generic fail-closed floor: a value with a variable, substitution, backtick or quote that
 * cannot be resolved is never allowed in a path position. A command whose program reads or writes
 * files has every non-option value in a file position; any other command needs a path-like value.
 */
function dynamicArgumentAsks(command: SimpleCommand, ctx: RuleContext): boolean {
  const nonPath = nonPathTokens(command);
  const written = new Set(writeTargets(command));
  const filePosition = invocationsOf(command).some((inv) =>
    FILE_ARGUMENT_PROGRAMS.has(inv.program),
  );
  const cwd = cwdOf(command, ctx.facts);
  const tokens = [...command.argv, ...command.redirects.map((redirect) => redirect.target)];
  for (const token of tokens) {
    if (!/[$`"']/.test(token)) continue;
    if (written.has(token) || consumeNonPath(nonPath, token)) continue;
    // A leading environment assignment is a variable value, not a file argument.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    // `pathCandidates` drops dynamic words that are not path-shaped (`$A$B`, `$(date).txt`); in a
    // file position the word itself is still a path. An option carries its value after `=` or, for
    // the file flags (`-f` sed/awk/grep, `-T`, `-o`, `-O`, `-D`), attached to the letter.
    const candidates = pathCandidates(token);
    let probes: string[];
    if (candidates.length > 0) {
      probes = candidates;
    } else if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      const longName = eq > 0 ? token.slice(0, eq) : token;
      const attached = /^-[fToOD](.+)$/.exec(token);
      const value = eq > 0 && FILE_LONG_OPTIONS.has(longName) ? token.slice(eq + 1) : attached?.[1];
      probes =
        value !== undefined && value.length > 0 && !nonPath.has(value) && !written.has(value)
          ? [value]
          : [];
    } else {
      probes = [token];
    }
    for (const candidate of probes) {
      if (expandPath(candidate, ctx.facts, cwd, command.vars) !== null) continue;
      if (isUrlLike(candidate) || isRemoteSpec(candidate)) continue;
      if (knownPathRoot(candidate, cwd)) continue;
      if (filePosition || isPathLikeDynamic(candidate)) return true;
    }
  }
  return false;
}

function isServeInvocation(inv: Invocation): boolean {
  const { program, args } = inv;
  if (program === "python" || program === "python3") {
    return args.includes("-m") && args.some((a) => a === "http.server" || a === "SimpleHTTPServer");
  }
  if (program === "php") return args.includes("-S");
  if (program === "flask") return args[0] === "run";
  if (program === "rails") return args[0] === "server" || args[0] === "s";
  if (SAFE_SERVE_PROGRAMS.has(program)) return true;
  if (["next", "vite", "nuxt", "ng"].includes(program)) {
    const sub = nonOptionArgs(args)[0];
    return sub === undefined || ["dev", "start", "serve", "preview", "watch"].includes(sub);
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    const sub = args.find((a) => !a.startsWith("-"));
    const script = sub === "run" ? args[args.indexOf("run") + 1] : sub;
    return script === "dev" || script === "start" || script === "serve" || script === "preview";
  }
  return false;
}

function writesOutside(inv: Invocation, command: SimpleCommand, ctx: RuleContext): boolean {
  for (const target of writeTargetsOf(inv)) {
    const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts), command.vars);
    if (resolved !== null && !inside(resolved, ctx.facts.workspace) && !tmpRootOf(resolved))
      return true;
  }
  for (const redirect of command.redirects) {
    if (redirect.op === "<") continue;
    const resolved = expandPath(
      redirect.target,
      ctx.facts,
      cwdOf(command, ctx.facts),
      command.vars,
    );
    if (resolved !== null && !inside(resolved, ctx.facts.workspace) && !tmpRootOf(resolved))
      return true;
  }
  return false;
}

function rmIsRecursiveForce(args: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (a === "--recursive") recursive = true;
    else if (a === "--force") force = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes("r") || a.includes("R")) recursive = true;
      if (a.includes("f")) force = true;
    }
  }
  return recursive && force;
}

/** The part of a path before its first glob segment: `rm -rf /home/*` deletes `/home`. */
function globBase(path: string): string {
  const parts = path.split("/");
  const index = parts.findIndex((part) => part.includes("*") || part.includes("?"));
  if (index < 0) return path;
  return parts.slice(0, index).join("/") || "/";
}

function isDangerousDelete(resolved: string, ctx: RuleContext): boolean {
  const base = globBase(resolved);
  const t = tildeForm(base, ctx.facts);
  if (t === "/" || t === "~" || t === "~/") return true;
  return isAncestor(base, ctx.facts.workspace);
}

function modifiesDevice(command: SimpleCommand, ctx: RuleContext): boolean {
  // Only a write redirect that really lands on a device path counts (`2>/dev/null`, a listing to
  // /tmp and a read of the device files are not edits).
  const redirectsDevice = command.redirects.some((redirect) => {
    if (redirect.op === "<" || isIgnoredDevice(redirect.target)) return false;
    const resolved = expandPath(
      redirect.target,
      ctx.facts,
      cwdOf(command, ctx.facts),
      command.vars,
    );
    return resolved !== null && isDevicePath(resolved, ctx.facts);
  });
  if (redirectsDevice) return true;
  return (
    eachInvocation([command], (inv) =>
      [
        "rm",
        "mv",
        "cp",
        "chmod",
        "chown",
        "truncate",
        "tee",
        "sed",
        "dd",
        "ln",
        "touch",
        "install",
        "shred",
        "unlink",
        "vi",
        "vim",
        "nano",
        "emacs",
        "code",
        "ed",
      ].includes(inv.program),
    ).length > 0
  );
}

const RULES: readonly Rule[] = [
  {
    id: "allow.read",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv, command) => {
        if (!READ_PROGRAMS.has(inv.program)) return false;
        if (inv.program === "sed" && hasInPlace(inv.args)) return false;
        if (inv.program === "kill" && !inv.args.includes("-l")) return false;
        if (inv.program === "env" && inv.args.length > 0) return false;
        if (
          inv.program === "crontab" &&
          (!inv.args.includes("-l") || nonOptionArgs(inv.args).length > 0)
        )
          return false;
        if (inv.program === "launchctl") {
          const action = nonOptionArgs(inv.args)[0];
          if (action !== undefined && LAUNCHCTL_CHANGES.includes(action)) return false;
        }
        // `find -delete` / `-exec` / `-fprint` is not a read: its targets are dynamic.
        if (
          inv.program === "find" &&
          inv.args.some((a) =>
            [
              "-delete",
              "-exec",
              "-execdir",
              "-ok",
              "-okdir",
              "-fprint",
              "-fprintf",
              "-fls",
            ].includes(a),
          )
        ) {
          return false;
        }
        // A path-like word or redirection target with an unresolved variable is not a confident
        // read; the line falls to `unsure` instead of `allow`. A value in a known non-path position
        // (`git commit -m $MSG`, a grep pattern) does not count.
        const nonPath = nonPathTokens(command);
        const unresolved = [
          ...inv.argv,
          ...command.redirects.map((redirect) => redirect.target),
        ].some((token) => {
          if (consumeNonPath(nonPath, token)) return false;
          return pathCandidates(token).some(
            (candidate) =>
              isConcretePathWord(candidate) &&
              expandPath(candidate, ctx.facts, cwdOf(command, ctx.facts), command.vars) === null,
          );
        });
        if (unresolved) return false;
        // Reading a secret path is not "reading anything except the secret paths".
        return (
          secretTokens(
            { argv: inv.argv, redirects: command.redirects, pipeline: command.pipeline },
            ctx.facts,
          ).length === 0
        );
      });
      return matched.length > 0
        ? { reason: "Reads files; reading is allowed.", commands: matched }
        : null;
    },
  },
  {
    id: "allow.dev",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (globalInstallOf(inv.program, inv.args, ctx.venv || venvBinary(inv.raw))) return false;
        const local = inv.raw.startsWith("./") || inv.raw.startsWith("../");
        const isDev =
          DEV_PROGRAMS.has(inv.program) ||
          (SHELL_PROGRAMS.has(inv.program) && wrapperScript(inv) === null) ||
          venvBinary(inv.raw) ||
          local;
        if (!isDev) return false;
        // Starting a server is its own rule.
        return !isServeInvocation(inv);
      });
      return matched.length > 0
        ? {
            reason: "Builds, tests or formats the project; development commands are allowed.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "allow.git",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv, command) => {
        if (inv.program !== "git") return false;
        // A config value or environment override that makes git run another program is not a
        // plain git command (`ask.git-exec`).
        if (gitRunsArbitraryProgram(command)) return false;
        if (inv.args[0] === "push" && gitPushKind(inv.args.slice(1)) !== null) return false;
        if (inv.args[0] === "config" && hasArg(inv.args.slice(1), "--global", "--system"))
          return false;
        return true;
      });
      return matched.length > 0
        ? {
            reason:
              "A git command that does not push forcibly or rewrite a remote; this is allowed.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "allow.gh",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (inv.program !== "gh") return false;
        const cleaned = inv.args.filter((a) => !a.startsWith("-"));
        if (cleaned[0] === "pr" && cleaned[1] === "merge") return false;
        if (cleaned[0] === "repo" && cleaned[1] === "delete") return false;
        if (cleaned[0] === "release" && cleaned[1] === "delete") return false;
        return ghIsSafe(inv.args);
      });
      return matched.length > 0
        ? {
            reason: "A GitHub command that only reads or opens a pull request; this is allowed.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "allow.network",
    outcome: "allow",
    check: (ctx) => {
      const matched: SimpleCommand[] = [];
      for (let index = 0; index < ctx.commands.length; index += 1) {
        const command = ctx.commands[index] as SimpleCommand;
        const allowed = invocationsOf(command).some((inv) => {
          if (!NETWORK_PROGRAMS.has(inv.program)) return false;
          if (networkSendsSecret(inv, command, ctx)) return false;
          if (writesOutside(inv, command, ctx)) return false;
          // `nc host < ~/.ssh/id_rsa`: the command sends what it reads from a secret.
          const readsSecretRedirect = command.redirects.some((redirect) => {
            if (redirect.op !== "<") return false;
            const resolved = expandPath(
              redirect.target,
              ctx.facts,
              cwdOf(command, ctx.facts),
              command.vars,
            );
            return resolved === null || isSecretPath(resolved, ctx.facts);
          });
          if (readsSecretRedirect) return false;
          // Only a secret read *before* this command can flow into it.
          return !secretFlowsInto(ctx, index);
        });
        if (allowed) matched.push(command);
      }
      return matched.length > 0
        ? {
            reason:
              "Uses the network; network access is allowed when no secret or outside write is involved.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "allow.serve",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) => isServeInvocation(inv));
      return matched.length > 0
        ? { reason: "Starts a server or opens a browser; this is allowed.", commands: matched }
        : null;
    },
  },
  {
    id: "allow.docker",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(
        ctx.commands,
        (inv, command) =>
          inv.program === "docker" &&
          dockerPrivileged(inv.args, ctx.facts, cwdOf(command, ctx.facts), command.vars) === null,
      );
      return matched.length > 0
        ? { reason: "A Docker command without host access; this is allowed.", commands: matched }
        : null;
    },
  },
  {
    id: "allow.workspace-write",
    outcome: "allow",
    check: (ctx) => {
      const matched: SimpleCommand[] = [];
      for (const command of ctx.commands) {
        if (
          writeTargets(command).some((target) => {
            const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts), command.vars);
            return (
              resolved !== null && inside(resolved, ctx.facts.workspace) && !isGitHook(resolved)
            );
          })
        ) {
          matched.push(command);
        }
      }
      return matched.length > 0
        ? {
            reason: "Writes inside the workspace; this is allowed.",
            commands: matched,
            covered: matched.filter(isKnownCommand),
          }
        : null;
    },
  },
  {
    id: "allow.tmp-write",
    outcome: "allow",
    check: (ctx) => {
      const matched: SimpleCommand[] = [];
      for (const command of ctx.commands) {
        if (
          writeTargets(command).some((target) => {
            const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts), command.vars);
            return resolved !== null && tmpRootOf(resolved);
          })
        ) {
          matched.push(command);
        }
      }
      return matched.length > 0
        ? {
            reason: "Writes to the device's temporary files; this is allowed.",
            commands: matched,
            covered: matched.filter(isKnownCommand),
          }
        : null;
    },
  },
  {
    id: "allow.own-kill",
    outcome: "allow",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (inv.program !== "kill") return false;
        const targets = nonOptionArgs(inv.args);
        if (targets.length === 0) return false;
        return targets.every((t) => t === "$$" || t === "$!" || /^%[A-Za-z0-9_-]+$/.test(t));
      });
      return matched.length > 0
        ? {
            reason: "Stops a process or job the device started; this is allowed.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "ask.outside-write",
    outcome: "ask",
    check: (ctx) => {
      const matched: SimpleCommand[] = [];
      let why: string | null = null;
      for (const command of ctx.commands) {
        for (const target of writeTargets(command)) {
          const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts), command.vars);
          if (resolved !== null && (inside(resolved, ctx.facts.workspace) || tmpRootOf(resolved)))
            continue;
          if (
            resolved !== null &&
            (isGitHook(resolved) ||
              isPersistencePath(resolved, ctx.facts) ||
              isDevicePath(resolved, ctx.facts))
          )
            continue;
          if (resolved !== null && isDangerousDelete(resolved, ctx)) continue;
          matched.push(command);
          why ??=
            resolved === null
              ? "Writes to a path that cannot be resolved statically; this needs approval."
              : `Writes or deletes ${target} outside the workspace and temporary files; this needs approval.`;
        }
      }
      return why === null
        ? null
        : { reason: why, commands: matched, covered: matched.filter(isKnownCommand) };
    },
  },
  {
    id: "ask.force-push",
    outcome: "ask",
    check: (ctx) => {
      let why: string | null = null;
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (inv.program === "git" && inv.args[0] === "push") {
          const kind = gitPushKind(inv.args.slice(1));
          if (kind === "force") {
            why ??= "Force-pushes to a remote; this needs approval.";
            return true;
          }
          if (kind === "protected") {
            why ??=
              "Pushes to a protected branch (main, master or release/*); this needs approval.";
            return true;
          }
        }
        if (inv.program === "gh" && inv.args[0] === "pr" && inv.args[1] === "merge") {
          why ??= "Merges a pull request; this needs approval.";
          return true;
        }
        return false;
      });
      return why === null ? null : { reason: why, commands: matched };
    },
  },
  {
    id: "ask.remote-destroy",
    outcome: "ask",
    check: (ctx) => {
      let why: string | null = null;
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (
          inv.program === "git" &&
          inv.args[0] === "push" &&
          gitPushKind(inv.args.slice(1)) === "remote-destroy"
        ) {
          why ??= "Deletes remote branches or tags; this needs approval.";
          return true;
        }
        if (inv.program === "gh" && inv.args[0] === "repo" && inv.args[1] === "delete") {
          why ??= "Deletes a GitHub repository; this needs approval.";
          return true;
        }
        if (inv.program === "gh" && inv.args[0] === "release" && inv.args[1] === "delete") {
          why ??= "Deletes a GitHub release; this needs approval.";
          return true;
        }
        return false;
      });
      return why === null ? null : { reason: why, commands: matched };
    },
  },
  {
    id: "ask.rc-files",
    outcome: "ask",
    check: (ctx) => {
      let why: string | null = null;
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (
          inv.program === "crontab" &&
          (!inv.args.includes("-l") || nonOptionArgs(inv.args).length > 0)
        ) {
          why ??= "Changes crontab; this needs approval.";
          return true;
        }
        if (inv.program === "launchctl") {
          const action = nonOptionArgs(inv.args)[0];
          if (action !== undefined && LAUNCHCTL_CHANGES.includes(action)) {
            why ??= "Changes a launch agent; this needs approval.";
            return true;
          }
        }
        if (inv.program === "ssh-keygen") {
          why ??= "Changes ~/.ssh; this needs approval.";
          return true;
        }
        if (
          inv.program === "git" &&
          inv.args[0] === "config" &&
          hasArg(inv.args.slice(1), "--global", "--system")
        ) {
          why ??= "Changes ~/.gitconfig; this needs approval.";
          return true;
        }
        return false;
      });
      for (const command of ctx.commands) {
        if (commandHasUnresolvedSecret(command, ctx)) {
          matched.push(command);
          why ??=
            "Changes or prints a shell rc file, SSH configuration or another secret/persistence location; this needs approval.";
        }
        const touched = [
          ...persistenceTokens(command, ctx.facts),
          ...secretTokens(command, ctx.facts),
        ];
        if (touched.length === 0) continue;
        const ownersOnly =
          eachInvocation([command], (inv) => isSecretOwner(inv.program, touched, ctx.facts))
            .length > 0;
        const credentials = credentialSecretTokens(command, ctx);
        if (!ownersOnly && !touched.every((path) => credentials.has(path))) {
          matched.push(command);
          why ??=
            "Changes or prints a shell rc file, SSH configuration or another secret/persistence location; this needs approval.";
        }
      }
      const keychain = eachInvocation(
        ctx.commands,
        (inv) => inv.program === "security" && inv.args.some((a) => KEYCHAIN_DUMP.test(a)),
      );
      if (keychain.length > 0) {
        matched.push(...keychain);
        why ??= "Prints a macOS keychain item; this needs approval.";
      }
      return why === null ? null : { reason: why, commands: matched };
    },
  },
  {
    id: "ask.sudo",
    outcome: "ask",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) =>
        ["sudo", "su", "doas", "pkexec"].includes(inv.program),
      );
      return matched.length > 0
        ? {
            reason: "Runs a command with elevated privileges; this needs approval.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "ask.global-install",
    outcome: "ask",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) =>
        globalInstallOf(inv.program, inv.args, ctx.venv || venvBinary(inv.raw)),
      );
      return matched.length > 0
        ? {
            reason: "Installs a package outside the project; this needs approval.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "ask.docker-privileged",
    outcome: "ask",
    check: (ctx) => {
      let why: string | null = null;
      const matched = eachInvocation(ctx.commands, (inv, command) => {
        if (inv.program !== "docker") return false;
        const reason = dockerPrivileged(
          inv.args,
          ctx.facts,
          cwdOf(command, ctx.facts),
          command.vars,
        );
        if (reason === null) return false;
        why ??= `Docker ${reason}; this needs approval.`;
        return true;
      });
      return why === null ? null : { reason: why, commands: matched };
    },
  },
  {
    id: "ask.kill-other",
    outcome: "ask",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (inv.program === "pkill" || inv.program === "killall") return true;
        if (inv.program !== "kill") return false;
        const targets = nonOptionArgs(inv.args).filter((a) => !a.startsWith("-"));
        if (targets.length === 0) return false;
        return !targets.every((t) => t === "$$" || t === "$!" || /^%[A-Za-z0-9_-]+$/.test(t));
      });
      return matched.length > 0
        ? {
            reason: "Stops a process the device did not start; this needs approval.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "ask.git-exec",
    outcome: "ask",
    check: (ctx) => {
      const matched = ctx.commands.filter((command) => gitRunsArbitraryProgram(command));
      return matched.length > 0
        ? {
            reason:
              "Makes git run another program through a config value, config write or environment override; this needs approval.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "ask.dynamic-arg",
    outcome: "ask",
    check: (ctx) => {
      const matched = ctx.commands.filter((command) => dynamicArgumentAsks(command, ctx));
      return matched.length > 0
        ? {
            reason:
              "Uses a variable, substitution or quoted value as a file path that cannot be resolved statically; this needs approval.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "deny.secret-exfil",
    outcome: "deny",
    check: (ctx) => {
      const direct = eachInvocation(ctx.commands, (inv, command) => {
        if (!NETWORK_PROGRAMS.has(inv.program)) return false;
        if (networkSendsSecret(inv, command, ctx)) return true;
        return command.redirects.some((redirect) => {
          if (redirect.op !== "<") return false;
          const resolved = expandPath(
            redirect.target,
            ctx.facts,
            cwdOf(command, ctx.facts),
            command.vars,
          );
          return resolved === null || isSecretPath(resolved, ctx.facts);
        });
      });
      if (direct.length > 0) {
        return {
          reason:
            "Sends a secret file (an SSH key, cloud credentials or a .env) to a network command.",
          commands: direct,
        };
      }
      const matched: SimpleCommand[] = [];
      for (let index = 0; index < ctx.commands.length; index += 1) {
        const command = ctx.commands[index] as SimpleCommand;
        const network =
          eachInvocation([command], (inv) => NETWORK_PROGRAMS.has(inv.program)).length > 0;
        if (!network) continue;
        // Only a secret read earlier in the line can be piped into this command.
        if (!secretFlowsInto(ctx, index)) continue;
        matched.push(command);
        for (let source = 0; source < index; source += 1) {
          const other = ctx.commands[source] as SimpleCommand;
          if (readsSecret(other, ctx)) matched.push(other);
        }
      }
      return matched.length > 0
        ? {
            reason:
              "Pipes a secret file (an SSH key, cloud credentials or a .env) into a network command.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "deny.root-delete",
    outcome: "deny",
    check: (ctx) => {
      const matched = eachInvocation(ctx.commands, (inv, command) => {
        if (inv.program !== "rm" || !rmIsRecursiveForce(inv.args)) return false;
        for (const target of nonOptionArgs(inv.args)) {
          const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts), command.vars);
          if (resolved !== null && isDangerousDelete(resolved, ctx)) return true;
        }
        return false;
      });
      return matched.length > 0
        ? {
            reason: "Deletes /, the home directory or a parent of the workspace with rm -rf.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "deny.tooling-edit",
    outcome: "deny",
    check: (ctx) => {
      const matched: SimpleCommand[] = [];
      for (const command of ctx.commands) {
        if (deviceTokens(command, ctx.facts).length > 0 && modifiesDevice(command, ctx))
          matched.push(command);
      }
      matched.push(
        ...eachInvocation(
          ctx.commands,
          (inv) => isSecurityToolDisable(inv) || isDeviceServiceCommand(inv),
        ),
      );
      return matched.length > 0
        ? {
            reason:
              "Edits Capybara's own device files or the device directory's marker, or disables an OS security tool.",
            commands: matched,
          }
        : null;
    },
  },
  {
    id: "unsure.unparsed",
    outcome: "unsure",
    check: (ctx) =>
      ctx.unsure === null
        ? null
        : {
            reason: `The command cannot be parsed with confidence (${ctx.unsure}); it needs review.`,
            commands: [],
          },
  },
];

/* -------------------------------------------------------------------------------------------- *
 * Cwd tracking and obfuscation checks
 * -------------------------------------------------------------------------------------------- */

/**
 * Walk the chain and give each command its effective directory (a `cd` earlier in the line moves
 * the commands after it). A `cd` outside the workspace and tmp is `unsure`: the relative paths
 * after it cannot be checked against the workspace.
 */
function assignCwds(commands: SimpleCommand[], facts: ResolvedFacts): DetailedParse {
  let cwd = facts.cwd;
  for (const command of commands) {
    command.cwd = cwd;
    const inv = stripNeutral(command.argv);
    if (inv === null) continue;
    if (inv.program === "pushd" || inv.program === "popd") {
      return { ok: false, unsure: "pushd/popd changes the directory" };
    }
    if (inv.program !== "cd") continue;
    const target = nonOptionArgs(inv.args)[0];
    if (target === undefined)
      return { ok: false, unsure: "cd without a target (the home directory)" };
    const resolved = expandPath(target, facts, cwd);
    if (resolved === null)
      return { ok: false, unsure: "cd into a directory that cannot be resolved" };
    if (!inside(resolved, facts.workspace) && !tmpRootOf(resolved)) {
      return { ok: false, unsure: "cd outside the workspace" };
    }
    cwd = resolved;
  }
  return { ok: true, value: commands };
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** A simple assignment value (`X=$HOME/.kube`), expanded with the variables seen so far. */
function assignmentValue(
  raw: string,
  facts: ResolvedFacts,
  vars: ReadonlyMap<string, string | null>,
): string | null {
  let p = raw;
  if (p === "~" || p.startsWith("~/")) {
    if (facts.home !== null) p = facts.home + p.slice(1);
  } else {
    const homeRef = /^\$(?:\{HOME\}|HOME)(?=\/|$)/.exec(p);
    if (homeRef !== null) {
      const rest = p.slice(homeRef[0].length);
      p = facts.home === null ? `~${rest}` : facts.home + rest;
    }
  }
  const substituted = substituteVariables(p, vars);
  if (substituted === null || /[$`]/.test(substituted)) return null;
  return substituted;
}

/**
 * Track simple assignments for the rule pass.
 *
 * What persists to later commands is only what a real shell persists: a standalone assignment
 * statement (`X=v`) and `export/declare/typeset X=v`. A leading `X=v` environment prefix on a
 * command (`X=/tmp cmd ...`) neither changes the shell's variables nor the expansions of that same
 * command: the shell expands the command words before it runs the command, and the assignment only
 * reaches that command's environment. So a variable a prefix shadows is unresolved for this
 * command's expansions (fail closed instead of trusting the prefix value), and no prefix is ever
 * written to the persistent table. Each command snapshots the table visible to it (with `PWD`).
 */
function assignVariables(commands: SimpleCommand[], facts: ResolvedFacts): void {
  const vars = new Map<string, string | null>();
  for (const command of commands) {
    const cwd = command.cwd ?? facts.cwd;
    vars.set("PWD", cwd);
    const standalone = command.argv.length > 0 && command.argv.every((t) => ASSIGNMENT.test(t));
    if (standalone) {
      for (const token of command.argv) {
        const match = ASSIGNMENT.exec(token);
        if (match === null) continue;
        vars.set(match[1] as string, assignmentValue(match[2] ?? "", facts, vars));
      }
    }
    const inv = stripNeutral(command.argv);
    if (inv !== null && ["export", "declare", "typeset"].includes(inv.program)) {
      for (const arg of inv.args) {
        const match = ASSIGNMENT.exec(arg);
        if (match === null) continue;
        vars.set(match[1] as string, assignmentValue(match[2] ?? "", facts, vars));
      }
    }
    // Leading `X=v` prefixes of this command: unresolved here, not persisted.
    const snapshot = new Map(vars);
    for (const token of command.argv) {
      const match = ASSIGNMENT.exec(token);
      if (match === null) break;
      snapshot.set(match[1] as string, null);
    }
    command.vars = snapshot;
  }
}

function rejectObfuscation(commands: SimpleCommand[]): DetailedParse {
  const byPipeline = new Map<number, SimpleCommand[]>();
  for (const command of commands) {
    const list = byPipeline.get(command.pipeline) ?? [];
    list.push(command);
    byPipeline.set(command.pipeline, list);
  }
  for (const list of byPipeline.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const inv = stripNeutral((list[i] as SimpleCommand).argv);
      if (inv === null || !["base64", "base32", "xxd", "uudecode"].includes(inv.program)) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const later = stripNeutral((list[j] as SimpleCommand).argv);
        if (later === null) continue;
        if (
          SHELL_PROGRAMS.has(later.program) ||
          ["python", "python3", "node", "perl", "ruby", "php", "eval"].includes(later.program)
        ) {
          return { ok: false, unsure: "base64 fed into an interpreter" };
        }
      }
    }
    // A pipeline into an interpreter (`curl ... | bash`): the fed text cannot be inspected.
    if (list.length >= 2) {
      const first = stripNeutral((list[0] as SimpleCommand).argv);
      const last = stripNeutral((list[list.length - 1] as SimpleCommand).argv);
      if (first !== null && last !== null) {
        const interpreter =
          SHELL_PROGRAMS.has(last.program) ||
          ["python", "python3", "node", "perl", "ruby", "php", "eval"].includes(last.program);
        if (interpreter && first.program !== last.program) {
          return { ok: false, unsure: "a pipeline into an interpreter" };
        }
      }
    }
  }
  return { ok: true, value: commands };
}

/** Prefixes that are never stripped: the command behind them is not trusted by prefix. */
const NEVER_PREFIX: ReadonlySet<string> = new Set(["watch", "setsid", "flock", "ionice"]);

function rejectDynamicPaths(commands: SimpleCommand[]): DetailedParse {
  const writePrograms = [
    "rm",
    "mv",
    "cp",
    "install",
    "ln",
    "touch",
    "truncate",
    "tee",
    "mkdir",
    "rmdir",
    "chmod",
    "chown",
    "shred",
  ];
  for (const command of commands) {
    for (const redirect of command.redirects) {
      if (isUnresolvedDynamic(redirect.target))
        return { ok: false, unsure: "dynamic redirection target" };
    }
    const inv = stripNeutral(command.argv);
    if (inv === null) continue;
    if (RESERVED_WORDS.has(inv.program)) return { ok: false, unsure: "a shell control structure" };
    if (isUnresolvedDynamic(inv.raw)) return { ok: false, unsure: "dynamic command" };
    const outer = command.argv[0] === undefined ? "" : baseName(command.argv[0]);
    if (NEVER_PREFIX.has(outer)) {
      return { ok: false, unsure: `the ${outer} prefix is never trusted` };
    }
    if (
      outer === "xargs" &&
      writePrograms.includes(inv.program) &&
      nonOptionArgs(inv.args).length === 0
    ) {
      return { ok: false, unsure: "xargs takes the paths from stdin" };
    }
    if (writePrograms.includes(inv.program)) {
      for (const target of nonOptionArgs(inv.args)) {
        if (isUnresolvedDynamic(target)) return { ok: false, unsure: "dynamic path argument" };
      }
    }
    if (inv.program === "dd") {
      for (const a of inv.args) {
        if (a.startsWith("of=") && isUnresolvedDynamic(a.slice(3))) {
          return { ok: false, unsure: "dynamic path argument" };
        }
      }
    }
  }
  return { ok: true, value: commands };
}

function isUnresolvedDynamic(token: string): boolean {
  if (token.includes("{}")) return true; // xargs' placeholder: the real path comes from stdin
  const withoutHome = token
    .replace(/\$\{HOME\}/g, "")
    .replace(/\$HOME/g, "")
    .replace(/~/g, "");
  return /[$`]/.test(withoutHome);
}

/* -------------------------------------------------------------------------------------------- *
 * Public entry points
 * -------------------------------------------------------------------------------------------- */

const RANKS: Record<RuleOutcome, number> = { allow: 0, unsure: 1, ask: 2, deny: 3 };

function strictest(hits: RuleHit[]): RuleOutcome {
  let outcome: RuleOutcome = "allow";
  for (const hit of hits) if (RANKS[hit.outcome] > RANKS[outcome]) outcome = hit.outcome;
  return outcome;
}

/**
 * The rule table over a command line: the strictest outcome and every hit, in rule order. A parse
 * the tokenizer cannot make confidently yields only `unsure.unparsed`; a command no rule covers
 * adds `unsure.uncovered`.
 */
export function reviewRules(command: string, facts: ReviewFacts): ReviewResult {
  const resolved = resolveFacts(facts);
  const parsed = parseDetailed(command);
  let commands: SimpleCommand[] = [];
  let unsure = parsed.ok ? null : parsed.unsure;
  if (parsed.ok) {
    const withCwds = assignCwds(parsed.value, resolved);
    if (withCwds.ok) {
      commands = withCwds.value;
      assignVariables(commands, resolved);
    } else unsure = withCwds.unsure;
  }
  const ctx: RuleContext = {
    facts: resolved,
    commands,
    unsure,
    venv: commandLineActivatesVenv(commands),
  };
  const hits: RuleHit[] = [];
  const covered = new Set<SimpleCommand>();
  for (const rule of RULES) {
    const match = rule.check(ctx);
    if (match === null) continue;
    hits.push({ id: rule.id, outcome: rule.outcome, reason: match.reason });
    for (const command of match.covered ?? match.commands) covered.add(command);
  }
  const uncovered = commands.filter((command) => command.argv.length > 0 && !covered.has(command));
  if (uncovered.length > 0) {
    hits.push({
      id: "unsure.uncovered",
      outcome: "unsure",
      reason: "No rule covers every command in this line; it needs review.",
    });
  }
  if (hits.length === 0) {
    hits.push({
      id: "unsure.uncovered",
      outcome: "unsure",
      reason: "No rule covers this command; it needs review.",
    });
  }
  return { outcome: strictest(hits), hits };
}

/**
 * The same table for a file-tool write: workspace and tmp writes pass; the device's own files are
 * denied; git hooks, shell rc files and secret files ask; anything else outside asks to write
 * outside.
 */
export function reviewWrite(path: string, facts: ReviewFacts): ReviewResult {
  const resolved = resolveFacts(facts);
  const absolute = expandPath(path, resolved);
  if (absolute === null) {
    return {
      outcome: "unsure",
      hits: [
        {
          id: "unsure.uncovered",
          outcome: "unsure",
          reason: "The path cannot be resolved statically; it needs review.",
        },
      ],
    };
  }
  if (isDevicePath(absolute, resolved)) {
    return {
      outcome: "deny",
      hits: [
        {
          id: "deny.tooling-edit",
          outcome: "deny",
          reason: "Edits Capybara's own device files or the device directory's marker.",
        },
      ],
    };
  }
  if (isGitHook(absolute)) {
    return {
      outcome: "ask",
      hits: [
        { id: "ask.rc-files", outcome: "ask", reason: "Changes a git hook; this needs approval." },
      ],
    };
  }
  if (inside(absolute, resolved.workspace)) {
    return {
      outcome: "allow",
      hits: [
        {
          id: "allow.workspace-write",
          outcome: "allow",
          reason: "Writes inside the workspace; this is allowed.",
        },
      ],
    };
  }
  if (tmpRootOf(absolute)) {
    return {
      outcome: "allow",
      hits: [
        {
          id: "allow.tmp-write",
          outcome: "allow",
          reason: "Writes to the device's temporary files; this is allowed.",
        },
      ],
    };
  }
  if (isPersistencePath(absolute, resolved) || isSecretPath(absolute, resolved)) {
    return {
      outcome: "ask",
      hits: [
        {
          id: "ask.rc-files",
          outcome: "ask",
          reason:
            "Changes a shell rc file, SSH configuration or another secret/persistence location; this needs approval.",
        },
      ],
    };
  }
  return {
    outcome: "ask",
    hits: [
      {
        id: "ask.outside-write",
        outcome: "ask",
        reason: `Writes ${path} outside the workspace and temporary files; this needs approval.`,
      },
    ],
  };
}
