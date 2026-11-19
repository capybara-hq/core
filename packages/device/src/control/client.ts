import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { type ControlRequest, type ControlResponse, controlSocketPath } from "./protocol.js";

/** The answer of one control error: the runner answered, but refused the op. */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Asks the running program one op over its control socket and answers the result; `undefined`
 * when no runner answers (no socket, nothing listening, or no answer within `timeoutMs`). Throws
 * {@link ControlError} when the runner answered `ok: false`. Only a socket of this user is asked.
 */
export async function queryControl(
  stateDir: string,
  op: ControlRequest["op"],
  timeoutMs = 500,
): Promise<unknown | undefined> {
  const path = controlSocketPath(stateDir);
  try {
    const st = lstatSync(path);
    const uid = process.getuid?.();
    if (!st.isSocket() || (uid !== undefined && st.uid !== uid)) return undefined;
  } catch {
    return undefined;
  }
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      sock.destroy();
      settle();
    };
    const timer = setTimeout(() => finish(() => resolve(undefined)), timeoutMs);
    sock.setEncoding("utf8");
    sock.once("error", () => finish(() => resolve(undefined)));
    sock.once("close", () => finish(() => resolve(undefined)));
    sock.once("connect", () => sock.write(`${JSON.stringify({ id: 1, op })}\n`));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: Partial<ControlResponse>;
        try {
          msg = JSON.parse(line) as Partial<ControlResponse>;
        } catch {
          continue;
        }
        // events and answers to other ids are not ours
        if (msg.id !== 1) continue;
        if (msg.ok === true) return finish(() => resolve(msg.result));
        const error = (msg as { error?: { code?: unknown; message?: unknown } }).error;
        return finish(() =>
          reject(new ControlError(String(error?.code ?? "failed"), String(error?.message ?? ""))),
        );
      }
    });
  });
}
