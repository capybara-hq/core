import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  parseSandboxExecutionRef,
  type SandboxExecutionRef,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { OUTPUT_SPOOL_HELPER } from "./output-spool-helper.js";

export interface OutputLocator {
  ref: SandboxExecutionRef;
  name: string;
  identity: { dev: number; ino: number; uid: number };
  directory: { dev: number; ino: number; uid: number };
  committed: number;
}
export interface OutputSpoolOptions {
  privateRoot: string;
  artifactRoot: string;
  outputPath: string;
  ref: SandboxExecutionRef;
  pythonPath: string;
  publish: (locator: OutputLocator) => Promise<void>;
  /** Trusted deterministic I/O boundary injection; never supplied by a user or wire request. */
  barrier?: ((name: string) => Promise<void>) | undefined;
  io?: {
    maxWriteBytes?: number;
    maxReadBytes?: number;
    failWriteAfterBytes?: number;
    shortReadAfterBytes?: number;
  };
}
export function validateOutputRange(offset: number, maxBytes: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > 65536
  )
    throw new SandboxScopeDeniedError(
      "Invalid output bounds; use a safe nonnegative offset and a 0–65536 byte budget",
    );
}
function canonical(path: string): string {
  return process.platform === "darwin"
    ? path.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1")
    : path;
}
function nameFor(ref: SandboxExecutionRef): string {
  return `output-${createHash("sha256")
    .update(
      JSON.stringify([ref.instanceId, ref.instanceGeneration, ref.operationId, ref.executionId]),
    )
    .digest("hex")}.spool`;
}
/** One bounded append at a time. Disk files, never an in-memory tail, are the retained authority. */
export class ManagedOutputSpool {
  private child: ChildProcessWithoutNullStreams;
  private rpcQueue: Promise<unknown> = Promise.resolve();
  private response:
    | { resolve: (value: unknown) => void; reject: (error: unknown) => void }
    | undefined;
  private ended: Promise<void>;
  private closed = false;
  private expired = false;
  private fault: unknown;
  private appending: Promise<void> | undefined;
  private readers = new Set<Promise<unknown>>();
  private record!: OutputLocator;
  private readonly readonly: boolean;
  private constructor(
    private options: OutputSpoolOptions,
    existing: boolean,
  ) {
    this.readonly = existing;
    this.child = spawn(options.pythonPath, ["-I", "-c", OUTPUT_SPOOL_HELPER], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = "";
    // Responses are bounded to base64(65,536) plus envelope; diagnostics never enter user output.
    this.child.stdout.on("data", (bytes: Buffer) => {
      pending += bytes.toString();
      if (pending.length > 90000) {
        this.response?.reject(Error("Output helper response exceeded bound"));
        this.child.kill();
      }
      if (pending.includes("\n")) pending = "";
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const waiter = this.response;
      this.response = undefined;
      if (!waiter) return;
      try {
        const value = JSON.parse(line);
        if (value.error !== undefined)
          waiter.reject(Error(`Managed output I/O failed: ${value.error}`));
        else waiter.resolve(value.result);
      } catch (error) {
        waiter.reject(error);
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => this.response?.reject(error));
    this.ended = new Promise((resolve) => {
      this.child.once("close", () => {
        this.closed = true;
        this.response?.reject(Error("Managed output helper closed"));
        resolve();
      });
      this.child.once("error", (error) => {
        this.response?.reject(error);
      });
    });
  }
  private rpc<T>(message: object): Promise<T> {
    const next = this.rpcQueue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (this.closed) {
            reject(Error("Managed output helper closed"));
            return;
          }
          this.response = { resolve: (value) => resolve(value as T), reject };
          this.child.stdin.write(`${JSON.stringify(message)}\n`);
        }),
    );
    this.rpcQueue = next.catch(() => {});
    return next;
  }
  private async barrier(name: string) {
    await this.options.barrier?.(name);
  }
  static async create(options: OutputSpoolOptions): Promise<ManagedOutputSpool> {
    options = { ...options, ref: parseSandboxExecutionRef(options.ref) };
    const root = canonical(options.artifactRoot),
      path = canonical(options.outputPath);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("../") || rel === ".." || resolve(path) !== path)
      throw new SandboxScopeDeniedError("Output artifact is outside its starting root");
    const spool = new ManagedOutputSpool(options, false);
    try {
      const info = await spool.rpc<{
        identity: OutputLocator["identity"];
        directory: OutputLocator["directory"];
        directories: number;
      }>({
        op: "init",
        root: canonical(options.privateRoot),
        name: nameFor(options.ref),
        artifactRoot: root,
        artifactComponents: rel.split("/"),
        io: options.io,
      });
      spool.record = {
        ref: { ...options.ref },
        name: nameFor(options.ref),
        identity: info.identity,
        directory: info.directory,
        committed: 0,
      };
      for (const file of ["spool", "artifact"]) {
        await spool.barrier(`${file}-file-sync`);
        await spool.rpc({ op: "sync", file });
      }
      for (let index = info.directories - 1; index >= 0; index--) {
        await spool.barrier(`directory-sync:${index}`);
        await spool.rpc({ op: "syncDir", index });
      }
      await spool.barrier("creation-verify");
      await spool.rpc({ op: "verify" });
      await options.publish(structuredClone(spool.record));
      return spool;
    } catch (error) {
      await spool.close();
      throw error;
    }
  }
  static async openExisting(
    options: OutputSpoolOptions & { locator: OutputLocator; cleanup?: boolean },
  ): Promise<ManagedOutputSpool> {
    options = {
      ...options,
      ref: parseSandboxExecutionRef(options.ref),
      locator: structuredClone(options.locator),
    };
    const record = options.locator;
    if (
      record.name !== nameFor(options.ref) ||
      JSON.stringify(record.ref) !== JSON.stringify(options.ref) ||
      !Number.isSafeInteger(record.committed) ||
      record.committed < 0
    )
      throw new SandboxScopeDeniedError("Retained output reference mismatch");
    const spool = new ManagedOutputSpool(options, true);
    try {
      await spool.rpc({
        op: "init",
        root: canonical(options.privateRoot),
        name: record.name,
        identity: record.identity,
        directory: record.directory,
        cleanup: options.cleanup,
        io: options.io,
        committed: record.committed,
        existing: true,
      });
      spool.record = structuredClone(record);
      return spool;
    } catch (error) {
      await spool.close();
      throw error;
    }
  }
  append(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.readonly || this.expired || this.closed || this.fault)
      return Promise.reject(Error("Managed output stream is unavailable"));
    if (this.appending || bytes.byteLength > 65536)
      return Promise.reject(Error("Managed output requires one bounded outstanding append"));
    const copy = Buffer.from(bytes);
    const next = this.record.committed + copy.length;
    if (!Number.isSafeInteger(next)) {
      this.fault = Error("Output position overflow");
      return Promise.reject(this.fault);
    }
    const pending = (async () => {
      try {
        for (const file of ["spool", "artifact"]) {
          await this.barrier(`${file}-write`);
          signal.throwIfAborted();
          await this.rpc({
            op: "write",
            file,
            data: copy.toString("base64"),
            offset: this.record.committed,
          });
        }
        await this.barrier("append-spool-sync");
        await this.rpc({ op: "sync", file: "spool" });
        await this.barrier("checkpoint");
        const record = { ...this.record, committed: next };
        await this.options.publish(structuredClone(record));
        this.record = record;
      } catch (error) {
        this.fault = error;
        throw error;
      }
    })();
    this.appending = pending.finally(() => {
      this.appending = undefined;
    });
    return this.appending;
  }
  async read(opts: {
    offset: number;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<{ data: Uint8Array; offset: number; nextOffset: number; totalBytes: number }> {
    opts = { offset: opts.offset, maxBytes: opts.maxBytes, signal: opts.signal };
    validateOutputRange(opts.offset, opts.maxBytes);
    opts.signal.throwIfAborted();
    if (this.expired) return Promise.reject(Error("Retained output expired"));
    const totalBytes = this.record.committed;
    const length = Math.min(opts.maxBytes, Math.max(0, totalBytes - opts.offset));
    const reading = (async () => {
      await this.barrier("read");
      opts.signal.throwIfAborted();
      const encoded = await this.rpc<string>({
        op: "read",
        offset: opts.offset,
        length,
        total: totalBytes,
      });
      opts.signal.throwIfAborted();
      const data = Buffer.from(encoded, "base64");
      if (data.length !== length) throw Error("Unexpected short retained output read");
      return { data, offset: opts.offset, nextOffset: opts.offset + data.length, totalBytes };
    })();
    this.readers.add(reading);
    void reading.finally(() => this.readers.delete(reading)).catch(() => {});
    return new Promise((resolve, reject) => {
      const abort = () => reject(opts.signal.reason);
      opts.signal.addEventListener("abort", abort, { once: true });
      if (opts.signal.aborted) abort();
      void reading
        .then(resolve, reject)
        .finally(() => opts.signal.removeEventListener("abort", abort));
    });
  }
  async flush(): Promise<void> {
    await this.appending;
    if (this.fault) throw this.fault;
    if (this.readonly) return;
    try {
      for (const file of ["spool", "artifact"]) {
        await this.barrier(`final-${file}-sync`);
        await this.rpc({ op: "sync", file });
      }
    } catch (error) {
      this.fault = error;
      throw error;
    }
  }
  async expire(tombstone: () => Promise<void>, cleaned: () => Promise<void>): Promise<void> {
    this.expired = true;
    await Promise.allSettled([...this.readers, ...(this.appending ? [this.appending] : [])]);
    await this.barrier("expiry-tombstone");
    await tombstone();
    await this.barrier("expiry-unlink");
    await this.rpc({ op: "unlink" });
    await this.barrier("expiry-directory-sync");
    await this.rpc({ op: "syncParent" });
    await this.barrier("expiry-complete");
    await cleaned();
    await this.close();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled([...this.readers, ...(this.appending ? [this.appending] : [])]);
    await this.rpcQueue;
    this.child.stdin.end('{"op":"close"}\n');
    await this.ended;
  }
}
