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
      value += "$(...)";
      dynamic = true;
      i = sub.value.end;
      continue;
    }

    if (c === "`") {
      const sub = readBacktick(text, i, depth);
      if (!sub.ok) return sub;
      subs.push(sub.value.commands);
      value += "$(...)";
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
      out += "$(...)";
      dynamic = true;
      i = sub.value.end;
      continue;
    }
    if (c === "`") {
      const sub = readBacktick(text, i, depth);
      if (!sub.ok) return sub;
      subs.push(sub.value.commands);
      out += "$(...)";
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
): ParseSuccess<{ commands: SimpleCommand[]; end: number }> | ParseFailure {
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
        return { ok: true, value: { commands: parsed.value, end: i + 1 } };
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
): ParseSuccess<{ commands: SimpleCommand[]; end: number }> | ParseFailure {
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
      return { ok: true, value: { commands: parsed.value, end: i + 1 } };
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
  let pendingDup = false;
  let pipeline = 0;

  const flush = (): void => {
    for (const sub of subs) sub.pipeline = pipeline;
    commands.push(...subs);
    if (argv.length > 0 || redirects.length > 0) commands.push({ argv, redirects, pipeline });
    argv = [];
    redirects = [];
    subs = [];
    pending = null;
    pendingDup = false;
  };

  for (const token of tokens) {
    if (token.kind === "op") {
      if (token.op === ">" || token.op === ">>" || token.op === "<") {
        pending = { op: token.op };
        continue;
      }
      if (token.op === ">&" || token.op === "<&") {
        pendingDup = true;
        continue;
      }
      flush();
      if (token.op !== "|") pipeline += 1;
      continue;
    }
    if (pendingDup) {
      pendingDup = false;
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
    if (["nohup", "command", "builtin", "exec", "unbuffer", "caffeinate"].includes(program)) {
      rest = rest.slice(1);
      continue;
    }
    if (["time", "nice", "stdbuf", "ionice", "watch"].includes(program)) {
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
    return { program, raw: head, args: rest.slice(1), argv: rest };
  }
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
    for (const nested of inner.value) nested.pipeline = command.pipeline;
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

/** `~` / `$HOME` expanded and relative paths made absolute; null when a variable is unknown. */
function expandPath(path: string, facts: ResolvedFacts, cwd: string = facts.cwd): string | null {
  let p = path;
  if (p === "~" || p.startsWith("~/")) {
    if (facts.home === null) return normalizePath(p);
    p = facts.home + p.slice(1);
  } else {
    const homeRef = /^\$(?:\{HOME\}|HOME)(?=\/|$)/.exec(p);
    if (homeRef !== null) {
      if (facts.home === null) return normalizePath(p);
      p = facts.home + p.slice(homeRef[0].length);
    }
  }
  if (p.startsWith("/") || p.startsWith("~")) return normalizePath(p);
  if (/[$()`]/.test(p)) return null;
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
  return DEVICE_DIRS.some((dir) => t === dir || t.startsWith(`${dir}/`));
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

/** A path argument as written: plain, `@file` (curl), `file=@path`, or `--flag=value`. */
function pathCandidates(token: string): string[] {
  const out: string[] = [];
  const add = (value: string): void => {
    const candidate = value.startsWith("@") ? value.slice(1) : value;
    if (looksLikePath(candidate) && !out.includes(candidate)) out.push(candidate);
  };
  if (token.startsWith("@") && token.length > 1) add(token.slice(1));
  const eq = token.indexOf("=");
  if (eq > 0) add(token.slice(eq + 1));
  if (looksLikePath(token)) out.push(token);
  return out;
}

function cwdOf(command: SimpleCommand, facts: ResolvedFacts): string {
  return command.cwd ?? facts.cwd;
}

function secretTokens(command: SimpleCommand, facts: ResolvedFacts): string[] {
  const found = new Set<string>();
  for (const token of command.argv) {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, facts, cwdOf(command, facts));
      if (resolved !== null && isSecretPath(resolved, facts)) found.add(resolved);
    }
  }
  for (const redirect of command.redirects) {
    const resolved = expandPath(redirect.target, facts, cwdOf(command, facts));
    if (resolved !== null && isSecretPath(resolved, facts)) found.add(resolved);
  }
  return [...found];
}

function persistenceTokens(command: SimpleCommand, facts: ResolvedFacts): string[] {
  const found = new Set<string>();
  for (const token of command.argv) {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, facts, cwdOf(command, facts));
      if (resolved !== null && isPersistencePath(resolved, facts)) found.add(resolved);
    }
  }
  for (const redirect of command.redirects) {
    const resolved = expandPath(redirect.target, facts, cwdOf(command, facts));
    if (resolved !== null && isPersistencePath(resolved, facts)) found.add(resolved);
  }
  return [...found];
}

function deviceTokens(command: SimpleCommand, facts: ResolvedFacts): string[] {
  const found = new Set<string>();
  for (const token of command.argv) {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, facts, cwdOf(command, facts));
      if (resolved !== null && isDevicePath(resolved, facts)) found.add(resolved);
    }
  }
  for (const redirect of command.redirects) {
    const resolved = expandPath(redirect.target, facts, cwdOf(command, facts));
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

function volumeHostPaths(args: string[]): Array<string | null> {
  const out: Array<string | null> = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    let spec: string | null = null;
    let isMount = false;
    if (a === "-v" || a === "--volume") spec = args[i + 1] ?? null;
    else if (a.startsWith("--volume=")) spec = a.slice("--volume=".length);
    else if (a.startsWith("-v") && a.length > 2) spec = a.slice(2);
    else if (a === "--mount") {
      spec = args[i + 1] ?? null;
      isMount = true;
    } else if (a.startsWith("--mount=")) {
      spec = a.slice("--mount=".length);
      isMount = true;
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
    out.push(host.startsWith("/") || host.startsWith("~") || host.startsWith(".") ? host : null);
  }
  return out;
}

function dockerPrivileged(args: string[], facts: ResolvedFacts, cwd: string): string | null {
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
    const resolved = expandPath(volume, facts, cwd);
    if (resolved !== null && !inside(resolved, facts.workspace)) {
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

function isDeviceServiceCommand(inv: Invocation): boolean {
  if (!inv.argv.join(" ").includes("capybara-device")) return false;
  return [
    "launchctl",
    "systemctl",
    "service",
    "pkill",
    "killall",
    "kill",
    "rm",
    "mv",
    "chmod",
    "chown",
  ].includes(inv.program);
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
    case "mv":
      // The sources are deleted as well as the destination being written.
      return positional;
    case "cp":
    case "install":
    case "ln":
      return positional.length > 0 ? [positional[positional.length - 1] as string] : [];
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
    case "git": {
      if (args[0] !== "clone") return [];
      const pos = nonOptionArgs(args.slice(1));
      return pos.length >= 2 ? [pos[1] as string] : [];
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
  command: string;
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
    if (
      (t === "~/.ssh" || t.startsWith("~/.ssh/")) &&
      ["git", "ssh", "scp", "sftp", "rsync", "ssh-add"].includes(program)
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
function readsSecret(command: SimpleCommand, ctx: RuleContext): boolean {
  const tokens = secretTokens(command, ctx.facts);
  if (tokens.length > 0) {
    const owner = eachInvocation([command], (inv) => isSecretOwner(inv.program, tokens, ctx.facts));
    if (owner.length === 0) return true;
  }
  return (
    eachInvocation(
      [command],
      (inv) => inv.program === "security" && inv.args.some((a) => KEYCHAIN_DUMP.test(a)),
    ).length > 0
  );
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

/** A secret path a network command sends (as data), not one it uses as a credential. */
function networkSendsSecret(inv: Invocation, command: SimpleCommand, ctx: RuleContext): boolean {
  const { args } = inv;
  const secret = (token: string): boolean => {
    for (const candidate of pathCandidates(token)) {
      const resolved = expandPath(candidate, ctx.facts, cwdOf(command, ctx.facts));
      if (resolved !== null && isSecretPath(resolved, ctx.facts)) return true;
    }
    return false;
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (isCredentialFlag(inv.program, flag)) {
      if (!a.includes("=")) i += 1;
      continue;
    }
    if (secret(a)) return true;
    if (
      [
        "--body-file",
        "--post-file",
        "--upload-file",
        "-T",
        "-d",
        "--data-binary",
        "--data",
      ].includes(a) &&
      args[i + 1] !== undefined &&
      secret(args[i + 1] as string)
    ) {
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
      const resolved = expandPath(value, ctx.facts, cwdOf(command, ctx.facts));
      if (resolved !== null) out.add(resolved);
    }
  }
  return out;
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
    const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts));
    if (resolved !== null && !inside(resolved, ctx.facts.workspace) && !tmpRootOf(resolved))
      return true;
  }
  for (const redirect of command.redirects) {
    if (redirect.op === "<") continue;
    const resolved = expandPath(redirect.target, ctx.facts, cwdOf(command, ctx.facts));
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

function modifiesDevice(command: SimpleCommand): boolean {
  if (command.redirects.some((r) => r.op !== "<")) return true;
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
        // `find -delete` / `find -exec` is not a read: its targets are dynamic.
        if (
          inv.program === "find" &&
          inv.args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a))
        ) {
          return false;
        }
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
      const matched = eachInvocation(ctx.commands, (inv) => {
        if (inv.program !== "git") return false;
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
      const matched = eachInvocation(ctx.commands, (inv, command) => {
        if (!NETWORK_PROGRAMS.has(inv.program)) return false;
        if (networkSendsSecret(inv, command, ctx)) return false;
        if (writesOutside(inv, command, ctx)) return false;
        // `nc host < ~/.ssh/id_rsa`: the command sends what it reads from a secret.
        const readsSecretRedirect = command.redirects.some((redirect) => {
          if (redirect.op !== "<") return false;
          const resolved = expandPath(redirect.target, ctx.facts, cwdOf(command, ctx.facts));
          return resolved !== null && isSecretPath(resolved, ctx.facts);
        });
        if (readsSecretRedirect) return false;
        const upstream = ctx.commands.some(
          (other) =>
            other.pipeline === command.pipeline && other !== command && readsSecret(other, ctx),
        );
        return !upstream;
      });
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
          dockerPrivileged(inv.args, ctx.facts, cwdOf(command, ctx.facts)) === null,
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
            const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts));
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
            const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts));
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
          const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts));
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
        const reason = dockerPrivileged(inv.args, ctx.facts, cwdOf(command, ctx.facts));
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
    id: "deny.secret-exfil",
    outcome: "deny",
    check: (ctx) => {
      const direct = eachInvocation(ctx.commands, (inv, command) => {
        if (!NETWORK_PROGRAMS.has(inv.program)) return false;
        if (networkSendsSecret(inv, command, ctx)) return true;
        return command.redirects.some((redirect) => {
          if (redirect.op !== "<") return false;
          const resolved = expandPath(redirect.target, ctx.facts, cwdOf(command, ctx.facts));
          return resolved !== null && isSecretPath(resolved, ctx.facts);
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
      for (const command of ctx.commands) {
        const network =
          eachInvocation([command], (inv) => NETWORK_PROGRAMS.has(inv.program)).length > 0;
        if (!network) continue;
        const sources = ctx.commands.filter(
          (other) =>
            other.pipeline === command.pipeline && other !== command && readsSecret(other, ctx),
        );
        if (sources.length > 0) matched.push(command, ...sources);
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
          const resolved = expandPath(target, ctx.facts, cwdOf(command, ctx.facts));
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
        if (deviceTokens(command, ctx.facts).length > 0 && modifiesDevice(command))
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
    if (withCwds.ok) commands = withCwds.value;
    else unsure = withCwds.unsure;
  }
  const ctx: RuleContext = {
    command,
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
