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
