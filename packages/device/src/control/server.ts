import { chmodSync, lstatSync, mkdirSync, type Stats, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { RunningOperation } from "../activity.js";
import { machineDirOfConnection } from "../connections.js";
import {
  CONTROL_LINE_MAX_BYTES,
  CONTROL_OPS,
  CONTROL_PATH_MAX_BYTES,
  CONTROL_WRITE_MAX_BYTES,
  type ControlEvent,
  type ControlRequest,
  type ControlResponse,
  controlSocketPath,
  type LiveStatus,
} from "./protocol.js";

/** How long the check for a live socket at the path waits for a connection. */
const PROBE_TIMEOUT_MS = 1000;
/** Owner-only peers: a handful of connections is plenty (the desktop app, a `status`). */
const MAX_CONNECTIONS = 32;

export interface ControlServerOptions {
  stateDir: string;
  status(): LiveStatus;
  running(): RunningOperation[];
  drain(): void;
  stop(): void;
}

export interface ControlServer {
  close(): Promise<void>;
  /** Pushes a status event to every connection that subscribed. */
  publish(s: LiveStatus): void;
}

const mode = (st: Stats): string => `0${(st.mode & 0o777).toString(8)}`;

/** Why `dir` is not a directory of this user closed to others (`label` names it), or undefined. */
function ownerOnlyDirReason(label: string, dir: string, st: Stats): string | undefined {
  if (!st.isDirectory()) return `${label} ${dir} is not a directory`;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    return `${label} ${dir} belongs to another user (uid ${st.uid})`;
  }
  if ((st.mode & 0o077) !== 0) {
    return `${label} ${dir} has mode ${mode(st)}, open to other users; run chmod 700 ${dir}`;
  }
  return undefined;
}

/**
 * Why no control socket can be made for the connection whose directory is `stateDir`, from what
 * is visible without binding: a directory that is not a connection's, a path over
 * {@link CONTROL_PATH_MAX_BYTES}, a machine directory or a `run/` directory that is missing, not
 * the user's or open to other users (the same owner and mode rule the credential file follows; a
 * missing `run/` is fine, the server makes it 0700). Undefined when nothing is in the way. `status`
 * uses it to explain a runner that does not answer.
 */
export function controlUnavailableReason(stateDir: string): string | undefined {
  let path: string;
  let machineDir: string;
  try {
    path = controlSocketPath(stateDir);
    machineDir = machineDirOfConnection(stateDir);
  } catch (e) {
    return (e as Error).message;
  }
  const bytes = Buffer.byteLength(path);
  if (bytes > CONTROL_PATH_MAX_BYTES) {
    return (
      `the control socket path ${path} is ${bytes} bytes, longer than the ` +
      `${CONTROL_PATH_MAX_BYTES} bytes a unix socket path may have; use a shorter XDG_CONFIG_HOME`
    );
  }
  let st: Stats;
  try {
    st = statSync(machineDir);
  } catch (e) {
    return `the state directory ${machineDir} cannot be read (${(e as Error).message})`;
  }
  const machineReason = ownerOnlyDirReason("the state directory", machineDir, st);
  if (machineReason !== undefined) return machineReason;
  const run = dirname(path);
  try {
    // lstat: a symlink in place of run/ is refused, never followed
    st = lstatSync(run);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `the socket directory ${run} cannot be read (${(e as Error).message})`;
  }
  return ownerOnlyDirReason("the socket directory", run, st);
}

/** Whether something answers on the socket at `path`: "live", "stale" (nothing listens) or why not. */
function probe(path: string): Promise<"live" | "stale" | { error: string }> {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    const done = (r: "live" | "stale" | { error: string }): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ error: "it did not answer in time" }), PROBE_TIMEOUT_MS);
    sock.once("connect", () => done("live"));
    sock.once("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "stale" : { error: e.message }),
    );
  });
}

/**
 * Clears the way for a socket at `path`: nothing there, or a stale socket of this user (nothing
 * listens) that is removed. A live socket, a file that is not a socket or one of another user is
 * never touched. Answers why not, or undefined when the path is free.
 */
async function clearPath(path: string): Promise<string | undefined> {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!st.isSocket()) return `${path} exists and is not a socket; it was left alone`;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return `${path} belongs to another user`;
  const found = await probe(path);
  if (found === "live") return `another capybara-device already answers on ${path}`;
  if (found !== "stale") return `${path} cannot be checked (${found.error})`;
  try {
    // only the socket judged stale: a file replaced meanwhile is left alone
    const now = lstatSync(path);
    if (now.ino === st.ino && now.dev === st.dev) unlinkSync(path);
  } catch {
    // gone already
  }
  return undefined;
}

/** Binds `path` with the umask closed to group and others, so the socket is never wider than 0600. */
function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // the bind of a unix socket happens inside listen(), synchronously: the umask is restored
    // right after it, never left closed across an await
    const umask = process.umask(0o077);
    try {
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(umask);
    }
  });
}

