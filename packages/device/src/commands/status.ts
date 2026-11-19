import { queryControl } from "../control/client.js";
import type { LiveStatus } from "../control/protocol.js";
import { controlUnavailableReason } from "../control/server.js";
import { type ProcessChecks, readRunningPid } from "../pid.js";
import { policyMode, readCredential, readPolicy, type SandboxMode } from "../state.js";

/** How long `status` waits for the running program to answer on its control socket. */
export const STATUS_CONTROL_TIMEOUT_MS = 500;

export interface StatusOptions extends ProcessChecks {
  /** The running program's pid, if any (default: the pid file, checked against the process). */
  running?: () => number | undefined;
}

/** What the running program says of itself over the control socket, or why it cannot. */
type Control =
  | { control: "ok"; live: LiveStatus }
  | { control: "absent"; live: null }
  | { control: "unavailable"; controlReason: string; live: null };

async function controlState(stateDir: string, opts: StatusOptions): Promise<Control> {
  let answer: unknown;
  try {
    answer = await queryControl(stateDir, "status", STATUS_CONTROL_TIMEOUT_MS);
  } catch (e) {
    return { control: "unavailable", controlReason: (e as Error).message, live: null };
  }
  if (answer !== undefined) return { control: "ok", live: answer as LiveStatus };
  const pid = (opts.running ?? (() => readRunningPid(stateDir, opts)))();
  if (pid === undefined) return { control: "absent", live: null };
  // a program runs but does not answer: say why when it is visible from here (decision 3)
  return {
    control: "unavailable",
    controlReason:
      controlUnavailableReason(stateDir) ??
      `the running program (pid ${pid}) does not answer on its control socket`,
    live: null,
  };
}

/** `status`: exit 0 when logged in, 1 when not (or the credential file is unusable). */
export async function status(
  stateDir: string,
  json: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
  opts: StatusOptions = {},
): Promise<number> {
  let cred: ReturnType<typeof readCredential>;
  try {
    cred = readCredential(stateDir);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  if (cred === undefined) {
    out(json ? JSON.stringify({ loggedIn: false }) : "Not logged in.");
    return 1;
  }
  // An unreadable policy file is reported by `start` and `policy show`; status still answers.
  let sandboxMode: SandboxMode | undefined;
  try {
    sandboxMode = policyMode(readPolicy(stateDir));
  } catch {
    sandboxMode = undefined;
  }
  // The credential itself is never printed.
  const { credential: _secret, ...shown } = cred;
  const control = await controlState(stateDir, opts);
  if (json) {
    out(
      JSON.stringify({ loggedIn: true, ...shown, ...(sandboxMode && { sandboxMode }), ...control }),
    );
  } else {
    out(
      [
        "Logged in.",
        `  deployment:   ${cred.url}`,
        `  organization: ${cred.orgId}`,
        `  device:       ${cred.deviceId}`,
        `  directory:    ${cred.dir}`,
        `  mode:         ${cred.mode} | ${sandboxMode ?? "unknown"}`,
        `  running:      ${runningLine(control)}`,
      ].join("\n"),
    );
  }
  return 0;
}

function runningLine(c: Control): string {
  if (c.control === "absent") return "no";
  if (c.control === "unavailable") return `yes (no live status: ${c.controlReason})`;
  const l = c.live;
  const reason = l.offlineReason === undefined ? "" : `: ${l.offlineReason}`;
  return `yes, pid ${l.pid}, ${l.connection}${reason} since ${l.since}`;
}
