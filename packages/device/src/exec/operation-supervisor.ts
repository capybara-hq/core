import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  type SandboxStopResult,
} from "@capybara-hq/plugin-sdk";
import type { NativeHelperResult } from "./native-helper-client.js";
import { digest, type LocalExecAuthority, type LocalOperationGrant } from "./operation-types.js";
import {
  type MacWorkerHandle,
  type MacWorkerRequest,
  startMacOperationWorker,
  type TrustedLaunchIdentity,
} from "./operation-worker.js";
import {
  finalizeRecoveredOutput,
  ManagedOutputSpool,
  type OutputLocator,
  validateOutputRange,
} from "./output-spool.js";
import { timed } from "./transfer-timing.js";

interface Entry {
  ref: SandboxExecutionRef;
  admitBeforeMs: number;
  hash: string;
  retainUntilMs: number;
  state: "consumed" | "running" | "completed" | "unknown";
  revoked: boolean;
  identity?: TrustedLaunchIdentity;
  result?: ExecResult | NativeHelperResult | OmittedReadResult;
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
    state: "collecting" | "complete" | "fault" | "uncertain";
    unavailable?: boolean;
    interruptedCancellation: boolean;
    expired?: boolean;
    cleaned?: boolean;
  };
}
/**
 * What the journal keeps of a completed native read: its outcome, never its bytes. The bytes stay
 * in this process's memory for in-process retries; rewriting megabytes of file content on every
 * fsynced journal commit is what made transfers slow and could exhaust the journal. A read has no
 * lasting effect, so after a restart its retry reports an unknown outcome instead.
 */
interface OmittedReadResult {
  omitted: "native-read";
  bytes: number;
  truncated: boolean;
}
const isOmittedRead = (result: Entry["result"]): result is OmittedReadResult =>
  typeof result === "object" && result !== null && "omitted" in result;
/** A completed native read's bytes as base64, while the entry still holds them. */
const readBytes = (result: Entry["result"]): string | undefined =>
  typeof result === "object" && result !== null && "dataB64" in result ? result.dataB64 : undefined;
