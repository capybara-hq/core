import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { SettingsService } from "../../src/identity/settings.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxDispatcher } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import {
  PermissionConfigPublication,
  permissionConfigFingerprint,
  permissionConfigProjection,
} from "../../src/sandbox/permission-config-publication.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer, rd: TestContainer, a: TestKernel, b: TestKernel, db: KernelDb;
const log = createLogger("error", { write: () => {} });
const cfg = (mode: "allowed" | "off", hosts = ["a.example"]) =>
  KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 4).toString("base64"),
    roles: ["api"],
    http: { port: 0 },
    log: { level: "error" },
    marketplaces: { official: { enabled: false } },
    devices: { autoMode: mode },
    sandbox: { limits: { egress: "allowlist", allowHosts: hosts } },
  });
const pub = (replica: TestKernel) => replica.app.get(PermissionConfigPublication);
const hashA = () => permissionConfigFingerprint(cfg("allowed"));
const hashB = () => permissionConfigFingerprint(cfg("off", ["b.example"]));
const activation = () => ({
  activation: { expectedActiveHash: hashA() },
  startup: { signal: new AbortController().signal, remainingMs: () => 30_000 },
});
const state = async () => ({
  publication: await db.selectFrom("permission_config_publication").selectAll().execute(),
  epochs: await db
    .selectFrom("permission_authority_epochs")
    .selectAll()
    .orderBy("kind")
    .orderBy("id")
    .execute(),
  outbox: await db.selectFrom("outbox").selectAll().orderBy("id").execute(),
  roots: await db
    .selectFrom("conversations")
    .select(["id", "org_id", "permission_profile", "permission_consent", "permission_revision"])
    .where("parent_conversation_id", "is", null)
    .orderBy("id")
    .execute(),
  intents: await db
    .selectFrom("sandbox_operation_intents")
    .selectAll()
    .orderBy("operation_id")
    .execute(),
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  a = await startKernel(cfg("allowed"), { env: {}, logger: log });
  b = await startKernel(cfg("off", ["b.example"]), { env: {}, logger: log });
  db = a.app.get(KernelDb);
  // Drop only the after-commit delivery hint; durable rows and admission gates remain real.
  for (const replica of [a, b])
    vi.spyOn(replica.app.get(OutboxDispatcher), "dispatchOwn").mockResolvedValue();
});
beforeEach(async () => {
  await db.deleteFrom("sandbox_operation_intents").execute();
  await db.deleteFrom("outbox").where("job_name", "=", "sandbox-operation-revoke").execute();
  await db.deleteFrom("permission_config_publication").execute();
  await db.deleteFrom("deployment_settings").where("key", "=", "devicesAutoMode").execute();
  await pub(a).initialize();
  await a.app
    .get(KernelConfigService)
    .apply(cfg("allowed"), (old, next) => pub(a).publish(old, next));
  await b.app.get(KernelConfigService).apply(cfg("off", ["b.example"]));
  await db.deleteFrom("permission_config_publication").execute();
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("concurrent different ordinary initializers establish one winner without overwriting", async () => {
  const results = await Promise.all([pub(a).initialize(), pub(b).initialize()]);
  expect(results.map((r) => r.outcome).sort()).toEqual(["initialized", "mismatch"]);
  const before = await state();
  await Promise.all([pub(a).initialize(), pub(b).initialize()]);
  expect(await state()).toEqual(before);
});

it("B holds authority before duplicate B and competing C enter: one CAS transition", async () => {
  await pub(a).initialize();
  const f = await consent();
  const operationId = await admittedIntent(f);
  const before = await state();
  const held = gate(),
    release = gate();
  const ceilings = b.app.get(PermissionCeilingWrites);
  const original = ceilings.lock.bind(ceilings);
  let first = true;
  const spy = vi.spyOn(ceilings, "lock").mockImplementation(async (...args) => {
    await original(...args);
    if (first) {
      first = false;
      held.resolve();
      await release.promise;
    }
  });
  const cConfig = cfg("allowed", ["c.example"]);
  const c = new PermissionConfigPublication(
    db,
    a.app.get(TransactionHost),
    new KernelConfigService({ config: cConfig, env: {} }, log),
    a.app.get(PermissionCeilingWrites),
  );
  const winner = pub(b).initialize(activation());
  const failed = winner.catch((e: unknown) => e);
  try {
    await held.promise;
    const duplicate = pub(b).initialize(activation());
    const competitor = c.initialize(activation()).catch((e: unknown) => e);
    release.resolve();
    expect((await winner).outcome).toBe("activated");
    expect((await duplicate).outcome).toBe("already-active");
    expect(await competitor).toBeInstanceOf(Error);
    const after = await state();
    expect(after.publication[0]?.fingerprint).toBe(hashB());
    expect(
      after.outbox.filter((row) => row.job_id === `sandbox-operation-revoke-${operationId}`),
    ).toHaveLength(1);
    const previous = before.epochs.find((r) => r.kind === "platform")?.revision ?? 0;
    expect(after.epochs.find((r) => r.kind === "platform")?.revision).toBe(previous + 1);
    const stable = await state();
    await pub(b).initialize(activation());
    expect(await state()).toEqual(stable);
  } finally {
    release.resolve();
    await failed;
    spy.mockRestore();
  }
});

async function consent() {
  const accountId = randomUUID(),
    orgId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID(),
    deviceId = randomUUID();
  await db
    .insertInto("accounts")
    .values({ id: accountId, display_name: "Dual test", email: null })
    .execute();
  await db
    .insertInto("orgs")
    .values({ id: orgId, slug: orgId, name: "Dual test", created_by: accountId })
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
      provider: "@activation-dual",
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
  for (const replica of [a, b])
    replica.app.get(SandboxProviders).register({
      plugin: "@activation-dual",
      version: "test",
      impl: {
        operation() {
          throw new Error("no provider IO");
        },
        permissionSupport() {
          throw new Error("no provider IO");
        },
        revokeOperation() {
          throw new Error("no provider IO");
        },
      } as unknown as SandboxProvider,
    });
  const preview = await a.app.get(PermissionFacts).preview(orgId, accountId, deviceId);
  await db
    .updateTable("conversations")
    .set({
      permission_profile: "full-access",
      permission_consent: JSON.stringify({ deviceId, scopeRevision: preview.scopeRevision }),
    })
    .where("id", "=", conversationId)
    .execute();
  const row = () =>
    db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
  const view = async (replica: TestKernel) =>
    replica.app.get(PermissionFacts).view(orgId, accountId, await row());
  const ctx = {
    orgId,
    deviceId,
    holderConversationId: conversationId,
    actor: { accountId, conversationId },
  };
  const admit = (replica: TestKernel) =>
    replica.app.get(SandboxOperationAuthority).resolve(ctx, "exec", new AbortController().signal);
  return {
    row,
    view,
    admit,
    ctx,
    accountId,
    orgId,
    deviceId,
    conversationId,
    scopeRevision: preview.scopeRevision,
  };
}

it("full-scope-a-b-a-does-not-resurrect-consent", async () => {
  await pub(a).initialize();
  const f = await consent();
  expect((await f.admit(a)).profile).toBe("full-access");
  expect((await pub(b).initialize()).outcome).toBe("mismatch");
  expect((await f.admit(a)).profile).toBe("full-access");
  await pub(b).initialize(activation());
  const afterB = await state();
  await expect(f.admit(a)).rejects.toThrow(/current permission configuration/);
  expect((await f.admit(b)).profile).toBe("approve-for-me");
  expect((await pub(a).initialize()).outcome).toBe("mismatch");
  await expect(pub(a).initialize(activation())).rejects.toThrow(/active=/);
  expect(await state()).toEqual(afterB);
  await pub(a).initialize({ activation: { expectedActiveHash: hashB() } });
  expect((await f.view(a)).profile).toBe("approve-for-me");
  expect((await f.admit(a)).profile).toBe("approve-for-me");
  expect((await f.row()).permission_consent).toBeNull();
  expect((await f.view(a)).scopeRevision).not.toBe(f.scopeRevision);
  const afterA = await state();
  expect(afterA.epochs.find((r) => r.kind === "platform")?.full_revision).toBe(
    (afterB.epochs.find((r) => r.kind === "platform")?.full_revision ?? 0) + 1,
  );
  await pub(a).initialize({ activation: { expectedActiveHash: hashB() } });
  expect(await state()).toEqual(afterA);
});

async function mixedIntents(full: Awaited<ReturnType<typeof consent>>) {
  return {
    rootConversationId: full.conversationId,
    full: await admittedIntent(full),
    network: await admittedIntent(await consent(), true),
    read: await admittedIntent(await consent(), true, "readFile"),
  };
}

function assertMixedEffects(
  before: Awaited<ReturnType<typeof state>>,
  after: Awaited<ReturnType<typeof state>>,
  intents: Awaited<ReturnType<typeof mixedIntents>>,
  changesNetwork: boolean,
) {
  const platform = before.epochs.find((row) => row.kind === "platform");
  if (!platform) throw new Error("Missing platform epoch fixture");
  expect(after.epochs).toEqual(
    before.epochs.map((row) =>
      row.kind === "platform"
        ? { ...row, revision: row.revision + 1, full_revision: row.full_revision + 1 }
        : row,
    ),
  );
  // H0 allowed -> H1 off removes Full in both orders. N0 -> N1 additionally removes
  // the existing a.example restricted exec scope; restricted readFile remains valid.
  const revoked = changesNetwork ? [intents.full, intents.network] : [intents.full];
  for (const row of after.intents) {
    const previous = before.intents.find((entry) => entry.operation_id === row.operation_id);
    expect(previous).toBeDefined();
    if (revoked.includes(row.operation_id))
      expect(row).toEqual({
        ...previous,
        state: "revoked",
        outcome_unknown: false,
        updated_at: row.updated_at,
      });
    else expect(row).toEqual(previous);
  }
  expect(after.intents).toHaveLength(before.intents.length);
  const oldOutboxIds = new Set(before.outbox.map((row) => row.id));
  expect(after.outbox.filter((row) => oldOutboxIds.has(row.id))).toEqual(before.outbox);
  const added = after.outbox.filter((row) => !oldOutboxIds.has(row.id));
  const root = before.roots.find((row) => row.id === intents.rootConversationId);
  if (!root) throw new Error("Missing Full root fixture");
  expect(root.permission_profile).toBe("full-access");
  const revision = root.permission_revision + 1;
  expect(after.roots).toEqual(
    before.roots.map((row) =>
      row.id === root.id
        ? {
            ...row,
            permission_profile: "approve-for-me",
            permission_consent: null,
            permission_revision: revision,
          }
        : row,
    ),
  );
  const expectedJobs = [
    ...revoked.map((operationId) => ({
      job_id: `sandbox-operation-revoke-${operationId}`,
      queue: "cap-kernel-maintenance",
      job_name: "sandbox-operation-revoke",
      data: { operationId },
      org_id: null,
    })),
    {
      job_id: `permission-recheck-${root.id}-${revision}`,
      queue: "cap-kernel-maintenance",
      job_name: "permission-approval-recheck",
      data: { orgId: root.org_id, rootConversationId: root.id, revision },
      org_id: root.org_id,
    },
  ];
  expect(
    added
      .map(({ job_id, queue, job_name, data, org_id }) => ({
        job_id,
        queue,
        job_name,
        data,
        org_id,
      }))
      .sort((a, b) => a.job_id.localeCompare(b.job_id)),
  ).toEqual(expectedJobs.sort((a, b) => a.job_id.localeCompare(b.job_id)));
}

it("mixed-hot-restart-payload-keeps-effective-network", async () => {
  await pub(a).initialize();
  const f = await consent();
  const effects = await mixedIntents(f);
  const beforeMixed = await state();
  const mixed = cfg("off", ["b.example"]);
  const config = a.app.get(KernelConfigService);
  await config.apply(mixed, (before, next) => pub(a).publish(before, next));
  assertMixedEffects(beforeMixed, await state(), effects, false);
  const effective = cfg("off");
  expect(config.get().sandbox.limits.allowHosts).toEqual(["a.example"]);
  expect((await state()).publication[0]).toMatchObject({
    fingerprint: permissionConfigFingerprint(effective),
    projection: permissionConfigProjection(effective),
  });
  // A real newly started replica with (H1,N0) can admit work immediately. The existing B
  // carries the frozen startup (H1,N1) and stays fenced until explicit activation.
  const matching = await startKernel(effective, { env: {}, logger: log });
  try {
    const provider = a.app.get(SandboxProviders).forName("@activation-dual");
    if (!provider) throw new Error("Missing test provider");
    matching.app.get(SandboxProviders).register(provider);
    expect((await f.admit(matching)).profile).toBe("approve-for-me");
  } finally {
    await matching.close();
  }
  await expect(f.admit(b)).rejects.toThrow(/current permission configuration/);
  expect((await f.admit(a)).profile).toBe("approve-for-me");
  const before = await state();
  await config.apply(cfg("off", ["future.example"]), (old, next) => pub(a).publish(old, next));
  expect(await state()).toEqual(before);
  expect((await f.admit(a)).profile).toBe("approve-for-me");
});

it.each(["watch", "activation"])(
  "mixed-watch-explicit-activation-both-orders: %s acquires first",
  async (first) => {
    await pub(a).initialize();
    const f = await consent();
    const effects = await mixedIntents(f);
    const before = await state();
    const loserHeld = gate(),
      loserRelease = gate();
    const held = gate(),
      release = gate();
    const owner = first === "watch" ? a : b;
    const ceilings = owner.app.get(PermissionCeilingWrites);
    const original = ceilings.lock.bind(ceilings);
    let intercepted = false;
    const spy = vi.spyOn(ceilings, "lock").mockImplementation(async (...args) => {
      await original(...args);
      if (!intercepted) {
        intercepted = true;
        held.resolve();
        await release.promise;
      }
    });
    const loserCeilings = (first === "watch" ? b : a).app.get(PermissionCeilingWrites);
    const originalLoser = loserCeilings.lock.bind(loserCeilings);
    const loserSpy = vi.spyOn(loserCeilings, "lock").mockImplementation(async (...args) => {
      await originalLoser(...args);
      loserHeld.resolve();
      await loserRelease.promise;
    });
    const watch = () =>
      a.app
        .get(KernelConfigService)
        .apply(cfg("off", ["b.example"]), (old, next) => pub(a).publish(old, next));
    const activate = () => pub(b).initialize(activation());
    let losing: Promise<unknown> | undefined;
    const winning = first === "watch" ? watch() : activate();
    const firstResult = winning.catch((e: unknown) => e);
    try {
      await held.promise;
      losing = (first === "watch" ? activate() : watch()).catch((e: unknown) => e);
      release.resolve();
      await winning;
      await loserHeld.promise;
      const afterWinner = await state();
      assertMixedEffects(before, afterWinner, effects, first === "activation");
      loserRelease.resolve();
      const loserResult = await losing;
      expect(await state()).toEqual(afterWinner);
      if (first === "watch") {
        expect(loserResult).toBeInstanceOf(Error);
        expect((await f.admit(a)).profile).toBe("approve-for-me");
        await expect(f.admit(b)).rejects.toThrow();
      } else {
        expect((await f.admit(b)).profile).toBe("approve-for-me");
        await expect(f.admit(a)).rejects.toThrow();
      }
      const expected = first === "watch" ? cfg("off") : cfg("off", ["b.example"]);
      expect((await state()).publication[0]).toMatchObject({
        fingerprint: permissionConfigFingerprint(expected),
        projection: permissionConfigProjection(expected),
      });
      expect(a.app.get(KernelConfigService).get().sandbox.limits.allowHosts).toEqual(["a.example"]);
    } finally {
      release.resolve();
      loserRelease.resolve();
      await firstResult;
      await losing;
      spy.mockRestore();
      loserSpy.mockRestore();
    }
  },
);

async function admittedIntent(
  f: Awaited<ReturnType<typeof consent>>,
  restricted = false,
  method: "exec" | "readFile" = "exec",
) {
  if (restricted)
    await db
      .updateTable("conversations")
      .set({ permission_profile: "approve-for-me", permission_consent: null })
      .where("id", "=", f.conversationId)
      .execute();
  const scope = await a.app
    .get(SandboxOperationAuthority)
    .resolve(f.ctx, method, new AbortController().signal);
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
      provider: "@activation-dual",
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

it("lost COMMIT acknowledgment across replicas preserves exactly one semantic and revoke transition", async () => {
  await pub(a).initialize();
  const f = await consent();
  const operationId = await admittedIntent(f);
  const abort = new AbortController(),
    committed = gate(),
    ack = gate();
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
  const run = pub(b).initialize({
    ...activation(),
    startup: { signal: abort.signal, remainingMs: () => 30_000 },
  });
  const outcome = run.catch((e: unknown) => e);
  try {
    await committed.promise;
    abort.abort();
    expect(await outcome).toMatchObject({ outcome: "uncertain" });
    spy.mockRestore();
    ack.resolve();
    const before = await state();
    expect(
      before.outbox.filter((row) => row.job_id === `sandbox-operation-revoke-${operationId}`),
    ).toHaveLength(1);
    expect((await pub(b).initialize(activation())).outcome).toBe("already-active");
    expect(await state()).toEqual(before);
    await expect(f.admit(a)).rejects.toThrow(/current permission configuration/);
    expect((await f.admit(b)).profile).toBe("approve-for-me");
  } finally {
    ack.resolve();
    spy.mockRestore();
  }
});

it("delegated DB writer serializes before frozen startup activation using current stored semantics", async () => {
  await pub(a).initialize();
  const config = a.app.get(KernelConfigService);
  const delegated = cfg("allowed");
  delete delegated.devices.autoMode;
  await config.apply(delegated, (old, next) => pub(a).publish(old, next));
  const f = await consent();
  await db
    .updateTable("accounts")
    .set({ is_super_admin: true })
    .where("id", "=", f.accountId)
    .execute();
  const before = await state();
  const entered = gate(),
    release = gate();
  const ceilings = a.app.get(PermissionCeilingWrites),
    original = ceilings.lock.bind(ceilings);
  const spy = vi.spyOn(ceilings, "lock").mockImplementation(async (...args) => {
    await original(...args);
    entered.resolve();
    await release.promise;
  });
  const setting = a.app
    .get(SettingsService)
    .update({ devicesAutoMode: { mode: "off" } }, f.accountId);
  const settingResult = setting.catch((e: unknown) => e);
  try {
    await entered.promise;
    const starting = pub(b).initialize({
      activation: { expectedActiveHash: permissionConfigFingerprint(delegated) },
      startup: { signal: new AbortController().signal, remainingMs: () => 30_000 },
    });
    release.resolve();
    await setting;
    expect((await starting).outcome).toBe("activated");
    const after = await state();
    expect(after.epochs.find((r) => r.kind === "platform")?.full_revision).toBe(
      (before.epochs.find((r) => r.kind === "platform")?.full_revision ?? 0) + 1,
    );
    expect(after.epochs.find((r) => r.kind === "platform")?.revision).toBe(
      (before.epochs.find((r) => r.kind === "platform")?.revision ?? 0) + 2,
    );
    expect((await f.admit(b)).profile).toBe("approve-for-me");
    await expect(f.admit(a)).rejects.toThrow();
  } finally {
    release.resolve();
    await settingResult;
    spy.mockRestore();
  }
});
