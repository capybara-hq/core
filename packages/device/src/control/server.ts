import { chmodSync, lstatSync, type Stats, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { RunningOperation } from "../activity.js";
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

/**
 * Why no control socket can be made for this state directory, from what is visible without
 * binding: a path over {@link CONTROL_PATH_MAX_BYTES}, or a state directory that is missing, not
 * the user's or open to other users (the same owner and mode rule the credential file follows).
 * Undefined when nothing is in the way. `status` uses it to explain a runner that does not answer.
 */
export function controlUnavailableReason(stateDir: string): string | undefined {
  const path = controlSocketPath(stateDir);
  const bytes = Buffer.byteLength(path);
  if (bytes > CONTROL_PATH_MAX_BYTES) {
    return (
      `the control socket path ${path} is ${bytes} bytes, longer than the ` +
      `${CONTROL_PATH_MAX_BYTES} bytes a unix socket path may have; use a shorter XDG_CONFIG_HOME`
    );
  }
  let st: Stats;
  try {
    st = statSync(stateDir);
  } catch (e) {
    return `the state directory ${stateDir} cannot be read (${(e as Error).message})`;
  }
  if (!st.isDirectory()) return `the state directory ${stateDir} is not a directory`;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    return `the state directory ${stateDir} belongs to another user (uid ${st.uid})`;
  }
  if ((st.mode & 0o077) !== 0) {
    return (
      `the state directory ${stateDir} has mode ${mode(st)}, open to other users; ` +
      `run chmod 700 ${stateDir}`
    );
  }
  return undefined;
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
 * Starts the control socket at `<stateDir>/control.sock` (mode 0600). Answers `{ unavailable }`
 * with the reason instead when the socket cannot be made safely; the runner keeps serving then.
 */
export async function startControlServer(
  opts: ControlServerOptions,
): Promise<ControlServer | { unavailable: string }> {
  const path = controlSocketPath(opts.stateDir);
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
