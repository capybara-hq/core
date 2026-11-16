import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeKernelApp, createKernelApp } from "../../src/app.js";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { PermissionProfileStore } from "../../src/conversations/permission-profile-store.js";
import { DeviceAccess } from "../../src/devices/access.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxDispatcher } from "../../src/infra/outbox/outbox.dispatcher.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { createLogger } from "../../src/log.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import {
  PermissionConfigPublication,
  permissionConfigFingerprint,
} from "../../src/sandbox/permission-config-publication.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let db: KernelDb;
const log = createLogger("error", { write: () => {} });
const config = (autoMode: "allowed" | "off" = "allowed", allowHosts = ["a.example"]) =>
  KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    roles: ["api"],
    http: { port: 0 },
    marketplaces: { official: { enabled: false } },
    devices: { autoMode },
    sandbox: { limits: { egress: "allowlist", allowHosts } },
  });
const publisher = (cfg = config()) =>
  new PermissionConfigPublication(
    db,
    k.app.get(TransactionHost),
    new KernelConfigService({ config: cfg, env: {} }, log),
    k.app.get(PermissionCeilingWrites),
  );
const snapshot = async () => ({
  active: await db.selectFrom("permission_config_publication").selectAll().execute(),
  epochs: await db.selectFrom("permission_authority_epochs").selectAll().execute(),
  outbox: await db.selectFrom("outbox").selectAll().execute(),
});
beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(config(), { env: {}, logger: log });
  db = k.app.get(KernelDb);
  // Keep durable obligations in PG while simulating a dropped after-commit delivery hint.
  vi.spyOn(k.app.get(OutboxDispatcher), "dispatchOwn").mockResolvedValue();
});
beforeEach(async () => {
  await db.deleteFrom("permission_config_publication").execute();
  await db.deleteFrom("deployment_settings").where("key", "=", "devicesAutoMode").execute();
});
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("ordinary initialization, matching and mismatch cannot overwrite authority", async () => {
  const a = publisher();
  const b = publisher(config("off"));
  expect(await a.initialize()).toEqual({
    outcome: "initialized",
    activeHash: permissionConfigFingerprint(config()),
  });
  const before = await snapshot();
  expect((await a.initialize()).outcome).toBe("matching");
  expect((await b.initialize()).outcome).toBe("mismatch");
  expect(await snapshot()).toEqual(before);
});
it("explicit CAS refuses absence/stale expectation and same candidate is idempotent", async () => {
  const a = publisher();
  const b = publisher(config("off"));
  const expectedActiveHash = permissionConfigFingerprint(config());
  await expect(b.initialize({ activation: { expectedActiveHash } })).rejects.toThrow(
    /first startup/i,
  );
  await a.initialize();
  await expect(
    b.initialize({ activation: { expectedActiveHash: "0".repeat(64) } }),
  ).rejects.toThrow(/active=/);
  expect((await b.initialize({ activation: { expectedActiveHash } })).outcome).toBe("activated");
  const before = await snapshot();
  expect((await b.initialize({ activation: { expectedActiveHash } })).outcome).toBe(
    "already-active",
  );
  expect(await snapshot()).toEqual(before);
  await expect(a.assertCurrent()).rejects.toThrow();
  await expect(b.assertCurrent()).resolves.toBeUndefined();
});
it("programmatic-invalid-activation-intent", async () => {
  for (const matching of [false, true]) {
    if (matching) await publisher().initialize();
    for (const expectedActiveHash of ["", "force", "A".repeat(64), " ", "a".repeat(64) + "\n"]) {
      const before = await snapshot();
      const result = await createKernelApp(config(), {
        permissionConfigActivation: { expectedActiveHash },
        logger: log,
      }).then(
        async (app) => {
          await closeKernelApp(app);
          return undefined;
        },
        (e: unknown) => e,
      );
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/lowercase 64-hex/);
      await expect(publisher().initialize({ activation: { expectedActiveHash } })).rejects.toThrow(
        /lowercase 64-hex/,
      );
      expect(await snapshot()).toEqual(before);
    }
  }
});

