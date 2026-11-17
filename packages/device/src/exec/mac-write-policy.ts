import {
  SANDBOX_GIT_ALLOWED_DIRECTORIES,
  SANDBOX_GIT_ALLOWED_FILES,
  SANDBOX_GIT_DENIED_INTERNALS,
  SANDBOX_MANDATORY_WRITE_DENIES,
} from "@capybara-hq/plugin-sdk";

/** One raw SBPL write rule for the patched sandbox runtime (`writeRegexRules`, macOS). */
export interface MacWriteRegexRule {
  action: "allow" | "deny";
  operations: ("file-write*" | "file-write-unlink" | "file-write-create")[];
  regex: string;
}

const META = /[\\^$.|?*+()[\]{}]/g;
/** A literal name as a regex, every letter matched in either case (APFS is case-insensitive). */
function ci(name: string): string {
  let out = "";
  for (const ch of name) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += lower !== upper ? `[${lower}${upper}]` : ch.replace(META, "\\$&");
  }
  return out;
}
const any = (names: readonly string[]) => `(${names.map(ci).join("|")})`;

/**
 * Every write rule names the specific create and unlink operations as well as `file-write*`:
 * Seatbelt lets a rule for a specific operation (the runtime allows file-write-create in write
 * roots) win over a later wildcard rule, so only rules of the same specificity override in order.
 */
const WRITE: MacWriteRegexRule["operations"] = [
  "file-write*",
  "file-write-create",
  "file-write-unlink",
];

/** Seatbelt refuses a string literal longer than this (measured: 1024 characters fail). */
const MAX_REGEX = 1000;

/**
 * `prefix(a|b|…)suffix` as one rule per group of alternatives, each regex short enough for
 * Seatbelt; adjacent rules with the same action and operations decide exactly like one.
 */
function chunked(
  action: MacWriteRegexRule["action"],
  prefix: string,
  alternatives: readonly string[],
  suffix: string,
): MacWriteRegexRule[] {
  const rules: MacWriteRegexRule[] = [];
  let group: string[] = [];
  const regex = (names: string[]) => `${prefix}(${names.join("|")})${suffix}`;
  for (const alternative of alternatives) {
    if (group.length && regex([...group, alternative]).length > MAX_REGEX) {
      rules.push({ action, operations: WRITE, regex: regex(group) });
      group = [];
    }
    group.push(alternative);
  }
  if (group.length) rules.push({ action, operations: WRITE, regex: regex(group) });
  return rules;
}

/**
 * The shared SDK write policy as ordered SBPL regex rules for one write root (or, with "", any
 * path), appended after every other write rule; Seatbelt is last-match-wins, so a later rule
 * decides over an earlier one for the same operations:
 *
 * 1. deny the mandatory write denies (at any depth, and beneath), every `HEAD`, and everything
 *    below any `.git`;
 * 2. allow git's ordinary internals in a gitdir, a submodule gitdir (`modules/<name…>/`) or a
 *    worktree gitdir (`worktrees/<name>/`);
 * 3. deny again, at any depth below `.git`: the internals that run or redirect code, any `.git`
 *    or `HEAD` inside an allowlisted subtree, and next to the `HEAD`s git keeps there no
 *    `objects`, `commondir` or `gitdir`;
 * 4. allow the `HEAD`s git keeps in its subtrees (`logs/HEAD`, `refs/remotes/<r>/HEAD`, …);
 * 5. deny creating, removing or moving any `.git` entry itself.
 *
 * Seatbelt sees paths, not contents, and cannot tell a directory rename from mkdir at the
 * destination: a directory a command fills outside `.git` and then renames into git's subtrees
 * (where git itself creates arbitrarily named entries) keeps its contents. git's
 * `safe.bareRepository=explicit` (recommended to owners) refuses such a directory as a repository.
 */
export function macWriteRegexRules(root: string): MacWriteRegexRule[] {
  const escaped = root.replace(META, "\\$&");
  const anywhere = `^${escaped}/(.*/)?`;
  const git = `${anywhere}${ci(".git")}`;
  const nested = `(/${ci("modules")}/.+|/${ci("worktrees")}/[^/]+)?`;
  const subtrees = any(SANDBOX_GIT_ALLOWED_DIRECTORIES);
  const head = ci("HEAD");
  const lock = `(${ci(".lock")})?`;
  const keepsHead = `(${ci("logs")}|${ci("sequencer")}|${ci("logs")}/${ci("refs")}/${ci("remotes")}/[^/]+|${ci("refs")}/${ci("remotes")}/[^/]+)`;
  const write = WRITE;
  const deny = (regex: string): MacWriteRegexRule => ({ action: "deny", operations: write, regex });
  const allow = (regex: string): MacWriteRegexRule => ({
    action: "allow",
    operations: write,
    regex,
  });
  const rules: MacWriteRegexRule[] = [
    ...chunked(
      "deny",
      anywhere,
      SANDBOX_MANDATORY_WRITE_DENIES.map((e) => e.map(ci).join("/")),
      "(/.*)?$",
    ),
    deny(`${anywhere}${head}$`),
    deny(`${git}/.+$`),
    allow(`${git}${nested}/${subtrees}(/.*)?$`),
    ...chunked("allow", `${git}${nested}/`, SANDBOX_GIT_ALLOWED_FILES.map(ci), `${lock}$`),
    allow(`${git}${nested}/${ci("info")}/${ci("exclude")}${lock}$`),
    allow(`${git}/${ci("worktrees")}/[^/]+$`),
    deny(
      `${git}/(.*/)?${any(SANDBOX_GIT_DENIED_INTERNALS.map((n) => n.split("/").pop() as string))}(/.*)?$`,
    ),
    deny(`${git}(/.*)?/${subtrees}/(.*/)?${ci(".git")}(/.*)?$`),
    deny(`${git}(/.*)?/${subtrees}/(.*/)?${head}$`),
    deny(`${git}(/.*)?/${keepsHead}/${any(["objects", "commondir", "gitdir"])}(/.*)?$`),
    allow(`${git}${nested}/${ci("logs")}(/${ci("refs")}/${ci("remotes")}/[^/]+)?/${head}$`),
    allow(`${git}${nested}/${ci("refs")}/${ci("remotes")}/[^/]+/${head}$`),
    allow(`${git}${nested}/${ci("sequencer")}/${head}$`),
    {
      action: "deny",
      operations: ["file-write-unlink", "file-write-create"],
      regex: `${anywhere}${ci(".git")}$`,
    },
  ];
  // fail closed: a root so long that a rule cannot be expressed gets no restricted launch
  if (rules.some((rule) => rule.regex.length > MAX_REGEX))
    throw new Error("A write root path is too long for the macOS write policy");
  return rules;
}
