import { join, relative, sep } from "node:path";
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
 *   modules (outside `infra/`; tokens in {@link KC_ALLOWED_FACTORY_TOKENS} aside); constructing
 *   a provider class (`new <Name>Service(` or any kernel `@Injectable` class) outside `infra/`,
 *   also in the CLI (`apps/capybara/src`) and `packages/testing/src`; and duplicate instances: a
 *   class in the `providers` of more than one module (`@Module({ … })` or a dynamic module
 *   object);
 * - kc-late-binding: `forwardRef(` (outside {@link KC_FORWARD_REF_ALLOWLIST}) and `ModuleRef`
 *   `.get(` / `.resolve(` outside `infra/`. This is a proxy: late binding through a closure in
 *   general (a setter or a callback filled in after construction) is not statically checked;
 * - kc-inject: a constructor parameter without `@Inject…(` in an `@Injectable` / `@Controller` /
 *   `@Processor` / `@Catch` / `@Module` class or a guard (`implements CanActivate`): esbuild and
 *   tsx emit no decorator metadata;
 * - kc-cron: a bare `@Cron(` / `@Interval(` / `@Timeout(` outside `infra/schedule`: fixed-period
 *   jobs are `@LockedCron` (run once across replicas);
 * - kc-decorator-host: a class using an infra method decorator lacks the property it reads
 *   (`@Transactional` → `txHost`, `@WithLock` → `lockService`, `@Cacheable` / `@CacheEvict` →
 *   `cacheService`, `@LockedCron` → `lockService` and `log`);
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
 * - kc-health: `healthz` / `readyz` routes outside `infra/health` (`@nestjs/terminus`);
 * - kc-logger: module-level loggers (`createLogger(` / `createConfiguredLogger(` / `pino(` /
 *   `new Logger(` at module scope) outside `log.ts`, `log-config.ts` and `infra/logging`;
 * - kc-process: process-wide listeners (`process.on` …, `installProcessGuards`,
 *   `handleShutdownSignals`) outside `infra/lifecycle`: `createKernelApp` installs none;
 * - kc-ported-header: a file that names octok-platform starts with the canonical header
 *   `// Ported from octok-platform <path> (owner-approved, 2026-10-28).`;
 * - kc-lock-in-tx / kc-side-effect-in-tx: see {@link checkTransactionalMethods} (ported from octok).
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
] as const;
export type KcRule = (typeof KC_RULES)[number];

/** A permanent exception: `path` (a file, or a directory ending in `/`), optionally only inside the function or method `within`. */
export interface KcException {
  rule: KcRule;
  path: string;
  within?: string;
  reason: string;
}

/** A directory (ending in `/`) or file not converted yet, and how many violations it may hide. */
export interface KcPendingEntry {
  path: string;
  max: number;
}

/** Rule → the directories and files not converted yet. */
export type KcPending = Partial<Record<KcRule, readonly KcPendingEntry[]>>;

