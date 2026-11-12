import { randomBytes } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";

/**
 * Launching a background Bash task (spec 2026-11-05-background-bash-design §4.2): the task id, the
 * one short exec that starts the command detached from the exec, and the model-visible result.
 * Every path is relative to the instance's workspace root (the launch exec's `cwd`), so the
 * script is the same whatever the instance's roots are.
 */

/** The launch exec's own time limit: it only writes a file and forks. */
export const LAUNCH_EXEC_TIMEOUT_MS = 30_000;

/**
 * The longest a background task may run, in seconds: `sandbox.background.maxSeconds`, at most
 * `sandbox.limits.maxCommandSeconds`. It is also a task's default `timeout`.
 */
export const backgroundMaxSeconds = (cfg: Pick<KernelConfig, "sandbox">): number =>
  Math.min(cfg.sandbox.background.maxSeconds, cfg.sandbox.limits.maxCommandSeconds);

/** The directory of the task files, relative to the workspace root. */
export const TASKS_DIR = ".capybara/tasks";

/** A task's output file, relative to the workspace root (`output_path` while reserved). */
export const taskOutputPath = (id: string): string => `${TASKS_DIR}/${id}.out`;

/**
 * The absolute output file of a task from its `output_path`: absolute once the task started (the
 * launch records `<workspace>/.capybara/tasks/<id>.out` of its instance); a reservation's relative
 * path is read under the default workspace.
 */
export const taskOutputFile = (outputPath: string): string =>
  outputPath.startsWith("/") ? outputPath : `${DEFAULT_SANDBOX_ROOTS.workspace}/${outputPath}`;

