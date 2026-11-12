import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { DeviceExecArgs, ExecResult, SandboxRoots } from "@capybara-hq/plugin-sdk";
import { type WebSocket, WebSocketServer } from "ws";
import type { Executor } from "../src/exec/types.js";

/** A stand-in for the kernel's `/device/connect` gateway, as the program sees it. */
export class FakeKernel {
  readonly http: Server = createServer();
  readonly wss = new WebSocketServer({ noServer: true });
  readonly sockets: WebSocket[] = [];
  readonly headers: IncomingMessage["headers"][] = [];
  /** Every frame received, tagged with the connection index. */
  readonly frames: Array<{ conn: number; frame: any }> = [];
  /** When set, the next upgrade is answered with this HTTP status. */
  rejectWith: number | undefined;
  url = "";

  async start(): Promise<void> {
    this.http.on("upgrade", (req: IncomingMessage, socket: Duplex, head) => {
      this.headers.push(req.headers);
      if (this.rejectWith !== undefined) {
        socket.end(
          `HTTP/1.1 ${this.rejectWith} X\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = this.sockets.push(ws) - 1;
        ws.on("message", (d) => this.frames.push({ conn, frame: JSON.parse(String(d)) }));
      });
    });
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", r));
    this.url = `ws://127.0.0.1:${(this.http.address() as AddressInfo).port}/device/connect`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  send(conn: number, frame: unknown): void {
    this.sockets[conn]?.send(JSON.stringify(frame));
  }

  of(type: string, conn?: number): any[] {
    return this.frames
      .filter((f) => f.frame.type === type && (conn === undefined || f.conn === conn))
      .map((f) => f.frame);
  }

  async waitFor<T>(what: string, get: () => T | undefined | false, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export const ROOTS: SandboxRoots = {
  workspace: "/work/e1",
  skills: "/work/e1/.skills",
  tmp: "/work/e1/.tmp",
};

export const OK_EXEC: ExecResult = {
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  truncated: false,
  timedOut: false,
};

export function execArgs(command: string, tag = "t1"): DeviceExecArgs {
  return {
    command,
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    tag,
    actor: { accountId: "acc", conversationId: "conv" },
    limits: {
      cpu: 1,
      memoryMb: 512,
      diskMb: 1024,
      egress: "none",
      allowHosts: [],
      tier: "strict",
      devHosts: [],
    },
  };
}

export function req(id: string, op: string, args: unknown) {
  return { type: "req", id, op, args, deadlineMs: 5000 };
}

/** Commands block until `release(command)` is called or the request is aborted. */
export class FakeExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots = ROOTS;
  root: "ok" | "gone" = "ok";
  readonly started: string[] = [];
  readonly aborted: string[] = [];
  readonly killed: string[][] = [];
  files = new Map<string, Uint8Array>();
  private readonly gates = new Map<string, () => void>();

  release(command: string): void {
    this.gates.get(command)?.();
  }

  exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    this.started.push(args.command);
    return new Promise((resolve, reject) => {
      if (args.command === "now") return resolve(OK_EXEC);
      this.gates.set(args.command, () => resolve({ ...OK_EXEC, stdout: `${args.command}\n` }));
      signal.addEventListener("abort", () => {
        this.aborted.push(args.command);
        reject(new Error("aborted"));
      });
    });
  }

  async readFile(path: string, maxBytes: number) {
    const d = this.files.get(path);
    if (!d) return null;
    return { data: d.subarray(0, maxBytes), truncated: d.length > maxBytes };
  }
  async writeFile(path: string, data: Uint8Array) {
    this.files.set(path, data);
  }
  async stat(path: string) {
    const d = this.files.get(path);
    return d ? { size: d.length, isDir: false } : null;
  }
  async killTagged(tags: string[]) {
    this.killed.push(tags);
  }
  async killAll() {
    this.killed.push(["*"]);
  }
  /** When set, ensureRoot waits for it. */
  rootGate: Promise<void> | undefined;
  async ensureRoot() {
    await this.rootGate;
    return this.root;
  }
}