function readers(cfg = config(), env: NodeJS.ProcessEnv = {}) {
  const service = new KernelConfigService({ config: cfg, env }, log);
  const facts = new PermissionFacts(
    db,
    service,
    k.app.get(SandboxProviders),
    k.app.get(DeviceAccess),
  );
  const publication = new PermissionConfigPublication(
    db,
    k.app.get(TransactionHost),
    service,
    k.app.get(PermissionCeilingWrites),
  );
  const authority = new SandboxOperationAuthority(
    k.app.get(PermissionCallGrants),
    publication,
    db,
    k.app.get(TransactionHost),
    k.app.get(PermissionProfileStore),
    facts,
    k.app.get(NetworkGrants),
    k.app.get(PermissionAuthorityLock),
    k.app.get(PermissionAuthorityEpochStore),
  );
  return { service, facts, publication, authority };
}
async function consentFixture() {
  const accountId = randomUUID(),
    orgId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID(),
    deviceId = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id: accountId, display_name: "Activation test", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({ id: orgId, slug: orgId, name: "Activation test", created_by: accountId })
    .execute();
  await db
    .insertInto("memberships")
    .values({ org_id: orgId, account_id: accountId, role: "owner" })
    .execute();
  await db
    .insertInto("agents")
    .values({
      id: agentId,
      org_id: orgId,
      owner_account_id: accountId,
      visibility: "org",
      current_version: 1,
    })
    .execute();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      source: "cloud",
      provider: "@activation-test",
    })
    .execute();
  await db
    .insertInto("conversations")
    .values({
      id: conversationId,
      org_id: orgId,
      account_id: accountId,
      agent_id: agentId,
      title: null,
      source: "web",
      device_id: deviceId,
    })
    .execute();
  k.app.get(SandboxProviders).register({
    plugin: "@activation-test",
    version: "test",
    impl: {
      operation() {
        throw new Error("provider IO forbidden");
      },
      permissionSupport() {
        throw new Error("provider IO forbidden");
      },
      revokeOperation() {
        throw new Error("provider IO forbidden");
      },
    } as unknown as SandboxProvider,
  });
  const a = readers();
  await a.publication.initialize();
  const preview = await a.facts.preview(orgId, accountId, deviceId);
  expect(preview.fullAccessCeiling).toBe(true);
  const consent = { deviceId, scopeRevision: preview.scopeRevision };
  await db
    .updateTable("conversations")
    .set({ permission_profile: "full-access", permission_consent: JSON.stringify(consent) })
    .where("id", "=", conversationId)
    .execute();
  const row = () =>
    db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
  const ctx = {
    orgId,
    deviceId,
    holderConversationId: conversationId,
    actor: { accountId, conversationId },
  };
  const view = async (r = a) => r.facts.view(orgId, accountId, await row());
  expect((await view()).profile).toBe("full-access");
  expect((await a.authority.resolve(ctx, "exec", new AbortController().signal)).profile).toBe(
    "full-access",
  );
  return { a, accountId, orgId, deviceId, conversationId, row, view, consent, ctx };
}

it("unrelated-config-preserves-full-consent", async () => {
  const f = await consentFixture();
  const next = config();
  next.http.port = 38765;
  next.log.level = "warn";
  const b = readers(next);
  const before = await snapshot();
  const root = await f.row();
  expect((await b.publication.initialize()).outcome).toBe("matching");
  expect(
    (await b.publication.initialize({ activation: { expectedActiveHash: "f".repeat(64) } }))
      .outcome,
  ).toBe("already-active");
  expect(await snapshot()).toEqual(before);
  expect(await f.row()).toEqual(root);
  expect(await f.view(b)).toMatchObject({
    profile: "full-access",
    scopeRevision: f.consent.scopeRevision,
  });
  expect((await b.authority.resolve(f.ctx, "exec", new AbortController().signal)).profile).toBe(
    "full-access",
  );
});

