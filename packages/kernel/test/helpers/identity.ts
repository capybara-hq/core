// biome-ignore-all lint/suspicious/noExplicitAny: test handles over an untyped Kysely
/**
 * The identity / orgs / admin providers over a test's own Kysely, for tests without a running
 * kernel (ruling R10; Task 5.1 moves the tests to the Nest application). Every service built for
 * the same `db` shares one set of database handles, so their transactions see each other.
 */

import { getQueueToken } from "@nestjs/bullmq";
import type { Kysely } from "kysely";
import { SetupService } from "../../src/admin/setup.service.js";
import type { Keyring } from "../../src/ctx/secrets.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { EvalBudget } from "../../src/evals/budget.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import type { EnterpriseAdminLock } from "../../src/identity/enterprise-admin.js";
import { ExternalIdentities } from "../../src/identity/external.js";
import { ExternalIdentityLock } from "../../src/identity/external-identity-lock.js";
import { SessionService } from "../../src/identity/sessions.js";
import { SettingsService } from "../../src/identity/settings.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import {
  type StandaloneDatabase,
  standaloneDatabase,
} from "../../src/infra/database/standalone.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { KernelEvents } from "../../src/infra/events/kernel-events.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { KERNEL_LOGGER, REDIS } from "../../src/infra/tokens.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import { DirectorySync } from "../../src/orgs/directory-sync.js";
import { InvitationsService } from "../../src/orgs/invitations.service.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { Offboarding, type OffboardingRunControl } from "../../src/orgs/offboarding.js";
import { OrgLock } from "../../src/orgs/org-lock.js";
import { OrgsService } from "../../src/orgs/orgs.service.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import type { SandboxJobs } from "../../src/sandbox/jobs.js";
import type { ApprovalsService } from "../../src/tools/approvals.service.js";
import { type Credentials, clearAccountCredentials } from "../../src/tools/credentials.js";
import type { QuestionsService } from "../../src/tools/questions.service.js";

const quiet = createLogger("error", { write: () => {} });
const handles = new WeakMap<object, StandaloneDatabase>();

/** The database handles of `db` (one set per Kysely object). */
export function handlesFor(db: Kysely<any>): StandaloneDatabase {
  let h = handles.get(db);
  if (!h) {
    h = standaloneDatabase(db, quiet);
    handles.set(db, h);
  }
  return h;
}

/**
 * The `capybara` view of `db` (the kernel-schema Kysely the tests query with). It maps to `db`'s
 * handles, so the providers built for the view share their `TransactionHost` with those built for
 * `db`. Its `transaction()` is a plain Kysely transaction: code that must join it runs inside
 * `handlesFor(db).txHost.run(...)` instead.
 */
export function legacyDbFor(db: Kysely<any>): KernelSchemaDb {
  const h = handlesFor(db);
  const view = kernelDb(db);
  handles.set(view, h);
  return view;
}

/** A config holder for providers that read a few config values. */
export function configOf(cfg: unknown): Pick<KernelConfigService, "get"> {
  return { get: () => cfg as never };
}

export function accountsFor(db: Kysely<any>): AccountsService {
  const h = handlesFor(db);
  return new AccountsService(h.db, h.txHost, h.adminLock, h.setupLock);
}

export function orgLockFor(db: Kysely<any>): OrgLock {
  const h = handlesFor(db);
  return new OrgLock(h.db, h.txHost);
}

export function adminLockFor(db: Kysely<any>): EnterpriseAdminLock {
  return handlesFor(db).adminLock;
}

export function apiTokensFor(db: Kysely<any>): ApiTokenService {
  const h = handlesFor(db);
  return new ApiTokenService(h.db, h.txHost, orgLockFor(db));
}

export function settingsFor(
  db: Kysely<any>,
  log: Pick<KernelLogger, "warn"> = quiet,
): SettingsService {
  const h = handlesFor(db);
  return new SettingsService(h.db, h.txHost, adminLockFor(db), log);
}

export function orgsFor(
  db: Kysely<any>,
  settings: SettingsService = settingsFor(db),
  tokens: ApiTokenService = apiTokensFor(db),
  events: KernelEvents = new KernelEvents(quiet),
): OrgsService {
  const h = handlesFor(db);
  return new OrgsService(
    h.db,
    h.txHost,
    settings,
    tokens,
    orgLockFor(db),
    events,
    new EvalBudget(h.db, h.txHost),
  );
}

export function setupFor(
  db: Kysely<any>,
  accounts: AccountsService = accountsFor(db),
  orgs: OrgsService = orgsFor(db),
): SetupService {
  const h = handlesFor(db);
  return new SetupService(h.db, h.txHost, h.setupLock, accounts, orgs);
}

export function sessionsFor(
  db: Kysely<any>,
  redis: ConstructorParameters<typeof SessionService>[2],
  keyring: Keyring,
  opts: { accessTtlSeconds: number; refreshTtlDays: number },
): SessionService {
  const h = handlesFor(db);
  return new SessionService(
    h.db,
    h.txHost,
    redis,
    keyring,
    configOf({
      auth: {
        accessTokenTtlSeconds: opts.accessTtlSeconds,
        refreshTokenTtlDays: opts.refreshTtlDays,
      },
    }),
  );
}

