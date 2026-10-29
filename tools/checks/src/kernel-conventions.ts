import { join, posix, relative, sep } from "node:path";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
} from "./source.js";

/**
 * Kernel conventions residue check (nest kernel spec §2.2 and §2.4): the kernel does every concern
 * one way, and each removed pattern has a rule so it cannot come back. The rules (`kc-*`):
 *
 * - kc-transaction: `.transaction()` / `.startTransaction()`, `isTransaction`, `Transaction`
 *   types (also inside `KernelSchemaDb | Transaction` unions) and parameters named `trx` / `tx`
 *   outside `infra/database` (`@Transactional` + `KernelDb` + `afterCommit` instead);
 * - kc-lock: `pg_advisory*` / `pg_try_advisory*` outside the migrations (R9: a transaction-scoped
 *   `pg_advisory_xact_lock` is transaction semantics, like `FOR UPDATE`, and is allowed only inside a
 *   `@Transactional({ propagation: "mandatory" })` method of a dedicated lock provider, an
 *   `@Injectable` class named `*Lock`), `"NX"` / `SET … NX` outside `infra/lock`, and
 *   `setInterval` in a file importing ioredis outside `infra/` (a hand-rolled renewal timer;
 *   heuristic); `LockService` / `@WithLock` instead;
 * - kc-queue: BullMQ `new Worker` / `new Queue` / `new QueueEvents` and `upsertJobScheduler`
 *   outside `infra/queue` (`@Processor`, `BullModule.registerQueue`, `@LockedCron`; the
 *   extensions' `ctx.queue` is an exception);
 * - kc-wiring: `useFactory` / `useValue` providers in `kernel.module.ts` and the role and domain
 *   modules (outside `infra/`; the tokens of {@link KC_ALLOWED_FACTORY_TOKENS} in their own module
 *   aside, and an allowance that matches nothing fails as `kc-stale-exception`); constructing
 *   a provider class (`new <Name>Service(` or any kernel `@Injectable` class) outside `infra/`,
 *   also in the CLI (`apps/capybara/src`) and `packages/testing/src`; and duplicate instances: a
 *   class in the `providers` of more than one module (`@Module({ … })` or a dynamic module
 *   object), with provider lists followed and what cannot be followed reported as unconfirmable
 *   (see {@link checkDuplicateProviders});
 * - kc-late-binding: `forwardRef(` (outside {@link KC_FORWARD_REF_ALLOWLIST}) and `ModuleRef`
 *   `.get(` / `.resolve(` outside `infra/`. This is a proxy: late binding through a closure in
 *   general (a setter or a callback filled in after construction) is not statically checked;
 * - kc-inject: a constructor parameter without `@Inject…(` in an `@Injectable` / `@Controller` /
 *   `@Processor` / `@Catch` / `@Module` class or a guard (`implements CanActivate`): esbuild and
 *   tsx emit no decorator metadata;
 * - kc-cron: a bare `@Cron(` / `@Interval(` / `@Timeout(` outside `infra/schedule`, and a call of
 *   `@nestjs/schedule`'s `Cron` / `Interval` / `Timeout` there (a decorator held in a variable or
 *   passed to `applyDecorators`): fixed-period jobs are `@LockedCron`, config-period jobs
 *   `@LockedInterval` (run once across replicas);
 * - kc-decorator-host: a class using an infra method decorator lacks the property it reads
 *   (`@Transactional` → `txHost`, `@WithLock` → `lockService`, `@Cacheable` / `@CacheEvict` →
 *   `cacheService`, `@LockedCron` → `lockService` and `log`, `@LockedInterval` → those and
 *   `config`);
 * - kc-zod-pipe: `new ZodPipe(`, and `@Body()` / `@Query()` / `@Param()` on a parameter typed with
 *   a `createZodDto` class (`@ZBody` / `@ZQuery` / `@ZParam` validate it; heuristic);
 * - kc-facade: the `createKernel` facade and its `Kernel` type, anywhere (kernel, its tests,
 *   `@capybara-hq/testing`, the CLI);
 * - kc-legacy: the legacy graph's names ({@link LEGACY_NAMES}), in the same places;
 * - kc-config: `() => KernelConfig` closures outside `infra/config` (`KernelConfigService`);
 * - kc-cache: classes named `*Cache` outside `infra/cache`, and a read-through Redis cache (a
 *   `.get(k)` and a `.set(k, v, "EX" | "PX", …)` on the same key in one function, `v` not a
 *   constant marker and no `NX`; heuristic);
 *   `@Cacheable` / `@CacheEvict` instead;
 * - kc-rate-limit: `LoginRateLimiter` / `RATE_LIMITER` and Redis `incr` / `incrby` counters outside
 *   `infra/throttler` (`@nestjs/throttler`, `CredentialThrottler`);
 * - kc-health: `healthz` / `readyz` routes outside `infra/health` (`@nestjs/terminus`): a route
 *   decorator, `@Controller` or `x.get(path, handler)` whose path is one, also through a const
 *   string (in any scanned file, a property of a const object, a concatenation); a path of such a
 *   route that is not visible statically is reported as unconfirmable;
 * - kc-logger: module-level loggers (`createLogger(` / `createConfiguredLogger(` / `pino(` /
 *   `new Logger(` declared or assigned at module scope, or in a static class field) outside
 *   `log.ts`, `log-config.ts` and `infra/logging`;
 * - kc-process: process-wide listeners (`process.on` … on the process object, an alias of it,
 *   `node:process` or `globalThis.process`, also read by `["on"]`, destructured or imported by
 *   name; `installProcessGuards`, `handleShutdownSignals`) outside `infra/lifecycle`:
 *   `createKernelApp` installs none;
 * - kc-ported-header: a file that names octok-platform starts with the canonical header
 *   `// Ported from octok-platform <path> (owner-approved, 2026-10-28).`;
 * - kc-lock-in-tx / kc-side-effect-in-tx: see {@link checkTransactionalMethods} (ported from octok);
 * - kc-worker-only: a `@LockedCron` / `@LockedInterval` / `@Processor` provider is provided only by
 *   modules that only `WorkerModule` imports, transitively (see {@link checkWorkerOnly}).
 *
 * Names are resolved, not matched as text ({@link buildResolver}): every rule above that looks for
 * a decorator, a function or a class follows aliased imports (`import { Cron as C }`), re-exports,
 * namespace members and same-file aliases (`const p = process`), and reads a decorator held in a
 * variable (`const Svc = Injectable(); @Svc`). What stays out of reach, beyond the limits each
 * rule lists: a name passed through a function or stored in an object (`install(process)`,
 * `holder.p = process`), a logger or a decorator built by a function of the scanned code
 * (`const log = makeLog()`, `const Svc = () => Injectable()`: kc-inject's case fails at boot in
 * Nest), a schedule added through `SchedulerRegistry`, and `x.get(path)` registrations with a
 * path not visible statically and no handler argument (a `Map` or Redis `get` looks the same). A
 * name given values in several scopes of one file is read as all of them, which can only add.
 *
 * Exceptions ({@link KC_EXCEPTIONS}) are permanent and carry their reason; pending entries
 * ({@link KC_PENDING}) are the directories and files not converted yet, each with the number of
 * violations it may still hide (a ratchet): more fails with the violations listed, fewer fails as
 * "lower max", none fails as a stale entry (`kc-stale-pending`). A stale exception fails too
 * (`kc-stale-exception`). Both lists only shrink.
 */
export const KC_RULES = [
  "kc-transaction",
  "kc-lock",
  "kc-queue",
  "kc-wiring",
  "kc-late-binding",
  "kc-inject",
  "kc-cron",
  "kc-decorator-host",
  "kc-zod-pipe",
  "kc-facade",
  "kc-legacy",
  "kc-config",
  "kc-cache",
  "kc-rate-limit",
  "kc-health",
  "kc-logger",
  "kc-process",
  "kc-ported-header",
  "kc-lock-in-tx",
  "kc-side-effect-in-tx",
  "kc-worker-only",
] as const;
export type KcRule = (typeof KC_RULES)[number];

/**
 * A permanent exception: `path` (a file, or a directory ending in `/`), optionally only inside the
 * class, function or method `within`, and only for the finding whose message starts with `what`
 * (one entry of a list, say).
 */
export interface KcException {
  rule: KcRule;
  path: string;
  within?: string;
  what?: string;
  reason: string;
}

/** A directory (ending in `/`) or file not converted yet, and how many violations it may hide. */
export interface KcPendingEntry {
  path: string;
  max: number;
}

/** Rule → the directories and files not converted yet. */
export type KcPending = Partial<Record<KcRule, readonly KcPendingEntry[]>>;

/** A token one module may provide with `useFactory` / `useValue` (not a domain class). */
export interface KcFactoryAllowance {
  /** The token's identifier, exactly. */
  token: string;
  /** The module file that provides it (the allowance covers no other file). */
  path: string;
  reason: string;
}

export interface KcOptions {
  pending?: KcPending;
  exceptions?: readonly KcException[];
  /** Defaults to {@link KC_ALLOWED_FACTORY_TOKENS}. */
  factoryTokens?: readonly KcFactoryAllowance[];
}

export const KERNEL_SRC = "packages/kernel/src";

/** Outside the kernel source, where hand wiring (`new <provider>(`) must disappear too. */
export const WIRING_ROOTS: readonly string[] = ["apps/capybara/src", "packages/testing/src"];

/** Where the facade and the legacy names must disappear from: the kernel, its callers and their tests. */
export const FACADE_ROOTS = [
  "packages/kernel/src",
  "packages/kernel/test",
  "packages/testing/src",
  "packages/testing/test",
  "apps/capybara/src",
  "apps/capybara/test",
] as const;

/** Names of the temporary legacy graph (Phase 3 / 5 remove them; R2 for the test hooks). */
export const LEGACY_NAMES: ReadonlySet<string> = new Set([
  "legacyKernelView",
  "KERNEL_DB",
  "KERNEL_CONFIG",
  "API_DEPS",
  "ApiDeps",
  "registerFrom",
  "LEGACY_GRAPH",
  "LegacyGraph",
  "LegacyGraphModule",
  "createLegacyGraph",
  "KERNEL_TEST_HOOKS",
  "KernelTestHooks",
  // the Phase 3 bridges (rulings R7, R8): deleted with the legacy graph (Task 3.9)
  "ConvertedProviders",
  "LegacyPorts",
  "LegacyPortsModule",
  "LegacyPortValues",
  "legacyCurrentTrx",
]);

/**
 * Provider tokens a module may build with `useFactory` / `useValue` (not a domain class), each in
 * its one module. An allowance that matches no provider fails (`kc-stale-exception`): the list
 * only shrinks.
 */
export const KC_ALLOWED_FACTORY_TOKENS: readonly KcFactoryAllowance[] = [
  {
    token: "HEALTH_CHECKS",
    path: "packages/kernel/src/kernel.module.ts",
    reason: "the readiness checks are terminus indicators over the pool and Redis, not a class",
  },
  {
    token: "KERNEL_APP_OPTIONS",
    path: "packages/kernel/src/kernel.module.ts",
    reason:
      "the options the application was created with (logger, env, the named test seams): a value " +
      "from the caller, not a domain class",
  },
  {
    token: "RUN_QUOTA",
    path: "packages/kernel/src/runtime/runtime.module.ts",
    reason:
      "OrgQuota is one instance per key prefix (the org run quota; plan 3.6): the only domain " +
      "factory, one token per prefix",
  },
  {
    token: "EVAL_QUOTA",
    path: "packages/kernel/src/runtime/runtime.module.ts",
    reason:
      "OrgQuota is one instance per key prefix (the org eval quota; plan 3.6): the only domain " +
      "factory, one token per prefix",
  },
];

/** Files allowed to call `forwardRef(` (a module or provider cycle), each with its reason. Empty. */
export const KC_FORWARD_REF_ALLOWLIST: readonly { path: string; reason: string }[] = [];