it("restricted-network-activation-preserves-full-consent", async () => {
  const f = await consentFixture();
  const b = readers(config("allowed", ["b.example"]));
  const before = await f.row();
  const fullScope = await f.a.facts.scope(f.orgId, f.deviceId, null, null);
  expect((await f.a.facts.readDevice(f.orgId, f.deviceId)).policy.network).toEqual({
    kind: "open-public",
    hosts: [],
  });
  expect(
    (
      await b.publication.initialize({
        activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
      })
    ).outcome,
  ).toBe("activated");
  expect((await b.facts.scope(f.orgId, f.deviceId, null, null)).scopeRevision).toBe(
    fullScope.scopeRevision,
  );
  expect(await f.row()).toEqual(before);
  expect((await f.view(b)).profile).toBe("full-access");
  expect((await b.authority.resolve(f.ctx, "exec", new AbortController().signal)).profile).toBe(
    "full-access",
  );
  await expect(f.a.authority.resolve(f.ctx, "exec", new AbortController().signal)).rejects.toThrow(
    /current permission configuration/,
  );
});

it("source labels normalize while delegated identity resolves current DB semantics", async () => {
  const f = await consentFixture();
  const same = config("allowed", ["a.example", "a.example"]);
  expect(permissionConfigFingerprint(same)).toBe(permissionConfigFingerprint(config()));
  const env = { CAPYBARA_DEVICES__AUTO_MODE: "allowed" };
  const winning = resolveConfig({ ...config("off"), log: { level: "error" } }, env);
  const envReader = readers(winning, env);
  expect((await envReader.publication.initialize()).outcome).toBe("matching");
  expect((await f.view(envReader)).profile).toBe("full-access");
  const delegated = config();
  delete delegated.devices.autoMode;
  expect(permissionConfigFingerprint(delegated)).not.toBe(permissionConfigFingerprint(config()));
  await db
    .insertInto("deployment_settings")
    .values({ key: "devicesAutoMode", value: JSON.stringify({ mode: "allowed" }) })
    .execute();
  const d = readers(delegated);
  await d.publication.initialize({
    activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
  });
  expect((await f.view(d)).profile).toBe("full-access");
  expect((await f.view(d)).scopeRevision).toBe(f.consent.scopeRevision);
  // A delegated candidate reads the current DB choice under authority; flattening to allowed
  // would miss the actual transition to off here.
  await db
    .updateTable("deployment_settings")
    .set({ value: JSON.stringify({ mode: "off" }) })
    .where("key", "=", "devicesAutoMode")
    .execute();
  const explicit = readers(config());
  await explicit.publication.initialize({
    activation: { expectedActiveHash: permissionConfigFingerprint(delegated) },
  });
  expect((await f.view(explicit)).profile).toBe("approve-for-me");
});