export function externalFor(db: Kysely<any>, config: () => unknown): ExternalIdentities {
  const h = handlesFor(db);
  return new ExternalIdentities(h.db, h.txHost, new ExternalIdentityLock(h.xactLock, h.txHost), {
    get: () => config() as never,
  });
}

const noWaits = { cancelPendingFor: async () => ({ records: [], seqs: new Map() }) };
const noRuns: OffboardingRunControl = {
  abortWaiting: async () => false,
  abortIfOrphaned: async () => false,
  requestAbort: async () => {},
};

/** What offboarding reads besides the database: the sandbox jobs and the tools services. */
export type OffboardingTestDeps = {
  /** Enqueues the member's sandbox destruction (nothing by default). */
  sandboxDestroy?: Pick<SandboxJobs, "destroy">;
  eventLog?: ConstructorParameters<typeof Offboarding>[5];
  /** Stops the member's runs (none by default). */
  offboardRuns?: OffboardingRunControl;
  credentials?: Pick<Credentials, "clearAccount">;
  approvals?: Pick<ApprovalsService, "cancelPendingFor">;
  questions?: Pick<QuestionsService, "cancelPendingFor">;
};

/**
 * Offboarding over `db`. Without `deps` it only touches the database (deletes credentials, revokes
 * sessions and tokens, reassigns agents); it cancels no approval or question and stops no run.
 */
export function testOffboarding(
  db: Kysely<any>,
  deps: OffboardingTestDeps = {},
  opts: {
    redis?: ConstructorParameters<typeof Offboarding>[3];
    sessions?: ConstructorParameters<typeof Offboarding>[2];
    registry?: ExtensionRegistry;
    log?: Pick<KernelLogger, "warn">;
  } = {},
): Offboarding {
  const h = handlesFor(db);
  const { credentials, approvals, questions, eventLog, offboardRuns, sandboxDestroy } = deps;
  return new Offboarding(
    h.db,
    h.txHost,
    opts.sessions ?? { markRevoked: async () => {} },
    opts.redis ?? ({ set: async () => "OK", exists: async () => 0 } as never),
    opts.registry ?? new ExtensionRegistry(),
    eventLog ?? { notify: async () => {}, publishChanged: async () => {} },
    sandboxDestroy ?? { destroy: async () => {} },
    offboardRuns ?? noRuns,
    credentials ?? {
      clearAccount: (orgId, accountId) => clearAccountCredentials(h.db.db, orgId, accountId),
    },
    approvals ?? noWaits,
    questions ?? noWaits,
    (opts.log ?? quiet) as KernelLogger,
  );
}

export function membersFor(
  db: Kysely<any>,
  offboarding: Offboarding = testOffboarding(db),
): MembersService {
  const h = handlesFor(db);
  return new MembersService(h.db, h.txHost, orgLockFor(db), offboarding);
}

export function invitationsFor(
  db: Kysely<any>,
  accounts: AccountsService = accountsFor(db),
  members: MembersService = membersFor(db),
): InvitationsService {
  const h = handlesFor(db);
  return new InvitationsService(h.db, h.txHost, accounts, members, orgLockFor(db));
}

/** Runs `fn` in a transaction of `db`'s handles (for `mandatory` methods). */
export function inTransaction<T>(db: Kysely<any>, fn: () => Promise<T>): Promise<T> {
  return handlesFor(db).txHost.run(fn);
}

export function orgSettingsFor(db: Kysely<any>, config: () => unknown): OrgSettingsService {
  const h = handlesFor(db);
  return new OrgSettingsService(h.db, h.txHost, orgLockFor(db), { get: () => config() as never });
}

/** Runs `fn` in a transaction of a running kernel (for its `mandatory` providers). */
export function kernelTransaction<T>(
  k: { app: { get(c: unknown): unknown } },
  fn: () => Promise<T>,
): Promise<T> {
  return (k.app.get(TransactionHost) as TransactionHost).run(fn);
}

/**
 * A `DirectorySync` over a running kernel's providers, with test overrides (its own Redis client,
 * org extension configs, offboarding or queue).
 */
export function directorySyncFor(
  k: { app: { get(c: unknown): unknown } },
  o: {
    redis?: ConstructorParameters<typeof DirectorySync>[2];
    orgExtensionConfigs?: ConstructorParameters<typeof DirectorySync>[4];
    offboarding?: ConstructorParameters<typeof DirectorySync>[6];
    queue?: ConstructorParameters<typeof DirectorySync>[8];
  } = {},
): DirectorySync {
  const get = <T>(c: unknown) => k.app.get(c) as T;
  return new DirectorySync(
    get(KernelDb),
    get(TransactionHost),
    o.redis ?? get(REDIS),
    get(ExtensionRegistry),
    o.orgExtensionConfigs ?? get(OrgExtensionConfigs),
    get(ExternalIdentities),
    o.offboarding ?? get(Offboarding),
    get(OrgLock),
    o.queue ?? get(getQueueToken(MAINTENANCE_QUEUE_NAME)),
    get(LockService),
    get(KERNEL_LOGGER),
  );
}
