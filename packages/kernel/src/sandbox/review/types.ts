/**
 * Command review, stage 1 (auto-mode spec §5.2): the pure rule table over a parsed shell command
 * line and the facts of the run. No database, model or lock lives here; the kernel service that
 * calls it and the classifier for `unsure` are separate (spec §5.3).
 */

/** One rule's verdict. Strictest wins: `deny` > `ask` > `unsure` > `allow`. */
export type RuleOutcome = "allow" | "ask" | "deny" | "unsure";

/**
 * One rule that fired. `id` is one of the grant classes of the auto-mode spec (§5.2); `reason` is
 * English the model and the person can read.
 */
export interface RuleHit {
  id: string;
  outcome: RuleOutcome;
  reason: string;
}

/**
 * The ask classes a person is asked about every time, never remembered for the session: printing or
 * copying a credential (or a credential file), a link to a secret or a persistence location, a dynamic path argument (the floor of
 * spec §5.2: what it names is only known when it runs) and `sudo` (any command at all). Remembering
 * one would allow the next, different command of that class without the person seeing it.
 */
const NEVER_SESSION_CLASSES: ReadonlySet<string> = new Set([
  "ask.credential-print",
  "ask.secret-file",
  "ask.credential-link",
  "ask.ssh",
  "ask.outside-link",
  "ask.dynamic-arg",
  "ask.sudo",
]);

/**
 * Whether a rule id may back the person's `本会话允许同类` grant: one concrete rule class the person
 * can reason about, never a catch-all. The `unsure.*` hits stand for "no rule decided this", so
 * remembering one would allow every future parser-unreadable command for the conversation — the
 * bucket the review keeps fail-closed. A classifier ask has no rule at all.
 */
export const isSessionGrantableRule = (rule: string | null): rule is string =>
  rule !== null && !rule.startsWith("unsure.") && !NEVER_SESSION_CLASSES.has(rule);

/**
 * The rule outcome once the person's session grants are applied (hardening spec 2026-11-15 R4): an
 * `ask` line is allowed only when **every** ask hit's class is granted and **no** `unsure` hit is
 * left — a grant for one class never lets another class, or an unread part of the line, through.
 * Otherwise the outcome stays, and `hit` is the first hit the grants did not cover (the one the
 * person or the classifier must decide). Not for `deny` or `allow` lines, which grants never touch.
 */
export function applySessionGrants(
  result: ReviewResult,
  granted: (rule: string) => boolean,
): { outcome: RuleOutcome; hit: RuleHit | undefined } {
  if (result.outcome !== "ask") {
    return { outcome: result.outcome, hit: result.hits.find((h) => h.outcome === result.outcome) };
  }
  const open = result.hits.filter(
    (h) =>
      h.outcome === "unsure" ||
      (h.outcome === "ask" && !(isSessionGrantableRule(h.id) && granted(h.id))),
  );
  const ask = open.find((h) => h.outcome === "ask");
  if (ask !== undefined) return { outcome: "ask", hit: ask };
  const unsure = open.find((h) => h.outcome === "unsure");
  if (unsure !== undefined) return { outcome: "unsure", hit: unsure };
  return { outcome: "allow", hit: result.hits.find((h) => h.outcome === "ask") };
}

/**
 * The facts of the run the rules read. Commands run in a device's workspace; `mode` says whether
 * the OS sandbox is on (the rules are the same in both modes), and `attended` says whether a
 * person is present to answer an `ask` (an unattended `ask` becomes a `deny`, spec §5.4).
 */
export interface ReviewFacts {
  /** The device's workspace root: reads are allowed, writes here need no ask. */
  workspace: string;
  mode: "auto" | "sandbox";
  attended: boolean;
  /** The directory the command runs in; default: the workspace. */
  cwd?: string;
  /**
   * Absolute paths this conversation's own tool calls wrote (`Write` / `Edit`, and the write
   * targets of its earlier `Bash` lines): running one of them with an interpreter is not a
   * development command but code the run itself produced (hardening spec R1).
   */
  written?: readonly string[];
}

/** One shell redirection of a simple command. */
export interface Redirect {
  op: ">" | ">>" | "<";
  /** The target as written (not resolved; the rules resolve it against the run's facts). */
  target: string;
}

/** One simple command (after quoting, pipes and chains are split). */
export interface SimpleCommand {
  /** Shell words, quotes removed; a command substitution is kept as `$(...)` in its word. */
  argv: string[];
  redirects: Redirect[];
  /**
   * Commands joined by `|` share an index: data a secret-reading command produced flows into the
   * commands after it, which is what the secret-exfiltration rule reads.
   */
  pipeline: number;
  /**
   * The wrapper the command was unwrapped from (`bash -c`, `sh -c`, `eval`, `su -c`), when any.
   * The unwrapped commands replace the wrapper in {@link ParsedCommand.commands}.
   */
  wrapper?: string;
  /**
   * The absolute directory this command runs in. `parseCommand` leaves it unset (it has no run
   * facts); `reviewRules` sets it while walking the chain, so a `cd` earlier in the line moves the
   * relative paths of the commands after it.
   */
  cwd?: string;
  /**
   * Where this command's stdout flows when it is inside an unwrapped wrapper: the wrapper's own
   * pipeline. Unset for ordinary commands, whose stdout flows into their own {@link pipeline}.
   */
  flow?: number;
  /** The unwrapped wrapper a command belongs to (undefined outside any wrapper). */
  block?: number;
  /**
   * The shell variable values visible to this command (a simple `NAME=value` / `export NAME=value`
   * table built by `reviewRules`, with `PWD`): used to resolve `$X` inside path arguments.
   */
  vars?: ReadonlyMap<string, string | null>;
}

/** The parsed command line: every simple command, in execution order. */
export interface ParsedCommand {
  commands: SimpleCommand[];
}

/** The public review result: the strictest outcome and every hit, in rule-table order. */
export interface ReviewResult {
  outcome: RuleOutcome;
  hits: RuleHit[];
}