it("abort-after-authority-before-commit rolls back the complete authority write", async () => {
  await publisher().initialize();
  const before = await snapshot();
  const staged = deferred();
  const resume = deferred();
  const abort = new AbortController();
  const ceilings = k.app.get(PermissionCeilingWrites);
  const original = ceilings.publishLocked.bind(ceilings);
  const spy = vi.spyOn(ceilings, "publishLocked").mockImplementation(async (...args) => {
    await original(...args);
    staged.resolve();
    await resume.promise;
  });
  const run = publisher(config("off")).initialize({
    activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
    startup: { signal: abort.signal, remainingMs: () => 30_000 },
  });
  const result = run.catch((e: unknown) => e);
  try {
    await staged.promise;
    abort.abort();
    expect(await result).toBeInstanceOf(Error);
    resume.resolve();
    expect(await snapshot()).toEqual(before);
  } finally {
    resume.resolve();
    spy.mockRestore();
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("shutdown-after-commit-dispatch-lost-ack resolves by idempotent authoritative retry", async () => {
  await publisher().initialize();
  const abort = new AbortController();
  const committed = deferred();
  const ack = deferred();
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const result = Reflect.apply(original, this, args);
    if (args[0] === "commit")
      return (result as Promise<unknown>).then(async (value) => {
        committed.resolve();
        await ack.promise;
        return value;
      });
    return result;
  } as typeof original);
  const b = publisher(config("off"));
  const activation = { expectedActiveHash: permissionConfigFingerprint(config()) };
  const run = b.initialize({
    activation,
    startup: { signal: abort.signal, remainingMs: () => 30_000 },
  });
  const result = run.catch((e: unknown) => e);
  try {
    await committed.promise;
    abort.abort();
    expect(await result).toMatchObject({ outcome: "uncertain" });
    const before = await snapshot();
    spy.mockRestore();
    ack.resolve();
    expect((await b.initialize({ activation })).outcome).toBe("already-active");
    expect(await snapshot()).toEqual(before);
  } finally {
    ack.resolve();
    spy.mockRestore();
  }
});

async function intent(
  f: Awaited<ReturnType<typeof consentFixture>>,
  restricted = false,
  method: "exec" | "backgroundStart" = "exec",
) {
  if (restricted)
    await db
      .updateTable("conversations")
      .set({ permission_profile: "approve-for-me", permission_consent: null })
      .where("id", "=", f.conversationId)
      .execute();
  const scope = await f.a.authority.resolve(f.ctx, method, new AbortController().signal);
  await db
    .insertInto("sandbox_operation_intents")
    .values({
      operation_id: scope.operationId,
      org_id: f.orgId,
      account_id: f.accountId,
      device_id: f.deviceId,
      root_conversation_id: f.conversationId,
      conversation_id: f.conversationId,
      run_id: null,
      call_id: null,
      ordinal: 0,
      method,
      input_hash: "a".repeat(64),
      admission_hash: "b".repeat(64),
      input: "{}",
      scope: JSON.stringify(scope),
      epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
      provider: "@activation-test",
      provider_version: "test",
      instance_generation: "test",
      deadline: new Date(Date.now() + 30_000),
      retain_until: new Date(Date.now() + 60_000),
      state: "admitted",
      execution_id: randomUUID(),
    })
    .execute();
  return scope.operationId;
}
it.each(["exec", "backgroundStart"] as const)(
  "restricted activation revokes only affected %s intents with one epoch and durable outbox",
  async (method) => {
    const full = await consentFixture(),
      restricted = await consentFixture();
    const fullId = await intent(full, false, method),
      restrictedId = await intent(restricted, true, method);
    const epoch = await db
      .selectFrom("permission_authority_epochs")
      .selectAll()
      .where("kind", "=", "platform")
      .executeTakeFirstOrThrow();
    await publisher(config("allowed", ["b.example"])).initialize({
      activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
    });
    const after = await db
      .selectFrom("permission_authority_epochs")
      .selectAll()
      .where("kind", "=", "platform")
      .executeTakeFirstOrThrow();
    expect(after.revision).toBe(epoch.revision + 1);
    expect(after.full_revision).toBe(epoch.full_revision);
    expect(
      (
        await db
          .selectFrom("sandbox_operation_intents")
          .select("state")
          .where("operation_id", "=", fullId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("admitted");
    expect(
      (
        await db
          .selectFrom("sandbox_operation_intents")
          .select("state")
          .where("operation_id", "=", restrictedId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("revoked");
    expect(
      await db
        .selectFrom("outbox")
        .select("job_id")
        .where("job_id", "=", `sandbox-operation-revoke-${restrictedId}`)
        .execute(),
    ).toHaveLength(1);
  },
);
it.each(["before-outbox", "before-commit"])(
  "activation fault %s rolls back publication, epochs and revokes",
  async (phase) => {
    const f = await consentFixture();
    await intent(f);
    const before = await snapshot();
    const root = await f.row();
    const ceilings = k.app.get(PermissionCeilingWrites);
    const original = ceilings.publishLocked.bind(ceilings);
    const spy = vi.spyOn(ceilings, "publishLocked").mockImplementation(async (...args) => {
      if (phase === "before-commit") await original(...args);
      throw new Error("injected activation fault");
    });
    try {
      await expect(
        publisher(config("off")).initialize({
          activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
        }),
      ).rejects.toThrow("injected activation fault");
      expect(await snapshot()).toEqual(before);
      expect(await f.row()).toEqual(root);
    } finally {
      spy.mockRestore();
    }
  },
);
it("candidate remains frozen when the source changes after load and before authority", async () => {
  await publisher().initialize();
  const next = config("off", ["b.example"]);
  const r = readers(next);
  const acquired = deferred(),
    resume = deferred();
  const ceilings = k.app.get(PermissionCeilingWrites);
  const original = ceilings.lock.bind(ceilings);
  const spy = vi.spyOn(ceilings, "lock").mockImplementation(async (...args) => {
    await original(...args);
    acquired.resolve();
    await resume.promise;
  });
  const run = r.publication.initialize({
    activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
  });
  try {
    await acquired.promise;
    next.sandbox.limits.allowHosts = ["future.example"];
    resume.resolve();
    expect((await run).activeHash).toBe(permissionConfigFingerprint(config("off", ["b.example"])));
  } finally {
    resume.resolve();
    spy.mockRestore();
  }
});

it("activation conflict diagnostics expose only fingerprints and the command template", async () => {
  await publisher().initialize();
  const candidate = config("off", ["secret-host-sentinel.example"]);
  candidate.db.url = "postgres://secret-user:secret-password@secret-host/secret-database";
  const result = await publisher(candidate)
    .initialize({ activation: { expectedActiveHash: "0".repeat(64) } })
    .catch((e: unknown) => e);
  expect(result).toBeInstanceOf(Error);
  const message = (result as Error).message;
  expect(message).toContain(`active=${permissionConfigFingerprint(config())}`);
  expect(message).toContain(`candidate=${permissionConfigFingerprint(candidate)}`);
  expect(message).toContain("capybara start --activate-permission-config");
  expect(message).not.toContain("secret-");
});

it("already aborted startup leaves an absent or matching publication untouched", async () => {
  const abort = new AbortController();
  abort.abort();
  for (const initialized of [false, true]) {
    if (initialized) await publisher().initialize();
    const before = await snapshot();
    await expect(
      publisher().initialize({
        activation: { expectedActiveHash: permissionConfigFingerprint(config()) },
        startup: { signal: abort.signal, remainingMs: () => 30_000 },
      }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
});

it.each(["exec", "backgroundStart"] as const)(
  "actual org writer narrows restricted %s authority while preserving Full",
  async (method) => {
    const f = await consentFixture();
    const fullId = await intent(f, false, method);
    const restrictedId = await intent(f, true, method);
    await k.app
      .get(OrgSettingsService)
      .update(
        f.orgId,
        { cloudNetwork: { mode: "allowlist", excludedHosts: ["a.example"], extraHosts: [] } },
        f.accountId,
      );
    const rows = await db
      .selectFrom("sandbox_operation_intents")
      .select(["operation_id", "state"])
      .where("operation_id", "in", [fullId, restrictedId])
      .execute();
    expect(rows.find((r) => r.operation_id === fullId)?.state).toBe("admitted");
    expect(rows.find((r) => r.operation_id === restrictedId)?.state).toBe("revoked");
  },
);

it.each(["exec", "backgroundStart"] as const)(
  "actual owner writer narrows %s baseline but preserves recorded additions and Full",
  async (method) => {
    const f = await consentFixture();
    const fullId = await intent(f, false, method);
    const revokedId = await intent(f, true, method);
    const grantedId = await intent(f, true, method);
    await db
      .updateTable("sandbox_operation_intents")
      .set({ granted_hosts: JSON.stringify(["a.example"]) })
      .where("operation_id", "=", grantedId)
      .execute();
    const machine = await db
      .insertInto("device_machines")
      .values({
        org_id: f.orgId,
        device_id: f.deviceId,
        account_id: f.accountId,
        credential_hash: randomUUID(),
        name: "fixture",
        os: "darwin",
        arch: "arm64",
        local_policy: JSON.stringify({ mode: "auto", allowedDomains: ["a.example"] }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await k.app.get(MachinesService).recordPolicy(machine.id, { mode: "auto", allowedDomains: [] });
    const rows = await db
      .selectFrom("sandbox_operation_intents")
      .select(["operation_id", "state"])
      .where("operation_id", "in", [fullId, revokedId, grantedId])
      .execute();
    expect(rows.find((r) => r.operation_id === fullId)?.state).toBe("admitted");
    expect(rows.find((r) => r.operation_id === grantedId)?.state).toBe("admitted");
    expect(rows.find((r) => r.operation_id === revokedId)?.state).toBe("revoked");
  },
);
