import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type ExecResult,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  type SandboxExecutionRef,
  type SandboxExecutionStatus,
  SandboxOperationOutcomeUnknownError,
  type SandboxOperationRef,
  SandboxScopeDeniedError,
  type SandboxStopResult,
} from "@capybara-hq/plugin-sdk";
import { writePrivate } from "../state.js";
import type { NativeHelperResult } from "./native-helper-client.js";
import { digest, type LocalExecAuthority, type LocalOperationGrant } from "./operation-types.js";
import {
  type MacWorkerHandle,
  type MacWorkerRequest,
  startMacOperationWorker,
  type TrustedLaunchIdentity,
} from "./operation-worker.js";
import { ManagedOutputSpool, type OutputLocator, validateOutputRange } from "./output-spool.js";

interface Entry {
  ref: SandboxExecutionRef;
  admitBeforeMs: number;
  hash: string;
  retainUntilMs: number;
  state: "consumed" | "running" | "completed" | "unknown";
  revoked: boolean;
  identity?: TrustedLaunchIdentity;
  result?: ExecResult | NativeHelperResult;
  stop?: SandboxStopResult;
  request?: {
    scope: MacWorkerRequest["scope"];
    grant: LocalOperationGrant;
    authority?: LocalExecAuthority;
    kind: MacWorkerRequest["kind"];
  };
  tail?: string;
  output?: {
    locator: OutputLocator;
    state: "collecting" | "complete" | "fault";
    interruptedCancellation: boolean;
    expired?: boolean;
    cleaned?: boolean;
  };
}
interface Live {
  worker?: MacWorkerHandle;
  controller: AbortController;
  completion: Promise<ExecResult | NativeHelperResult>;
  finished?: Promise<void>;
}
export interface SupervisorOptions {
  stateDir: string;
  deviceId: string;
  instanceGeneration: string;
  now?: () => number;
  start?: (request: MacWorkerRequest, signal: AbortSignal) => Promise<MacWorkerHandle>;
  onLiveChanged?: (live: boolean) => void;
  pythonPath?: string;
  outputBarrier?: (name: string) => Promise<void>;
  beforePersist?: () => void;
}
/** One owner process per generation. A restarted process never reuses recorded PIDs. */
export class MacOperationSupervisor {
  private entries = new Map<string, Entry>();
  private live = new Map<string, Live>();
  // Stop ownership outlives worker completion until the cancellation attempt settles.
  private cancellations = new Map<string, Promise<SandboxStopResult>>();
  private faultOwners = new Map<string, Live>();
  private outputReads = new Map<string, Set<Promise<unknown>>>();
  private spools = new Map<string, ManagedOutputSpool>();
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  private now: () => number;
  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.file = join(options.stateDir, `operation-journal-${digest(options.deviceId)}.json`);
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        version: number;
        entries: Entry[];
      };
      if (raw.version !== 1 || !Array.isArray(raw.entries))
        throw new Error("Unsupported operation journal");
      for (const e of raw.entries) {
        parseSandboxExecutionRef(e.ref);
        if (e.state === "running" || e.state === "consumed") e.state = "unknown";
        if (
          e.output &&
          e.output.state !== "complete" &&
          e.output.interruptedCancellation &&
          e.stop?.outcome !== "stopped"
        )
          e.stop = { outcome: "cancel-pending" };
        this.entries.set(e.ref.operationId, e);
      }
    }
  }
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private persist(): void {
    this.options.beforePersist?.();
    const text = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    if (Buffer.byteLength(text) > 64 * 1024 * 1024)
      throw new Error("Operation journal capacity exhausted");
    writePrivate(this.file, text);
    for (const path of [this.file, this.options.stateDir]) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  private expireRetained(): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (
        entry.retainUntilMs > this.now() ||
        this.live.has(entry.ref.operationId) ||
        this.cancellations.has(entry.ref.operationId) ||
        (entry.output && !entry.output.cleaned)
      )
        continue;
      if (
        entry.result !== undefined ||
        entry.tail !== undefined ||
        entry.request !== undefined ||
        entry.identity !== undefined
      ) {
        delete entry.result;
        delete entry.tail;
        delete entry.request;
        delete entry.identity;
        entry.state = "unknown";
        changed = true;
      }
    }
    if (changed) this.persist();
  }
  private validate(ref: SandboxExecutionRef): Entry | undefined {
    ref = parseSandboxExecutionRef(ref);
    if (
      ref.instanceId !== this.options.deviceId ||
      ref.instanceGeneration !== this.options.instanceGeneration
    )
      throw new SandboxScopeDeniedError(
        "Execution reference belongs to another instance generation",
      );
    const e = this.entries.get(ref.operationId);
    if (e && JSON.stringify(e.ref) !== JSON.stringify(ref))
      throw new SandboxScopeDeniedError("Execution reference does not match its owned execution");
    return e;
  }
  private async admit(
    request: MacWorkerRequest,
    hash: string,
    retainUntilMs: number,
    signal: AbortSignal,
  ): Promise<{ entry: Entry; fresh: boolean }> {
    return this.serial(() => {
      signal.throwIfAborted();
      this.expireRetained();
      const id = request.scope.operationId;
      const previous = this.entries.get(id);
      if (previous) {
        if (previous.revoked) throw new SandboxScopeDeniedError("Operation was revoked");
        if (previous.hash !== hash)
          throw new SandboxScopeDeniedError("Operation input hash mismatch");
        if (previous.ref.instanceGeneration !== this.options.instanceGeneration)
          throw new SandboxOperationOutcomeUnknownError(
            "Operation belongs to an earlier generation; outcome unknown",
          );
        return { entry: previous, fresh: false };
      }
      const deadline =
        "admitBeforeMs" in request.scope ? request.scope.admitBeforeMs : this.now() + 60000;
      if (deadline <= this.now()) throw new SandboxScopeDeniedError("Operation admission expired");
      if (this.entries.size >= 10000) throw new Error("Operation journal capacity exhausted");
      const entry: Entry = {
        ref: {
          executionId: randomUUID(),
          operationId: id,
          instanceId: this.options.deviceId,
          instanceGeneration: this.options.instanceGeneration,
        },
        admitBeforeMs: deadline,
        hash,
        retainUntilMs: Math.max(deadline, retainUntilMs),
        state: "consumed",
        revoked: false,
        request: {
          scope: request.scope,
          grant: request.grant,
          kind: request.kind,
          ...(request.authority ? { authority: request.authority } : {}),
        },
      };
      this.entries.set(id, entry);
      this.persist();
      return { entry, fresh: true };
    });
  }
  private launch(
    entry: Entry,
    request: MacWorkerRequest,
    signal: AbortSignal,
    background: boolean,
  ): Promise<MacWorkerHandle> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let resolve!: (v: ExecResult | NativeHelperResult) => void;
    let reject!: (e: unknown) => void;
    const completion = new Promise<ExecResult | NativeHelperResult>((a, b) => {
      resolve = a;
      reject = b;
    });
    void completion.catch(() => {});
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const appendTail = (text: string) => {
      if (!text) return;
      const old = Buffer.from(entry.tail ?? "", "base64");
      entry.tail = Buffer.concat([old, Buffer.from(text)])
        .subarray(-65536)
        .toString("base64");
    };
    const live: Live = { controller, completion };
    this.live.set(entry.ref.operationId, live);
    this.options.onLiveChanged?.(true);
    const promise = (async () => {
      try {
        const worker = await (this.options.start ?? startMacOperationWorker)(
          {
            ...request,
            beforeLaunch: async () => {
              await request.beforeLaunch();
              await this.serial(() => {
                if (entry.revoked || controller.signal.aborted)
                  throw new SandboxScopeDeniedError("Operation revoked before launch");
                if (entry.admitBeforeMs <= this.now())
                  throw new SandboxScopeDeniedError("Operation admission expired before launch");
              });
            },
            onLaunch: async (identity) => {
              await this.serial(() => {
                if (entry.revoked)
                  throw new SandboxScopeDeniedError("Operation revoked during launch");
                entry.identity = identity;
                entry.state = "running";
                this.persist();
              });
              await request.onLaunch(identity);
            },
            onOutput: async (b, stream = "stdout") => {
              const spool = this.spools.get(entry.ref.operationId);
              if (spool) {
                if (entry.output?.state === "fault")
                  throw Error("Managed output collection has failed");
                try {
                  await spool.append(b, new AbortController().signal);
                } catch (error) {
                  this.collectorFault(entry, live);
                  throw error;
                }
              } else appendTail(decoders[stream].write(b));
              await request.onOutput?.(b, stream);
            },
          },
          controller.signal,
        );
        live.worker = worker;
        if (entry.output?.state === "fault") this.collectorFault(entry, live);
        live.finished = worker.completion
          .then(
            async (value) => {
              appendTail(decoders.stdout.end());
              appendTail(decoders.stderr.end());
              const spool = this.spools.get(entry.ref.operationId);
              if (spool && entry.output?.state !== "fault") {
                try {
                  await spool.flush();
                } catch {
                  this.collectorFault(entry, live);
                }
              }
              await this.serial(() => {
                if (entry.output?.state === "fault") return;
                const oldOutput = entry.output;
                if (oldOutput)
                  entry.output = {
                    ...oldOutput,
                    state: "complete",
                    interruptedCancellation: false,
                  };
                entry.state = "completed";
                entry.result = value;
                if (
                  entry.stop?.outcome === "cancel-pending" &&
                  !this.cancellations.has(entry.ref.operationId) &&
                  value &&
                  "exitCode" in value
                )
                  entry.stop = {
                    outcome: "already-exited",
                    exitCode: value.exitCode,
                    timedOut: value.timedOut,
                  };
                try {
                  this.persist();
                } catch (error) {
                  if (oldOutput) entry.output = oldOutput;
                  if (entry.output) this.collectorFault(entry, live);
                  throw error;
                }
              });
              resolve(value);
            },
            async (error) => {
              if (entry.output) this.collectorFault(entry, live);
              appendTail(decoders.stdout.end());
              appendTail(decoders.stderr.end());
              await this.serial(() => {
                entry.state = "unknown";
                this.persist();
              });
              reject(error);
            },
          )
          .finally(async () => {
            const spool = this.spools.get(entry.ref.operationId);
            this.spools.delete(entry.ref.operationId);
            await spool?.close();
            signal.removeEventListener("abort", abort);
            this.live.delete(entry.ref.operationId);
            this.options.onLiveChanged?.(this.live.size > 0 || this.faultOwners.size > 0);
          })
          .catch((error) => {
            if (entry.output) this.collectorFault(entry, live);
            entry.state = "unknown";
            delete entry.result;
            reject(
              new SandboxOperationOutcomeUnknownError(
                "Cannot persist the consumed operation outcome",
                { cause: error },
              ),
            );
          });
        await worker.ready;
        if (background) signal.removeEventListener("abort", abort);
        return worker;
      } catch (error) {
        signal.removeEventListener("abort", abort);
        controller.abort(error);
        await live.worker?.cancel("Launch failed").catch(() => {});
        await this.serial(() => {
          entry.state = "unknown";
          this.persist();
        });
        reject(error);
        this.live.delete(entry.ref.operationId);
        this.options.onLiveChanged?.(this.live.size > 0 || this.faultOwners.size > 0);
        throw error;
      }
    })();
    return promise;
  }
  async execute(
    request: MacWorkerRequest,
    hash: string,
    signal: AbortSignal,
  ): Promise<ExecResult | NativeHelperResult> {
    const { entry, fresh } = await this.admit(request, hash, this.now() + 60000, signal);
    if (!fresh) {
      if (entry.state === "completed") return entry.result ?? null;
      throw new SandboxOperationOutcomeUnknownError("Consumed operation outcome is unknown");
    }
    const launching = this.launch(entry, request, signal, false);
    const live = this.live.get(entry.ref.operationId);
    await launching;
    if (!live)
      throw new SandboxOperationOutcomeUnknownError("Consumed operation outcome is unknown");
    return live.completion;
  }
  async start(
    request: MacWorkerRequest,
    hash: string,
    retainUntilMs: number,
    signal: AbortSignal,
  ): Promise<SandboxExecutionRef> {
    if (!Number.isSafeInteger(retainUntilMs) || retainUntilMs <= this.now())
      throw new SandboxScopeDeniedError("Background retention must be in the future");
    const { entry, fresh } = await this.admit(request, hash, retainUntilMs, signal);
    if (fresh) {
      if (!request.managedOutput)
        throw new SandboxScopeDeniedError("Background start requires a trusted managed artifact");
      try {
        await request.beforeLaunch();
        const spool = await ManagedOutputSpool.create({
          privateRoot: this.options.stateDir,
          ...request.managedOutput,
          ref: entry.ref,
          pythonPath: request.pythonPath,
          barrier: this.options.outputBarrier,
          publish: (locator) =>
            this.serial(() => {
              const previous = entry.output;
              entry.output = {
                locator,
                state: previous?.state ?? "collecting",
                interruptedCancellation: true,
              };
              try {
                this.persist();
              } catch (error) {
                if (previous) entry.output = previous;
                else delete entry.output;
                throw error;
              }
            }),
        });
        this.spools.set(entry.ref.operationId, spool);
        await this.launch(entry, request, signal, true);
      } catch (error) {
        await this.spools.get(entry.ref.operationId)?.close();
        this.spools.delete(entry.ref.operationId);
        throw error;
      }
    } else if (!entry.output && (entry.state === "unknown" || entry.state === "consumed"))
      throw new SandboxOperationOutcomeUnknownError("Consumed background start outcome is unknown");
    return { ...entry.ref };
  }
  private collectorFault(entry: Entry, live: Live): void {
    if (!entry.output) return;
    entry.output.state = "fault";
    entry.output.interruptedCancellation = entry.stop?.outcome !== "stopped";
    entry.state = "unknown";
    delete entry.result;
    entry.revoked = true;
    if (entry.stop?.outcome !== "stopped") entry.stop = { outcome: "cancel-pending" };
    // The prelaunch collecting marker remains the durable fallback. New disk failure cannot
    // gate exact cancellation, and this function never waits for append/worker completion.
    void this.serial(() => this.persist()).catch(() => {});
    if (
      !live.worker ||
      this.cancellations.has(entry.ref.operationId) ||
      entry.stop.outcome === "stopped"
    )
      return;
    const worker = live.worker;
    this.faultOwners.set(entry.ref.operationId, live);
    const attempt = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async (): Promise<SandboxStopResult> => {
        try {
          await worker.cancel("Managed output collection failed", 0);
        } catch {
          return { outcome: "cancel-pending" };
        }
        entry.stop = { outcome: "stopped" };
        if (entry.output) entry.output.interruptedCancellation = false;
        this.faultOwners.delete(entry.ref.operationId);
        this.options.onLiveChanged?.(this.live.size > 0 || this.faultOwners.size > 0);
        await this.serial(() => this.persist()).catch(() => {});
        return entry.stop;
      })
      .finally(() => {
        this.cancellations.delete(entry.ref.operationId);
      });
    this.cancellations.set(entry.ref.operationId, attempt);
  }
  private async retained(
    entry: Entry,
    cleanup = false,
  ): Promise<{ spool: ManagedOutputSpool; temporary: boolean }> {
    const live = this.spools.get(entry.ref.operationId);
    if (live) return { spool: live, temporary: false };
    if (!entry.output) throw Error("Retained output lost");
    const spool = await ManagedOutputSpool.openExisting({
      privateRoot: this.options.stateDir,
      artifactRoot: this.options.stateDir,
      outputPath: "unused",
      ref: entry.ref,
      locator: entry.output.locator,
      cleanup,
      pythonPath: this.options.pythonPath ?? "/usr/bin/python3",
      publish: async () => {
        throw Error("Recovered output cannot append");
      },
      barrier: this.options.outputBarrier,
    });
    return { spool, temporary: true };
  }
  async readOutput(
    ref: SandboxExecutionRef,
    opts: { offset: number; maxBytes: number; signal: AbortSignal },
  ): Promise<
    | { data: Uint8Array; offset: number; nextOffset: number; totalBytes: number }
    | { unavailable: "lost" | "expired" }
  > {
    validateOutputRange(opts.offset, opts.maxBytes);
    opts.signal.throwIfAborted();
    const entry = this.validate(ref);
    if (!entry?.output) return { unavailable: "lost" };
    if (entry.retainUntilMs <= this.now() || entry.output.expired) {
      await this.expireOutput(ref).catch(() => {});
      return { unavailable: "expired" };
    }
    const reading = (async () => {
      let retained: Awaited<ReturnType<MacOperationSupervisor["retained"]>> | undefined;
      try {
        retained = await this.retained(entry);
        return await retained.spool.read(opts);
      } catch {
        opts.signal.throwIfAborted();
        return { unavailable: "lost" as const };
      } finally {
        if (retained?.temporary) {
          const closing = retained.spool.close();
          if (opts.signal.aborted) void closing.catch(() => {});
          else await closing;
        }
      }
    })();
    let readers = this.outputReads.get(ref.operationId);
    if (!readers) {
      readers = new Set();
      this.outputReads.set(ref.operationId, readers);
    }
    readers.add(reading);
    try {
      return await reading;
    } finally {
      readers.delete(reading);
      if (!readers.size) this.outputReads.delete(ref.operationId);
    }
  }

  async expireOutput(ref: SandboxExecutionRef): Promise<void> {
    const entry = this.validate(ref);
    if (
      !entry?.output ||
      entry.output.cleaned ||
      entry.retainUntilMs > this.now() ||
      this.live.has(ref.operationId) ||
      this.cancellations.has(ref.operationId) ||
      entry.stop?.outcome === "cancel-pending" ||
      entry.output.interruptedCancellation
    )
      return;
    await Promise.allSettled([...(this.outputReads.get(ref.operationId) ?? [])]);
    const { spool } = await this.retained(entry, entry.output.expired === true);
    try {
      await spool.expire(
        () =>
          this.serial(() => {
            if (entry.output) entry.output.expired = true;
            this.persist();
          }),
        () =>
          this.serial(() => {
            if (entry.output) entry.output.cleaned = true;
            this.persist();
          }),
      );
    } finally {
      await spool.close();
    }
  }
  async settled(id: string): Promise<void> {
    const live = this.live.get(id);
    await live?.completion;
    await live?.finished;
    await this.queue;
  }
  async status(ref: SandboxExecutionRef, signal: AbortSignal): Promise<SandboxExecutionStatus> {
    signal.throwIfAborted();
    const e = this.validate(ref);
    if (!e || e.retainUntilMs <= this.now() || e.output?.state === "fault")
      return { state: "lost" };
    if (e.state === "completed" && e.result && "exitCode" in e.result)
      return { state: "exited", exitCode: e.result.exitCode, timedOut: e.result.timedOut };
    return { state: this.live.has(ref.operationId) ? "running" : "lost" };
  }
  async tail(
    ref: SandboxExecutionRef,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | { unavailable: "lost" | "expired" }> {
    opts.signal.throwIfAborted();
    const e = this.validate(ref);
    if (!e) return { unavailable: "lost" };
    if (e.retainUntilMs <= this.now()) {
      await this.expireOutput(ref);
      this.expireRetained();
      return { unavailable: "expired" };
    }
    if (e.output) {
      if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0 || opts.maxBytes > 65536)
        throw new SandboxScopeDeniedError("Tail budget must be between 0 and 65536 bytes");
      const total = e.output.locator.committed;
      const raw = await this.readOutput(ref, {
        offset: Math.max(0, total - 65536),
        maxBytes: Math.min(65536, total),
        signal: opts.signal,
      });
      if ("unavailable" in raw) return raw;
      let begin = 0;
      while (begin < raw.data.length && ((raw.data[begin] as number) & 0xc0) === 0x80) begin++;
      const decoder = new StringDecoder("utf8");
      let text = decoder.write(Buffer.from(raw.data.subarray(begin)));
      if (e.output.state !== "collecting" || !this.live.has(ref.operationId)) text += decoder.end();
      const bytes = Buffer.from(text);
      let start = Math.max(0, bytes.length - opts.maxBytes);
      if (e.output.state === "complete") {
        let cursor = bytes.length - (bytes.at(-1) === 10 ? 1 : 0);
        for (let line = 0; line < 20; line++) {
          const previous = bytes.lastIndexOf(10, cursor - 1);
          if (previous < 0) {
            cursor = -1;
            break;
          }
          cursor = previous;
        }
        start = Math.max(start, cursor + 1);
      }
      while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
      return {
        data: bytes.subarray(start),
        truncated: total > raw.data.length || begin > 0 || start > 0,
      };
    }
    if (e.state === "unknown") return { unavailable: "lost" };
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0 || opts.maxBytes > 65536)
      throw new SandboxScopeDeniedError("Tail budget must be between 0 and 65536 bytes");
    const bytes = Buffer.from(e.tail ?? "", "base64");
    let start = Math.max(0, bytes.length - opts.maxBytes);
    if (e.state === "completed") {
      let cursor = bytes.length - (bytes[bytes.length - 1] === 10 ? 1 : 0);
      for (let line = 0; line < 20; line++) {
        const previous = bytes.lastIndexOf(10, cursor - 1);
        if (previous < 0) {
          cursor = -1;
          break;
        }
        cursor = previous;
      }
      start = Math.max(start, cursor + 1);
    }
    while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
    return { data: bytes.subarray(start), truncated: start > 0 || bytes.length === 65536 };
  }
  async stop(
    ref: SandboxExecutionRef,
    opts: { graceMs: number; signal: AbortSignal },
  ): Promise<SandboxStopResult> {
    opts.signal.throwIfAborted();
    if (!Number.isFinite(opts.graceMs) || opts.graceMs < 0 || opts.graceMs > 30000)
      throw new SandboxScopeDeniedError("Invalid stop grace");
    const e = this.validate(ref);
    if (!e) return { outcome: "lost" };
    if (e.output?.state === "fault") {
      if (e.stop?.outcome === "stopped") return e.stop;
      const live = this.live.get(ref.operationId) ?? this.faultOwners.get(ref.operationId);
      if (live) this.collectorFault(e, live);
      return { outcome: "cancel-pending" };
    }
    let outcome: SandboxStopResult | Promise<SandboxStopResult> = { outcome: "cancel-pending" };
    await this.serial(() => {
      if (e.output?.state === "fault") {
        const live = this.live.get(ref.operationId) ?? this.faultOwners.get(ref.operationId);
        if (live) this.collectorFault(e, live);
        outcome = e.stop?.outcome === "stopped" ? e.stop : { outcome: "cancel-pending" };
        return;
      }
      const active = this.cancellations.get(ref.operationId);
      if (active) {
        outcome = active;
        return;
      }
      if (e.stop && e.stop.outcome !== "cancel-pending") {
        outcome = e.stop;
        return;
      }
      if (e.state === "completed" && e.result && "exitCode" in e.result) {
        e.stop = {
          outcome: "already-exited",
          exitCode: e.result.exitCode,
          timedOut: e.result.timedOut,
        };
        outcome = e.stop;
        this.persist();
        return;
      }
      e.revoked = true;
      e.stop = { outcome: "cancel-pending" };
      this.persist();
      const live = this.live.get(ref.operationId);
      if (!live) return;
      // Claim inside the journal queue before invoking cancellation or observing completion.
      // Do not return this promise from the queue callback: settlement also journals its result.
      const attempt = Promise.resolve()
        .then(async (): Promise<SandboxStopResult> => {
          if (live.worker) {
            try {
              await live.worker.cancel("Stopped", opts.graceMs);
            } catch {
              return { outcome: "cancel-pending" };
            }
          } else live.controller.abort("Stopped");
          await live.completion.catch(() => {});
          await live.finished;
          await this.serial(() => {
            if (e.stop?.outcome === "cancel-pending") {
              e.stop = { outcome: "stopped" };
              if (e.output) e.output.interruptedCancellation = false;
              try {
                this.persist();
              } catch (error) {
                if (e.output?.state !== "fault") throw error;
              }
            }
          });
          return e.stop ?? { outcome: "cancel-pending" };
        })
        .finally(async () => {
          await this.serial(() => {
            this.cancellations.delete(ref.operationId);
            if (
              e.stop?.outcome === "cancel-pending" &&
              e.output?.state !== "fault" &&
              e.state === "completed" &&
              e.result &&
              "exitCode" in e.result
            ) {
              e.stop = {
                outcome: "already-exited",
                exitCode: e.result.exitCode,
                timedOut: e.result.timedOut,
              };
              this.persist();
            }
          });
        });
      this.cancellations.set(ref.operationId, attempt);
      outcome = attempt;
    });
    return outcome;
  }

  async revokeOperation(ref: SandboxOperationRef, signal: AbortSignal): Promise<void> {
    ref = parseSandboxOperationRef(ref);
    signal.throwIfAborted();
    let e = this.entries.get(ref.operationId);
    if (!e) {
      await this.serial(() => {
        e = this.entries.get(ref.operationId);
        if (e) {
          e.revoked = true;
        } else {
          e = {
            ref: {
              executionId: randomUUID(),
              operationId: ref.operationId,
              instanceId: this.options.deviceId,
              instanceGeneration: this.options.instanceGeneration,
            },
            admitBeforeMs: ref.admitBeforeMs,
            hash: "revoked",
            retainUntilMs: ref.admitBeforeMs,
            state: "unknown",
            revoked: true,
          };
          this.entries.set(ref.operationId, e);
        }
        this.persist();
      });
    }
    if (e) await this.stop(e.ref, { graceMs: 0, signal });
  }
  async reconcile(
    allowed: (request: NonNullable<Entry["request"]>) => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    for (const e of this.entries.values()) {
      signal.throwIfAborted();
      // Retain earlier generations as consumption/revocation evidence, never live authority.
      if (
        e.ref.instanceId !== this.options.deviceId ||
        e.ref.instanceGeneration !== this.options.instanceGeneration
      )
        continue;
      if (e.output?.state === "fault") await this.serial(() => this.persist()).catch(() => {});
      if (e.stop?.outcome === "cancel-pending") await this.stop(e.ref, { graceMs: 0, signal });
      else if (e.request && !e.revoked && e.state !== "completed" && !allowed(e.request))
        await this.revokeOperation(
          { operationId: e.ref.operationId, admitBeforeMs: e.admitBeforeMs },
          signal,
        );
    }
  }
}