/** The file the launch writes the session id to, relative to the workspace root. */
export const taskSidPath = (id: string): string => `${TASKS_DIR}/${id}.sid`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new task id: `bt_` plus 6 lowercase base32 characters. */
export function newTaskId(): string {
  const bytes = randomBytes(6);
  let out = "bt_";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

/** The programs a session launch and the later polls and stops need (Linux, sandbox-fake). */
const REQUIRED_SESSION = ["bash", "setsid", "nohup", "timeout", "pgrep", "pkill", "base64"];
/** The programs a process group launch and the later polls and stops need (macOS). */
const REQUIRED_GROUP = ["bash", "perl", "nohup", "base64"];

/** A task id ({@link newTaskId}). */
export const TASK_ID_RE = /^bt_[a-z2-7]{6}$/;

/**
 * A shell fragment that sets how a task's processes are found and signalled by its sid, defining
 * `tk_alive <sid>` (status 0 while the task has a process) and `tk_kill <SIGNAL> <sid>` (0: sent,
 * 1: no process left, anything else: a failure), and `pg` to the mode:
 * - `-s`, the session, where `pgrep` has `-s` (Linux procps and busybox, the sandbox-fake shims:
 *   `pgrep -s 0`, the own session, exits 0 or 1): `pgrep -s` and `pkill -s`;
 * - `-g`, the process group, elsewhere (macOS). Its `pgrep` has no `-s`, and inside the OS sandbox
 *   (Seatbelt) a command can neither list processes nor signal those of another command. So the
 *   task's process group (its id is the sid) is watched by its launcher ({@link GROUP_LAUNCHER}),
 *   which signals it on request: `tk_kill` appends the signal to `.capybara/tasks/g<sid>.ctl`, and
 *   `tk_alive` asks `kill(0, -sid)`, where "not permitted" (another command's group) still means
 *   the group exists. A group signal is one system call, so it misses no process forked meanwhile.
 * Relative to the workspace root. Every script that asks for or signals a task's processes starts
 * with it; the launch picks its launcher with the same test.
 */
export const SESSION_MODE_SCRIPT = [
  'if pgrep -s 0 >/dev/null 2>&1 || [ "$?" -eq 1 ]; then pg=-s',
  'tk_alive() { pgrep -s "$1" >/dev/null 2>&1; }',
  'tk_kill() { pkill -"$1" -s "$2"; }',
  "else pg=-g",
  `tk_alive() { perl -e 'exit((kill(0, -$ARGV[0]) || $!{EPERM}) ? 0 : 1)' "$1"; }`,
  `tk_kill() { tk_alive "$2" || return 1; echo "$1" >> ${TASKS_DIR}/g"$2".ctl || return 2; }`,
  "fi",
].join("\n");

/**
 * The process group launcher (macOS: {@link SESSION_MODE_SCRIPT}'s `-g`), a perl program run as
 * `perl -e <this> <seconds> <task path>` from the workspace root. It makes a session of its own
 * (leaving the launch exec's process group), starts `bash <task>.sh` as the leader of a new process
 * group (the task; its id, the sid, goes to `<task>.sid` through a rename) and watches it every
 * 0.1 s, outside the group:
 * - the command exits: its status as the shell gives it (`128 + signal` when killed) goes to
 *   `<task>.exit`, and what it left running in the group is SIGKILLed (the task ends when its
 *   command exits, as the poll does on Linux);
 * - the time limit passes: 137 goes to `<task>.exit`, then the group is SIGKILLed (as
 *   `timeout -s KILL`);
 * - a signal is requested in `g<sid>.ctl` ({@link SESSION_MODE_SCRIPT}'s `tk_kill`, read through
 *   a rename): the group gets it, and no exit file is written any more (a stop, as on Linux).
 * It exits once the group is empty. Contains no single quote (it goes between single quotes).
 */
export const GROUP_LAUNCHER = [
  "use POSIX;",
  "my ($n, $t) = @ARGV;",
  "my ($d) = $t =~ m{^(.*)/};",
  'sub put { my ($f, $v) = @_; open(my $h, ">", "$f.tmp") or return; print $h "$v\\n"; close($h); rename("$f.tmp", $f) }',
  'POSIX::setsid() or die "setsid: $!\\n";',
  "my $c = fork();",
  'defined $c or die "fork: $!\\n";',
  'if ($c == 0) { setpgid(0, 0); exec("bash", "$t.sh") or POSIX::_exit(127) }',
  "setpgid($c, $c);",
  'put("$t.sid", $c);',
  'my $ctl = "$d/g$c.ctl";',
  "my $end = time() + $n;",
  "my ($code, $done);",
  'sub fin { put("$t.exit", $_[0]) unless $done; $done = 1 }',
  "while (1) {",
  '  if (rename($ctl, "$ctl.$$")) { open(my $h, "<", "$ctl.$$"); my @s = grep { /^[A-Z0-9]+$/ } map { s/\\s+//gr } <$h>; close($h); unlink("$ctl.$$"); $done = 1; kill($_, -$c) for @s }',
  '  if (!defined $code && waitpid($c, WNOHANG) == $c) { $code = ($? & 127) ? 128 + ($? & 127) : $? >> 8; fin($code); kill("KILL", -$c) }',
  '  if (!defined $code && time() >= $end) { fin(137); kill("KILL", -$c) }',
  "  last if defined $code && !kill(0, -$c);",
  "  select(undef, undef, undef, 0.1);",
  "}",
].join(" ");

/**
 * The shell of the launch exec: writes `command` (base64 in the script, so nothing is quoted by
 * hand) to `.capybara/tasks/<id>.sh` and starts it with bash (the shell a foreground `Bash` call
 * runs its command in), detached from the exec under a hard time limit of `seconds` that SIGKILLs
 * every process of the task, with its exit status written to `<id>.exit` and its output to
 * `<id>.out`; the task's sid goes to `<id>.sid` and is printed. Where `pgrep` has `-s`
 * ({@link SESSION_MODE_SCRIPT}) the command runs in a session of its own under
 * `setsid nohup sh -c 'timeout -s KILL <seconds> …'` and the sid is `$!`, the pid `setsid` started;
 * elsewhere (macOS: no `setsid`, no `timeout`, no `pgrep -s`) {@link GROUP_LAUNCHER} runs it in a
 * process group of its own, watched by the launcher, and writes the sid (the group id) itself,
 * which the launch waits for (up to 10 s). An
 * environment without one of the needed programs fails with a readable error on stderr and exit
 * code 127, before anything starts. `id` must be a task id and `seconds` a positive integer (both
 * go into the script unquoted).
 */
export function launchScript(id: string, command: string, seconds: number): string {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid background task id: ${JSON.stringify(id)}`);
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error(`invalid background task seconds: ${seconds}`);
  }
  const b64 = Buffer.from(command, "utf8").toString("base64");
  const t = `${TASKS_DIR}/${id}`;
  const need = (list: string[]) =>
    `for c in ${list.join(" ")}; do command -v "$c" >/dev/null 2>&1 || { echo "Background tasks need ${list.join(", ")} in this environment; $c is missing." >&2; exit 127; }; done`;
  return [
    "set -e",
    SESSION_MODE_SCRIPT,
    `if [ "$pg" = -s ]; then ${need(REQUIRED_SESSION)}; else ${need(REQUIRED_GROUP)}; fi`,
    `mkdir -p ${TASKS_DIR}`,
    `printf '%s' '${b64}' | base64 -d > ${t}.sh`,
    `if [ "$pg" = -s ]; then`,
    `setsid nohup sh -c 'timeout -s KILL ${seconds} bash ${t}.sh; echo $? > ${t}.exit' > ${t}.out 2>&1 < /dev/null &`,
    // the session id goes to a file first: a launch that ends before its output comes back
    // (aborted, timed out) still leaves the id of what it started
    `echo $! > ${t}.sid`,
    "else",
    `rm -f ${t}.sid`,
    `nohup perl -e '${GROUP_LAUNCHER}' ${seconds} ${t} > ${t}.out 2>&1 < /dev/null &`,
    // the launcher writes the group id once the group exists
    `i=0; while [ ! -s ${t}.sid ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done`,
    `[ -s ${t}.sid ] || { echo "The background task did not start: no process group id after 10 s." >&2; exit 1; }`,
    "fi",
    `cat ${t}.sid`,
  ].join("\n");
}

/** The model-visible result of a launch (spec §2.1); `workspace`: the instance's workspace root. */
export function startedText(
  id: string,
  description: string,
  workspace: string = DEFAULT_SANDBOX_ROOTS.workspace,
): string {
  return [
    `Started background task ${id} ("${description}").`,
    `Output: ${workspace}/${taskOutputPath(id)}`,
    "Read it with TaskOutput (or Read), stop it with TaskStop. You will be told when it finishes.",
  ].join("\n");
}