const omitRead = (result: { dataB64: string; truncated: boolean }): OmittedReadResult => ({
  omitted: "native-read",
  bytes: Buffer.byteLength(result.dataB64, "base64"),
  truncated: result.truncated,
});
/** The entry as the journal stores it (see {@link OmittedReadResult}). */
function journalForm(entry: Entry): Entry {
  const result = entry.result;
  if (readBytes(result) === undefined) return entry;
  return { ...entry, result: omitRead(result as { dataB64: string; truncated: boolean }) };
}
const RETAINED_READ_BYTES = 64 * 1024 * 1024;
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
  /**
   * Called once each live worker (an exec, or a background task long after its start answered)
   * is gone: completed, killed or failed to launch. Never throws into the supervisor.
   */
  onLiveEnded?: (operationId: string) => void;
  pythonPath?: string;
  outputBarrier?: (name: string) => Promise<void>;
  beforePersist?: () => void;
  /**
   * Linux: called once, at construction, for every recorded launch identity that was running
   * under another device process (the supervisor was lost). It ends that exact recorded session;
   * the entry stays unknown and is never resumed.
   */
  reapOrphan?: (identity: TrustedLaunchIdentity) => void;
  /**
   * The most completed native read bytes kept in memory for retries (default 64 MiB). Past it the
   * oldest reads give their bytes up and their retry reports an unknown outcome, as after a
   * restart.
   */
  retainedReadBytes?: number;
}
interface Journal {
  version: 1;
  transaction?: {
    id: string;
    revision: number;
    predecessor: string;
    deviceId: string;
    generation: string;
  };
  entries: Entry[];
}
interface Decision {
  version: 1;
  transaction: NonNullable<Journal["transaction"]>;
  candidate: string;
  predecessor: string;
  outputs: {
    ref: SandboxExecutionRef;
    locator: OutputLocator;
    state: NonNullable<Entry["output"]>["state"];
  }[];
}
class JournalCommitUncertainError extends Error {}
/** What a supervisor still owns: work that a drain must see settle before it disconnects. */
export interface SupervisorOwnership {
  /** Live workers, including acknowledged background tasks whose start RPC already answered. */
  workers: number;
  /** Exact cancellations whose attempt has not settled. */
  cancellations: number;
  /** Output collectors (spools) still open, and output reads in flight. */
  collectors: number;
  /** Deferred control/journal persistence not yet written. */
  persistence: number;
}
/** A drain gave up before everything it owns settled; the supervisor stays draining. */
export class DrainPendingError extends Error {
  override name = "DrainPendingError";
  constructor(readonly pending: SupervisorOwnership) {
    super("The device still owns running work; it stays draining and is not reusable");
  }
}
function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeSynced(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function parseJournal(text: string): Journal {
  const raw = JSON.parse(text) as Journal;
  if (raw.version !== 1 || !Array.isArray(raw.entries))
    throw Error("Unsupported operation journal");
  const ids = new Set<string>();
  for (const entry of raw.entries) {
    parseSandboxExecutionRef(entry.ref);
    if (ids.has(entry.ref.operationId)) throw Error("Conflicting operation journal");
    ids.add(entry.ref.operationId);
  }
  return raw;
}
function outputEvidence(journal: Journal): Decision["outputs"] {
  return journal.entries.flatMap((entry) =>
    entry.output
      ? [{ ref: entry.ref, locator: entry.output.locator, state: entry.output.state }]
      : [],
  );
}
/** One owner process per generation. A restarted process never reuses recorded PIDs. */
export class MacOperationSupervisor {
  private entries = new Map<string, Entry>();
  private live = new Map<string, Live>();
  // Stop ownership outlives worker completion until the cancellation attempt settles.
  private cancellations = new Map<string, Promise<SandboxStopResult>>();
  private faultOwners = new Map<string, Live>();
  private controlWrites = new Map<string, Promise<void>>();
  private dirtyControls = new Set<string>();
  private outputReads = new Map<string, Set<Promise<unknown>>>();
  private spools = new Map<string, ManagedOutputSpool>();
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  private rollbackFile: string;
  private decisionFile: string;
  private journalBlocked = false;
  private verifiedJournal = JSON.stringify({ version: 1, entries: [] });
  private now: () => number;
  private draining = false;
  /** Set by {@link close}: a superseded supervisor never writes the shared journal again. */
  private closed = false;
  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.file = join(options.stateDir, `operation-journal-${digest(options.deviceId)}.json`);
    this.rollbackFile = `${this.file}.rollback`;
    this.decisionFile = `${this.file}.decision`;
    const predecessor = existsSync(this.rollbackFile)
      ? readFileSync(this.rollbackFile, "utf8")
      : this.verifiedJournal;
    let selected = predecessor;
    let uncertain: Journal | undefined;
    if (existsSync(this.file) && !existsSync(this.rollbackFile))
      throw Error("Operation journal predecessor is missing");
    if (existsSync(this.decisionFile) && !existsSync(this.file)) this.journalBlocked = true;
    if (existsSync(this.file)) {
      const candidate = readFileSync(this.file, "utf8");
      // An identical checkpoint is itself the durable floor, including a previous ACK.
      if (candidate === predecessor) selected = candidate;
      else if (existsSync(this.decisionFile)) {
        try {
          const next = parseJournal(candidate),
            prior = parseJournal(predecessor);
          uncertain = next;
          const decision = JSON.parse(readFileSync(this.decisionFile, "utf8")) as Decision;
          const tx = next.transaction;
          if (
            !tx ||
            tx.deviceId !== options.deviceId ||
            decision.version !== 1 ||
            JSON.stringify(decision.transaction) !== JSON.stringify(tx) ||
            decision.candidate !== digest(candidate) ||
            decision.predecessor !== digest(predecessor) ||
            tx.predecessor !== decision.predecessor ||
            tx.revision !== (prior.transaction?.revision ?? 0) + 1 ||
            JSON.stringify(decision.outputs) !== JSON.stringify(outputEvidence(next))
          )
            throw Error("Invalid operation commit evidence");
          this.validateSuccessor(prior, next);
          for (const entry of next.entries) {
            if (entry.ref.instanceId !== options.deviceId) throw Error("Wrong instance in journal");
            const old = prior.entries.find((e) => e.ref.operationId === entry.ref.operationId);
            if (!old && entry.ref.instanceGeneration !== tx.generation)
              throw Error("Wrong execution generation in commit evidence");
            if (
              entry.output &&
              !entry.output.expired &&
              JSON.stringify(old?.output) !== JSON.stringify(entry.output)
            )
              finalizeRecoveredOutput(
                options.stateDir,
                options.pythonPath ?? "/usr/bin/python3",
                entry.output.locator,
              );
          }
          // Readable decision bytes are not proof of the former syscall's outcome. Validate
          // and finalize all evidence anew before exposing the successor after restart.
          syncPath(this.file);
          syncPath(this.decisionFile);
          syncPath(options.stateDir);
          selected = candidate;
          uncertain = undefined;
        } catch {
          this.journalBlocked = true;
          // Never report a shorter successful snapshot if C could have been acknowledged.
        }
      }
    }
    this.verifiedJournal = selected;
    const raw = parseJournal(selected);
    if (this.journalBlocked && !uncertain) {
      for (const entry of raw.entries) {
        entry.state = "unknown";
        delete entry.result;
        if (entry.output) entry.output.unavailable = true;
      }
    }
    if (uncertain) {
      for (const candidate of uncertain.entries) {
        const old = raw.entries.find((e) => e.ref.operationId === candidate.ref.operationId);
        if (JSON.stringify(old) === JSON.stringify(candidate)) continue;
        if (old) {
          old.state = "unknown";
          delete old.result;
          if (old.output) old.output.unavailable = true;
        }
        // Preserve possibly consumed identities without treating a candidate as a commit.
        if (!old) {
          const tombstone: Entry = { ...candidate, state: "unknown", revoked: true };
          delete tombstone.result;
          if (candidate.output)
            tombstone.output = {
              ...candidate.output,
              state: "uncertain",
              unavailable: true,
              interruptedCancellation: true,
            };
          raw.entries.push(tombstone);
        }
      }
    }
    for (const e of raw.entries) {
      this.recoverControl(e);
      if (
        (e.state === "running" || e.state === "consumed") &&
        e.identity?.session &&
        options.reapOrphan
      )
        options.reapOrphan(e.identity);
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
  private validateSuccessor(prior: Journal, next: Journal): void {
    for (const old of prior.entries) {
      const entry = next.entries.find((e) => e.ref.operationId === old.ref.operationId);
      if (
        !entry ||
        JSON.stringify(entry.ref) !== JSON.stringify(old.ref) ||
        entry.hash !== old.hash ||
        (old.revoked && !entry.revoked) ||
        (old.stop?.outcome === "stopped" && entry.stop?.outcome !== "stopped")
      )
        throw Error("Commit would regress an operation tombstone");
      if (old.output) {
        const output = entry.output;
        if (
          !output ||
          output.locator.committed < old.output.locator.committed ||
          JSON.stringify({ ...output.locator, committed: 0 }) !==
            JSON.stringify({ ...old.output.locator, committed: 0 }) ||
          (old.output.state === "fault" && output.state !== "fault") ||
          (old.output.state === "complete" &&
            output.state !== "complete" &&
            output.state !== "fault") ||
          (old.output.expired && !output.expired) ||
          (old.output.cleaned && !output.cleaned)
        )
          throw Error("Commit would regress retained output");
      }
    }
  }
  private controlFile(entry: Entry): string {
    return join(this.options.stateDir, `operation-control-${digest(entry.ref)}.json`);
  }
  private recoverControl(entry: Entry): void {
    const file = this.controlFile(entry);
    if (!existsSync(file)) return;
    try {
      const control = JSON.parse(readFileSync(file, "utf8"));
      if (
        control.version !== 1 ||
        JSON.stringify(control.ref) !== JSON.stringify(entry.ref) ||
        control.revoked !== true ||
        typeof control.fault !== "boolean" ||
        !["stopped", "cancel-pending"].includes(control.stop)
      )
        throw Error("Invalid operation control");
      syncPath(file);
      syncPath(this.options.stateDir);
      entry.revoked = true;
      entry.stop = {
        outcome:
          entry.stop?.outcome === "stopped" || control.stop === "stopped"
            ? "stopped"
            : "cancel-pending",
      };
      if (control.fault && entry.output) {
        entry.output.state = "fault";
        entry.state = "unknown";
        delete entry.result;
      }
      if (entry.output) entry.output.interruptedCancellation = entry.stop?.outcome !== "stopped";
    } catch {
      this.journalBlocked = true;
      entry.revoked = true;
      entry.state = "unknown";
      delete entry.result;
      if (entry.stop?.outcome !== "stopped") entry.stop = { outcome: "cancel-pending" };
      if (entry.output) {
        if (entry.output.state !== "fault") entry.output.state = "uncertain";
        entry.output.interruptedCancellation = entry.stop?.outcome !== "stopped";
      }
    }
  }
  private persistControl(entry: Entry): void {
    this.options.beforePersist?.();
    const file = this.controlFile(entry),
      temporary = `${file}.${randomUUID()}.candidate`;
    let fault = entry.output?.state === "fault",
      stopped = entry.stop?.outcome === "stopped";
    if (existsSync(file)) {
      const prior = JSON.parse(readFileSync(file, "utf8"));
      if (JSON.stringify(prior.ref) !== JSON.stringify(entry.ref))
        throw Error("Control reference mismatch");
      fault ||= prior.fault === true;
      stopped ||= prior.stop === "stopped";
    }
    try {
      writeSynced(
        temporary,
        JSON.stringify({
          version: 1,
          ref: entry.ref,
          revoked: true,
          fault,
          stop: stopped ? "stopped" : "cancel-pending",
        }),
      );
      renameSync(temporary, file);
      syncPath(file);
      syncPath(this.options.stateDir);
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {}
    }
  }
  /**
   * Keeps the completed read bytes held for retries within {@link SupervisorOptions.retainedReadBytes}:
   * the oldest reads (admission order) give their bytes up first.
   */
  private boundRetainedReads(): void {
    const budget = this.options.retainedReadBytes ?? RETAINED_READ_BYTES;
    const held: Entry[] = [];
    let total = 0;
    for (const entry of this.entries.values()) {
      const data = readBytes(entry.result);
      if (data === undefined) continue;
      held.push(entry);
      total += Buffer.byteLength(data, "base64");
    }
    for (const entry of held) {
      if (total <= budget) break;
      const result = entry.result as { dataB64: string; truncated: boolean };
      total -= Buffer.byteLength(result.dataB64, "base64");
      entry.result = omitRead(result);
    }
  }
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private persist(): void {
    timed("supervisor", "journal", () => this.persistNow());
  }
  private persistNow(): void {
    if (this.closed)
      throw new SandboxPermissionUnsupportedError(
        "This instance generation was superseded; its journal belongs to the current binding",
      );
    if (this.journalBlocked)
      throw Error("Operation journal requires recovery after uncertain commit");
    this.options.beforePersist?.();
    const prior = parseJournal(this.verifiedJournal);
    const transaction = {
      id: randomUUID(),
      revision: (prior.transaction?.revision ?? 0) + 1,
      predecessor: digest(this.verifiedJournal),
      deviceId: this.options.deviceId,
      generation: this.options.instanceGeneration,
    };
    const journal: Journal = {
      version: 1,
      transaction,
      entries: [...this.entries.values()].map(journalForm),
    };
    const text = JSON.stringify(journal);
    if (Buffer.byteLength(text) > 64 * 1024 * 1024)
      throw Error("Operation journal capacity exhausted");
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const candidate = `${this.file}.${transaction.id}.candidate`;
    const rollbackCandidate = `${this.rollbackFile}.${transaction.id}.candidate`;
    const decisionCandidate = `${this.decisionFile}.${transaction.id}.candidate`;
    let deciding = false;
    try {
      // Advance the durable floor before touching C. Keep the old decision until the floor
      // is synced: a crash here must still retain the previous acknowledged successor.
      writeSynced(rollbackCandidate, this.verifiedJournal);
      renameSync(rollbackCandidate, this.rollbackFile);
      syncPath(this.options.stateDir);
      if (existsSync(this.decisionFile)) {
        rmSync(this.decisionFile);
        syncPath(this.options.stateDir);
      }
      writeSynced(candidate, text);
      renameSync(candidate, this.file);
      syncPath(this.file);
      syncPath(this.options.stateDir);
      const decision: Decision = {
        version: 1,
        transaction,
        candidate: digest(text),
        predecessor: transaction.predecessor,
        outputs: outputEvidence(journal),
      };
      writeSynced(decisionCandidate, JSON.stringify(decision));
      deciding = true;
      renameSync(decisionCandidate, this.decisionFile);
      syncPath(this.decisionFile);
      syncPath(this.options.stateDir);
      this.verifiedJournal = text;
    } catch (cause) {
      if (deciding) {
        this.journalBlocked = true;
        throw new JournalCommitUncertainError("Operation final commit outcome is unknown", {
          cause,
        });
      }
      throw cause;
    } finally {
      for (const path of [candidate, rollbackCandidate, decisionCandidate])
        try {
          rmSync(path, { force: true });
        } catch {}
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
      // Only the retained payload goes. A completed entry stays completed (settled for good). An
      // entry that never completed stays unknown and keeps its launch identity: that identity is
      // what marks work of a lost process that may still run (see retiredByExpiry).
      const completed = entry.state === "completed";
      if (
        Object.hasOwn(entry, "result") ||
        entry.tail !== undefined ||
        entry.request !== undefined ||
        (completed && entry.identity !== undefined)
      ) {
        delete entry.result;
        delete entry.tail;
        delete entry.request;
        if (completed) delete entry.identity;
        else entry.state = "unknown";
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
      // a draining device admits nothing new; retries of admitted ids above stay recoverable
      if (this.draining)
        throw new SandboxPermissionUnsupportedError(
          "The device is draining; retry the operation after it reconnects",
        );
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
                if (entry.output?.state === "uncertain")
                  throw new JournalCommitUncertainError("Managed output commit remains unknown");
                if (entry.output?.state === "fault")
                  throw Error("Managed output collection has failed");
                try {
                  await spool.append(b, new AbortController().signal);
                } catch (error) {
                  this.collectorFault(entry, live, error);
                  throw error;
                }
              } else appendTail(decoders[stream].write(b));
              await request.onOutput?.(b, stream);
            },
          },
          controller.signal,
        );
        live.worker = worker;
        if (entry.output?.state === "fault" || entry.output?.state === "uncertain")
          this.collectorFault(entry, live);
        live.finished = worker.completion
          .then(
            async (value) => {
              appendTail(decoders.stdout.end());
              appendTail(decoders.stderr.end());
              const spool = this.spools.get(entry.ref.operationId);
              if (spool && entry.output?.state !== "fault" && entry.output?.state !== "uncertain") {
                try {
                  await spool.flush();
                } catch {
                  this.collectorFault(entry, live);
                }
              }
              await this.serial(() => {
                if (entry.output?.state === "fault" || entry.output?.state === "uncertain") return;
                const oldOutput = entry.output;
                if (oldOutput)
                  entry.output = {
                    ...oldOutput,
                    state: "complete",
                    interruptedCancellation: false,
                  };
                entry.state = "completed";
                entry.result = value;
                this.boundRetainedReads();
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
                  if (entry.output) this.collectorFault(entry, live, error);
                  throw error;
                }
              });
              resolve(value);
            },
            async (error) => {
              if (entry.output) this.collectorFault(entry, live, error);
              appendTail(decoders.stdout.end());
              appendTail(decoders.stderr.end());
              // The fault path schedules background persistence after failure credit and
              // cancellation dispatch. A prompt worker rejection must not reintroduce IO here.
              if (!entry.output)
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
            this.liveEnded(entry.ref.operationId);
            this.notifyOwned();
          })
          .catch((error) => {
            if (entry.output) this.collectorFault(entry, live, error);
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
        this.liveEnded(entry.ref.operationId);
        this.notifyOwned();
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
      if (
        entry.state === "completed" &&
        Object.hasOwn(entry, "result") &&
        !isOmittedRead(entry.result)
      )
        return entry.result ?? null;
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
  private collectorFault(entry: Entry, live: Live, cause?: unknown): void {
    if (!entry.output) return;
    if (entry.output.state !== "fault")
      entry.output.state =
        cause instanceof JournalCommitUncertainError ||
        (cause === undefined && entry.output.state === "uncertain")
          ? "uncertain"
          : "fault";
    entry.output.interruptedCancellation = entry.stop?.outcome !== "stopped";
    entry.state = "unknown";
    delete entry.result;
    entry.revoked = true;
    if (entry.stop?.outcome !== "stopped") entry.stop = { outcome: "cancel-pending" };
    // Latch exact ownership before doing any new storage work. The next event-loop turn
    // lets the rejected output callback release its failure credit before dispatching cancel.
    if (entry.stop.outcome !== "stopped") this.faultOwners.set(entry.ref.operationId, live);
    if (!live.worker) return;
    if (!this.cancellations.has(entry.ref.operationId) && entry.stop.outcome !== "stopped") {
      const worker = live.worker;
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
          this.notifyOwned();
          this.scheduleControl(entry);
          return entry.stop;
        })
        .finally(() => {
          this.cancellations.delete(entry.ref.operationId);
          this.notifyOwned();
        });
      this.cancellations.set(entry.ref.operationId, attempt);
      this.notifyOwned();
    }
    // Register after cancel's dispatch turn. Neither this write nor its journal fallback
    // is awaited by append, failure credit or cancellation; a failed write remains retryable.
    this.scheduleControl(entry);
  }
  private scheduleControl(entry: Entry): void {
    const id = entry.ref.operationId;
    const previous = this.controlWrites.get(id) ?? Promise.resolve();
    const writing = previous
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(async () => {
        let saved = false;
        try {
          await this.options.outputBarrier?.("control-persist");
          try {
            this.persistControl(entry);
            saved = true;
          } catch {}
          // Independent attempts: failed sidecar replacement must not suppress a possible
          // durable stopped/fault journal update, nor may a blocked journal suppress control.
          await this.serial(() => {
            this.persist();
            saved = true;
          }).catch(() => {});
          await this.options.outputBarrier?.("control-persisted");
        } finally {
          if (saved) this.dirtyControls.delete(id);
          else this.dirtyControls.add(id);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.controlWrites.get(id) === writing) this.controlWrites.delete(id);
      });
    this.controlWrites.set(id, writing);
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
    ref = parseSandboxExecutionRef(ref);
    opts = { offset: opts.offset, maxBytes: opts.maxBytes, signal: opts.signal };
    validateOutputRange(opts.offset, opts.maxBytes);
    opts.signal.throwIfAborted();
    const entry = this.validate(ref);
    if (!entry?.output || entry.output.unavailable) return { unavailable: "lost" };
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
            const previous = entry.output;
            if (previous) entry.output = { ...previous, expired: true };
            try {
              this.persist();
            } catch (error) {
              if (previous) entry.output = previous;
              throw error;
            }
          }),
        () =>
          this.serial(() => {
            const previous = entry.output;
            if (previous) entry.output = { ...previous, cleaned: true };
            try {
              this.persist();
            } catch (error) {
              if (previous) entry.output = previous;
              throw error;
            }
          }),
      );
    } finally {
      await spool.close();
    }
  }
  /**
   * The owner watcher runs while anything is owned: a live worker, a faulted collector's owner or
   * an exact cancellation still settling (an idle socket or a disconnect does not end it).
   */
  private liveEnded(operationId: string): void {
    try {
      this.options.onLiveEnded?.(operationId);
    } catch {
      // an observer never affects the supervisor
    }
  }
  private notifyOwned(): void {
    this.options.onLiveChanged?.(
      this.live.size > 0 || this.faultOwners.size > 0 || this.cancellations.size > 0,
    );
  }
  ownership(): SupervisorOwnership {
    let reads = 0;
    for (const readers of this.outputReads.values()) reads += readers.size;
    return {
      workers: new Set([...this.live.keys(), ...this.faultOwners.keys()]).size,
      cancellations: this.cancellations.size,
      collectors: this.spools.size + reads,
      persistence: this.controlWrites.size + this.dirtyControls.size,
    };
  }
  /** Starts a graceful drain: no new admission from now on, for the rest of this process. */
  beginDrain(): void {
    this.draining = true;
  }
  get isDraining(): boolean {
    return this.draining;
  }
  /**
   * Operations of another instance generation whose effect may still exist (permission runtime
   * cutover B4): owned here (live, faulted or cancelling), or recorded without a completed result
   * or an established stop or exit (an expired entry without a launch identity excepted: see
   * retiredByExpiry). A binding to another generation is refused while any remains; a newer
   * generation alone never clears them.
   */
  /**
   * Gives the journal up for good (B4: one supervisor per journal). Only after everything owned
   * settled; the caller then builds the successor from the journal on disk.
   */
  close(): void {
    const o = this.ownership();
    if (o.workers + o.cancellations + o.collectors + o.persistence > 0)
      throw new SandboxPermissionUnsupportedError(
        "The supervisor still owns work; settle it first",
      );
    this.draining = true;
    this.closed = true;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  retirementObligations(generation: string): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.ref.instanceGeneration === generation) continue;
      const id = e.ref.operationId;
      const owned = this.live.has(id) || this.faultOwners.has(id) || this.cancellations.has(id);
      if (owned || !this.settledEntry(e)) count++;
    }
    return count;
  }
  /** An entry (not owned by this process) whose work can have no effect any more. */
  private settledEntry(e: Entry): boolean {
    return (
      e.state === "completed" ||
      e.stop?.outcome === "stopped" ||
      e.stop?.outcome === "already-exited" ||
      this.retiredByExpiry(e)
    );
  }
  /**
   * An unknown entry past its retention with no launch identity and no output left uncleaned:
   * nothing about it can be stopped, reaped or read, so it blocks no binding. Journals of earlier
   * device versions hold such entries for work that completed (the retention sweep used to mark
   * it unknown), and work that never launched (refused, revoked or failed before its launch was
   * recorded) looks the same. Work of a lost process that may still run keeps its recorded launch
   * identity past retention and stays an obligation.
   */
  private retiredByExpiry(e: Entry): boolean {
    return (
      e.state === "unknown" &&
      e.retainUntilMs <= this.now() &&
      e.identity === undefined &&
      (e.output === undefined || e.output.cleaned === true)
    );
  }
  /**
   * Waits until nothing is owned: acknowledged workers (whatever happened to their start RPC),
   * collectors, pending exact cancellations and deferred persistence. Status, reads, tails, stops
   * and reconciliation keep working meanwhile. When `signal` aborts first it throws
   * {@link DrainPendingError} with what is still owned; it never declares a drain from an empty
   * request table. A control write that keeps failing stays owned (dirty) until it succeeds.
   */
  async settle(signal: AbortSignal): Promise<void> {
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const empty = (o: SupervisorOwnership) =>
      o.workers + o.cancellations + o.collectors + o.persistence === 0;
    const retried = new Set<string>();
    while (!empty(this.ownership())) {
      if (signal.aborted) throw new DrainPendingError(this.ownership());
      // a dirty control with no write in flight is retried once per drain; one that fails again
      // stays owned until the drain gives up (no write loop)
      for (const id of this.dirtyControls) {
        const entry = this.entries.get(id);
        if (entry && !this.controlWrites.has(id) && !retried.has(id)) {
          retried.add(id);
          this.scheduleControl(entry);
        }
      }
      const waits: Promise<unknown>[] = [this.queue.catch(() => {})];
      const o = this.ownership();
      // only failed persistence is left: nothing to wait for but the drain's end
      if (
        o.workers + o.cancellations + o.collectors === 0 &&
        this.controlWrites.size === 0 &&
        this.outputReads.size === 0
      )
        waits.push(aborted);
      for (const live of [...this.live.values(), ...this.faultOwners.values()])
        waits.push(
          live.completion.catch(() => {}),
          live.finished?.catch(() => {}) ?? live.completion,
        );
      waits.push(...this.cancellations.values(), ...this.controlWrites.values());
      for (const readers of this.outputReads.values()) waits.push(...readers);
      await Promise.race([Promise.allSettled(waits), aborted]);
      // let finally() handlers that release ownership run before checking again
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  async settled(id: string): Promise<void> {
    const live = this.live.get(id);
    try {
      await live?.completion;
    } finally {
      await live?.finished;
      await this.queue;
      while (this.controlWrites.has(id)) await this.controlWrites.get(id);
    }
  }
  async status(ref: SandboxExecutionRef, signal: AbortSignal): Promise<SandboxExecutionStatus> {
    signal.throwIfAborted();
    const e = this.validate(ref);
    if (
      !e ||
      e.retainUntilMs <= this.now() ||
      e.output?.state === "fault" ||
      e.output?.state === "uncertain" ||
      e.output?.unavailable
    )
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
    if (e.output?.state === "fault" || e.output?.state === "uncertain" || e.output?.unavailable) {
      if (e.stop?.outcome === "stopped") {
        if (this.dirtyControls.has(e.ref.operationId)) this.scheduleControl(e);
        return e.stop;
      }
      const live = this.live.get(ref.operationId) ?? this.faultOwners.get(ref.operationId);
      if (live) this.collectorFault(e, live);
      return { outcome: "cancel-pending" };
    }
    let outcome: SandboxStopResult | Promise<SandboxStopResult> = { outcome: "cancel-pending" };
    await this.serial(() => {
      if (e.output?.state === "fault" || e.output?.state === "uncertain" || e.output?.unavailable) {
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
        if (!this.journalBlocked) this.persist();
        return;
      }
      e.revoked = true;
      e.stop = { outcome: "cancel-pending" };
      this.persistControl(e);
      // Independent intent is durable. Shared publication cannot veto cancellation of
      // an already-owned worker, including when another execution's commit is uncertain.
      try {
        this.persist();
      } catch {}
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
              this.faultOwners.delete(ref.operationId);
              this.notifyOwned();
              try {
                this.persistControl(e);
              } catch {}
              try {
                this.persist();
              } catch {}
            }
          });
          return e.stop ?? { outcome: "cancel-pending" };
        })
        .finally(async () => {
          await this.serial(() => {
            this.cancellations.delete(ref.operationId);
            this.notifyOwned();
            if (
              e.stop?.outcome === "cancel-pending" &&
              e.output?.state !== "fault" &&
              e.output?.state !== "uncertain" &&
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
      this.notifyOwned();
      outcome = attempt;
    });
    return outcome;
  }

  /** Live background tasks this process owns (a live worker with managed output), by id. */
  private liveBackground(): Set<string> {
    const ids = new Set<string>();
    for (const id of this.live.keys()) {
      const entry = this.entries.get(id);
      if (entry && (entry.output !== undefined || this.spools.has(id))) ids.add(id);
    }
    return ids;
  }
  /**
   * What would still refuse a binding to `generation` once this supervisor's live background
   * tasks were stopped: live or faulted foreground workers, cancellations in flight, collectors
   * and reads not belonging to those tasks, pending persistence, and other generations'
   * unsettled entries that are not those tasks (uncertain work of earlier processes included).
   */
  blockersBesidesLiveBackground(generation: string): number {
    const background = this.liveBackground();
    let count = 0;
    for (const id of new Set([...this.live.keys(), ...this.faultOwners.keys()]))
      if (!background.has(id)) count++;
    count += this.cancellations.size + this.controlWrites.size + this.dirtyControls.size;
    for (const id of this.spools.keys()) if (!background.has(id)) count++;
    for (const readers of this.outputReads.values()) count += readers.size;
    for (const e of this.entries.values()) {
      const id = e.ref.operationId;
      if (e.ref.instanceGeneration === generation || background.has(id)) continue;
      if (this.live.has(id) || this.faultOwners.has(id) || this.cancellations.has(id)) continue;
      if (!this.settledEntry(e)) count++;
    }
    return count;
  }
  /**
   * Exact-stops every operation this supervisor owns live (a live or faulted worker), each by its
   * recorded ref, never a PID or marker scan; `backgroundOnly` limits it to live background tasks.
   * Resolves with each outcome once its attempt settled or `signal` aborted: an attempt that has
   * not settled by then reports `cancel-pending` and stays owned (and journaled as pending).
   */
  async stopOwned(opts: {
    backgroundOnly: boolean;
    graceMs: number;
    signal: AbortSignal;
  }): Promise<{ operationId: string; result: SandboxStopResult }[]> {
    const ids = opts.backgroundOnly
      ? this.liveBackground()
      : new Set([...this.live.keys(), ...this.faultOwners.keys()]);
    const pending = (): SandboxStopResult => ({ outcome: "cancel-pending" });
    const aborted = new Promise<SandboxStopResult>((resolve) => {
      if (opts.signal.aborted) resolve(pending());
      else opts.signal.addEventListener("abort", () => resolve(pending()), { once: true });
    });
    return Promise.all(
      [...ids].flatMap((operationId) => {
        const entry = this.entries.get(operationId);
        if (!entry) return [];
        const attempt = opts.signal.aborted
          ? Promise.resolve(pending())
          : this.stop(entry.ref, { graceMs: opts.graceMs, signal: opts.signal }).catch(pending);
        return [Promise.race([attempt, aborted]).then((result) => ({ operationId, result }))];
      }),
    );
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
      if (e.output?.state === "fault" || e.output?.state === "uncertain" || e.output?.unavailable)
        this.scheduleControl(e);
      if (e.stop?.outcome === "cancel-pending") await this.stop(e.ref, { graceMs: 0, signal });
      else if (e.request && !e.revoked && e.state !== "completed" && !allowed(e.request))
        await this.revokeOperation(
          { operationId: e.ref.operationId, admitBeforeMs: e.admitBeforeMs },
          signal,
        );
    }
  }
}