export const KC_EXCEPTIONS: readonly KcException[] = [
  {
    rule: "kc-lock",
    path: "packages/kernel/src/db/migrator.ts",
    reason:
      "R4: the migration runner's session advisory lock serialises migrations on the database " +
      "itself, before Redis is part of the start sequence",
  },
  {
    rule: "kc-lock",
    path: "packages/kernel/src/extensions/migrate-lock.ts",
    reason:
      "R4: the extension migration runner's advisory lock serialises an extension's migrations " +
      "on the database itself, like the kernel migration runner's",
  },
  {
    rule: "kc-queue",
    path: "packages/kernel/src/ctx/queue.ts",
    reason:
      "ctx.queue is the extension contract: each extension's own BullMQ queues and workers, " +
      "created and closed with the extension's lifecycle (spec §2.4)",
  },
  {
    rule: "kc-cache",
    path: "packages/kernel/src/runtime/media-cache.ts",
    reason:
      "a per-run in-process LRU of immutable attachment bytes (keyed by etag), dropped with the " +
      "run; not shared state and not a Redis cache",
  },
  {
    rule: "kc-rate-limit",
    path: "packages/kernel/src/channels/supervisor.ts",
    within: "failed",
    reason:
      "the consecutive-failure counter that drives a channel connection's exponential backoff, " +
      "not a rate limit",
  },
  {
    rule: "kc-process",
    path: "packages/kernel/src/app.ts",
    within: "startBuiltKernelApp",
    reason:
      "startBuiltKernelApp is the start half of startKernelApp, the process entry `capybara " +
      "start` runs; it owns the signal handlers, createKernelApp installs none",
  },
  {
    rule: "kc-wiring",
    path: "packages/kernel/src/kernel.module.ts",
    within: "KernelAppOptionsModule",
    what: "the provider `options.overrides`",
    reason:
      "the application's `overrides` are KernelOverride values, `{ provide: <seam token>, " +
      "useValue }`, each checked against KERNEL_OVERRIDE_TOKENS before they are listed: a value, " +
      "never a class, so no second instance of one",
  },
  {
    rule: "kc-worker-only",
    path: "packages/kernel/src/kernel.module.ts",
    within: "KernelAppOptionsModule",
    what: "the provider `options.overrides`",
    reason:
      "the application's `overrides` are KernelOverride values, `{ provide: <seam token>, " +
      "useValue }`, each checked against KERNEL_OVERRIDE_TOKENS before they are listed: a value, " +
      "never a cron or a queue consumer",
  },
  {
    rule: "kc-ported-header",
    path: "packages/kernel/src/infra/schedule/locked-cron.decorator.ts",
    reason:
      "packages octok's two-layer cron pattern rather than porting one file, so its header names " +
      "the pattern (owner-approved)",
  },
];

/**
 * Not converted yet: a directory (ending with `/`) or file with the number of violations it may
 * still hide. The Nest refactor converted everything, so the map is empty and must stay empty:
 * the map and its stale check remain so a regression cannot be parked here quietly. Never add an
 * entry: more violations than `max` fail, and so do fewer (`kc-stale-pending`).
 */
export const KC_PENDING: KcPending = {};

// ---------------------------------------------------------------------------------------------
// Implementation

interface Hit {
  rule: KcRule;
  rel: string;
  line: number;
  message: string;
  within: string[];
}

interface FileInfo {
  rel: string;
  /** Path below `packages/kernel/src/`, or undefined outside the kernel source. */
  k: string | undefined;
  /** A non-test file of {@link WIRING_ROOTS}. */
  wiring: boolean;
  parsed: ParsedFile;
}

const MESSAGES: Record<KcRule, string> = {
  "kc-transaction":
    "explicit transaction outside infra/database: use @Transactional() with KernelDb (and afterCommit)",
  "kc-lock":
    "hand-rolled lock (pg advisory lock, SET NX or a renewal timer): use LockService / @WithLock",
  "kc-queue":
    "BullMQ queue, worker or scheduler built by hand: use @Processor, BullModule.registerQueue or @LockedCron",
  "kc-wiring":
    "hand wiring: domain classes are @Injectable providers listed in their module, injected with @Inject(Class)",
  "kc-inject":
    "constructor parameter without @Inject(...): esbuild / tsx emit no decorator metadata",
  "kc-decorator-host": "",
  "kc-zod-pipe":
    "per-parameter validation: use a createZodDto class with @ZBody / @ZQuery / @ZParam",
  "kc-facade":
    "the createKernel facade and its Kernel type are gone: build the application with createKernelApp / startKernelApp",
  "kc-late-binding":
    "late binding: inject the provider with @Inject(Class) (forwardRef / ModuleRef only for a listed cycle)",
  "kc-cron":
    "bare scheduler decorator: fixed-period jobs use @LockedCron (try once across replicas)",
  "kc-legacy": "legacy graph name: inject the domain provider instead",
  "kc-config": "config getter closure: inject KernelConfigService and call get()",
  "kc-cache": "ad-hoc cache: use @Cacheable / @CacheEvict (CacheService)",
  "kc-rate-limit":
    "hand-written rate limiter or counter: use @nestjs/throttler (@Throttled) or CredentialThrottler",
  "kc-health":
    "health route outside infra/health: the terminus HealthController owns /healthz and /readyz",
  "kc-logger": "module-level logger: inject KERNEL_LOGGER (KernelLogger)",
  "kc-process":
    "process-wide handler outside infra/lifecycle: only the process entry installs signal handlers and guards",
  "kc-ported-header":
    "a file ported from octok-platform starts with `// Ported from octok-platform <path> (owner-approved, 2026-10-28).`",
  "kc-lock-in-tx": "",
  "kc-side-effect-in-tx": "",
  "kc-worker-only":
    "a cron, interval or queue-consumer provider must be provided only by modules that only WorkerModule imports (transitively)",
};

const DECORATOR_HOSTS: Record<string, readonly string[]> = {
  Transactional: ["txHost"],
  WithLock: ["lockService"],
  Cacheable: ["cacheService"],
  CacheEvict: ["cacheService"],
  LockedCron: ["lockService", "log"],
  LockedInterval: ["lockService", "log", "config"],
};

const INJECTED_CLASS_DECORATORS = new Set([
  "Injectable",
  "Controller",
  "Processor",
  "Catch",
  "Module",
]);
const SCHEDULE_DECORATORS = new Set(["Cron", "Interval", "Timeout"]);
const TX_PARAM_NAMES = new Set(["trx", "tx"]);
const LOCK_DECORATORS = new Set(["WithLock", "LockedCron", "LockedInterval"]);
const BULLMQ_CLASSES = new Set(["Worker", "Queue", "QueueEvents"]);
const PROCESS_LISTENERS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
const PROCESS_INSTALLERS = new Set(["installProcessGuards", "handleShutdownSignals"]);
/** Decorators whose first argument is a route path (or prefix). */
const ROUTE_DECORATORS = new Set(["Get", "Head", "All", "Controller"]);
/** Fastify-style registrations: `app.get(path, handler)`, `app.route({ url })`. */
const ROUTE_METHODS = new Set(["get", "head", "all", "route"]);
const PROCESS_SOURCES: ReadonlySet<string> = new Set(["process", "node:process"]);
const HEALTH_PATH = /^\/?(?:healthz|readyz)$/;
const SET_NX = /\bset\b[^\n]*\bNX\b/i;
const PG_ADVISORY = /pg_(?:try_)?advisory/;
/** A transaction-scoped advisory lock and nothing session-level in the same text (R9). */
const PG_XACT = /pg_advisory_xact_lock/;

/**
 * R9: `pg_advisory_xact_lock` (released at COMMIT / ROLLBACK, transaction semantics like
 * `FOR UPDATE`) is allowed in a `@Transactional({ propagation: "mandatory" })` method of an
 * `@Injectable` class whose name ends with `Lock`: the caller's transaction holds it, and one
 * provider per lock owns it. Session-level advisory locks never qualify.
 */
function xactLockAllowed(value: string, anc: readonly Node[]): boolean {
  if (!PG_XACT.test(value) || /pg_(?:try_)?advisory_(?:lock|unlock)\b/.test(value)) return false;
  const method = [...anc].reverse().find((a) => a.type === "MethodDefinition");
  const cls = [...anc]
    .reverse()
    .find((a) => a.type === "ClassDeclaration" || a.type === "ClassExpression");
  if (!method || !cls) return false;
  if (!(nameOf(cls.id) ?? "").endsWith("Lock")) return false;
  if (!decoratorsOf(cls).some((d) => decoratorName(d) === "Injectable")) return false;
  return decoratorsOf(method).some((d) => {
    if (decoratorName(d) !== "Transactional") return false;
    const call = d.expression as Node;
    if (call.type !== "CallExpression") return false;
    const arg = (call.arguments as Node[])[0];
    if (arg?.type !== "ObjectExpression") return false;
    return (arg.properties as Node[]).some(
      (p) =>
        p.type === "Property" &&
        nameOf(p.key) === "propagation" &&
        (p.value as Node).type === "Literal" &&
        (p.value as Node).value === "mandatory",
    );
  });
}
/** A constant cache value (`"1"`, `DONE`): a marker or a dedupe key, not cached data. */
const isConstant = (n: Node | undefined) =>
  n === undefined ||
  n.type === "Literal" ||
  (n.type === "Identifier" && /^[A-Z][A-Z0-9_]*$/.test(n.name as string));
const CANONICAL_HEADER = /^Ported from octok-platform \S.*\(owner-approved, 2026-10-28\)\./;
const MODULE_LOGGER_FACTORIES = new Set(["createLogger", "createConfiguredLogger", "pino"]);

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

/** Depth-first walk that hands each node its ancestors (outermost first). */
function visit(node: unknown, fn: (n: Node, anc: readonly Node[]) => void, anc: Node[] = []): void {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, fn, anc);
    return;
  }
  if (!isNode(node)) return;
  fn(node, anc);
  anc.push(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" || k === "start" || k === "end") continue;
    if (typeof v === "object" && v !== null) visit(v, fn, anc);
  }
  anc.pop();
}

const nameOf = (n: unknown): string | undefined =>
  isNode(n) && (n.type === "Identifier" || n.type === "PrivateIdentifier")
    ? (n.name as string)
    : undefined;

/** The name a decorator is called by: `@X`, `@X(...)`, `@ns.X(...)`. */
function decoratorName(d: Node): string | undefined {
  let e = d.expression as Node;
  if (e.type === "CallExpression") e = e.callee as Node;
  if (e.type === "MemberExpression") return nameOf(e.property);
  return nameOf(e);
}

const decoratorsOf = (n: Node): Node[] => (n.decorators as Node[] | undefined) ?? [];

/** Non-computed member property name of a call's callee, and its object. */
function memberCall(call: Node): { object: Node; prop: string } | undefined {
  const callee = call.callee as Node;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  const prop = nameOf(callee.property);
  return prop === undefined ? undefined : { object: callee.object as Node, prop };
}

