import { rootsOf, type SandboxActor, type SandboxHandle } from "@capybara-hq/plugin-sdk";
import type { HeldProvider, TaggedProvider } from "../sandbox/sandbox.service.js";
import { SESSION_MODE_SCRIPT, TASK_ID_RE, TASKS_DIR } from "./launch.js";

/**
 * A background task's session inside the sandbox (spec 2026-11-05-background-bash-design §4.2):
 * every process of a task is in the session `setsid` started, so liveness is `pgrep -s <sid>` and
 * stopping is `pkill -s <sid>` (never `kill -0` or `/proc`, which disagree between sandbox-fake and
 * Linux). macOS has no `setsid` and its `pgrep` / `pkill` no `-s`: there the task is the process
 * group the launch made (`launchScript`), signalled with `kill -- -<sid>` ({@link SESSION_MODE_SCRIPT}).
 */

/**
 * `p` with every `exec` carrying `actor` (`SandboxService.ifRunning` tags execs but leaves the
 * actor to the caller): the provider then reads like a `withSandbox` holder's.
 */
export function actingAs(p: TaggedProvider, actor: SandboxActor): HeldProvider {
  const wrapped = Object.create(p) as HeldProvider;
  Object.defineProperty(wrapped, "exec", {
    value: (h: SandboxHandle, args: Parameters<HeldProvider["exec"]>[1]) =>
      p.exec(h, { ...args, actor }),
  });
  return wrapped;
}

/** Who a background task's own execs (poll, stop, reads) act for: its trigger and its owner. */
export const taskActor = (task: {
  triggerAccountId: string;
  conversationId: string;
}): SandboxActor => ({ accountId: task.triggerAccountId, conversationId: task.conversationId });

/** A session id (the pid `setsid` started). */
export const SID_RE = /^[1-9][0-9]*$/;

/** The time limit of one kill of a session ({@link killSession}). */
export const KILL_SESSION_TIMEOUT_MS = 10_000;

/** Throws unless `id` is a task id and `sid` a session id (both go into scripts unquoted). */
export function assertTaskRef(id: string, sid: string): void {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid background task id: ${JSON.stringify(id)}`);
  if (!SID_RE.test(sid)) throw new Error(`invalid background task session: ${JSON.stringify(sid)}`);
}

/**
 * A shell fragment that kills every process of the session `sid` with SIGKILL, repeated until the
 * session is empty (pkill exits 1: no process left): a process may fork between pkill's listing
 * and its signals, and the child would live on. Sets `ks` to 0 when the session was confirmed
 * empty, else to pkill's failing status (3 when it was still not empty after 10 tries). Uses only
 * the variables and functions of {@link SESSION_MODE_SCRIPT} (it starts with it), `ks`, `kc` and `ki`. `sid` must be
 * a session id.
 */
export function killSessionScript(sid: string): string {
  if (!SID_RE.test(sid)) throw new Error(`invalid background task session: ${JSON.stringify(sid)}`);
  return `${SESSION_MODE_SCRIPT}\nks=3; for ki in 1 2 3 4 5 6 7 8 9 10; do tk_kill KILL ${sid}; kc=$?; if [ "$kc" -eq 1 ]; then ks=0; break; fi; if [ "$kc" -ne 0 ]; then ks=$kc; break; fi; sleep 0.2; done`;
}

/**
 * Kills every process of the session `sid` ({@link killSessionScript}) in an exec of its own. Any
 * pkill status other than 0 and 1 is a failure. Runs with a fresh signal of its own (a command
 * must be killed even when the caller was just aborted). True when the session was confirmed
 * empty; false when it could not be (an error is never thrown).
 */
export async function killSession(
  p: Pick<HeldProvider, "exec">,
  h: SandboxHandle,
  sid: string,
): Promise<boolean> {
  if (!SID_RE.test(sid)) return false;
  const r = await p
    .exec(h, {
      command: `${killSessionScript(sid)}; exit "$ks"`,
      cwd: rootsOf(h).workspace,
      timeoutMs: KILL_SESSION_TIMEOUT_MS,
      maxOutputBytes: 4096,
      signal: AbortSignal.timeout(KILL_SESSION_TIMEOUT_MS),
    })
    .catch(() => undefined);
  return r?.exitCode === 0;
}

/** How long a stop waits after SIGTERM before SIGKILL (spec §2.3). */
export const STOP_GRACE_MS = 5000;

/** The time limit of the SIGTERM exec: the grace period plus some room. */
export const TERM_EXEC_TIMEOUT_MS = STOP_GRACE_MS + 5000;

/**
 * Exit code 0 with `exited <code>` when the task had already finished (its exit file exists),
 * else sends SIGTERM to the session and waits up to {@link STOP_GRACE_MS} for it to empty, then
 * prints `term`. Relative to the workspace root.
 */
export function termScript(id: string, sid: string): string {
  const f = `${TASKS_DIR}/${id}`;
  const tries = Math.ceil(STOP_GRACE_MS / 200);
  return [
    `if [ -s ${f}.exit ]; then echo "exited $(cat ${f}.exit)"; exit 0; fi`,
    SESSION_MODE_SCRIPT,
    `tk_kill TERM ${sid} >/dev/null 2>&1`,
    `i=0; while [ "$i" -lt ${tries} ] && tk_alive ${sid}; do sleep 0.2; i=$((i+1)); done`,
    "echo term",
  ].join("\n");
}

/** The most bytes of a task's output end a tail reads (the event keeps at most 4 000 characters). */
const TAIL_BYTES = 12_000;

/** The longest `lastLines` of a finished task (spec §2.4). */
export const LAST_LINES_MAX_CHARS = 4000;

/**
 * A shell pipeline printing the last 20 lines of task `id`'s output (at most {@link TAIL_BYTES}),
 * base64 on one line (empty when there is no output file). Relative to the workspace root.
 */
export function tailCommand(id: string): string {
  return `{ tail -n 20 ${TASKS_DIR}/${id}.out 2>/dev/null | tail -c ${TAIL_BYTES} | base64 | tr -d '\\n'; }`;
}

/** Decodes a {@link tailCommand} result into `lastLines`: its end, at most 4 000 characters. */
export function decodeTail(b64: string): string {
  const text = Buffer.from(b64.trim(), "base64").toString("utf8");
  return text.length > LAST_LINES_MAX_CHARS ? text.slice(-LAST_LINES_MAX_CHARS) : text;
}