export interface KcOptions {
  pending?: KcPending;
  exceptions?: readonly KcException[];
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

/** Provider tokens a module may build with `useFactory` (not a domain class). */
export const KC_ALLOWED_FACTORY_TOKENS: readonly { token: RegExp; reason: string }[] = [
  {
    token: /^HEALTH_CHECKS$/,
    reason: "the readiness checks are terminus indicators over the pool and Redis, not a class",
  },
  {
    token: /^KERNEL_APP_OPTIONS$/,
    reason:
      "the options the application was created with (logger, env, overrides): a value from the " +
      "caller, not a domain class",
  },
  {
    // TODO(3.6): stale-check these once the OrgQuota tokens exist.
    token: /^(?:RUN_QUOTA|EVAL_QUOTA)$/,
    reason:
      "OrgQuota is one instance per key prefix (RUN_QUOTA_PREFIX, EVAL_QUOTA_PREFIX; plan 3.6): " +
      "the only domain factory, one token per prefix",
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
    within: "startKernelApp",
    reason:
      "startKernelApp is the process entry `capybara start` runs; it owns the signal handlers, " +
      "createKernelApp installs none",
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
 * Not converted yet, computed from the tree at the start of the Nest refactor (Task 2.9): Phase 3
 * removes each domain directory as it becomes a Nest module, Phase 5 empties the map. Directories
 * end with `/`; `max` is the number of violations the entry may still hide (lower it as they go).
 * Never add an entry or raise a max: more violations than `max` fail, and so do fewer
 * (`kc-stale-pending`).
 */
export const KC_PENDING: KcPending = {
  "kc-transaction": [
    { path: "packages/kernel/src/admin/", max: 7 },
    { path: "packages/kernel/src/agents/", max: 6 },
    { path: "packages/kernel/src/catalog/", max: 46 },
    { path: "packages/kernel/src/channels/", max: 5 },
    { path: "packages/kernel/src/conversations/", max: 19 },
    { path: "packages/kernel/src/ctx/", max: 1 },
    { path: "packages/kernel/src/evals/", max: 19 },
    { path: "packages/kernel/src/extensions/", max: 24 },
    { path: "packages/kernel/src/files/", max: 1 },
    { path: "packages/kernel/src/http/", max: 1 },
    { path: "packages/kernel/src/identity/", max: 31 },
    { path: "packages/kernel/src/orgs/", max: 21 },
    { path: "packages/kernel/src/runtime/", max: 25 },
    { path: "packages/kernel/src/tools/", max: 34 },
  ],
  "kc-lock": [
    { path: "packages/kernel/src/admin/", max: 2 },
    { path: "packages/kernel/src/catalog/", max: 5 },
    { path: "packages/kernel/src/channels/", max: 4 },
    { path: "packages/kernel/src/ctx/", max: 2 },
    { path: "packages/kernel/src/evals/", max: 2 },
    { path: "packages/kernel/src/extensions/", max: 7 },
    { path: "packages/kernel/src/identity/", max: 2 },
    { path: "packages/kernel/src/runtime/", max: 4 },
    { path: "packages/kernel/src/sandbox/", max: 4 },
    { path: "packages/kernel/src/tools/", max: 1 },
  ],
  "kc-queue": [
    { path: "packages/kernel/src/channels/", max: 2 },
    { path: "packages/kernel/src/conversations/", max: 2 },
    { path: "packages/kernel/src/evals/", max: 2 },
    { path: "packages/kernel/src/runtime/", max: 8 },
  ],
  "kc-wiring": [
    { path: "apps/capybara/src/commands/admin-create.ts", max: 3 },
    { path: "apps/capybara/src/commands/admin-grant.ts", max: 1 },
    { path: "apps/capybara/src/commands/bootstrap.ts", max: 1 },
    { path: "packages/kernel/src/catalog/", max: 1 },
    { path: "packages/kernel/src/http/", max: 73 },
    { path: "packages/kernel/src/kernel.module.ts", max: 5 },
    { path: "packages/kernel/src/kernel.ts", max: 14 },
    { path: "packages/kernel/src/lifecycle/", max: 1 },
    { path: "packages/testing/src/kernel-helpers.ts", max: 1 },
  ],
  "kc-zod-pipe": [
    { path: "packages/kernel/src/admin/", max: 11 },
    { path: "packages/kernel/src/agents/", max: 3 },
    { path: "packages/kernel/src/catalog/", max: 17 },
    { path: "packages/kernel/src/channels/", max: 2 },
    { path: "packages/kernel/src/conversations/", max: 15 },
    { path: "packages/kernel/src/evals/", max: 10 },
    { path: "packages/kernel/src/extensions/", max: 1 },
    { path: "packages/kernel/src/files/", max: 4 },
    { path: "packages/kernel/src/identity/", max: 4 },
    { path: "packages/kernel/src/orgs/", max: 8 },
    { path: "packages/kernel/src/runtime/", max: 1 },
    { path: "packages/kernel/src/tools/", max: 12 },
    { path: "packages/kernel/src/ui/", max: 9 },
  ],
  "kc-facade": [
    { path: "apps/capybara/src/commands/start.ts", max: 3 },
    { path: "apps/capybara/test/", max: 6 },
    { path: "packages/kernel/src/index.ts", max: 2 },
    { path: "packages/kernel/src/kernel.ts", max: 5 },
    { path: "packages/kernel/test/", max: 348 },
    { path: "packages/testing/src/index.ts", max: 1 },
    { path: "packages/testing/src/kernel-helpers.ts", max: 6 },
    { path: "packages/testing/src/replica-runner.ts", max: 3 },
    { path: "packages/testing/test/", max: 7 },
  ],
  "kc-legacy": [
    { path: "packages/kernel/src/admin/", max: 4 },
    { path: "packages/kernel/src/catalog/", max: 2 },
    { path: "packages/kernel/src/http/", max: 107 },
    { path: "packages/kernel/src/identity/", max: 4 },
    // The counts below include the Phase 3 bridges (R7 LegacyPorts / ConvertedProviders, R8
    // legacyCurrentTrx), added to kc-legacy by Task 3.1: they shrink as their owners convert
    { path: "packages/kernel/src/infra/database/legacy-view.ts", max: 3 },
    { path: "packages/kernel/src/kernel.module.ts", max: 21 },
    { path: "packages/kernel/src/kernel.ts", max: 19 },
    { path: "packages/kernel/src/lifecycle/", max: 12 },
    // R7 ports (EventLog, AttachmentsService, ProviderRegistry, AgentsService: Task 3.6) and R8
    // legacyCurrentTrx (identity / orgs helpers: 3.2; EventLog.append, consumeSkillPackage: 3.6)
    { path: "packages/kernel/src/models/", max: 7 },
    { path: "packages/kernel/src/orgs/", max: 4 },
    { path: "packages/kernel/src/skills/", max: 17 },
    { path: "packages/kernel/src/tools/", max: 2 },
    // the probe app re-provides LegacyPorts (R7) until Task 4.1 rebuilds it on createKernelApp
    { path: "packages/kernel/test/identity/public-routes.test.ts", max: 2 },
    // the R8 bridge's own test, deleted with legacy-view.ts
    { path: "packages/kernel/test/infra/legacy-transaction.test.ts", max: 4 },
  ],
  "kc-config": [
    { path: "packages/kernel/src/admin/", max: 2 },
    { path: "packages/kernel/src/catalog/", max: 4 },
    { path: "packages/kernel/src/channels/", max: 1 },
    { path: "packages/kernel/src/conversations/", max: 2 },
    { path: "packages/kernel/src/evals/", max: 5 },
    { path: "packages/kernel/src/extensions/", max: 4 },
    { path: "packages/kernel/src/http/", max: 9 },
    { path: "packages/kernel/src/identity/", max: 4 },
    { path: "packages/kernel/src/orgs/", max: 1 },
    { path: "packages/kernel/src/runtime/", max: 7 },
    { path: "packages/kernel/src/tools/", max: 15 },
    { path: "packages/kernel/src/ui/", max: 1 },
  ],
  "kc-cache": [{ path: "packages/kernel/src/runtime/", max: 1 }],
  "kc-rate-limit": [
    { path: "packages/kernel/src/admin/", max: 3 },
    { path: "packages/kernel/src/http/", max: 5 },
    { path: "packages/kernel/src/identity/", max: 7 },
    { path: "packages/kernel/src/orgs/", max: 3 },
  ],
};

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
    "the createKernel facade and its Kernel type are going away: build the application with createKernelApp",
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
};

const DECORATOR_HOSTS: Record<string, readonly string[]> = {
  Transactional: ["txHost"],
  WithLock: ["lockService"],
  Cacheable: ["cacheService"],
  CacheEvict: ["cacheService"],
  LockedCron: ["lockService", "log"],
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
const LOCK_DECORATORS = new Set(["WithLock", "LockedCron"]);
const BULLMQ_CLASSES = new Set(["Worker", "Queue", "QueueEvents"]);
const PROCESS_LISTENERS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
const PROCESS_INSTALLERS = new Set(["installProcessGuards", "handleShutdownSignals"]);
const ROUTE_METHODS = new Set(["Get", "Head", "All", "get", "head", "all", "route"]);
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

/** Names of the functions and methods enclosing a node, outermost first. */
function enclosingNames(anc: readonly Node[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < anc.length; i++) {
    const a = anc[i] as Node;
    const next = anc[i + 1];
    if (a.type === "FunctionDeclaration") {
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
  const known = collectKnown(kernelFiles);
  const hits: Hit[] = [];
  for (const f of files) {
    scanFile(f, known, hits);
  }
  for (const f of kernelFiles) checkTransactionalMethods(f, known, hits);
  checkDuplicateProviders(kernelFiles, hits);

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
        (e.within === undefined || h.within.includes(e.within)),
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
  for (const e of exceptions) {
    if (usedException.has(e)) continue;
    out.push({
      file: join(root, e.path),
      line: 1,
      rule: "kc-stale-exception",
      message: `the ${e.rule} exception${e.within ? ` (within ${e.within})` : ""} matches nothing: remove it from KC_EXCEPTIONS in tools/checks/src/kernel-conventions.ts`,
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

function collectKnown(files: FileInfo[]): Known {
  const known: Known = { providers: new Set(), dtos: new Set(), locked: new Map() };
  for (const f of files) {
    for (const cls of classes(f.parsed.program)) {
      const name = nameOf(cls.id);
      if (!name) continue;
      if (decoratorsOf(cls).some((d) => decoratorName(d) === "Injectable")) {
        known.providers.add(name);
      }
      const sup = cls.superClass as Node | null;
      if (sup?.type === "CallExpression" && nameOf(sup.callee) === "createZodDto") {
        known.dtos.add(name);
      }
      for (const m of (cls.body as Node).body as Node[]) {
        if (m.type !== "MethodDefinition") continue;
        if (!decoratorsOf(m).some((d) => LOCK_DECORATORS.has(decoratorName(d) ?? ""))) continue;
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

function scanFile(f: FileInfo, known: Known, hits: Hit[]): void {
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
        if (!within(k, "infra/lifecycle")) {
          if (mc && nameOf(mc.object) === "process" && PROCESS_LISTENERS.has(mc.prop)) {
            hit("kc-process", n, anc);
          }
          if (callee && PROCESS_INSTALLERS.has(callee)) hit("kc-process", n, anc);
        }
        if (fn && ROUTE_METHODS.has(fn) && !within(k, "infra/health")) {
          const arg = (n.arguments as Node[])[0];
          if (
            arg?.type === "Literal" &&
            typeof arg.value === "string" &&
            HEALTH_PATH.test(arg.value)
          ) {
            hit("kc-health", n, anc);
          }
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
        if (SCHEDULE_DECORATORS.has(decoratorName(n) ?? "") && !within(k, "infra/schedule")) {
          hit("kc-cron", n, anc);
        }
        break;
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
          if (KC_ALLOWED_FACTORY_TOKENS.some((t) => t.token.test(token))) break;
          hit("kc-wiring", n, anc, `${MESSAGES["kc-wiring"]} (${key} for ${token})`);
        }
        break;
    }
  });

  for (const s of cacheSets) {
    if (cacheGets.get(s.fn)?.has(s.key)) hit("kc-cache", s.node, s.anc);
  }

  // kc-logger: module-scope declarations only.
  if (!loggerHome) {
    for (const top of parsed.program.body as Node[]) {
      const decl = top.type === "ExportNamedDeclaration" ? (top.declaration as Node | null) : top;
      if (decl?.type !== "VariableDeclaration") continue;
      for (const d of decl.declarations as Node[]) {
        const init = d.init as Node | null;
        if (!init) continue;
        const callee = nameOf(init.callee);
        if (
          (init.type === "CallExpression" && callee && MODULE_LOGGER_FACTORIES.has(callee)) ||
          (init.type === "NewExpression" && callee === "Logger")
        ) {
          hit("kc-logger", d, []);
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

  function checkClass(cls: Node, anc: readonly Node[]): void {
    const name = nameOf(cls.id);
    const decorators = decoratorsOf(cls).map(decoratorName);
    const implementsGuard = ((cls.implements as Node[] | undefined) ?? []).some(
      (i) => nameOf(i.expression) === "CanActivate",
    );
    const injected =
      implementsGuard || decorators.some((d) => INJECTED_CLASS_DECORATORS.has(d ?? ""));
    const classAnc = [...anc, cls];

    if (injected) {
      const ctor = constructorOf(cls);
      for (const p of ((ctor?.value as Node | undefined)?.params as Node[] | undefined) ?? []) {
        if (decoratorsOf(p).some((d) => decoratorName(d)?.startsWith("Inject"))) continue;
        hit("kc-inject", p, classAnc);
      }
    }

    if (name?.endsWith("Cache") && !within(k as string, "infra/cache")) hit("kc-cache", cls, anc);

    if (!within(k as string, "infra")) {
      const members = memberNames(cls);
      for (const m of (cls.body as Node).body as Node[]) {
        if (m.type !== "MethodDefinition") continue;
        for (const d of decoratorsOf(m)) {
          const dn = decoratorName(d) ?? "";
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
        if (
          decoratorsOf(p).some((d) => ["Body", "Query", "Param"].includes(decoratorName(d) ?? ""))
        ) {
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
 * - kc-side-effect-in-tx: the method enqueues (`<…queue…>.add / addBulk`), publishes on the bus
 *   (`<…bus…>.publish`) or calls Redis (`<…redis…>.*`) outside an `afterCommit(() => …)`
 *   callback: a rollback cannot take those back, and a consumer may run before COMMIT.
 */
function checkTransactionalMethods(f: FileInfo, known: Known, hits: Hit[]): void {
  const { parsed, rel } = f;
  const textOf = (n: Node) => parsed.source.slice(n.start, n.end);
  for (const cls of classes(parsed.program)) {
    if (decoratorsOf(cls).some((d) => decoratorName(d) === "Controller")) continue;
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
      const txIdx = decs.findIndex((d) => decoratorName(d) === "Transactional");
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
      const lockIdx = decs.findIndex((d) => LOCK_DECORATORS.has(decoratorName(d) ?? ""));
      if (lockIdx > txIdx) {
        push(
          "kc-lock-in-tx",
          decs[txIdx] as Node,
          `@Transactional is above @${decoratorName(decs[lockIdx] as Node)} on ${className}.${methodName}: the transaction opens first and the lock is released before COMMIT; put the lock decorator above`,
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

/**
 * kc-wiring, duplicate instances: each class is provided by one module (others import it), so a
 * class in the `providers` of two modules (`@Module({ providers })` or a dynamic module object
 * `{ module, providers }`; a bare class or `useClass`) is reported at every listing.
 */
function checkDuplicateProviders(files: FileInfo[], hits: Hit[]): void {
  const listings = new Map<string, { rel: string; line: number; module: Node }[]>();
  for (const f of files) {
    visit(f.parsed.program, (n) => {
      let obj: Node | undefined;
      if (n.type === "Decorator" && decoratorName(n) === "Module") {
        const call = n.expression as Node;
        const arg = call.type === "CallExpression" ? (call.arguments as Node[])[0] : undefined;
        if (arg?.type === "ObjectExpression") obj = arg;
      } else if (
        n.type === "ObjectExpression" &&
        (n.properties as Node[]).some((p) => p.type === "Property" && nameOf(p.key) === "module")
      ) {
        obj = n;
      }
      if (!obj) return;
      const providers = (obj.properties as Node[]).find(
        (p) => p.type === "Property" && nameOf(p.key) === "providers",
      );
      const list = providers?.value as Node | undefined;
      if (list?.type !== "ArrayExpression") return;
      for (const el of list.elements as (Node | null)[]) {
        if (!el) continue;
        let cls = nameOf(el);
        if (el.type === "ObjectExpression") {
          const useClass = (el.properties as Node[]).find(
            (p) => p.type === "Property" && nameOf(p.key) === "useClass",
          );
          cls = useClass ? nameOf(useClass.value) : undefined;
        }
        if (!cls) continue;
        const at = { rel: f.rel, line: f.parsed.lineOf(el.start), module: obj };
        listings.set(cls, [...(listings.get(cls) ?? []), at]);
      }
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
