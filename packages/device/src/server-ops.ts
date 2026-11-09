import type {
  DeviceExecArgs,
  DeviceKillTaggedArgs,
  DeviceReadFileArgs,
  DeviceRes,
  DeviceStatArgs,
  DeviceWriteFileArgs,
  KernelReq,
} from "@capybara-hq/plugin-sdk";
import type { CommandLogEntry } from "./command-log.js";
import { DeviceOpError, type Executor } from "./exec/types.js";

/** The local-log line for a finished request. */
export function logEntryFor(req: KernelReq, res: DeviceRes, now: Date): CommandLogEntry {
  const exec = req.op === "exec" ? (req.args as DeviceExecArgs) : undefined;
  const exitCode =
    res.ok && req.op === "exec"
      ? ((res.result as { exitCode: number | null }).exitCode ?? null)
      : null;
  return {
    time: now.toISOString(),
    op: req.op,
    tag: exec ? exec.tag : null,
    actor: exec ? { accountId: exec.actor.accountId } : null,
    exitCode,
  };
}

/**
 * Runs one request on the executor and returns the answer. A vanished device directory
 * answers `fs_gone` for every operation except `stop`. Never throws.
 */
export async function runOp(
  executor: Executor,
  req: KernelReq,
  signal: AbortSignal,
): Promise<DeviceRes> {
  const ok = (result: unknown): DeviceRes => ({ type: "res", id: req.id, ok: true, result });
  try {
    if (req.op === "stop") return ok(null);
    if ((await executor.ensureRoot()) === "gone") {
      return {
        type: "res",
        id: req.id,
        ok: false,
        error: {
          kind: "fs_gone",
          message:
            "The device directory on this machine existed and is gone. It is not recreated automatically.",
        },
      };
    }
    // The kernel may have cancelled while ensureRoot ran: never start the work then.
    signal.throwIfAborted();
    switch (req.op) {
      case "create":
        return ok({ roots: executor.roots });
      case "exec":
        return ok(await executor.exec(req.args as DeviceExecArgs, signal));
      case "readFile": {
        const a = req.args as DeviceReadFileArgs;
        const r = await executor.readFile(a.path, a.maxBytes);
        return ok(
          r === null
            ? null
            : { dataB64: Buffer.from(r.data).toString("base64"), truncated: r.truncated },
        );
      }
      case "writeFile": {
        const a = req.args as DeviceWriteFileArgs;
        await executor.writeFile(a.path, Buffer.from(a.dataB64, "base64"));
        return ok(null);
      }
      case "stat":
        return ok(await executor.stat((req.args as DeviceStatArgs).path));
      case "killTagged":
        await executor.killTagged((req.args as DeviceKillTaggedArgs).tags);
        return ok(null);
      case "killAll":
        await executor.killAll();
        return ok(null);
    }
  } catch (e) {
    const kind = e instanceof DeviceOpError ? e.kind : "error";
    return {
      type: "res",
      id: req.id,
      ok: false,
      error: { kind, message: e instanceof Error ? e.message : String(e) },
    };
  }
}