/** Names of the classes, functions and methods enclosing a node, outermost first. */
function enclosingNames(anc: readonly Node[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < anc.length; i++) {
    const a = anc[i] as Node;
    const next = anc[i + 1];
    if (
      a.type === "FunctionDeclaration" ||
      a.type === "ClassDeclaration" ||
      a.type === "ClassExpression"
    ) {
      const n = nameOf(a.id);
      if (n) out.push(n);
    } else if (
      (a.type === "MethodDefinition" || a.type === "PropertyDefinition" || a.type === "Property") &&
      next !== undefined &&
      next === a.value
    ) {
      const n = nameOf(a.key);
      if (n) out.push(n);
    } else if (a.type === "VariableDeclarator" && next !== undefined && next === a.init) {
      const n = nameOf(a.id);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Base type name of a parameter or property type annotation (`Foo<Bar> | null` → `Foo`). */
function typeName(annotation: unknown): string | undefined {
  if (!isNode(annotation)) return undefined;
  let t = annotation.typeAnnotation as Node | undefined;
  if (t?.type === "TSUnionType") t = (t.types as Node[])[0];
  if (t?.type !== "TSTypeReference") return undefined;
  return nameOf(t.typeName);
}

/** The identifier of a parameter (unwrapping parameter properties and defaults). */
function paramBinding(p: Node): Node {
  let b = p.type === "TSParameterProperty" ? (p.parameter as Node) : p;
  if (b.type === "AssignmentPattern") b = b.left as Node;
  return b;
}

function constructorOf(cls: Node): Node | undefined {
  return ((cls.body as Node).body as Node[]).find(
    (m) => m.type === "MethodDefinition" && m.kind === "constructor",
  );
}

/** Property names a class instance has: parameter properties, class fields and accessors. */
function memberNames(cls: Node): Set<string> {
  const names = new Set<string>();
  for (const m of (cls.body as Node).body as Node[]) {
    if (m.type === "PropertyDefinition" || m.type === "MethodDefinition") {
      const n = nameOf(m.key);
      if (n) names.add(n);
    }
  }
  const ctor = constructorOf(cls);
  for (const p of ((ctor?.value as Node | undefined)?.params as Node[] | undefined) ?? []) {
    if (p.type === "TSParameterProperty") {
      const n = nameOf(paramBinding(p));
      if (n) names.add(n);
    }
  }
  return names;
}

const within = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);

const toPosix = (p: string) => p.split(sep).join("/");

/**
 * Runs every rule on `root` (the repository root, or a fixture laid out like it). Pending entries
 * and exceptions default to {@link KC_PENDING} and {@link KC_EXCEPTIONS}.
 */
export function checkKernelConventions(root: string, opts: KcOptions = {}): Finding[] {
  const pending = opts.pending ?? KC_PENDING;
  const exceptions = opts.exceptions ?? KC_EXCEPTIONS;
  const factoryTokens = opts.factoryTokens ?? KC_ALLOWED_FACTORY_TOKENS;
  const usedFactoryTokens = new Set<KcFactoryAllowance>();
  const out: Finding[] = [];
  const files: FileInfo[] = [];

  for (const dir of FACADE_ROOTS) {
    const kernelSrc = dir === KERNEL_SRC;
    const wiring = WIRING_ROOTS.includes(dir);
    for (const { file, isTest } of listSourceFiles(join(root, dir))) {
      if ((kernelSrc || wiring) && isTest) continue;
      if (file.endsWith(".d.ts")) continue;
      const parsed = parseFile(file);
      if (isParseError(parsed)) {
        out.push(parsed);
        continue;
      }
      const rel = toPosix(relative(root, file));
      files.push({
        rel,
        k: kernelSrc ? rel.slice(KERNEL_SRC.length + 1) : undefined,
        wiring,
        parsed,
      });
    }
  }

  const kernelFiles = files.filter((f) => f.k !== undefined);
  const resolver = buildResolver(files.filter((f) => f.k !== undefined || f.wiring));
  const known = collectKnown(kernelFiles, resolver);
  const hits: Hit[] = [];
  for (const f of files) {
    scanFile(f, known, resolver, hits, { tokens: factoryTokens, used: usedFactoryTokens });
  }
  for (const f of kernelFiles) checkTransactionalMethods(f, known, resolver, hits);
  checkDuplicateProviders(resolver, hits);
  checkWorkerOnly(resolver, hits);

  // De-duplicate (rule, file, line), then apply exceptions and pending entries.
  const seen = new Set<string>();
  const usedException = new Set<KcException>();
  /** Pending entry → the violations it hides. */
  const hidden = new Map<KcPendingEntry, Finding[]>();
  const coveredBy = (p: string, rel: string) => (p.endsWith("/") ? rel.startsWith(p) : rel === p);
  for (const h of hits.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    const key = `${h.rule} ${h.rel}:${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ex = exceptions.find(
      (e) =>
        e.rule === h.rule &&
        coveredBy(e.path, h.rel) &&
        (e.within === undefined || h.within.includes(e.within)) &&
        (e.what === undefined || h.message.startsWith(e.what)),
    );
    if (ex) {
      usedException.add(ex);
      continue;
    }
    const finding = { file: join(root, h.rel), line: h.line, rule: h.rule, message: h.message };
    const pend = (pending[h.rule] ?? []).find((p) => coveredBy(p.path, h.rel));
    if (pend !== undefined) {
      hidden.set(pend, [...(hidden.get(pend) ?? []), finding]);
      continue;
    }
    out.push(finding);
  }

  const where = "KC_PENDING in tools/checks/src/kernel-conventions.ts";
  for (const [rule, entries] of Object.entries(pending) as [KcRule, readonly KcPendingEntry[]][]) {
    for (const p of entries) {
      const found = hidden.get(p) ?? [];
      if (found.length > p.max) {
        // The ratchet: a new violation under a pending path is reported like any other.
        for (const f of found) {
          out.push({
            ...f,
            message: `${f.message} (pending "${p.path}" allows ${p.max} ${rule}, found ${found.length})`,
          });
        }
      } else if (found.length < p.max) {
        out.push({
          file: join(root, p.path),
          line: 1,
          rule: "kc-stale-pending",
          message:
            found.length === 0
              ? `no ${rule} violation left here: remove "${p.path}" from ${where}`
              : `${found.length} ${rule} violation(s) left here: lower max for "${p.path}" to ${found.length} in ${where}`,
        });
      }
    }
  }
  for (const a of factoryTokens) {
    if (usedFactoryTokens.has(a)) continue;
    out.push({
      file: join(root, a.path),
      line: 1,
      rule: "kc-stale-exception",
      message: `the factory allowance for ${a.token} matches no useFactory / useValue provider here: remove it from KC_ALLOWED_FACTORY_TOKENS in tools/checks/src/kernel-conventions.ts`,
    });
  }
  for (const e of exceptions) {
    if (usedException.has(e)) continue;
    out.push({
      file: join(root, e.path),
      line: 1,
      rule: "kc-stale-exception",
      message: `the ${e.rule} exception${e.within ? ` (within ${e.within})` : ""}${e.what ? ` (${e.what})` : ""} matches nothing: remove it from KC_EXCEPTIONS in tools/checks/src/kernel-conventions.ts`,
    });
  }
  return out;
}

interface Known {
  /** `@Injectable` classes and every class whose name ends with `Service`, by name. */
  providers: Set<string>;
  /** `class X extends createZodDto(...)`. */
  dtos: Set<string>;
  /** class → methods decorated `@WithLock` / `@LockedCron`. */
  locked: Map<string, Set<string>>;
}

function classes(program: Node): Node[] {
  const out: Node[] = [];
  visit(program, (n) => {
    if (n.type === "ClassDeclaration" || n.type === "ClassExpression") out.push(n);
  });
  return out;
}

/** The resolved names of the decorators on a class, method or parameter. */
const decoratorNames = (r: Resolver, f: FileInfo, n: Node): string[] =>
  decoratorsOf(n).flatMap((d) => r.decorators(f, d.expression as Node));

function collectKnown(files: FileInfo[], r: Resolver): Known {
  const known: Known = { providers: new Set(), dtos: new Set(), locked: new Map() };
  for (const f of files) {
    for (const cls of classes(f.parsed.program)) {
      const name = nameOf(cls.id);
      if (!name) continue;
      if (decoratorNames(r, f, cls).includes("Injectable")) known.providers.add(name);
      const sup = cls.superClass ? unwrap(cls.superClass as Node) : undefined;
      if (sup?.type === "CallExpression" && r.callee(f, sup).includes("createZodDto")) {
        known.dtos.add(name);
      }
      for (const m of (cls.body as Node).body as Node[]) {
        if (m.type !== "MethodDefinition") continue;
        if (!decoratorNames(r, f, m).some((d) => LOCK_DECORATORS.has(d))) continue;
        const mn = nameOf(m.key);
        if (!mn) continue;
        const set = known.locked.get(name) ?? new Set<string>();
        set.add(mn);
        known.locked.set(name, set);
      }
    }
  }
  return known;
}

function scanFile(
  f: FileInfo,
  known: Known,
  r: Resolver,
  hits: Hit[],
  factory: { tokens: readonly KcFactoryAllowance[]; used: Set<KcFactoryAllowance> },
): void {
  const { parsed, rel, k } = f;
  const hit = (rule: KcRule, at: Node | number, anc: readonly Node[], message = MESSAGES[rule]) => {
    const line = typeof at === "number" ? at : parsed.lineOf(at.start);
    hits.push({ rule, rel, line, message, within: enclosingNames(anc) });
  };

  // kc-facade / kc-legacy: everywhere in scope.
  visit(parsed.program, (n, anc) => {
    if (n.type !== "Identifier") return;
    const name = n.name as string;
    if (name === "createKernel" || name === "Kernel") hit("kc-facade", n, anc);
    else if (LEGACY_NAMES.has(name)) hit("kc-legacy", n, anc, `${MESSAGES["kc-legacy"]} (${name})`);
  });
  const newProvider = (n: Node, anc: readonly Node[]) => {
    const callee = nameOf(n.callee);
    if (
      callee &&
      callee !== "Service" &&
      (callee.endsWith("Service") || known.providers.has(callee))
    ) {
      hit("kc-wiring", n, anc, `${MESSAGES["kc-wiring"]} (new ${callee})`);
    }
  };
  if (k === undefined) {
    if (f.wiring) {
      visit(parsed.program, (n, anc) => {
        if (n.type === "NewExpression") newProvider(n, anc);
      });
    }
    return;
  }

  const inInfra = within(k, "infra");
  const bullmq = new Set<string>();
  let importsIoredis = false;
  for (const s of parsed.program.body as Node[]) {
    if (s.type !== "ImportDeclaration") continue;
    const src = (s.source as Node).value;
    if (src === "ioredis") importsIoredis = true;
    if (src === "bullmq") {
      for (const sp of (s.specifiers as Node[]) ?? []) {
        if (sp.type === "ImportSpecifier" && BULLMQ_CLASSES.has(nameOf(sp.imported) ?? "")) {
          bullmq.add(nameOf(sp.local) as string);
        }
      }
    }
  }
  const isModuleFile = k === "kernel.module.ts" || (k.endsWith(".module.ts") && !inInfra);
  const moduleRefs = new Set<string>();
  visit(parsed.program, (n) => {
    if (n.type === "Identifier" && typeName(n.typeAnnotation) === "ModuleRef") {
      moduleRefs.add(n.name as string);
    }
  });
  const forwardRefAllowed = KC_FORWARD_REF_ALLOWLIST.some((a) => a.path === rel);
  const loggerHome = k === "log.ts" || k === "log-config.ts" || within(k, "infra/logging");

  // Read-through caches: per enclosing function, the keys read with .get and written with .set EX/PX.
  const cacheGets = new Map<Node, Set<string>>();
  const cacheSets: { fn: Node; key: string; node: Node; anc: Node[] }[] = [];
  const textOf = (n: Node) => parsed.source.slice(n.start, n.end);
  const fnOf = (anc: readonly Node[]): Node | undefined => {
    for (let i = anc.length - 1; i >= 0; i--) {
      const a = anc[i] as Node;
      if (/Function/.test(a.type)) return a;
    }
    return undefined;
  };

  visit(parsed.program, (n, anc) => {
    switch (n.type) {
      case "Identifier": {
        const name = n.name as string;
        if (name === "isTransaction" && !within(k, "infra/database")) hit("kc-transaction", n, anc);
        if (
          (name === "LoginRateLimiter" || name === "RATE_LIMITER") &&
          !within(k, "infra/throttler")
        ) {
          hit("kc-rate-limit", n, anc);
        }
        break;
      }
      case "TSTypeReference": {
        const tn = n.typeName as Node;
        const name = tn.type === "TSQualifiedName" ? nameOf(tn.right) : nameOf(tn);
        if (name === "Transaction" && !within(k, "infra/database")) hit("kc-transaction", n, anc);
        break;
      }
      case "TSFunctionType": {
        const params = n.params as Node[];
        const ret = typeName(n.returnType);
        if (params.length === 0 && ret === "KernelConfig" && !within(k, "infra/config")) {
          hit("kc-config", n, anc);
        }
        break;
      }
      case "Literal":
      case "TemplateElement": {
        const value =
          n.type === "Literal"
            ? typeof n.value === "string"
              ? n.value
              : undefined
            : ((n.value as { cooked: string | null }).cooked ?? undefined);
        if (value === undefined) break;
        if (PG_ADVISORY.test(value) && !within(k, "migrations") && !xactLockAllowed(value, anc)) {
          hit(
            "kc-lock",
            n,
            anc,
            PG_XACT.test(value)
              ? `${MESSAGES["kc-lock"]} (R9: pg_advisory_xact_lock only inside a @Transactional({ propagation: "mandatory" }) method of an @Injectable *Lock provider)`
              : MESSAGES["kc-lock"],
          );
        }
        if ((value === "NX" || SET_NX.test(value)) && !within(k, "infra/lock")) {
          hit("kc-lock", n, anc);
        }
        break;
      }
      case "NewExpression": {
        const callee = nameOf(n.callee);
        if (!callee) break;
        if (bullmq.has(callee) && !within(k, "infra/queue")) hit("kc-queue", n, anc);
        if (callee === "ZodPipe") hit("kc-zod-pipe", n, anc);
        if (!inInfra) newProvider(n, anc);
        break;
      }
      case "CallExpression": {
        const callee = nameOf(n.callee);
        const mc = memberCall(n);
        const fn = callee ?? mc?.prop;
        if (fn === "transaction" || fn === "startTransaction") {
          if (mc && !within(k, "infra/database")) hit("kc-transaction", n, anc);
        }
        if (mc?.prop === "upsertJobScheduler" && !within(k, "infra/queue")) hit("kc-queue", n, anc);
        if (callee === "forwardRef" && !forwardRefAllowed) hit("kc-late-binding", n, anc);
        if (mc && (mc.prop === "get" || mc.prop === "resolve") && !inInfra) {
          const holder =
            mc.object.type === "MemberExpression" ? nameOf(mc.object.property) : nameOf(mc.object);
          if (holder && (moduleRefs.has(holder) || /^moduleRef$/i.test(holder))) {
            hit("kc-late-binding", n, anc);
          }
        }
        if ((mc?.prop === "incr" || mc?.prop === "incrby") && !within(k, "infra/throttler")) {
          hit("kc-rate-limit", n, anc);
        }
        if (callee === "setInterval" && importsIoredis && !inInfra) hit("kc-lock", n, anc);
        const resolved = r.callee(f, n);
        if (!within(k, "infra/lifecycle")) {
          if (resolved.some((c) => PROCESS_INSTALLERS.has(c))) hit("kc-process", n, anc);
          // `import { on } from "node:process"`
          const c = unwrap(n.callee as Node);
          if (
            c.type === "Identifier" &&
            r
              .syms(f, c.name as string)
              .some((s) => PROCESS_SOURCES.has(s.source as string) && PROCESS_LISTENERS.has(s.name))
          ) {
            hit("kc-process", n, anc);
          }
        }
        if (!within(k, "infra/health")) checkRoute(n, anc, resolved);
        // `Cron(…)` called anywhere (held in a variable, passed to applyDecorators)
        if (
          !within(k, "infra/schedule") &&
          unwrap(n.callee as Node).type === "Identifier" &&
          r
            .syms(f, nameOf(unwrap(n.callee as Node)) as string)
            .some((s) => s.source === "@nestjs/schedule" && SCHEDULE_DECORATORS.has(s.name))
        ) {
          hit("kc-cron", n, anc);
        }
        if (mc && !inInfra) {
          const args = n.arguments as Node[];
          const fnNode = fnOf(anc);
          if (fnNode && args[0]) {
            if (mc.prop === "get") {
              const set = cacheGets.get(fnNode) ?? new Set<string>();
              set.add(textOf(args[0]));
              cacheGets.set(fnNode, set);
            } else if (mc.prop === "set") {
              const mode = args[2];
              const nx = args.some((a) => a.type === "Literal" && a.value === "NX");
              if (
                mode?.type === "Literal" &&
                (mode.value === "EX" || mode.value === "PX") &&
                !nx &&
                !isConstant(args[1])
              ) {
                cacheSets.push({ fn: fnNode, key: textOf(args[0]), node: n, anc: [...anc] });
              }
            }
          }
        }
        break;
      }
      case "ClassDeclaration":
      case "ClassExpression":
        checkClass(n, anc);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (within(k, "infra/database")) break;
        for (const p of n.params as Node[]) {
          const name = nameOf(paramBinding(p));
          if (name && TX_PARAM_NAMES.has(name)) {
            hit("kc-transaction", p, anc, `${MESSAGES["kc-transaction"]} (parameter ${name})`);
          }
        }
        break;
      case "Decorator":
        if (
          r.decorators(f, n.expression as Node).some((d) => SCHEDULE_DECORATORS.has(d)) &&
          !within(k, "infra/schedule")
        ) {
          hit("kc-cron", n, anc);
        }
        break;
      case "MemberExpression": {
        // process.on, p.on with `const p = process`, process["on"], proc.on with node:process
        if (within(k, "infra/lifecycle")) break;
        const prop = n.computed
          ? (n.property as Node).type === "Literal"
            ? ((n.property as Node).value as unknown)
            : undefined
          : nameOf(n.property);
        if (
          typeof prop === "string" &&
          PROCESS_LISTENERS.has(prop) &&
          isProcess(n.object as Node)
        ) {
          hit("kc-process", n, anc);
        }
        break;
      }
      case "VariableDeclarator": {
        // const { on } = process
        const id = n.id as Node;
        if (within(k, "infra/lifecycle") || id.type !== "ObjectPattern" || !n.init) break;
        if (!isProcess(n.init as Node)) break;
        const takes = (id.properties as Node[]).some(
          (p) => p.type === "RestElement" || PROCESS_LISTENERS.has(nameOf(p.key) ?? ""),
        );
        if (takes) hit("kc-process", n, anc);
        break;
      }
      case "Property":
        if (isModuleFile && !n.computed) {
          const key = nameOf(n.key);
          if (key !== "useFactory" && key !== "useValue") break;
          const owner = anc[anc.length - 1] as Node;
          const provide = ((owner.properties as Node[]) ?? []).find(
            (p) => p.type === "Property" && nameOf(p.key) === "provide",
          );
          if (!provide) break;
          const token = textOf(provide.value as Node);
          const allowed = factory.tokens.find((t) => t.token === token && t.path === f.rel);
          if (allowed) {
            factory.used.add(allowed);
            break;
          }
          hit("kc-wiring", n, anc, `${MESSAGES["kc-wiring"]} (${key} for ${token})`);
        }
        break;
    }
  });

  for (const s of cacheSets) {
    if (cacheGets.get(s.fn)?.has(s.key)) hit("kc-cache", s.node, s.anc);
  }

  // kc-logger: module-scope declarations and assignments, and static class fields.
  if (!loggerHome) {
    const isLogger = (value: unknown): boolean => {
      if (!isNode(value)) return false;
      const v = unwrap(value);
      if (v.type !== "CallExpression" && v.type !== "NewExpression") return false;
      const names = r.callee(f, v);
      return v.type === "CallExpression"
        ? names.some((c) => MODULE_LOGGER_FACTORIES.has(c))
        : names.includes("Logger");
    };
    for (const top of parsed.program.body as Node[]) {
      const decl =
        top.type === "ExportNamedDeclaration" || top.type === "ExportDefaultDeclaration"
          ? (top.declaration as Node | null)
          : top;
      if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations as Node[]) if (isLogger(d.init)) hit("kc-logger", d, []);
      } else if (decl?.type === "ExpressionStatement") {
        const e = unwrap(decl.expression as Node);
        if (e.type === "AssignmentExpression" && isLogger(e.right)) hit("kc-logger", e, []);
      }
    }
    for (const cls of classes(parsed.program)) {
      for (const m of (cls.body as Node).body as Node[]) {
        if (m.type === "PropertyDefinition" && m.static && isLogger(m.value)) {
          hit("kc-logger", m, []);
        }
      }
    }
  }

  // kc-ported-header
  if (parsed.comments.some((c) => c.value.includes("octok-platform"))) {
    const firstStatement = (parsed.program.body as Node[])[0]?.start ?? parsed.source.length;
    const header: string[] = [];
    for (const c of parsed.comments) {
      if (c.start >= firstStatement || c.type !== "Line") break;
      header.push(c.value.trim());
    }
    if (!CANONICAL_HEADER.test(header.join(" "))) hit("kc-ported-header", 1, []);
  }

  /** Whether an expression is the process object: `process`, an alias of it, `node:process`. */
  function isProcess(node: Node): boolean {
    const e = unwrap(node);
    if (e.type === "MemberExpression" && !e.computed) {
      const obj = nameOf(unwrap(e.object as Node));
      return (obj === "globalThis" || obj === "global") && nameOf(e.property) === "process";
    }
    if (e.type !== "Identifier") return false;
    const ns = r.names.get(f)?.namespaces.get(e.name as string);
    if (ns !== undefined) return PROCESS_SOURCES.has(ns as string);
    return r
      .syms(f, e.name as string)
      .some((s) =>
        s.source === undefined
          ? s.name === "process" && s.f !== undefined
          : PROCESS_SOURCES.has(s.source as string) && (s.isDefault || s.name === "process"),
      );
  }

  /**
   * kc-health: a route whose path is a health path, also through a const (in any scanned file) or
   * a concatenation of them. A path that is not visible statically is reported as unconfirmable for
   * route decorators and `@Controller`, and for `x.get(path, handler)`-style registrations.
   */
  function checkRoute(n: Node, anc: readonly Node[], resolved: string[]): void {
    const args = n.arguments as Node[];
    let path: Node | undefined;
    let strict = false;
    const decorator = resolved.find((c) => ROUTE_DECORATORS.has(c));
    const mc = memberCall(n);
    if (decorator) {
      path = args[0];
      strict = true;
      if (decorator === "Controller" && path && unwrap(path).type === "ObjectExpression") {
        const p = (unwrap(path).properties as Node[]).find(
          (q) => q.type === "Property" && !q.computed && nameOf(q.key) === "path",
        );
        path = p?.value as Node | undefined;
      }
    } else if (mc && ROUTE_METHODS.has(mc.prop)) {
      const first = args[0] && unwrap(args[0]);
      if (mc.prop === "route" && first?.type === "ObjectExpression") {
        const p = (first.properties as Node[]).find(
          (q) =>
            q.type === "Property" && !q.computed && ["url", "path"].includes(nameOf(q.key) ?? ""),
        );
        path = p?.value as Node | undefined;
        strict = true;
      } else {
        path = args[0];
        const last = args[args.length - 1];
        strict = args.length >= 2 && FUNCTION_TYPES.has(unwrap(last as Node).type);
      }
    }
    if (!path || path.type === "SpreadElement") return;
    const values = r.strings(f, path, anc);
    if (values === undefined) {
      if (strict) {
        hit(
          "kc-health",
          n,
          anc,
          "route path not visible statically, so kc-health cannot rule out /healthz or /readyz: write it as a literal or a const string",
        );
      }
      return;
    }
    if (values.some((v) => HEALTH_PATH.test(v))) hit("kc-health", n, anc);
  }

  function checkClass(cls: Node, anc: readonly Node[]): void {
    const name = nameOf(cls.id);
    const decorators = decoratorNames(r, f, cls);
    const implementsGuard = ((cls.implements as Node[] | undefined) ?? []).some(
      (i) => nameOf(i.expression) === "CanActivate",
    );
    const injected = implementsGuard || decorators.some((d) => INJECTED_CLASS_DECORATORS.has(d));
    const classAnc = [...anc, cls];

    if (injected) {
      const ctor = constructorOf(cls);
      for (const p of ((ctor?.value as Node | undefined)?.params as Node[] | undefined) ?? []) {
        if (decoratorNames(r, f, p).some((d) => d.startsWith("Inject"))) continue;
        hit("kc-inject", p, classAnc);
      }
    }

    if (name?.endsWith("Cache") && !within(k as string, "infra/cache")) hit("kc-cache", cls, anc);

    if (!within(k as string, "infra")) {
      const members = memberNames(cls);
      for (const m of (cls.body as Node).body as Node[]) {
        if (m.type !== "MethodDefinition") continue;
        for (const d of decoratorsOf(m)) {
          const dn = r.decorators(f, d.expression as Node).find((n) => DECORATOR_HOSTS[n]) ?? "";
          const missing = (DECORATOR_HOSTS[dn] ?? []).filter((p) => !members.has(p));
          if (missing.length > 0) {
            hit(
              "kc-decorator-host",
              d,
              classAnc,
              `@${dn} reads ${missing.map((p) => `this.${p}`).join(" and ")}: inject it under that name`,
            );
          }
        }
      }
    }

    for (const m of (cls.body as Node).body as Node[]) {
      if (m.type !== "MethodDefinition") continue;
      for (const p of ((m.value as Node).params as Node[]) ?? []) {
        const binding = paramBinding(p);
        const t = typeName(binding.typeAnnotation);
        if (!t || !known.dtos.has(t)) continue;
        if (decoratorNames(r, f, p).some((d) => ["Body", "Query", "Param"].includes(d))) {
          hit("kc-zod-pipe", p, classAnc);
        }
      }
    }
  }
}

// Ported from octok-platform scripts/check-lock-tx.ts (owner-approved, 2026-10-28).
// Adapted: oxc-parser instead of ts-morph, findings instead of a report file, exceptions in
// KC_EXCEPTIONS instead of ignore comments, and a second rule for side effects inside the
// transaction (octok's scripts/check-transactional.ts left those to "v1"; spec §2.2).
/**
 * Two rules on methods decorated `@Transactional` (controllers skipped, as in octok):
 *
 * - kc-lock-in-tx: the lock's critical section must contain the transaction's, or the lock is
 *   released before COMMIT and the uniqueness / idempotency it guards is silently bypassed:
 *   (A) `@Transactional` written above `@WithLock` on the same method (the transaction opens
 *   first); (B) the method calls a `@WithLock` / `@LockedCron` method of its own class
 *   (`this.m()`) or of an injected one (`this.field.m()`, the field's class read from its
 *   constructor parameter type); (C) it takes a lock directly (`this.lockService.acquire / run`).
 *   Like octok v0, calls are followed one level only.
 * - kc-transaction (callback wrapper): the method's body is one call of a function parameter
 *   (`return fn()` / `await fn()`): `db.transaction().execute(fn)` under another name; write a
 *   named `@Transactional` method with the work in its body instead;
 * - kc-side-effect-in-tx: the method enqueues (`<…queue…>.add / addBulk`), publishes on the bus
 *   (`<…bus…>.publish`) or calls Redis (`<…redis…>.*`) outside an `afterCommit(() => …)`
 *   callback: a rollback cannot take those back, and a consumer may run before COMMIT.
 */
function checkTransactionalMethods(f: FileInfo, known: Known, r: Resolver, hits: Hit[]): void {
  const { parsed, rel } = f;
  const textOf = (n: Node) => parsed.source.slice(n.start, n.end);
  const names = (n: Node) => r.decorators(f, n.expression as Node);
  for (const cls of classes(parsed.program)) {
    if (decoratorNames(r, f, cls).includes("Controller")) continue;
    const className = nameOf(cls.id) ?? "<anonymous>";
    const fieldTypes = new Map<string, string>();
    for (const p of ((constructorOf(cls)?.value as Node | undefined)?.params as Node[]) ?? []) {
      if (p.type !== "TSParameterProperty") continue;
      const b = paramBinding(p);
      const field = nameOf(b);
      const type = typeName(b.typeAnnotation);
      if (field && type) fieldTypes.set(field, type);
    }
    for (const m of (cls.body as Node).body as Node[]) {
      if (m.type !== "MethodDefinition") continue;
      const decs = decoratorsOf(m);
      const txIdx = decs.findIndex((d) => names(d).includes("Transactional"));
      if (txIdx < 0) continue;
      const methodName = nameOf(m.key) ?? "<computed>";
      const push = (rule: KcRule, at: Node, message: string) =>
        hits.push({
          rule,
          rel,
          line: parsed.lineOf(at.start),
          message,
          within: [className, methodName],
        });
      // A callback transaction: the body is one call of a function parameter
      const params = new Set(
        (((m.value as Node).params as Node[]) ?? [])
          .map((p) => nameOf(paramBinding(p)))
          .filter((n): n is string => n !== undefined),
      );
      const stmts = (((m.value as Node).body as Node | undefined)?.body as Node[]) ?? [];
      if (stmts.length === 1) {
        const only = stmts[0] as Node;
        let call = (only.type === "ReturnStatement" ? only.argument : only.expression) as
          | Node
          | undefined;
        if (call?.type === "AwaitExpression") call = call.argument as Node;
        const callee = call?.type === "CallExpression" ? nameOf(call.callee) : undefined;
        if (call && callee && (call.callee as Node).type === "Identifier" && params.has(callee)) {
          push(
            "kc-transaction",
            call,
            `@Transactional ${className}.${methodName} only calls its parameter ${callee}: a callback transaction (db.transaction().execute(fn) under another name); write a named @Transactional method with the work in its body`,
          );
        }
      }
      const lockIdx = decs.findIndex((d) => names(d).some((n) => LOCK_DECORATORS.has(n)));
      if (lockIdx > txIdx) {
        push(
          "kc-lock-in-tx",
          decs[txIdx] as Node,
          `@Transactional is above @${names(decs[lockIdx] as Node).find((n) => LOCK_DECORATORS.has(n))} on ${className}.${methodName}: the transaction opens first and the lock is released before COMMIT; put the lock decorator above`,
        );
      }
      visit((m.value as Node).body, (n, anc) => {
        if (n.type !== "CallExpression") return;
        const mc = memberCall(n);
        if (!mc) return;
        const obj = mc.object;
        // (B) this.m() / this.field.m()
        let target: string | undefined;
        if (obj.type === "ThisExpression") target = className;
        else if (
          obj.type === "MemberExpression" &&
          (obj.object as Node).type === "ThisExpression"
        ) {
          const field = nameOf(obj.property);
          target = field ? fieldTypes.get(field) : undefined;
        }
        if (target && known.locked.get(target)?.has(mc.prop)) {
          push(
            "kc-lock-in-tx",
            n,
            `@Transactional ${className}.${methodName} calls the locked ${target}.${mc.prop}: the lock is released before COMMIT; take the lock outside the transaction`,
          );
          return;
        }
        const objText = textOf(obj);
        // (C) a lock taken directly
        if (/lockService$/i.test(objText) && (mc.prop === "acquire" || mc.prop === "run")) {
          push(
            "kc-lock-in-tx",
            n,
            `@Transactional ${className}.${methodName} takes a lock inside the transaction: the lock is released before COMMIT; take it outside`,
          );
          return;
        }
        const effect =
          ((mc.prop === "add" || mc.prop === "addBulk") && /queue/i.test(objText)) ||
          (mc.prop === "publish" && /bus/i.test(objText)) ||
          /redis/i.test(objText);
        if (!effect) return;
        const deferred = anc.some(
          (a) =>
            a.type === "CallExpression" &&
            (nameOf(a.callee) === "afterCommit" || memberCall(a)?.prop === "afterCommit"),
        );
        if (deferred) return;
        push(
          "kc-side-effect-in-tx",
          n,
          `@Transactional ${className}.${methodName} calls ${objText}.${mc.prop}() inside the transaction: wrap it in afterCommit(() => …)`,
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Name resolution, shared by the rules

/** Wrappers that do not change what an expression is: parentheses and type assertions. */
const TRANSPARENT = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

function unwrap(n: Node): Node {
  let e = n;
  while (TRANSPARENT.has(e.type)) e = e.expression as Node;
  return e;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Parents under which an identifier is not a reference to a value (a type, a name, a key). */
const NON_VALUE_PARENTS = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "ExportSpecifier",
  "ExportAllDeclaration",
  "TSTypeReference",
  "TSQualifiedName",
  "TSTypeQuery",
  "TSInterfaceHeritage",
  "TSClassImplements",
]);

/** Whether an identifier, under `parent`, is a value reference (not a key, a member name or a type). */
function isValueRef(n: Node, parent: Node | undefined): boolean {
  if (!parent || NON_VALUE_PARENTS.has(parent.type)) return false;
  if (
    (parent.type === "ClassDeclaration" || parent.type === "ClassExpression") &&
    parent.id === n
  ) {
    return false;
  }
  if (parent.type === "MemberExpression" && parent.property === n && !parent.computed) return false;
  if (parent.type === "Property" && parent.key === n && !parent.computed) return false;
  return parent.type !== "MethodDefinition" && parent.type !== "PropertyDefinition";
}

/** The kernel's own code: a relative path or the kernel package (not a third-party namespace). */
const isKernelSource = (src: unknown) =>
  typeof src === "string" && (src.startsWith(".") || src.startsWith("@capybara-hq/kernel"));

/** A declared name: in a scanned file (`f`), or imported from outside the scanned files (`source`). */
interface Sym {
  name: string;
  f?: FileInfo;
  source?: unknown;
  /** A default import from outside the scanned files: `name` is the local name. */
  isDefault?: boolean;
}

/** What a file imports and exports, and the names it declares. */
interface FileNames {
  /** Import locals → the imported name (`default` for a default import) and the source. */
  imports: Map<string, { imported: string; source: unknown }>;
  /** Namespace import locals (`import * as ns`) → the source. */
  namespaces: Map<string, unknown>;
  /** Exported names → the local (or, with `source`, the re-exported) name. */
  exports: Map<string, { local: string; source?: unknown }>;
  /** Sources of `export * from`. */
  stars: unknown[];
  declared: Set<string>;
  /** Every value a name is given anywhere in the file (`const x = …`, `x = …`), unwrapped. */
  inits: Map<string, Node[]>;
  /** Function declarations, by name. */
  functions: Map<string, Node>;
}

/** A module definition: an `@Module({ … })` argument or a dynamic module object `{ module: X, … }`. */
interface ModuleDef {
  object: Node;
  name: string;
  f: FileInfo;
  /** The ancestors of `object`, outermost first. */
  anc: Node[];
}

/** What a provider list holds: classes by their declared names, or something not visible statically. */
type ProviderEntry =
  | { kind: "class"; names: string[]; f: FileInfo; node: Node }
  | { kind: "unknown"; f: FileInfo; node: Node; what: string };

type Resolver = ReturnType<typeof buildResolver>;

/**
 * Resolves names across the scanned files (the kernel source, the CLI and `@capybara-hq/testing`,
 * not tests). An identifier is followed through its file's import to the scanned file the relative
 * path names, through that file's re-exports (`export { X as Y } from`, `export *`) to the declared
 * name, and through same-file aliases (`const p = process`, `x = Y`). An import from outside the
 * scanned files (a package name) falls back to every declared name an alias of it may be, and keeps
 * its source.
 */
function buildResolver(files: FileInfo[]) {
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const names = new Map<FileInfo, FileNames>();
  /** Aliased exports anywhere (`export { X as Y }`), Y → every X: the fallback by name. */
  const aliasTargets = new Map<string, Set<string>>();
  const defaultExports: { f: FileInfo; line: number; local: string; source: unknown }[] = [];
  /** `export * as ns from` of kernel code. */
  const starAs: { f: FileInfo; line: number; name: string }[] = [];
  for (const f of files) {
    const fn: FileNames = {
      imports: new Map(),
      namespaces: new Map(),
      exports: new Map(),
      stars: [],
      declared: new Set(),
      inits: new Map(),
      functions: new Map(),
    };
    names.set(f, fn);
    const give = (name: string | undefined, value: unknown) => {
      if (!name || !isNode(value)) return;
      fn.inits.set(name, [...(fn.inits.get(name) ?? []), unwrap(value)]);
    };
    visit(f.parsed.program, (n) => {
      if (n.type === "VariableDeclarator") give(nameOf(n.id), n.init);
      else if (n.type === "AssignmentExpression" && n.operator === "=")
        give(nameOf(n.left), n.right);
      else if (n.type === "FunctionDeclaration") {
        const id = nameOf(n.id);
        if (id) fn.functions.set(id, n);
      }
    });
    for (const s of f.parsed.program.body as Node[]) {
      if (s.type === "ImportDeclaration") {
        const source = (s.source as Node).value;
        for (const sp of (s.specifiers as Node[]) ?? []) {
          const local = nameOf(sp.local);
          if (!local) continue;
          if (sp.type === "ImportSpecifier") {
            const imported = nameOf(sp.imported) ?? ((sp.imported as Node).value as string);
            fn.imports.set(local, { imported, source });
          } else if (sp.type === "ImportDefaultSpecifier") {
            fn.imports.set(local, { imported: "default", source });
          } else if (sp.type === "ImportNamespaceSpecifier") {
            fn.namespaces.set(local, source);
          }
        }
        continue;
      }
      if (s.type === "ExportAllDeclaration") {
        if (!s.exported) fn.stars.push((s.source as Node).value);
        else if (isKernelSource((s.source as Node).value)) {
          starAs.push({ f, line: f.parsed.lineOf(s.start), name: nameOf(s.exported) ?? "…" });
        }
        continue;
      }
      if (s.type === "ExportDefaultDeclaration") {
        const d = s.declaration as Node;
        const local = d.type === "Identifier" ? (d.name as string) : nameOf(d.id);
        if (local) {
          fn.exports.set("default", { local });
          if (d.type !== "Identifier") fn.declared.add(local);
          defaultExports.push({ f, line: f.parsed.lineOf(s.start), local, source: undefined });
        }
        continue;
      }
      const decl = s.type === "ExportNamedDeclaration" ? (s.declaration as Node | null) : s;
      if (decl) {
        const id = nameOf(decl.id);
        if (id) fn.declared.add(id);
        for (const d of (decl.declarations as Node[] | undefined) ?? []) {
          const v = nameOf(d.id);
          if (v) fn.declared.add(v);
        }
      }
      if (s.type !== "ExportNamedDeclaration") continue;
      const source = s.source ? (s.source as Node).value : undefined;
      for (const sp of (s.specifiers as Node[]) ?? []) {
        const local = nameOf(sp.local);
        const as = nameOf(sp.exported) ?? ((sp.exported as Node).value as string);
        if (!local || !as) continue;
        fn.exports.set(as, { local, source });
        if (as === "default") {
          defaultExports.push({ f, line: f.parsed.lineOf(sp.start), local, source });
        } else if (as !== local) {
          const set = aliasTargets.get(as) ?? new Set<string>();
          set.add(local);
          aliasTargets.set(as, set);
        }
      }
    }
  }
  const namesOf = (f: FileInfo) => names.get(f) as FileNames;

  /** The scanned file a relative import names (`./x.js` → `x.ts` or `x/index.ts`). */
  const target = (from: FileInfo, source: unknown): FileInfo | undefined => {
    if (typeof source !== "string" || !source.startsWith(".")) return undefined;
    const base = posix
      .normalize(posix.join(posix.dirname(from.rel), source))
      .replace(/\.(?:js|ts)$/, "");
    return byRel.get(`${base}.ts`) ?? byRel.get(`${base}/index.ts`);
  };
  /** A name from outside the scanned files: itself, and every declared name an alias of it may be. */
  const byName = (name: string): string[] => {
    const out = new Set([name]);
    for (const n of out) for (const t of aliasTargets.get(n) ?? []) out.add(t);
    return [...out];
  };
  const outside = (name: string, source: unknown): Sym[] =>
    byName(name).map((n) => ({ name: n, source }));
  /** The declared names `name`, as `f` exports it, refers to (through re-exports and barrels). */
  const fromExport = (f: FileInfo, name: string, seen: Set<string>): Sym[] => {
    const key = `${f.rel}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const fn = namesOf(f);
    const e = fn.exports.get(name);
    if (e) {
      if (e.source === undefined) return fromLocal(f, e.local, seen);
      const t = target(f, e.source);
      return t ? fromExport(t, e.local, seen) : outside(e.local, e.source);
    }
    if (fn.declared.has(name) || fn.imports.has(name)) return fromLocal(f, name, seen);
    const viaStars = fn.stars.flatMap((src) => {
      const t = target(f, src);
      return t ? fromExport(t, name, seen) : [];
    });
    return viaStars.length > 0 ? viaStars : [{ name }];
  };
  /** The declared names a file's own identifier refers to: its import, or its same-file aliases. */
  const fromLocal = (f: FileInfo, name: string, seen: Set<string>): Sym[] => {
    const key = `local ${f.rel}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const fn = namesOf(f);
    const imp = fn.imports.get(name);
    if (imp) {
      const t = target(f, imp.source);
      if (t) return fromExport(t, imp.imported, seen);
      return imp.imported === "default"
        ? [{ name, source: imp.source, isDefault: true }]
        : outside(imp.imported, imp.source);
    }
    const out: Sym[] = [{ name, f }];
    for (const v of fn.inits.get(name) ?? []) {
      if (v.type === "Identifier" && v.name !== name)
        out.push(...fromLocal(f, v.name as string, seen));
    }
    return out;
  };
  const symCache = new Map<string, Sym[]>();
  /** The declared names an identifier of `f` refers to; more than one through aliases or the fallback. */
  const syms = (f: FileInfo, name: string): Sym[] => {
    if (!names.has(f)) return [{ name, f }];
    const key = `${f.rel}#${name}`;
    let r = symCache.get(key);
    if (!r) {
      r = fromLocal(f, name, new Set());
      symCache.set(key, r);
    }
    return r;
  };
  const canon = (f: FileInfo, name: string): string[] => [
    ...new Set(syms(f, name).map((s) => s.name)),
  ];
  /** `ns.X` of a namespace import `ns` of `f`: the names X refers to; undefined when `ns` is not one. */
  const nsMember = (f: FileInfo, ns: string, prop: string): string[] | undefined => {
    if (!names.has(f)) return undefined;
    const fn = namesOf(f);
    if (!fn.namespaces.has(ns)) return undefined;
    const src = fn.namespaces.get(ns);
    const t = target(f, src);
    return [
      ...new Set((t ? fromExport(t, prop, new Set()) : outside(prop, src)).map((s) => s.name)),
    ];
  };
  /** The values the names an identifier refers to are given in their own files. */
  const valuesOf = (f: FileInfo, name: string): { f: FileInfo; value: Node }[] =>
    syms(f, name).flatMap((s) =>
      s.f && names.has(s.f)
        ? (namesOf(s.f).inits.get(s.name) ?? []).map((value) => ({ f: s.f as FileInfo, value }))
        : [],
    );
  /** The names a call's callee resolves to (`ns.X(…)`: the member name). */
  const callee = (f: FileInfo, call: Node): string[] => {
    const c = unwrap(call.callee as Node);
    if (c.type === "Identifier") return canon(f, c.name as string);
    if (c.type === "MemberExpression" && !c.computed) {
      const n = nameOf(c.property);
      return n ? [n] : [];
    }
    return [];
  };

  /**
   * The names of the decorators an expression applies: `@X`, `@X(…)`, `@ns.X(…)`, a decorator held
   * in a variable (`const P = Processor("q"); @P`) and decorator calls among the arguments
   * (`applyDecorators(Processor("q"))`). With `bodies`, also what a function of the scanned code
   * returns (`const Job = () => Processor("q"); @Job()`).
   */
  const decorators = (f: FileInfo, expr: Node, bodies = false, depth = 0): string[] => {
    const e = unwrap(expr);
    if (depth > 6) return [];
    if (e.type === "Identifier") {
      return [...canon(f, e.name as string), ...held(f, e, bodies, depth + 1)];
    }
    if (e.type === "CallExpression") {
      return [
        ...decorators(f, e.callee as Node, bodies, depth + 1),
        ...(e.arguments as Node[]).flatMap((a) => {
          const u = unwrap(a);
          if (u.type === "CallExpression") return decorators(f, u, bodies, depth + 1);
          return u.type === "Identifier" ? held(f, u, bodies, depth + 1) : [];
        }),
      ];
    }
    if (e.type === "MemberExpression" && !e.computed) {
      const prop = nameOf(e.property);
      if (!prop) return [];
      const obj = unwrap(e.object as Node);
      return (obj.type === "Identifier" && nsMember(f, obj.name as string, prop)) || [prop];
    }
    return [];
  };
  /** What a name holding a decorator applies (and, with `bodies`, what a function of ours returns). */
  const held = (f: FileInfo, id: Node, bodies: boolean, depth: number): string[] => {
    if (depth > 6) return [];
    const out: string[] = [];
    for (const s of syms(f, id.name as string)) {
      if (!s.f || !names.has(s.f)) continue;
      const sf = s.f;
      for (const v of namesOf(sf).inits.get(s.name) ?? []) {
        if (v.type === "CallExpression") out.push(...decorators(sf, v, bodies, depth + 1));
        else if (bodies && FUNCTION_TYPES.has(v.type)) out.push(...returned(sf, v, depth + 1));
      }
      const decl = namesOf(sf).functions.get(s.name);
      if (bodies && decl) out.push(...returned(sf, decl, depth + 1));
    }
    return out;
  };
  const returned = (f: FileInfo, fn: Node, depth: number): string[] => {
    const body = fn.body as Node;
    if (body.type !== "BlockStatement" && body.type !== "FunctionBody") {
      return decorators(f, body, true, depth);
    }
    const out: string[] = [];
    visit(body, (n) => {
      if (n.type === "ReturnStatement" && n.argument) {
        out.push(...decorators(f, n.argument as Node, true, depth));
      }
    });
    return out;
  };
  /** The decorators a call applies to its arguments: `Processor("q")(X)`, `P(X)` with P held. */
  const applied = (f: FileInfo, call: Node): string[] => {
    const c = unwrap(call.callee as Node);
    if (c.type === "CallExpression") return decorators(f, c, true);
    return c.type === "Identifier" ? held(f, c, false, 0) : [];
  };

  /** The string values an expression can have, or undefined when that is not visible statically. */
  const strings = (
    f: FileInfo,
    node: Node,
    anc: readonly Node[],
    depth = 0,
  ): string[] | undefined => {
    const e = unwrap(node);
    if (depth > 6) return undefined;
    if (e.type === "Literal") return typeof e.value === "string" ? [e.value] : undefined;
    if (e.type === "TemplateLiteral") {
      const quasis = e.quasis as Node[];
      const cooked = (quasis[0]?.value as { cooked: string | null } | undefined)?.cooked;
      return quasis.length === 1 && typeof cooked === "string" ? [cooked] : undefined;
    }
    if (e.type === "BinaryExpression" && e.operator === "+") {
      const l = strings(f, e.left as Node, anc, depth + 1);
      const r = strings(f, e.right as Node, anc, depth + 1);
      return l && r ? l.flatMap((a) => r.map((b) => a + b)) : undefined;
    }
    if (e.type === "ArrayExpression") {
      const parts = (e.elements as (Node | null)[]).map((el) =>
        el && el.type !== "SpreadElement" ? strings(f, el, anc, depth + 1) : undefined,
      );
      return parts.every((p) => p !== undefined) ? parts.flat() : undefined;
    }
    if (e.type === "Identifier") {
      if (paramOf(anc, e.name as string)) return undefined;
      const vs = valuesOf(f, e.name as string).filter((v) => v.value.type !== "Identifier");
      const all = vs.map((v) => strings(v.f, v.value, [], depth + 1));
      return all.length > 0 && all.every((s) => s !== undefined) ? all.flat() : undefined;
    }
    if (e.type === "MemberExpression" && !e.computed) {
      const obj = unwrap(e.object as Node);
      const prop = nameOf(e.property);
      if (obj.type !== "Identifier" || !prop) return undefined;
      const all = valuesOf(f, obj.name as string)
        .filter((v) => v.value.type === "ObjectExpression")
        .map((v) => {
          const p = (v.value.properties as Node[]).find(
            (q) => q.type === "Property" && !q.computed && nameOf(q.key) === prop,
          );
          return p ? strings(v.f, p.value as Node, [], depth + 1) : undefined;
        });
      return all.length > 0 && all.every((s) => s !== undefined) ? all.flat() : undefined;
    }
    return undefined;
  };

  // Module definitions
  const modules = new Set<string>();
  const defs: ModuleDef[] = [];
  const defByObject = new Map<Node, ModuleDef>();
  /** `@Module(…)` whose metadata is not an object visible statically. */
  const opaque: { f: FileInfo; node: Node; name: string; anc: Node[] }[] = [];
  const classList: { f: FileInfo; cls: Node; name: string; anc: Node[] }[] = [];
  const addDef = (d: ModuleDef) => {
    defs.push(d);
    defByObject.set(d.object, d);
  };
  for (const f of files) {
    visit(f.parsed.program, (n, anc) => {
      if (n.type === "ClassDeclaration" || n.type === "ClassExpression") {
        const name = nameOf(n.id);
        if (!name) return;
        classList.push({ f, cls: n, name, anc: [...anc] });
        for (const d of decoratorsOf(n)) {
          if (!decorators(f, d.expression as Node).includes("Module")) continue;
          if (f.k !== undefined) modules.add(name);
          const e = unwrap(d.expression as Node);
          const arg = e.type === "CallExpression" ? (e.arguments as Node[])[0] : undefined;
          if (e.type === "CallExpression" && arg === undefined) continue;
          const u = arg && unwrap(arg);
          if (u?.type === "ObjectExpression") {
            addDef({ object: u, name, f, anc: [...anc, n, d, e] });
            continue;
          }
          const literal =
            u?.type === "Identifier"
              ? valuesOf(f, u.name as string).filter((v) => v.value.type === "ObjectExpression")
              : [];
          if (literal.length === 1) {
            const h = literal[0] as { f: FileInfo; value: Node };
            addDef({ object: h.value, name, f: h.f, anc: [...anc, n, d, e] });
          } else {
            opaque.push({ f, node: d, name, anc: [...anc, n] });
          }
        }
        return;
      }
      if (n.type !== "ObjectExpression") return;
      const mod = (n.properties as Node[]).find(
        (p) => p.type === "Property" && !p.computed && nameOf(p.key) === "module",
      );
      if (!mod) return;
      const v = unwrap(mod.value as Node);
      let name: string | undefined;
      if (v.type === "Identifier") name = canon(f, v.name as string)[0];
      else if (v.type === "MemberExpression" && !v.computed) {
        const obj = unwrap(v.object as Node);
        const prop = nameOf(v.property);
        name =
          (prop && obj.type === "Identifier" && nsMember(f, obj.name as string, prop)?.[0]) || prop;
      }
      if (name) addDef({ object: n, name, f, anc: [...anc] });
    });
  }

  /** The innermost function around a node with a parameter `name`, and its position. */
  function paramOf(
    anc: readonly Node[],
    name: string,
  ): { fn: Node; index: number; fnAnc: Node[] } | undefined {
    for (let i = anc.length - 1; i >= 0; i--) {
      const a = anc[i] as Node;
      if (!FUNCTION_TYPES.has(a.type)) continue;
      const index = (a.params as Node[]).findIndex((p) => nameOf(paramBinding(p)) === name);
      if (index >= 0) return { fn: a, index, fnAnc: anc.slice(0, i) };
    }
    return undefined;
  }

  const snippet = (f: FileInfo, n: Node) => {
    const text = f.parsed.source.slice(n.start, n.end).replace(/\s+/g, " ");
    return `\`${text.length > 48 ? `${text.slice(0, 45)}…` : text}\``;
  };
  const unknown = (f: FileInfo, node: Node, what?: string): ProviderEntry => ({
    kind: "unknown",
    f,
    node,
    what: what ?? `the provider ${snippet(f, node)}`,
  });
  type Each = (f: FileInfo, node: Node, anc: readonly Node[], depth: number) => ProviderEntry[];

  /**
   * A parameter followed to the arguments of its function's calls, when the function is a
   * same-file, unexported function that is only ever called.
   */
  const passed = (
    f: FileInfo,
    at: Node,
    p: { fn: Node; index: number; fnAnc: Node[] },
    depth: number,
    each: Each,
  ): ProviderEntry[] => {
    const parent = p.fnAnc[p.fnAnc.length - 1];
    let id: Node | undefined;
    if (p.fn.type === "FunctionDeclaration") id = p.fn.id as Node | undefined;
    else if (parent?.type === "VariableDeclarator" && unwrap(parent.init as Node) === p.fn) {
      id = parent.id as Node;
    }
    const fnName = nameOf(id);
    const exported =
      p.fnAnc.some(
        (a) => a.type === "ExportNamedDeclaration" || a.type === "ExportDefaultDeclaration",
      ) ||
      [...namesOf(f).exports.values()].some((e) => e.source === undefined && e.local === fnName);
    const what = `${snippet(f, at)}, a parameter of ${fnName ?? "a function"} whose callers are not all visible here`;
    if (!fnName || exported) return [unknown(f, at, what)];
    const calls: { call: Node; anc: Node[] }[] = [];
    let escapes = false;
    visit(f.parsed.program, (n, anc) => {
      if (n.type !== "Identifier" || n.name !== fnName || n === id) return;
      const par = anc[anc.length - 1];
      if (!isValueRef(n, par)) return;
      if (par?.type === "CallExpression" && unwrap(par.callee as Node) === n) {
        calls.push({ call: par, anc: anc.slice(0, -1) });
      } else if (par?.type !== "ParenthesizedExpression") escapes = true;
    });
    if (escapes) return [unknown(f, at, what)];
    return calls.flatMap(({ call, anc }) => {
      const args = call.arguments as Node[];
      if (args.slice(0, p.index + 1).some((a) => a.type === "SpreadElement")) {
        return [unknown(f, call, what)];
      }
      const arg = args[p.index];
      return arg ? each(f, arg, [...anc, call], depth + 1) : [];
    });
  };

  /** The entries of a provider list (an array, a spread, a const or parameter holding one). */
  const listEntries: Each = (f, node, anc, depth) => {
    const n = unwrap(node);
    if (depth > 8) return [unknown(f, n)];
    switch (n.type) {
      case "ArrayExpression":
        return (n.elements as (Node | null)[]).flatMap((el) => {
          if (!el) return [];
          return el.type === "SpreadElement"
            ? listEntries(f, el.argument as Node, anc, depth + 1)
            : elementEntries(f, el, anc, depth);
        });
      case "ConditionalExpression":
        return [
          ...listEntries(f, n.consequent as Node, anc, depth + 1),
          ...listEntries(f, n.alternate as Node, anc, depth + 1),
        ];
      case "LogicalExpression":
        return n.operator === "&&"
          ? listEntries(f, n.right as Node, anc, depth + 1)
          : [
              ...listEntries(f, n.left as Node, anc, depth + 1),
              ...listEntries(f, n.right as Node, anc, depth + 1),
            ];
      case "Identifier": {
        const p = paramOf(anc, n.name as string);
        if (p) return passed(f, n, p, depth, listEntries);
        const vs = valuesOf(f, n.name as string).filter((v) => v.value.type !== "Identifier");
        if (vs.length === 0) return [unknown(f, n)];
        return vs.flatMap((v) => listEntries(v.f, v.value, [], depth + 1));
      }
      default:
        return [unknown(f, n)];
    }
  };
  /** One element of a provider list. */
  const elementEntries: Each = (f, node, anc, depth) => {
    const e = unwrap(node);
    const cls = (n: Node): ProviderEntry[] => {
      const u = unwrap(n);
      if (u.type === "Identifier") {
        const p = paramOf(anc, u.name as string);
        if (p) return passed(f, u, p, depth, (pf, pn, pa, pd) => elementEntries(pf, pn, pa, pd));
        return [{ kind: "class", names: canon(f, u.name as string), f, node: u }];
      }
      if (u.type === "MemberExpression" && !u.computed) {
        const obj = unwrap(u.object as Node);
        const prop = nameOf(u.property);
        const names = prop && obj.type === "Identifier" && nsMember(f, obj.name as string, prop);
        if (names) return [{ kind: "class", names, f, node: u }];
      }
      return [unknown(f, u)];
    };
    switch (e.type) {
      case "Identifier": {
        // a provider object held in a const: `const P = { provide: X, useClass: Y }`
        const objects = valuesOf(f, e.name as string).filter(
          (v) => v.value.type === "ObjectExpression",
        );
        if (objects.length > 0 && !paramOf(anc, e.name as string)) {
          return objects.flatMap((v) => elementEntries(v.f, v.value, [], depth + 1));
        }
        return cls(e);
      }
      case "MemberExpression":
        return cls(e);
      case "ObjectExpression": {
        const props = e.properties as Node[];
        if (props.some((p) => p.type === "SpreadElement")) return [unknown(f, e)];
        const useClass = props.find(
          (p) => p.type === "Property" && !p.computed && nameOf(p.key) === "useClass",
        );
        return useClass ? cls(useClass.value as Node) : [];
      }
      case "CallExpression": {
        if (!callee(f, e).includes("configuredProcessor")) return [unknown(f, e)];
        const base = (e.arguments as Node[])[0];
        return base && base.type !== "SpreadElement" ? cls(base) : [unknown(f, e)];
      }
      default:
        return [unknown(f, e)];
    }
  };
  /** What a module definition provides. */
  const providerEntries = (def: ModuleDef): ProviderEntry[] => {
    const props = def.object.properties as Node[];
    const spread = props.find((p) => p.type === "SpreadElement");
    if (spread) return [unknown(def.f, spread, `the module definition of ${def.name} (a spread)`)];
    const prop = props.find(
      (p) => p.type === "Property" && !p.computed && nameOf(p.key) === "providers",
    );
    if (!prop) return [];
    return listEntries(def.f, prop.value as Node, [...def.anc, def.object, prop], 0);
  };

  return {
    files,
    names,
    target,
    byName,
    fromExport,
    syms,
    canon,
    nsMember,
    valuesOf,
    callee,
    decorators,
    applied,
    strings,
    paramOf,
    defaultExports,
    starAs,
    modules,
    defs,
    defByObject,
    opaque,
    classList,
    providerEntries,
  };
}

/** Whether a decorator expression has a shape the resolver reads: `@X`, `@ns.X`, `@X(…)`. */
function plainDecorator(expr: Node): boolean {
  const e = unwrap(expr);
  if (e.type === "Identifier") return true;
  if (e.type === "MemberExpression") return !e.computed;
  return e.type === "CallExpression" && plainDecorator(e.callee as Node);
}

/**
 * kc-wiring, duplicate instances: each class is provided by one module (others import it), so a
 * class in the `providers` of two modules (`@Module({ providers })` or a dynamic module object
 * `{ module, providers }`; a bare class, `useClass` or `configuredProcessor(X, …)`) is reported at
 * every listing. Classes are resolved by name (aliased imports, re-exports, namespace members), and
 * lists are followed: a const array in any scanned file (`providers: LIST`, `[...LIST]`), a
 * conditional or `??` / `||` / `&&` of lists, and a parameter of a same-file, unexported function
 * that is only ever called (to the arguments of its calls). Reported as "cannot be confirmed
 * statically": any other list or element (a call, a member of a value, a conditional element, a
 * parameter of an exported function), `@Module(…)` metadata that is not an object visible
 * statically, and a subclass of a module (it inherits the module's metadata, so a second instance
 * of every provider).
 */
function checkDuplicateProviders(r: Resolver, hits: Hit[]): void {
  const listings = new Map<string, { rel: string; line: number; module: Node }[]>();
  const unconfirmable = (f: FileInfo, node: Node, within: string[], what: string) =>
    hits.push({
      rule: "kc-wiring",
      rel: f.rel,
      line: f.parsed.lineOf(node.start),
      message: `${what}: which classes it provides cannot be confirmed statically, so kc-wiring cannot rule out a second instance; list the provider classes by name (or in a const array)`,
      within,
    });
  for (const def of r.defs) {
    if (def.f.k === undefined) continue;
    const within = enclosingNames(def.anc);
    for (const e of r.providerEntries(def)) {
      if (e.kind === "unknown") {
        unconfirmable(e.f, e.node, within, e.what);
        continue;
      }
      for (const cls of e.names) {
        const at = { rel: e.f.rel, line: e.f.parsed.lineOf(e.node.start), module: def.object };
        listings.set(cls, [...(listings.get(cls) ?? []), at]);
      }
    }
  }
  for (const o of r.opaque) {
    if (o.f.k === undefined) continue;
    unconfirmable(o.f, o.node, enclosingNames(o.anc), `the @Module metadata of ${o.name}`);
  }
  for (const c of r.classList) {
    if (c.f.k === undefined || !c.cls.superClass) continue;
    const sup = unwrap(c.cls.superClass as Node);
    const base =
      sup.type === "Identifier"
        ? r.canon(c.f, sup.name as string).find((n) => r.modules.has(n))
        : undefined;
    if (!base) continue;
    hits.push({
      rule: "kc-wiring",
      rel: c.f.rel,
      line: c.f.parsed.lineOf(sup.start),
      message: `${c.name} extends the module ${base} and inherits its metadata, so every provider of ${base} gets a second instance: import ${base} instead`,
      within: enclosingNames([...c.anc, c.cls]),
    });
  }
  for (const [cls, at] of listings) {
    if (new Set(at.map((a) => a.module)).size < 2) continue;
    for (const a of at) {
      hits.push({
        rule: "kc-wiring",
        rel: a.rel,
        line: a.line,
        message: `${cls} is provided by ${at.length} modules, so it has as many instances: provide it in its own module and import that module`,
        within: [],
      });
    }
  }
}

/** The worker role's module: the root of the modules a cron or a queue consumer may live in. */
const WORKER_MODULE = "WorkerModule";
const SCHEDULED_DECORATORS = new Set(["LockedCron", "LockedInterval"]);
const JOB_DECORATORS = new Set([...SCHEDULED_DECORATORS, "Processor"]);

/**
 * kc-worker-only (spec §2: crons and queue consumers run on the worker role only). The worker-only
 * classes are those with a `@LockedCron` / `@LockedInterval` method, those decorated `@Processor`,
 * the first argument of every `configuredProcessor(…)` call (the base class that gets `@Processor`
 * on a subclass; the provider `configuredProcessor` returns is checked at each call, by that
 * argument, not in the factory's own body), and every subclass of one of them (the class and method metadata is inherited,
 * so a subclass is a job too). Each place such a class is provided (an array element, a `useClass`
 * value, a `configuredProcessor` argument) must lie in the definition of a worker-only module, else
 * it is reported (also when it lies in no module definition at all: what module the list ends up in
 * is not visible statically).
 *
 * A module is worker-only when it is `WorkerModule`, or when it is referenced at least once and
 * every reference to it is in the `imports` of a worker-only module (a reference in a module's
 * `exports` is neutral; any other reference, e.g. a CLI context's module list or `app.ts`, makes it
 * a module of every role). The set is the greatest fixpoint, so a cycle reached only from
 * `WorkerModule` is worker-only. References are read in the kernel source, the CLI and
 * `@capybara-hq/testing` (not in tests).
 *
 * Names are resolved, not matched as text ({@link buildResolver}): aliased imports, re-export
 * chains (the same alias exported by two barrels resolves by the import's source, whatever the scan
 * order), same-file aliases, `ns.X` of `import * as ns`. Decorators are resolved the same way,
 * also when held in a variable (`const P = Processor("q"); @P`), returned by a function of ours,
 * called by hand (`Processor("q")(X)`, `LockedCron(…)(X.prototype, …)`) or applied with
 * `Reflect.decorate([…], X)`.
 *
 * Reported as unconfirmable, because what they hand on is not visible statically: a namespace
 * import of kernel code used other than as `ns.X`; `export * as` of kernel code; a default export
 * of a module or a worker-only class (`export default X`, `export { X as default }`), which can be
 * imported under any name; a module or worker-only class renamed while destructuring
 * (`const { CycleA: C } = await import(…)`); a decorator expression of another shape
 * (`@(flag ? A : B)`); `Reflect.decorate` with a decorator list or target that is not visible; and,
 * in a module that is not worker-only, a provider list or element whose classes are not visible
 * (a call, a conditional element, a member of a value, a parameter of an exported function; the
 * lists kc-wiring follows are followed here too) or `@Module(…)` metadata that is not an object.
 *
 * Out of reach: a computed name (`mod[name]`), a dynamic `import()` whose result is used whole, a
 * class decorated through `Reflect.defineMetadata` / `SetMetadata` with Nest's own metadata keys,
 * and a subclass built by a mixin that receives no worker-only class by name. `useFactory` /
 * `useValue` building a job with `new` is kc-wiring's. Within these limits the approximation errs
 * one way only: a module some code path never imports outside the worker role may still be
 * reported, a module imported elsewhere is not missed.
 */
function checkWorkerOnly(r: Resolver, hits: Hit[]): void {
  const files = r.files;
  const unconfirmed = (
    rel: string,
    line: number,
    what: string,
    within: string[] = [],
    hint = "import worker-only modules and classes by their own names",
    unseen = "which modules it reaches",
  ) =>
    hits.push({
      rule: "kc-worker-only",
      rel,
      line,
      message: `${what}: ${unseen} cannot be confirmed statically, so kc-worker-only cannot check it; ${hint}`,
      within,
    });
  for (const s of r.starAs) unconfirmed(s.f.rel, s.line, `\`export * as ${s.name}\``);

  /** The class names a call argument names (`X`, or `X.prototype` for a method decorator). */
  const classArg = (f: FileInfo, arg: Node | undefined): string[] => {
    const a = arg && unwrap(arg);
    if (a?.type === "Identifier") return r.canon(f, a.name as string);
    if (
      a?.type === "MemberExpression" &&
      !a.computed &&
      nameOf(a.property) === "prototype" &&
      unwrap(a.object as Node).type === "Identifier"
    ) {
      return r.canon(f, unwrap(a.object as Node).name as string);
    }
    return [];
  };
  const isJob = (names: string[]) => names.some((n) => JOB_DECORATORS.has(n));

  // Worker-only classes and modules.
  const jobs = new Set<string>();
  const modules = r.modules;
  const decorate = (f: FileInfo, at: Node, decs: string[], target: Node | undefined) => {
    if (!isJob(decs)) return;
    const named = classArg(f, target);
    if (named.length === 0) {
      unconfirmed(
        f.rel,
        f.parsed.lineOf(at.start),
        "a job decorator applied to a class that is not named",
        [],
        "decorate worker-only classes with @",
      );
    }
    for (const b of named) jobs.add(b);
  };
  for (const f of files) {
    if (f.k === undefined) continue;
    for (const cls of classes(f.parsed.program)) {
      const members = ((cls.body as Node).body as Node[]).filter(
        (m) => m.type === "MethodDefinition" || m.type === "PropertyDefinition",
      );
      for (const d of [...decoratorsOf(cls), ...members.flatMap(decoratorsOf)]) {
        if (plainDecorator(d.expression as Node)) continue;
        unconfirmed(
          f.rel,
          f.parsed.lineOf(d.start),
          "a decorator expression",
          [],
          "write decorators as @Name or @Name(…)",
        );
      }
      const name = nameOf(cls.id);
      if (!name) continue;
      const decs = decoratorsOf(cls).flatMap((d) => r.decorators(f, d.expression as Node, true));
      const scheduled = members.some((m) =>
        decoratorsOf(m).some((d) =>
          r.decorators(f, d.expression as Node, true).some((n) => SCHEDULED_DECORATORS.has(n)),
        ),
      );
      if (scheduled || decs.includes("Processor")) jobs.add(name);
    }
    visit(f.parsed.program, (n) => {
      if (n.type !== "CallExpression") return;
      const args = n.arguments as Node[];
      // configuredProcessor(Base, …): Base gets @Processor on a subclass
      if (r.callee(f, n).includes("configuredProcessor")) {
        for (const b of classArg(f, args[0])) jobs.add(b);
      }
      // a decorator called by hand: Processor("q")(X), LockedCron(…)(X.prototype, "m", d), P(X)
      decorate(f, n, r.applied(f, n), args[0]);
      // Reflect.decorate([decorators], X[, key])
      const c = unwrap(n.callee as Node);
      if (
        c.type === "MemberExpression" &&
        !c.computed &&
        nameOf(c.property) === "decorate" &&
        nameOf(unwrap(c.object as Node)) === "Reflect"
      ) {
        const list = args[0] && unwrap(args[0]);
        const held =
          list?.type === "Identifier"
            ? r.valuesOf(f, list.name as string).filter((v) => v.value.type === "ArrayExpression")
            : [];
        const arrays =
          list?.type === "ArrayExpression" ? [{ f, value: list }] : held.length > 0 ? held : [];
        const elements = arrays.flatMap((a) =>
          (a.value.elements as (Node | null)[]).map((el) => ({ f: a.f, el })),
        );
        if (arrays.length === 0 || elements.some(({ el }) => !el || el.type === "SpreadElement")) {
          unconfirmed(
            f.rel,
            f.parsed.lineOf(n.start),
            "`Reflect.decorate` with a decorator list that is not visible",
            [],
            "decorate worker-only classes with @",
          );
          return;
        }
        const decs = elements.flatMap(({ f: ef, el }) => r.decorators(ef, el as Node, true));
        decorate(f, n, decs, args[1]);
      }
    });
  }
  // A subclass of a job is a job (fixpoint over superclasses; a mixin that receives a job by name).
  const supers = r.classList
    .filter((c) => c.f.k !== undefined && c.cls.superClass)
    .map((c) => {
      const sup = unwrap(c.cls.superClass as Node);
      const named = (n: Node): string[] => {
        const u = unwrap(n);
        if (u.type === "Identifier") return r.canon(c.f, u.name as string);
        if (u.type === "MemberExpression" && !u.computed) {
          const obj = unwrap(u.object as Node);
          const prop = nameOf(u.property);
          return (
            (prop && obj.type === "Identifier" && r.nsMember(c.f, obj.name as string, prop)) || []
          );
        }
        return [];
      };
      const bases =
        sup.type === "CallExpression" ? (sup.arguments as Node[]).flatMap(named) : named(sup);
      return { name: c.name, bases };
    });
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of supers) {
      if (jobs.has(s.name) || !s.bases.some((b) => jobs.has(b))) continue;
      jobs.add(s.name);
      changed = true;
    }
  }

  const watched = (n: string) => jobs.has(n) || modules.has(n);
  for (const d of r.defaultExports) {
    const t = d.source === undefined ? d.f : r.target(d.f, d.source);
    const declared = t
      ? d.source === undefined
        ? r.canon(t, d.local)
        : r.fromExport(t, d.local, new Set()).map((s) => s.name)
      : r.byName(d.local);
    const hit = declared.find(watched);
    if (hit) unconfirmed(d.f.rel, d.line, `the default export of ${hit}`);
  }
  // A watched name renamed while destructuring (`const { CycleA: C } = await import(…)`)
  for (const f of files) {
    visit(f.parsed.program, (n, anc) => {
      if (n.type !== "Property" || n.computed || anc[anc.length - 1]?.type !== "ObjectPattern")
        return;
      const key = nameOf(n.key);
      let v = n.value as Node;
      if (v.type === "AssignmentPattern") v = v.left as Node;
      const bound = nameOf(v);
      if (key && bound !== key && r.byName(key).some(watched)) {
        unconfirmed(f.rel, f.parsed.lineOf(n.start), `${key} destructured under another name`);
      }
    });
  }
  if (jobs.size === 0) return;

  /** The innermost module definition around a node and the property of it the node is under. */
  const enclosing = (
    anc: readonly Node[],
  ): { def: ModuleDef; key: string | undefined } | undefined => {
    for (let i = anc.length - 1; i >= 0; i--) {
      const def = r.defByObject.get(anc[i] as Node);
      if (!def) continue;
      const prop = anc[i + 1];
      return { def, key: prop?.type === "Property" ? nameOf(prop.key) : undefined };
    }
    return undefined;
  };

  // Every value reference, by the declared name it resolves to, with its place.
  const refs: {
    name: string;
    node: Node;
    parent: Node;
    at: { def: ModuleDef; key: string | undefined } | undefined;
    file: FileInfo;
    rel: string;
    line: number;
    /** Inside `configuredProcessor` itself, whose provider is checked at its calls (by `base`). */
    factory?: boolean;
  }[] = [];
  /**
   * A reference placed past the wrappers that do not change what it is (`X as Provider`,
   * `<Provider>X`, `X!`, `(X)`): the outermost wrapper and the node it sits in.
   */
  const placed = (n: Node, anc: readonly Node[]): { node: Node; parent: Node } => {
    let node = n;
    let i = anc.length - 1;
    while (i > 0 && TRANSPARENT.has((anc[i] as Node).type)) node = anc[i--] as Node;
    return { node, parent: anc[i] as Node };
  };
  for (const f of files) {
    const fn = r.names.get(f) as FileNames;
    visit(f.parsed.program, (n, anc) => {
      const parent = anc[anc.length - 1];
      if (n.type !== "Identifier" || !isValueRef(n, parent)) return;
      const line = f.parsed.lineOf(n.start);
      const ns = fn.namespaces.get(n.name as string);
      if (fn.namespaces.has(n.name as string)) {
        const p = parent as Node;
        // `ns.X`: a reference to X, placed where the member expression is
        if (p.type === "MemberExpression" && p.object === n && !p.computed) {
          const outer = anc.slice(0, -1);
          const at = enclosing(outer);
          for (const name of r.nsMember(f, n.name as string, nameOf(p.property) as string) ?? []) {
            refs.push({
              name,
              ...placed(p, outer),
              at,
              file: f,
              rel: f.rel,
              line,
            });
          }
        } else if (isKernelSource(ns)) {
          unconfirmed(f.rel, line, `the namespace import ${n.name as string} used as a value`);
        }
        return;
      }
      const at = enclosing(anc);
      const factory = anc.some(
        (a) => a.type === "FunctionDeclaration" && nameOf(a.id) === "configuredProcessor",
      );
      for (const name of r.canon(f, n.name as string)) {
        refs.push({ name, ...placed(n, anc), at, file: f, rel: f.rel, line, factory });
      }
    });
  }

  // Importers of each module: module names, or "?" for a reference outside a module's imports.
  const importers = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!modules.has(ref.name)) continue;
    const at = ref.at;
    if (at && at.def.name === ref.name && at.key === "module") continue; // its own definition
    if (at?.key === "exports") continue;
    const set = importers.get(ref.name) ?? new Set<string>();
    set.add(at?.key === "imports" ? at.def.name : "?");
    importers.set(ref.name, set);
  }
  const workerOnly = new Set(
    [...modules].filter((m) => m === WORKER_MODULE || (importers.get(m)?.size ?? 0) > 0),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of workerOnly) {
      if (m === WORKER_MODULE) continue;
      if ([...(importers.get(m) ?? [])].every((i) => workerOnly.has(i))) continue;
      workerOnly.delete(m);
      changed = true;
    }
  }

  for (const ref of refs) {
    if (!jobs.has(ref.name) || ref.factory) continue;
    const p = ref.parent;
    const provided =
      p.type === "ArrayExpression" ||
      (p.type === "Property" && nameOf(p.key) === "useClass") ||
      (p.type === "CallExpression" &&
        (p.arguments as Node[])[0] === ref.node &&
        r.callee(ref.file, p).includes("configuredProcessor"));
    if (!provided) continue;
    const at = ref.at;
    if (at && workerOnly.has(at.def.name)) continue;
    const outside = at
      ? [...(importers.get(at.def.name) ?? [])]
          .map((i) => (i === "?" ? "a reference outside a module's imports" : i))
          .join(", ") || "nothing"
      : undefined;
    hits.push({
      rule: "kc-worker-only",
      rel: ref.rel,
      line: ref.line,
      message: at
        ? `${ref.name} runs on the worker role only (a cron, interval or queue consumer), but ${at.def.name} is imported outside WorkerModule (by ${outside}): provide it in a module only WorkerModule imports`
        : `${ref.name} runs on the worker role only (a cron, interval or queue consumer), but this list is in no module definition, so its module cannot be confirmed statically: list it in the providers of a module only WorkerModule imports`,
      within: [],
    });
  }

  // A module that is not worker-only: every provider must be visible, or it may hide a job.
  const providesHint = "list provider classes by name (or in a const array)";
  for (const def of r.defs) {
    if (workerOnly.has(def.name)) continue;
    const within = enclosingNames(def.anc);
    for (const e of r.providerEntries(def)) {
      if (e.kind !== "unknown") continue;
      unconfirmed(
        e.f.rel,
        e.f.parsed.lineOf(e.node.start),
        `${e.what} in ${def.name}`,
        within,
        providesHint,
        "which classes it provides",
      );
    }
  }
  for (const o of r.opaque) {
    if (workerOnly.has(o.name)) continue;
    unconfirmed(
      o.f.rel,
      o.f.parsed.lineOf(o.node.start),
      `the @Module metadata of ${o.name}`,
      enclosingNames(o.anc),
      providesHint,
      "which classes it provides",
    );
  }
}
