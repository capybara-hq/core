import { createServer, type Socket } from "node:net";
import {
  DEVICE_SERVICE_SOCKET_ENV,
  encodeServiceMessage,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";
import type { ServiceLaunch, ServiceLauncher } from "../src/services/supervisor.js";

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

/**
 * A launcher whose "service" runs in the test process: it listens on the socket the launch names
 * and speaks the device service protocol. A `request` is answered with `echo:<body>`; on a
 * `stream`, `burst:<n>` sends n messages `m0`..`m<n-1>`, `big:<n>` sends one message of n bytes,
 * anything else is echoed back. `exit(code)` ends the service as a process exit would.
 */
export function echoLauncher() {
  const calls: ServiceLaunch[] = [];
  const running: { exit: (code: number | null) => void }[] = [];
  /** Messages the service received on its stream connections, in order. */
  const received: string[] = [];
  /** Stream connections the service saw end, and who waits for a count of them. */
  let streamEnds = 0;
  const endWaiters: { n: number; resolve: () => void }[] = [];
  const ended = () => {
    streamEnds++;
    for (const w of [...endWaiters])
      if (streamEnds >= w.n) {
        endWaiters.splice(endWaiters.indexOf(w), 1);
        w.resolve();
      }
  };
  const launcher: ServiceLauncher = {
    async launch(req) {
      calls.push(req);
      const svc = await listenEcho(req.env[DEVICE_SERVICE_SOCKET_ENV] as string, {
        received,
        onStreamEnd: ended,
      });
      running.push(svc);
      return { exited: svc.exited, stop: async () => svc.exit(null), output: () => "" };
    },
  };
  return {
    launcher,
    calls,
    received,
    streamEnds: () => streamEnds,
    /** Resolves once the service saw `n` stream connections end. */
    untilStreamEnds: (n: number) =>
      new Promise<void>((resolve) => {
        if (streamEnds >= n) resolve();
        else endWaiters.push({ n, resolve });
      }),
    /** Ends every running service as if its process exited with `code`. */
    exitAll: (code: number | null) => {
      for (const r of running.splice(0)) r.exit(code);
    },
  };
}

/**
 * The echo service itself, listening on `socketPath` in this process: a `request` is answered
 * with `echo:<body>` (`hang` is never answered); on a `stream`, `burst:<n>` sends n messages,
 * `big:<n>` one message of n bytes, anything else is echoed. `exit` ends it like a process exit.
 */
export async function listenEcho(
  socketPath: string,
  hooks: { received?: string[]; onStreamEnd?: () => void } = {},
) {
  const conns = new Set<Socket>();
  const server = createServer((conn) => {
    conns.add(conn);
    const decoder = new ServiceMessageDecoder();
    let kind: string | undefined;
    conn.on("close", () => {
      conns.delete(conn);
      if (kind === "stream") hooks.onStreamEnd?.();
    });
    conn.on("error", () => {});
    conn.on("data", (chunk: Buffer) => {
      for (const m of decoder.push(chunk)) {
        if (kind === undefined) {
          kind = (JSON.parse(text(m)) as { kind: string }).kind;
          continue;
        }
        if (kind === "request") {
          if (text(m) !== "hang") conn.end(encodeServiceMessage(bytes(`echo:${text(m)}`)));
          continue;
        }
        const s = text(m);
        hooks.received?.push(s);
        if (s.startsWith("burst:"))
          for (let i = 0; i < Number(s.slice(6)); i++)
            conn.write(encodeServiceMessage(bytes(`m${i}`)));
        else if (s.startsWith("big:"))
          conn.write(encodeServiceMessage(new Uint8Array(Number(s.slice(4))).fill(65)));
        else conn.write(encodeServiceMessage(m));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  let resolveExit!: (v: { code: number | null }) => void;
  const exited = new Promise<{ code: number | null }>((r) => {
    resolveExit = r;
  });
  let done = false;
  return {
    exited,
    exit(code: number | null) {
      if (done) return;
      done = true;
      server.close();
      for (const c of conns) c.destroy();
      resolveExit({ code });
    },
  };
}

export { bytes, text };
