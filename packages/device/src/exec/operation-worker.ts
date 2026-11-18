import { type ChildProcess, fork, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { type FileHandle, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type ExecResult,
  SANDBOX_GIT_DENIED_INTERNALS,
  SANDBOX_MANDATORY_WRITE_DENIES,
  type SandboxBrowseScope,
  type SandboxExecOptions,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
  type SandboxPreparationScope,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { implicitWritePaths } from "../policy.js";
import { macReadAllows } from "./mac-read-policy.js";
import { macWriteRegexRules, macWriteRootSpellings } from "./mac-write-policy.js";
import {
  type NativeHelperRequest,
  type NativeHelperResult,
  type PinnedNativeRoot,
  runNativeHelper,
} from "./native-helper-client.js";
import type { LocalExecAuthority, LocalOperationGrant } from "./operation-types.js";
import {
  acquireSealedRuntime,
  type SealedRuntime,
  stagePrivateSource,
  stageRuntimeSource,
} from "./runtime-source.js";
import { ENV_NAME_RE, OutputCap, restrictedToolHomes, shellQuote } from "./shared.js";
export interface TrustedLaunchIdentity {
  pid: number;
  token: string;
  /**
   * Linux only: the closed session the operation agent owns (its SID and the leader's start
   * time), and the device process that launched it. A later device process reaps that exact
   * session after a lost supervisor; nothing is ever found by an environment marker.
   */
  session?: { sid: number; start: number };
  process?: string;
}
type Scope = SandboxOperationScope | SandboxBrowseScope | SandboxPreparationScope;
interface Common {
  scope: Scope;
  grant: LocalOperationGrant;
  stateDir: string;
  pythonPath: string;
  /**
   * The runtime hash the instance binding attested (from the bound backend). A restricted launch
   * runs only the sealed runtime with exactly this hash; absent, it is refused.
   */
  runtimeHash?: string;
  authority?: LocalExecAuthority;
  beforeLaunch: () => Promise<void>;
  onLaunch: (identity: TrustedLaunchIdentity) => Promise<void>;
  onOutput?: (bytes: Buffer, stream?: "stdout" | "stderr") => void | Promise<void>;
  /** Trusted background-only artifact configuration; never decoded from command text. */
  managedOutput?: { outputPath: string; artifactRoot: string };
  onDiagnostic?: (text: string) => void;
  onOutputFlow?: (info: {
    frameBytes: number;
    bufferedBytes: number;
    producerLimit: number;
  }) => void;
  onControl?: (event: "cancelled" | "process-exit") => void;
  onRuntimeReady?: (info: { pid: number; proxyUrl: string }) => Promise<void>;
  /**
   * macOS worker only, a test seam (trusted construction): the home and environment whose
   * version managers a restricted exec reads (default: this process's own). The Linux worker
   * takes them from its options.
   */
  toolHome?: { home: string; env: Record<string, string | undefined> };
}
export type MacWorkerRequest = Common &
  (
    | { kind: "exec"; scope: SandboxOperationScope; args: Omit<SandboxExecOptions, "signal"> }
    | {
        kind: "native";
        native: NativeHelperRequest;
        purpose: "operation" | "browse" | "preparation";
      }
  );
export interface MacWorkerHandle {
  ready: Promise<void>;
  completion: Promise<ExecResult | NativeHelperResult>;
  cancel(reason: string, graceMs?: number): Promise<void>;
}
/** Coalesce an active owned cancellation; a failed attempt never becomes a cached outcome. */
export function createCancellationAttempt(
  attempt: (graceMs: number) => Promise<void>,
): (graceMs: number) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (graceMs) => {
    if (!pending)
      pending = attempt(graceMs).finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
/**
 * Sandbox-runtime write-deny globs for one write root (or, with "", anywhere), from the shared
 * SDK policy: every {@link SANDBOX_MANDATORY_WRITE_DENIES} entry at the root, at any depth and
 * beneath; every {@link SANDBOX_GIT_DENIED_INTERNALS} entry at any depth below a `.git`
 * (submodule and worktree gitdirs included). The runtime also refuses moving an ancestor of a
 * denied path it can name, which keeps a write root's own `.git` in place. Patterns cannot
 * express the gitdir allowlist, the bare-repository `HEAD` rule or moving a deeper repository's
 * `.git` away (macOS residuals recorded in the SDK policy); any `.git` glob would deny everything
 * beneath it and break ordinary git work.
 */
export function mandatoryDenyPatterns(root: string): string[] {
  const anywhere = (name: string) => [
    ...(root ? [`${root}/${name}`, `${root}/${name}/**`] : []),
    `${root}/**/${name}`,
    `${root}/**/${name}/**`,
  ];
  return [
    ...SANDBOX_MANDATORY_WRITE_DENIES.flatMap((entry) => anywhere(entry.join("/"))),
    ...SANDBOX_GIT_DENIED_INTERNALS.flatMap((name) => [
      ...anywhere(`.git/${name}`),
      `${root}/**/.git/**/${name}`,
      `${root}/**/.git/**/${name}/**`,
      ...(root ? [`${root}/.git/**/${name}`, `${root}/.git/**/${name}/**`] : []),
    ]),
  ];
}
/**
 * Removes empty git sequencer directories (`.git/sequencer`, and those of the gitdirs below
 * `.git/modules`) under each write root, descriptor-relative and never following a link, after a
 * restricted command ended. Anything not empty, missing or not a directory is left alone.
 */
const REMOVE_EMPTY_SEQUENCERS = String.raw`
import json, os, stat, sys
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
budget = [4000]
def rmdir(fd, name):
    try:
        os.rmdir(name, dir_fd=fd)
    except OSError:
        pass
def walk(fd, depth):
    rmdir(fd, "sequencer")
    if depth > 8:
        return
    for entry in list(os.scandir(fd)):
        budget[0] -= 1
        if budget[0] < 0 or entry.name in ("objects", "refs", "logs", "sequencer"):
            continue
        if not entry.is_dir(follow_symlinks=False):
            continue
        try:
            child = os.open(entry.name, FLAGS, dir_fd=fd)
        except OSError:
            continue
        try:
            walk(child, depth + 1)
        finally:
            os.close(child)
for root in json.loads(sys.argv[1]):
    try:
        top = os.open(root, FLAGS)
    except OSError:
        continue
    try:
        git = os.open(".git", FLAGS, dir_fd=top)
    except OSError:
        os.close(top)
        continue
    try:
        rmdir(git, "sequencer")
        try:
            modules = os.open("modules", FLAGS, dir_fd=git)
        except OSError:
            modules = None
        if modules is not None:
            try:
                walk(modules, 0)
            finally:
                os.close(modules)
    finally:
        os.close(git)
        os.close(top)
`;
function removeEmptySequencers(
  roots: readonly string[],
  pythonPath: string,
  onDiagnostic?: (text: string) => void,
): void {
  const done = spawnSync(pythonPath, ["-I", "-c", REMOVE_EMPTY_SEQUENCERS, JSON.stringify(roots)], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 30_000,
  });
  if (done.status !== 0)
    onDiagnostic?.(
      `Removing empty git sequencer directories failed: ${String(done.stderr).slice(0, 300)}`,
    );
}
/** The JVM proxy agent the sandbox runtime points sandboxed JVMs at, inside its package. */
export const JAVA_PROXY_AGENT_JAR = "vendor/java-proxy-agent/srt-proxy-agent.jar";
/** The fixed private worker bootstrap (a runtime-manifest helper entry). */
export const WORKER = `import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
let manager,initialized=false,wrapped=false,closing=false,full=false,child,childClosed,timer,timedOut=false,killed=false;
const owned=new Map(),signaled=new Set();
let credit,sequence=0,outputFailed=false,outputDone=Promise.resolve();
async function collect(stream){
 try{for await(const chunk of stream){
  for(let offset=0;offset<chunk.length;offset+=65536){
   if(outputFailed)continue;
   const data=chunk.subarray(offset,offset+65536);const seq=sequence++;
   const bufferedBytes=chunk.length+stream.readableLength;if(bufferedBytes>262144)throw Error('Managed producer buffer exceeded bound');
   send({event:'output-flow',frameBytes:data.length,bufferedBytes,producerLimit:262144});
   await new Promise((resolve,reject)=>{credit={seq,resolve,reject};send({event:'output',stream:'stdout',seq,data:data.toString('base64')});});
  }
 }}catch(error){const alreadyFailed=outputFailed;outputFailed=true;stream.resume();if(!alreadyFailed)send({event:'error',message:'Managed producer failed'});}
}
const send=value=>{if(process.connected)process.send(value,()=>{});};
function signalOwned(signal='SIGKILL'){for(const pid of owned.keys()){if(signaled.has(pid))continue;try{process.kill(-pid,signal);if(signal==='SIGKILL')signaled.add(pid);}catch(error){if(error.code==='ESRCH')signaled.add(pid);else throw error;}}}
async function stop(){
 if(closing)return;closing=true;
 if(credit){outputFailed=true;const pending=credit;credit=undefined;pending.reject(Error('Owned output channel closed'));child?.stdout.resume();}
 try{signalOwned();}catch(error){closing=false;send({event:'error',message:'Owned cancellation remains pending: '+error.code});return;}
 await childClosed;owned.clear();await manager?.reset();process.disconnect?.();
}
process.on('disconnect',stop);process.on('SIGTERM',stop);
process.on('message',async message=>{try{
 if(message.type==='output-ack'){
  if(credit && credit.seq===message.seq){const pending=credit;credit=undefined;if(message.ok)pending.resolve();else{outputFailed=true;pending.reject(Error('Managed sink failed'));child?.stdout.resume();}}
 }else if(message.type==='init'){
  if(initialized)throw Error('Worker initialization is immutable');initialized=true;full=message.full;
  if(!full){({SandboxManager:manager}=await import(pathToFileURL(message.runtime)));const deps=manager.checkDependencies();if(!manager.isSupportedPlatform()||deps.errors?.length)throw Error('Unsupported macOS sandbox runtime');await manager.initialize(message.config,undefined,false);}
  send({event:'ready',proxyUrl:full?'':'http://srt:'+manager.getProxyAuthToken()+'@127.0.0.1:'+manager.getProxyPort()});
 }else if(message.type==='wrap'){
  if(!initialized||wrapped)throw Error('One command per worker');wrapped=true;
  const script=full?message.script:await manager.wrapWithSandbox(message.script,'/bin/bash');send({event:'wrapped',script});
 }else if(message.type==='execute'){
  if(!wrapped||child||closing)throw Error('Immutable worker already consumed');
  child=spawn('/bin/bash',['-c',message.script],{cwd:message.cwd,env:message.env,detached:true,stdio:['ignore','pipe','pipe']});
  const identity={pid:child.pid,token:randomUUID()};if(!identity.pid)throw Error('Missing trusted launch identity');
  owned.set(identity.pid,identity.token);
  childClosed=new Promise(resolve=>child.once('close',async code=>{clearTimeout(timer);await outputDone;send({event:'completed',code,timedOut,killed,outputFailed});resolve();}));
  child.once('error',error=>send({event:'error',message:String(error)}));
  child.once('exit',code=>{send({event:'process-exit',code,timedOut,killed});try{signalOwned();}catch(error){send({event:'error',message:'Owned group cleanup pending: '+error.code});}});
  if(message.managed){
    if(child.stdout.readableHighWaterMark>65536)throw Error('Unbounded managed producer buffer');
    outputDone=collect(child.stdout);let diagnosticBytes=0;child.stderr.on('data',bytes=>{diagnosticBytes+=bytes.length;if(diagnosticBytes<=65536)send({event:'diagnostic',text:bytes.toString()});});
  }else for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>{child[stream].pause();if(!process.connected){child[stream].resume();return;}process.send({event:'output',stream,data:bytes.toString('base64')},()=>child[stream].resume());});
  timer=setTimeout(()=>{timedOut=true;try{signalOwned();}catch(error){send({event:'error',message:'Owned timeout cancellation pending: '+error.code});}},message.timeoutMs);
  send({event:'launched',...identity});
 }else if(message.type==='cancel'){
  killed=true;try{if(message.graceMs>0&&child){signalOwned('SIGTERM');const force=setTimeout(()=>{try{signalOwned();}catch(error){send({event:'error',message:'Owned graceful cancellation pending: '+error.code});}},message.graceMs);childClosed.finally(()=>clearTimeout(force));}else signalOwned();send({event:'cancelled',ok:true});}catch(error){send({event:'cancelled',ok:false,message:'Owned cancellation pending: '+error.code});}
 }else if(message.type==='register'){
  if(!Number.isSafeInteger(message.pid)||message.pid<=1||typeof message.token!=='string')throw Error('Invalid trusted launch identity');
  owned.set(message.pid,message.token);send({event:'registered'});
 }else if(message.type==='release'){
  if(owned.get(message.pid)!==message.token)throw Error('Owned launch identity mismatch');owned.delete(message.pid);send({event:'released'});
 }else if(message.type==='stop')await stop();
}catch(error){send({event:'error',message:String(error)});await stop();}});`;

function kill(child: ChildProcess | undefined): void {
  if (child?.pid)
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
}
function message(child: ChildProcess, event: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", receive);
      child.off("exit", exit);
      child.off("error", error);
    };
    const receive = (m: unknown) => {
      const value = m as Record<string, unknown>;
      if (value.event === "error") {
        cleanup();
        reject(new SandboxPermissionUnsupportedError(String(value.message)));
      } else if (value.event === event) {
        cleanup();
        resolve(value);
      }
    };
    const exit = () => {
      cleanup();
      reject(
        new SandboxPermissionUnsupportedError(
          "Immutable worker exited before private IPC readiness",
        ),
      );
    };
    const error = (e: Error) => {
      cleanup();
      reject(e);
    };
    child.on("message", receive);
    child.once("exit", exit);
    child.once("error", error);
  });
}
let userTempDir: string | undefined | null = null;
/** The canonical `DARWIN_USER_TEMP_DIR` of this user, looked up once; undefined when unknown. */
function macUserTempDir(): string | undefined {
  if (userTempDir !== null) return userTempDir;
  try {
    const out = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const dir = out.status === 0 ? out.stdout.trim() : "";
    userTempDir = dir ? realpathSync(dir) : undefined;
  } catch {
    userTempDir = undefined;
  }
  return userTempDir;
}
const PRIVATE_TMP_PREFIX = "capybara-op-";
/**
 * Removes the private temporary directories of device processes that are gone (named with the
 * owning process id; this process removes its own when each operation ends). Best effort.
 */
