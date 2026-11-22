import {
  type ConnectionInfo,
  connectionLine,
  resolveConnection,
  scanConnections,
} from "../connections.js";
import { queryControl } from "../control/client.js";
import { controlSocketPath, type LiveStatus } from "../control/protocol.js";
import { controlUnavailableReason } from "../control/server.js";
import { type ProcessChecks, readRunningPid } from "../pid.js";
import { hasLoginService } from "../service/installed.js";

/** How long `status` waits for the running program to answer on its control socket. */
export const STATUS_CONTROL_TIMEOUT_MS = 500;

export interface StatusOptions extends ProcessChecks {
  /** The running program's pid for a connection directory, if any (default: the pid file, checked against the process). */
  running?: (stateDir: string) => number | undefined;
}

/** What the running program says of itself over the control socket, or why it cannot. */
type Control =
  | { control: "ok"; live: LiveStatus }
  | { control: "absent"; live: null }
  | { control: "unavailable"; controlReason: string; live: null };

/** A light shape check of the runner's answer before it is printed. */
function isLiveStatus(v: unknown): v is LiveStatus {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.pid === "number" &&
    typeof s.connection === "string" &&
    typeof s.deviceId === "string" &&
    typeof s.since === "string"
  );
}

async function controlState(stateDir: string, opts: StatusOptions): Promise<Control> {
  let answer: unknown;
  try {
    answer = await queryControl(stateDir, "status", STATUS_CONTROL_TIMEOUT_MS);
  } catch (e) {
    return { control: "unavailable", controlReason: (e as Error).message, live: null };
  }
  if (isLiveStatus(answer)) return { control: "ok", live: answer };
  // an answer of another shape is treated as no answer
  const pid = opts.running ? opts.running(stateDir) : readRunningPid(stateDir, opts);
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

/** One connection as `status --json` shows it. Never the credential. */
export type ConnectionStatusJson = {
  deviceId: string;
  orgId: string;
  orgName: string | null;
  deviceName: string | null;
  url: string;
  host: string;
  mode: "os" | "docker";
  dir: string;
  serviceInstalled: boolean;
  /** Absolute path of this connection's control socket; clients read it only from here. */
  controlSocket: string;
} & Control;

export interface MachineStatusJson {
  connections: ConnectionStatusJson[];
  unreadable: Array<{ deviceId: string; reason: string }>;
}

async function connectionStatus(
  c: ConnectionInfo,
  opts: StatusOptions & { home: string; platform: NodeJS.Platform },
): Promise<ConnectionStatusJson> {
  const base = {
    deviceId: c.deviceId,
    orgId: c.orgId,
    orgName: c.orgName,
    deviceName: c.deviceName,
    url: c.url,
    host: c.host,
    mode: c.mode,
    dir: c.workDir,
  };
  try {
    const control = await controlState(c.stateDir, opts);
    return {
      ...base,
      serviceInstalled: hasLoginService(opts.home, opts.platform, c.deviceId),
      controlSocket: controlSocketPath(c.stateDir),
      ...control,
    };
  } catch (e) {
    // one connection that cannot be examined never hides the others
    return {
      ...base,
      serviceInstalled: false,
      controlSocket: "",
      control: "unavailable",
      controlReason: `status failed: ${(e as Error).message}`,
      live: null,
    };
  }
}

function stateWord(c: Control): string {
  if (c.control === "absent") return "stopped";
  if (c.control === "unavailable") return `no live status (${c.controlReason})`;
  return c.live.connection;
}

/**
 * `status`: without a selector, every connection of this machine (one line each, or
 * {@link MachineStatusJson}); with one, the detail of that connection. Exit 0 when a connection is
 * shown, 1 when there is none or the selector names none.
 */
export async function status(
  machineDir: string,
  selector: string | undefined,
  json: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
  opts: StatusOptions & { home: string; platform: NodeJS.Platform },
): Promise<number> {
  if (selector !== undefined) {
    let c: ConnectionInfo;
    try {
      c = resolveConnection(selector, machineDir);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const s = await connectionStatus(c, opts);
    if (json) {
      out(JSON.stringify(s));
    } else {
      out(
        [
          "Connected.",
          `  deployment:   ${c.url}`,
          `  organization: ${c.orgName === null ? c.orgId : `${c.orgName} (${c.orgId})`}`,
          `  device:       ${c.deviceName === null ? c.deviceId : `${c.deviceName} (${c.deviceId})`}`,
          `  directory:    ${c.workDir}`,
          `  mode:         ${c.mode}`,
          `  service:      ${s.serviceInstalled ? "installed" : "not installed"}`,
          `  running:      ${runningLine(s)}`,
        ].join("\n"),
      );
    }
    return 0;
  }
  let scan: ReturnType<typeof scanConnections>;
  try {
    scan = scanConnections(machineDir);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  const { readable, unreadable } = scan;
  if (readable.length === 0 && unreadable.length === 0) {
    out(
      json
        ? JSON.stringify({ connections: [], unreadable: [] } satisfies MachineStatusJson)
        : "No connection. Run capybara-device login --url <url>.",
    );
    return 1;
  }
  const connections = await Promise.all(readable.map((c) => connectionStatus(c, opts)));
  if (json) {
    out(JSON.stringify({ connections, unreadable } satisfies MachineStatusJson));
  } else {
    readable.forEach((c, i) => {
      out(`${connectionLine(c)} · ${stateWord(connections[i] as ConnectionStatusJson)}`);
    });
    for (const u of unreadable) out(`${u.deviceId}: unreadable (${u.reason})`);
  }
  return readable.length > 0 ? 0 : 1;
}

function runningLine(c: Control): string {
  if (c.control === "absent") return "no";
  if (c.control === "unavailable") return `yes (no live status: ${c.controlReason})`;
  const l = c.live;
  const reason = l.offlineReason === undefined ? "" : `: ${l.offlineReason}`;
  return `yes, pid ${l.pid}, ${l.connection}${reason} since ${l.since}`;
}