/**
 * Starts the control socket of the connection in `stateDir` at {@link controlSocketPath} (mode
 * 0600, in `<machineDir>/run/`, made 0700 when absent). Answers `{ unavailable }` with the reason
 * instead when the socket cannot be made safely; the runner keeps serving then.
 */
export async function startControlServer(
  opts: ControlServerOptions,
): Promise<ControlServer | { unavailable: string }> {
  const early = controlUnavailableReason(opts.stateDir);
  if (early !== undefined) return { unavailable: early };
  const path = controlSocketPath(opts.stateDir);
  try {
    mkdirSync(dirname(path), { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      return { unavailable: `${dirname(path)} cannot be made (${(e as Error).message})` };
    }
  }
  // checked again: run/ exists now, whoever made it
  const blocked = controlUnavailableReason(opts.stateDir) ?? (await clearPath(path));
  if (blocked !== undefined) return { unavailable: blocked };

  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  const send = (sock: Socket, line: ControlResponse | ControlEvent): void => {
    if (sock.destroyed || !sock.writable) return;
    sock.write(`${JSON.stringify(line)}\n`);
    // a peer that stopped reading (a subscriber above all) never pins memory here
    if (sock.writableLength > CONTROL_WRITE_MAX_BYTES) sock.destroy();
  };
  const failure = (id: number, code: string, message: string): ControlResponse => ({
    id,
    ok: false,
    error: { code, message },
  });
  const fail = (sock: Socket, id: number, code: string, message: string): void =>
    send(sock, failure(id, code, message));

  /** The answer to one request line; a subscribe also adds the connection to the subscribers. */
  const respond = (sock: Socket, line: string): ControlResponse => {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return failure(0, "bad_request", "The line is not JSON");
    }
    const r = (req !== null && typeof req === "object" ? req : {}) as Partial<
      Record<keyof ControlRequest, unknown>
    >;
    const id = typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id > 0 ? r.id : 0;
    if (id === 0) return failure(0, "bad_request", 'The request needs "id", a positive integer');
    if (typeof r.op !== "string" || !(CONTROL_OPS as readonly string[]).includes(r.op)) {
      return failure(id, "unknown_op", `Unknown op; one of ${CONTROL_OPS.join(", ")}`);
    }
    const op = r.op as ControlRequest["op"];
    try {
      if (op === "status") return { id, ok: true, result: opts.status() };
      if (op === "running") return { id, ok: true, result: opts.running() };
      if (op === "subscribe") {
        subscribers.add(sock);
        return { id, ok: true, result: opts.status() };
      }
      if (op === "drain") opts.drain();
      else opts.stop();
      return { id, ok: true, result: null };
    } catch (e) {
      return failure(id, "failed", (e as Error).message);
    }
  };
  const answer = (sock: Socket, line: string): void => send(sock, respond(sock, line));

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding("utf8");
    let buf = "";
    let refused = false;
    const overLong = (): void => {
      refused = true;
      buf = "";
      fail(sock, 0, "bad_request", `A line is longer than ${CONTROL_LINE_MAX_BYTES} bytes`);
      sock.end();
    };
    // one listener per connection: lines are answered in order
    sock.on("data", (chunk: string) => {
      if (refused) return;
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (Buffer.byteLength(line) > CONTROL_LINE_MAX_BYTES) return overLong();
        if (line.trim() !== "") answer(sock, line);
      }
      if (Buffer.byteLength(buf) > CONTROL_LINE_MAX_BYTES) overLong();
    });
    sock.on("error", () => {
      // a peer that went away: nothing to answer
    });
    sock.on("close", () => {
      sockets.delete(sock);
      subscribers.delete(sock);
    });
  });
  server.maxConnections = MAX_CONNECTIONS;

  try {
    await listen(server, path);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      unavailable:
        err.code === "EADDRINUSE"
          ? `another capybara-device already answers on ${path}`
          : `cannot listen on ${path} (${err.message})`,
    };
  }
  let bound: Stats;
  try {
    chmodSync(path, 0o600);
    bound = lstatSync(path);
  } catch (e) {
    await new Promise<void>((r) => server.close(() => r()));
    return { unavailable: `cannot secure ${path} (${(e as Error).message})` };
  }
  server.on("error", () => {
    // a failure after listening affects new connections only; the runner keeps serving
  });

  let closed: Promise<void> | undefined;
  return {
    publish(s) {
      for (const sock of subscribers) send(sock, { event: "status", status: s });
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => {
          try {
            // only the socket this server bound: one another runner bound meanwhile stays
            const now = lstatSync(path);
            if (now.ino === bound.ino && now.dev === bound.dev) unlinkSync(path);
          } catch {
            // removed already (the listener's close unlinks it)
          }
          resolve();
        });
      });
      return closed;
    },
  };
}