async function sweepPrivateTemps(base: string): Promise<void> {
  try {
    for (const name of await readdir(base)) {
      const pid = Number(/^capybara-op-(\d+)-[^/]+$/.exec(name)?.[1]);
      if (!pid || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      await rm(join(base, name), { recursive: true, force: true });
    }
  } catch {
    // a failed sweep only leaves empty scratch directories behind
  }
}
/** A separate process owns each immutable SRT manager; Full never enters that process. */
export async function startMacOperationWorker(
  request: MacWorkerRequest,
  signal: AbortSignal,
): Promise<MacWorkerHandle> {
  signal.throwIfAborted();
  if (process.platform !== "darwin")
    throw new SandboxPermissionUnsupportedError(
      "macOS operation workers are unavailable on this platform",
    );
  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((a, b) => {
    readyResolve = a;
    readyReject = b;
  });
  void ready.catch(() => {});
  let child: ChildProcess | undefined;
  let runtime: ChildProcess | undefined;
  let cancelled = false;
  let finished = false;
  let cancellationFailure: unknown;
  let registered: TrustedLaunchIdentity | undefined;
  let execStarted = false;
  let execCompleted = false;
  let cancellation: Promise<void> | undefined;
  const files: FileHandle[] = [];
  const controller = new AbortController();
  const cancelExec = (graceMs: number) => {
    const worker = runtime;
    if (!worker?.connected) return;
    cancellationFailure = undefined;
    cancellation = message(worker, "cancelled")
      .then((result) => {
        if (result.ok !== true) throw new Error(String(result.message));
      })
      .catch((error) => {
        cancellationFailure = error;
        throw error;
      });
    void cancellation.catch(() => {});
    worker.send({ type: "cancel", graceMs });
  };
  const abort = () => {
    if (finished || cancelled) return;
    cancelled = true;
    controller.abort(signal.reason);
    if (execStarted && runtime?.connected) cancelExec(0);
    else {
      try {
        kill(child);
      } catch (error) {
        cancellationFailure = error;
        request.onDiagnostic?.(`Owned group ${child?.pid}: ${(error as Error).message}`);
      }
      if (!child && runtime) runtime.kill("SIGTERM");
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let sealed: SealedRuntime | undefined;
  let privateTmp: string | undefined;
  const completion = (async () => {
    try {
      // Restricted workers import only the sealed private copy of the verified runtime closure
      // the binding attested; anything else is refused here, before anything is spawned.
      if (!request.grant.full) sealed = await acquireSealedRuntime(request.runtimeHash);
      const runtimeEntry = sealed?.entry ?? "";
      // sandboxed JVMs load the staged agent: readable inside the sandbox, and named explicitly so
      // the runtime never looks for a global install of it
      const javaAgent = sealed?.stagedFile(JAVA_PROXY_AGENT_JAR);
      const helper =
        request.kind === "native" ? await stageRuntimeSource(request.stateDir) : undefined;
      const roots: PinnedNativeRoot[] = [];
      const rootAliases: { original: string; canonical: string }[] = [];
      if (request.kind === "native")
        for (const [access, paths] of [
          ["read", request.grant.readRoots],
          ["write", request.grant.writeRoots],
        ] as const) {
          for (const path of paths) {
            // Pin the nearest existing ancestor, then narrow using only trusted no-follow
            // components in the fixed helper. No ancestor is exposed as a file-access root.
            let anchor = path;
            const components: string[] = [];
            let canonicalAnchor: string;
            for (;;) {
              try {
                canonicalAnchor = await realpath(anchor);
                break;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT" || anchor === "/")
                  throw error;
                components.unshift(basename(anchor));
                anchor = dirname(anchor);
              }
            }
            const canonical = path.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");
            if (canonicalAnchor !== anchor.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1"))
              throw new SandboxScopeDeniedError(
                "Native grant root changed or contains an unpinned symlink",
              );
            rootAliases.push({ original: path, canonical });
            const file = await open(
              canonicalAnchor,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            files.push(file);
            const pinned = await file.stat();
            const current = await stat(canonicalAnchor);
            if (pinned.dev !== current.dev || pinned.ino !== current.ino)
              throw new Error("Pinned root changed during launch");
            roots.push({ path: canonical, fd: file.fd, access, components });
          }
        }
      // Version managers (asdf, nvm, pyenv, ...) read their data under the real home, while HOME
      // is the working directory: this trusted process has the real home and the device's own
      // environment (the forked worker runs with a reduced one), so it picks the variables and
      // grants their directories read only. Full access inherits this process's environment.
      const toolHomes =
        request.kind === "exec" && !request.grant.full
          ? restrictedToolHomes(
              request.toolHome?.home ?? homedir(),
              request.toolHome?.env ?? process.env,
              request.grant.deniedReadRoots,
            )
          : undefined;
      // A restricted command's own temporary directory (TMPDIR, TMP, TEMP): created empty for
      // this operation alone, private (0700) under the user's temporary directory, writable and
      // readable only inside the sandbox's grant, and removed once the operation's processes are
      // gone (a crashed device leaves it behind: the next launch removes it). The runtime's default (`/tmp/claude`) is shared by every command, so it is denied
      // (implicitWritePaths), and the user's temporary directory itself stays out of reach.
      if (request.kind === "exec" && !request.grant.full) {
        const base = macUserTempDir() ?? (await realpath(tmpdir()));
        await sweepPrivateTemps(base);
        privateTmp = await mkdtemp(join(base, `${PRIVATE_TMP_PREFIX}${process.pid}-`));
      }
      let wrap = async (script: string) => script;
      {
        const source = await stagePrivateSource(request.stateDir, "mac-worker.mjs", WORKER);
        runtime = fork(source, [], {
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        });
        const runtimeRoots = roots.length
          ? roots.map((r) => r.path)
          : [...request.grant.readRoots, ...request.grant.writeRoots];
        // Every read is denied from `/` down; only the grant, the system roots, the staged
        // helper and agent and the tool homes come back (mac-read-policy.ts). Ancestors get no
        // read rule: directory metadata is all traversal needs, and a subtree rule on one would
        // expose everything beneath it.
        // A native root pinned at an existing ancestor names the missing directories between
        // them: the fixed helper opens each one it creates or meets, so those are read exactly.
        const pinnedComponents = roots.flatMap((r) => {
          const dirs: string[] = [];
          for (let i = 1, p = dirname(r.path); i < (r.components?.length ?? 0); i++, p = dirname(p))
            dirs.push(p);
          return dirs;
        });
        const reads = macReadAllows({
          roots: [
            ...runtimeRoots,
            ...(privateTmp ? [privateTmp] : []),
            ...(toolHomes?.readRoots ?? []),
          ],
          exact: [
            ...pinnedComponents,
            ...(helper ? [helper] : []),
            ...(javaAgent ? [javaAgent] : []),
            ...(toolHomes?.readFiles ?? []),
          ],
          deniedReadRoots: request.grant.deniedReadRoots,
          userTempDir: macUserTempDir(),
        });
        const writeRoots =
          request.kind === "native"
            ? roots.filter((r) => r.access === "write").map((r) => r.path)
            : [...request.grant.writeRoots, ...(privateTmp ? [privateTmp] : [])];
        // Only the fixed native helper may establish missing ancestor directories. Its
        // descriptor prelude creates exact components and passes only the final narrow
        // root to NativeFiles. SRT needs this transient subtree write exception because
        // its path filters cannot express mkdir-only access; arbitrary exec never gets it.
        const establishmentRoots =
          request.kind === "native" && request.native.method === "writeFile"
            ? roots
                .filter(
                  (r) =>
                    r.access === "write" &&
                    r.components?.length &&
                    (request.native.path.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1") ===
                      r.path ||
                      request.native.path
                        .replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1")
                        .startsWith(`${r.path}/`)),
                )
                .map((r) => {
                  let firstMissing = r.path;
                  for (let i = 1; i < (r.components?.length ?? 0); i++)
                    firstMissing = dirname(firstMissing);
                  return firstMissing;
                })
            : [];
        const config = {
          filesystem: {
            denyRead: ["/", ...request.grant.deniedReadRoots],
            allowRead: reads.allowRead,
            // patched runtime: exact `(literal …)` read allows, never the subtree below them
            allowReadExact: reads.allowReadExact,
            allowWrite: [
              ...writeRoots,
              ...establishmentRoots.map((path) => ({ path, literal: true })),
            ],
            denyWrite: [
              ...implicitWritePaths(),
              // Per-root deny entries pin every ancestor against creation in SRT.
              // The fixed helper has no rename API; retain global Git content denies
              // while it establishes a missing root without those ancestor pins.
              // the mandatory write denies shared with the Linux broker (one SDK source)
              ...(establishmentRoots.length
                ? mandatoryDenyPatterns("")
                : writeRoots.flatMap((r) => mandatoryDenyPatterns(r))),
            ],
            // the shared policy exactly (case-insensitive, gitdir allowlist, HEAD rules), as
            // ordered regex rules the patched runtime appends last (mac-write-policy.ts)
            writeRegexRules: establishmentRoots.length
              ? macWriteRegexRules("")
              : writeRoots.flatMap((r) => macWriteRootSpellings(r).flatMap(macWriteRegexRules)),
          },
          network: {
            allowedDomains: [...request.grant.hosts],
            deniedDomains: [],
            allowLocalBinding: false,
          },
          ...(javaAgent ? { javaAgentJarPath: javaAgent } : {}),
        };
        const initialized = message(runtime, "ready");
        runtime.send({
          type: "init",
          full: request.grant.full,
          runtime: runtimeEntry,
          config,
        });
        const initializedInfo = await initialized;
        // the worker has imported the runtime: the copy may be pruned from now on
        sealed?.release();
        await request.onRuntimeReady?.({
          pid: runtime.pid as number,
          proxyUrl: String(initializedInfo.proxyUrl),
        });
        const worker = runtime;
        wrap = async (script) => {
          const response = message(worker, "wrapped");
          worker.send({ type: "wrap", script });
          return String((await response).script);
        };
      }
      controller.signal.throwIfAborted();
      const recordLaunch = async (pid: number) => {
        const identity = { pid, token: randomUUID() };
        if (!runtime) throw new Error("Missing private supervisor");
        const ack = message(runtime, "registered");
        runtime.send({ type: "register", ...identity });
        await ack;
        registered = identity;
        await request.onLaunch(identity);
      };
      if (request.kind === "native") {
        // Obtain the fixed wrapper before spawn; roots remain open in this trusted parent.
        const launch = {
          pythonPath: request.pythonPath,
          helperPath: helper as string,
        };
        // The transport's spawn callback is synchronous, so prepare its exact fixed invocation once.
        let prepared: string | undefined;
        const transport = await import("./native-helper-client.js");
        const invocation = transport.nativeHelperInvocation(roots, launch);
        prepared = await wrap([invocation.command, ...invocation.args].map(shellQuote).join(" "));
        return await runNativeHelper(
          {
            ...request.native,
            path: (() => {
              const alias = rootAliases
                .filter(
                  (r) =>
                    request.native.path === r.original ||
                    request.native.path.startsWith(`${r.original}/`),
                )
                .sort((a, b) => b.original.length - a.original.length)[0];
              return alias
                ? alias.canonical + request.native.path.slice(alias.original.length)
                : request.native.path;
            })(),
          },
          roots,
          {
            ...launch,
            ...(request.onDiagnostic ? { onDiagnostic: request.onDiagnostic } : {}),
            spawn: (_command, _args, opts) => {
              child = spawn("/bin/bash", ["-c", prepared as string], {
                ...opts,
                cwd: "/",
                env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
              });
              return child;
            },
            onLaunch: recordLaunch,
            beforeDispatch: async () => {
              await request.beforeLaunch();
              readyResolve();
            },
          },
          controller.signal,
        );
      }
      const args = request.args;
      for (const key of Object.keys(args.env ?? {}))
        if (!ENV_NAME_RE.test(key)) throw new Error("Invalid environment variable name");
      const outerEnv = {
        ...toolHomes?.env,
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        HOME: args.cwd ?? "/",
        TMPDIR: privateTmp ?? request.grant.writeRoots[0] ?? "/tmp",
      };
      // the runtime's wrapper sets its own TMPDIR after this environment: set ours inside it
      const temp = privateTmp
        ? `export TMPDIR=${shellQuote(privateTmp)} TMP=${shellQuote(privateTmp)} TEMP=${shellQuote(privateTmp)}; `
        : "";
      const exports = Object.entries(args.env ?? {})
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        .join("; ");
      const script = await wrap(
        `${temp}${!request.grant.full && exports ? `${exports}; ` : ""}exec /bin/bash -c ${shellQuote(args.command)}${request.managedOutput ? " 2>&1" : ""}`,
      );
      await request.beforeLaunch();
      controller.signal.throwIfAborted();
      const cap = new OutputCap(args.maxOutputBytes);
      const worker = runtime;
      if (!worker) throw new Error("Missing private supervisor");
      const launched = message(worker, "launched");
      const completed = message(worker, "completed");
      void launched.catch(() => {});
      void completed.catch(() => {});
      let outputPending: Promise<void> | undefined;
      let outputFault: unknown;
      const onOutput = (message: unknown) => {
        const item = message as {
          event: string;
          stream: "stdout" | "stderr";
          data: string;
          seq: number;
          text: string;
          frameBytes: number;
          bufferedBytes: number;
          producerLimit: number;
        };
        if (item.event === "output-flow") {
          request.onOutputFlow?.(item);
          return;
        }
        if (item.event === "cancelled" || item.event === "process-exit") {
          request.onControl?.(item.event);
          return;
        }
        if (item.event === "diagnostic") {
          request.onDiagnostic?.(item.text);
          return;
        }
        if (item.event !== "output") return;
        const bytes = Buffer.from(item.data, "base64");
        if (!request.managedOutput) {
          cap.push(item.stream, bytes);
          void request.onOutput?.(bytes, item.stream);
          return;
        }
        const ack = (ok: boolean) => {
          if (worker.connected) worker.send({ type: "output-ack", seq: item.seq, ok });
        };
        if (outputPending || bytes.length > 65536 || outputFault) {
          outputFault = Error("Managed output credit violation");
          ack(false);
          return;
        }
        cap.push("stdout", bytes);
        outputPending = Promise.resolve()
          .then(() => request.onOutput?.(bytes, "stdout"))
          .then(
            () => ack(true),
            (error) => {
              outputFault = error;
              ack(false);
            },
          )
          .finally(() => {
            outputPending = undefined;
          });
      };
      worker.on("message", onOutput);
      execStarted = true;
      worker.send({
        type: "execute",
        script,
        cwd: args.cwd,
        env: request.grant.full ? { ...process.env, ...args.env } : outerEnv,
        timeoutMs: args.timeoutMs,
        managed: request.managedOutput !== undefined,
      });
      try {
        const identity = await launched;
        registered = { pid: Number(identity.pid), token: String(identity.token) };
        await request.onLaunch(registered);
        readyResolve();
        const result = await completed;
        await outputPending;
        execCompleted = true;
        if (outputFault || result.outputFailed)
          throw outputFault ?? Error("Managed output stream failed");
        return {
          exitCode: result.killed || result.timedOut ? null : (result.code as number | null),
          stdout: cap.text("stdout"),
          stderr: cap.text("stderr"),
          truncated: cap.truncated,
          timedOut: result.timedOut === true,
        };
      } finally {
        worker.off("message", onOutput);
      }
    } catch (e) {
      readyReject(e);
      throw e;
    } finally {
      finished = true;
      sealed?.release();
      signal.removeEventListener("abort", abort);
      kill(child);
      await Promise.all(files.map((f) => f.close()));
      if (runtime) {
        const worker = runtime;
        if (worker.connected) {
          if (registered && (request.kind !== "exec" || execCompleted)) {
            const released = message(worker, "released");
            worker.send({ type: "release", ...registered });
            await released;
          }
          const ended = new Promise<void>((r) => worker.once("exit", () => r()));
          worker.send({ type: "stop" });
          await ended;
        } else if (worker.exitCode === null) worker.kill("SIGTERM");
      }
      // the sandbox keeps git's sequencer directory (it may hold a kept HEAD) from being removed
      // by the command; once the command is gone, the trusted worker removes it where empty
      if (request.kind === "exec" && !request.grant.full && execStarted)
        removeEmptySequencers(request.grant.writeRoots, request.pythonPath, request.onDiagnostic);
      if (privateTmp)
        await rm(privateTmp, { recursive: true, force: true }).catch((error) =>
          request.onDiagnostic?.(`Private temporary directory: ${(error as Error).message}`),
        );
    }
  })();
  void completion.catch(() => {});
  const cancelAttempt = createCancellationAttempt(async (graceMs) => {
    if (execStarted && !execCompleted && !runtime?.connected)
      throw new Error("Private supervisor lost; owned cancellation remains pending");
    if (finished) return;
    cancellationFailure = undefined;
    if (execStarted) {
      cancelled = true;
      controller.abort("Owned cancellation");
      cancelExec(graceMs);
    } else {
      cancelled = false;
      abort();
    }
    await cancellation;
    if (cancellationFailure) throw cancellationFailure;
    await completion.catch(() => {});
  });
  return { ready, completion, cancel: async (_reason, graceMs = 0) => cancelAttempt(graceMs) };
}
