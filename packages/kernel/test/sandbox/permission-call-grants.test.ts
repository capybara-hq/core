import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { describeOperationPayload } from "../../src/sandbox/operation-payloads.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { permissionFixture } from "../helpers/permission-policy.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pg: TestContainer, redis: TestContainer, k: TestKernel, raw: ReturnType<typeof createDb>;
beforeAll(async () => {
  [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pg.url, poolMax: 8 },
      redis: { url: redis.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
    }),
    {
      overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: () => true }],
      env: {},
      logger: createLogger("error", { write: () => {} }),
    },
  );
  raw = createDb(pg.url, 5);
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pg?.stop(), redis?.stop()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
});

const fixture = (
  toolKey = "Read",
  input: Record<string, unknown> = { file_path: "/work/a" },
  staged = false,
) => permissionFixture(k, raw, toolKey, input, staged);

import { PermissionProfileStore } from "../../src/conversations/permission-profile-store.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../../src/sandbox/permission-authority-lock.js";
import { PermissionCallGrants } from "../../src/sandbox/permission-call-grants.js";
import type { PermissionReviewSnapshot } from "../../src/sandbox/permission-call-types.js";
import { PermissionFacts, permissionScopeHash } from "../../src/sandbox/permission-facts.js";
import { buildPermissionCandidate } from "../../src/sandbox/review/permission-candidate.js";

const facts: PermissionReviewSnapshot = {
  orgId: "org",
  rootConversationId: "root",
  conversationId: "root",
  deviceId: "device",
  accountId: "owner",
  runId: "run",
  callId: "call",
  profile: "request-approval",
  profileRevision: 0,
  scopeRevision: "scope",
  authorityRevision: "authority",
  baseReadDirectories: ["/project"],
  baseWriteDirectories: ["/project"],
  baseHosts: [],
  workingRoot: "/project",
  outsideSandboxCeiling: true,
  broadProjectReach: true,
  fullConsent: false,
  unattended: false,
  availability: { state: "supported" },
  policy: {
    mode: "auto",
    allowedMode: "auto",
    localAllowedDomains: [],
    network: { kind: "open-public", hosts: [] },
  } as unknown as PermissionReviewSnapshot["policy"],
};
const candidate = (toolKey: string, input: unknown, f = facts) =>
  buildPermissionCandidate(
    { toolKey, specHash: "spec", rawInput: input, validatedInput: input },
    f,
  );
it.each(["Write", "Edit"])(
  "actual bare %s constructs a separate parent-directory proposal",
  (tool) => {
    expect(candidate(tool, { file_path: "/outside/reports/report.txt" })).toMatchObject({
      kind: "proposal",
      candidate: {
        targetPath: "/outside/reports/report.txt",
        scopeKind: "directories-and-hosts",
        permissionScope: {
          readDirectories: ["/outside/reports"],
          writeDirectories: ["/outside/reports"],
          hosts: [],
        },
      },
    });
  },
);
// The device never opens its owner-denied paths (the secret paths, its state directory) to a
// restricted grant: a call reaching one is refused with what works instead, never proposed for an
// approval (or a credential consent) that could never run.
describe("owner-denied device paths", () => {
  const homes = ["/home/u"];
  const atHome = { ...facts, baseReadDirectories: ["/home/u"], baseWriteDirectories: ["/home/u"] };
  const build = (toolKey: string, input: unknown, f = facts) =>
    buildPermissionCandidate(
      { toolKey, specHash: "spec", rawInput: input, validatedInput: input },
      f,
      homes,
    );
  it.each([
    ["Read", { file_path: "/home/u/.ssh/id_rsa" }, facts, "~/.ssh"],
    ["Read", { file_path: "/home/u/.ssh/id_rsa" }, atHome, "~/.ssh"],
    ["Write", { file_path: "/home/u/.ssh/authorized_keys" }, atHome, "~/.ssh"],
    ["Edit", { file_path: "/home/u/.aws/credentials" }, facts, "~/.aws"],
    ["Read", { file_path: "/home/u/.ssh" }, facts, "~/.ssh"],
    [
      "Write",
      { file_path: "/home/u/.config/capybara-device/policy.json" },
      facts,
      "~/.config/capybara-device",
    ],
    ["Bash", { command: "cd /home/u/.aws && ls" }, facts, "~/.aws"],
  ] as const)("%s %j is refused with an actionable text", (tool, input, f, named) => {
    const result = build(tool, input, f);
    expect(result).toMatchObject({ kind: "unsupported" });
    const message = (result as { message: string }).message;
    expect(message).toContain(named);
    expect(message).toMatch(/cannot be approved/);
    expect(message).toMatch(/Ask the user/);
  });
  it("an ordinary home path (and a lookalike name) is still proposed", () => {
    for (const path of ["/home/u/notes/a.txt", "/home/u/.sshfoo/a.txt", "/home/u/.config/other/a"])
      expect(build("Read", { file_path: path }), path).toMatchObject({ kind: "proposal" });
    expect(build("Read", { file_path: "/home/u/.ssh-notes" }, atHome)).toEqual({
      kind: "in-scope",
    });
  });
});
it("filesystem-root proposal is not a bounded directory", () => {
  expect(candidate("Write", { file_path: "/report.txt" })).toMatchObject({
    kind: "unsupported",
    code: "unbounded-scope",
  });
});
it("explicit cd directory and static URL host are exact proposals", () => {
  expect(
    candidate("Bash", { command: "cd /outside/reports && curl https://Example.com/a" }),
  ).toMatchObject({
    kind: "proposal",
    candidate: {
      permissionScope: {
        readDirectories: ["/outside/reports"],
        writeDirectories: ["/outside/reports"],
        hosts: ["example.com"],
      },
    },
  });
});
it("rejects 65 combined roots and accepts 64 without truncating", () => {
  const rootFacts = {
    ...facts,
    baseReadDirectories: Array.from({ length: 63 }, (_, i) => `/root${i}`),
    baseWriteDirectories: [],
  };
  expect(candidate("Write", { file_path: "/outside/report.txt" }, rootFacts).kind).toBe("proposal");
  expect(
    candidate(
      "Write",
      { file_path: "/outside/report.txt" },
      { ...rootFacts, baseReadDirectories: [...rootFacts.baseReadDirectories, "/last"] },
    ),
  ).toMatchObject({ kind: "unsupported" });
});
it("rejects 101 combined hosts and accepts 100 without truncating", () => {
  const hostFacts = {
    ...facts,
    baseHosts: Array.from({ length: 99 }, (_, i) => `h${i}.example.com`),
  };
  expect(candidate("Bash", { command: "curl https://extra.example.com" }, hostFacts).kind).toBe(
    "proposal",
  );
  expect(
    candidate(
      "Bash",
      { command: "curl https://extra.example.com" },
      { ...hostFacts, baseHosts: [...hostFacts.baseHosts, "last.example.com"] },
    ),
  ).toMatchObject({ kind: "unsupported" });
});
it("invalid and unbounded directories never widen authority", () => {
  for (const file_path of ["/a/*/file", `/outside/${"x".repeat(4096)}`, "/a/\0file"])
    expect(candidate("Write", { file_path })).toMatchObject({ kind: "unsupported" });
});
it("opaque Python and project generated-script edits get no expansion", () => {
  expect(candidate("Bash", { command: "python -c 'import os; print(os.getcwd())'" })).toEqual({
    kind: "in-scope",
  });
  expect(candidate("Write", { file_path: "package.json" })).toEqual({ kind: "in-scope" });
});

import { classifierMessage, parseReviewAnswer } from "../../src/sandbox/review/classifier.js";

it("independent classifier receives the same normalized object and refuses replacement authority", () => {
  const built = candidate("Write", { file_path: "/outside/reports/report.txt" });
  if (built.kind !== "proposal") throw new Error("Expected proposal");
  const message = classifierMessage({
    mode: "auto",
    kind: "write",
    text: "/outside/reports/report.txt",
    cwd: "/project",
    ruleHits: [],
    personMessages: "Create report",
    tag: "review-fixed",
    permissionCandidate: built.candidate,
  });
  expect(message).toContain(`<review-fixed>\n${JSON.stringify(built.candidate)}\n</review-fixed>`);
  expect(
    parseReviewAnswer(
      JSON.stringify({
        decision: "allow",
        reason: "Yes",
        permissionScope: { writeDirectories: ["/"] },
      }),
    ),
  ).toBeNull();
  expect(parseReviewAnswer('{"decision":"deny","reason":"No"}')).toEqual({
    decision: "deny",
    reason: "No",
  });
});

it("exact binding is required for expansion and exact evidence retries are immutable", async () => {
  const f = await fixture();
  const tx = k.app.get(TransactionHost),
    grants = k.app.get(PermissionCallGrants);
  let binding!: import("../../src/sandbox/permission-call-types.js").PermissionCallBinding;
  await tx.run(async () => {
    const subject = { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId };
    await k.app.get(PermissionAuthorityLock).acquire(subject, { kind: "admit" });
    const root = await k.app
      .get(PermissionProfileStore)
      .readOwnedRoot(f.orgId, f.conversationId, f.accountId);
    const view = await k.app.get(PermissionFacts).view(f.orgId, f.accountId, root);
    const vector = await k.app.get(PermissionAuthorityEpochStore).readLocked(subject);
    const { policy } = await k.app.get(PermissionFacts).readDevice(f.orgId, f.deviceId);
    const input = { file_path: "/outside/reports/report.txt" };
    // This second logged call is the actual input consumed by the trusted builder.
    await k.app.get(EventLog).appendIn(f.conversationId, [
      {
        type: "assistant_message",
        runId: f.runId,
        payload: {
          step: 2,
          stopReason: "tool_use",
          content: [{ type: "tool_call", id: "outside", name: "Write", input }],
        },
      },
    ]);
    const result = buildPermissionCandidate(
      { toolKey: "Write", specHash: "write-spec", rawInput: input, validatedInput: input },
      {
        orgId: f.orgId,
        rootConversationId: f.conversationId,
        conversationId: f.conversationId,
        deviceId: f.deviceId,
        accountId: f.accountId,
        runId: f.runId,
        callId: "outside",
        profile: view.profile,
        profileRevision: view.revision,
        scopeRevision: view.scopeRevision!,
        authorityRevision: permissionScopeHash({ scopeRevision: view.scopeRevision, vector }),
        baseReadDirectories: ["/work"],
        baseWriteDirectories: ["/work"],
        baseHosts: [],
        workingRoot: "/work",
        outsideSandboxCeiling: view.outsideSandboxCeiling,
        broadProjectReach: view.broadProjectReach,
        unattended: false,
        fullConsent: false,
        availability: view.availability,
        policy,
      },
    );
    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") throw new Error("Expected proposal");
    const c = result.candidate;
    binding = c.binding;
    const [e] = await k.app.get(EventLog).appendIn(f.conversationId, [
      {
        type: "permission_reviewed",
        runId: f.runId,
        payload: {
          ...c,
          outcome: "allow",
          reason: "The explicit directory is required.",
          decisionSource: "review-model",
        },
      },
    ]);
    if (!e) throw new Error("Missing review event");
    const decision = { source: "review-model" as const, reviewEventSeq: e.seq, decidedBy: null };
    const first = await grants.issueLocked(c, decision);
    expect(await grants.issueLocked(c, decision)).toEqual(first);
    const [otherEvidence] = await k.app.get(EventLog).appendIn(f.conversationId, [
      {
        type: "permission_reviewed",
        runId: f.runId,
        payload: {
          ...c,
          outcome: "allow",
          reason: "Another evidence locator",
          decisionSource: "review-model",
        },
      },
    ]);
    if (!otherEvidence) throw new Error("Missing second evidence event");
    await expect(
      grants.issueLocked(c, { ...decision, reviewEventSeq: otherEvidence.seq }),
    ).rejects.toThrow("different immutable permission evidence");
    expect(await grants.findForAdmission(c.binding)).toEqual({
      id: first.id,
      expansion: c.permissionScope,
      scopeKind: "directories-and-hosts",
      source: "review-model",
    });
    for (const key of Object.keys(c.binding)) {
      const value = c.binding[key as keyof typeof c.binding];
      expect(
        await grants.findForAdmission({
          ...c.binding,
          [key]: typeof value === "number" ? value + 1 : `${value}-changed`,
        }),
      ).toBeNull();
    }
    expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toHaveLength(0);
  });
  expect(await f.db.selectFrom("permission_call_grants").selectAll().execute()).toHaveLength(1);
  await tx.run(async () => {
    const subject = { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId };
    await k.app.get(PermissionAuthorityLock).acquire(subject, { kind: "write", level: "device" });
    const epochs = k.app.get(PermissionAuthorityEpochStore),
      current = await epochs.readLocked({ orgId: f.orgId, deviceId: f.deviceId });
    await epochs.bumpLocked("device", f.deviceId, current.device!);
  });
  await tx.run(async () => {
    await k.app
      .get(PermissionAuthorityLock)
      .acquire(
        { orgId: f.orgId, deviceId: f.deviceId, rootConversationId: f.conversationId },
        { kind: "admit" },
      );
    await expect(grants.findForAdmission(binding)).rejects.toThrow("Permissions changed");
  });
});

it.each(["exec", "backgroundStart"] as const)(
  "%s dispatch validates exact admitted input and original source across consumed retries",
  async (method) => {
    const f = await fixture();
    const service = k.app.get(PermissionCallGrants);
    const operationId = randomUUID();
    const scope = {
      operationId,
      admitBeforeMs: Date.now() + 30000,
      deviceId: f.deviceId,
      rootConversationId: f.conversationId,
      profileRevision: 1,
      ceilingRevision: "authority",
      profile: "approve-for-me" as const,
      actor: { accountId: f.accountId, conversationId: f.conversationId, runId: f.runId },
      tag: operationId,
      filesystem: { kind: "scoped" as const, readRoots: ["/work"], writeRoots: ["/work"] },
      network: { kind: "allowlist" as const, hosts: ["registry.npmjs.org"] },
    };
    const input = {
      command: "curl https://registry.npmjs.org",
      timeoutMs: 100,
      maxOutputBytes: 100,
    };
    const inputDigest = describeOperationPayload(input).digest;
    const original = {
      hosts: ["registry.npmjs.org"],
      source: { kind: "task" as const, id: "original-task", accountId: "original-decider" },
    };
    const executionGrants = { version: 1 as const, grants: original };
    await f.db
      .insertInto("sandbox_operation_intents")
      .values({
        operation_id: operationId,
        org_id: f.orgId,
        account_id: f.accountId,
        device_id: f.deviceId,
        root_conversation_id: f.conversationId,
        conversation_id: f.conversationId,
        run_id: f.runId,
        call_id: "transport-proof",
        ordinal: 0,
        method,
        input_hash: permissionScopeHash({ method, inputDigest }),
        admission_hash: permissionScopeHash({ method, inputDigest, scope, executionGrants }),
        granted_hosts: JSON.stringify(original.hosts),
        execution_grants: JSON.stringify(executionGrants),
        input: JSON.stringify(input),
        scope: JSON.stringify(scope),
        epochs: JSON.stringify({ platform: 0, org: 0, device: 0, root: 0 }),
        provider: "@local",
        provider_version: "test",
        instance_generation: "g",
        deadline: new Date(Date.now() + 30000),
        retain_until: new Date(Date.now() + 60000),
        execution_id: f.claim.executionId,
        state: "dispatching",
      })
      .execute();
    const dispatch = () => service.forExecution(operationId, f.deviceId, method, scope, input);
    expect(await dispatch()).toEqual(original);
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "started-or-unknown" })
      .where("operation_id", "=", operationId)
      .execute();
    expect(await dispatch()).toEqual(original);
    await expect(
      service.forExecution(operationId, f.deviceId, method, scope, {
        ...input,
        command: "different",
      }),
    ).rejects.toThrow("exact admitted execution");
    await expect(
      service.forExecution(
        operationId,
        f.deviceId,
        method,
        { ...scope, profileRevision: 2 },
        input,
      ),
    ).rejects.toThrow("exact admitted method and scope");
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({
        execution_grants: JSON.stringify({
          version: 1,
          grants: { ...original, source: { ...original.source, id: "forged" } },
        }),
      })
      .where("operation_id", "=", operationId)
      .execute();
    await expect(dispatch()).rejects.toThrow("exact admitted execution");
    const noGrant = { version: 1, grants: null };
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({
        execution_grants: JSON.stringify(noGrant),
        granted_hosts: "[]",
        admission_hash: permissionScopeHash({
          method,
          inputDigest,
          scope,
          executionGrants: noGrant,
        }),
      })
      .where("operation_id", "=", operationId)
      .execute();
    expect(await dispatch()).toBeUndefined();
    await expect(
      f.db
        .updateTable("sandbox_operation_intents")
        .set({ method: "stat" })
        .where("operation_id", "=", operationId)
        .execute(),
    ).rejects.toThrow("execution_grants_check");
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({ execution_grants: null })
      .where("operation_id", "=", operationId)
      .execute();
    await expect(dispatch()).rejects.toThrow("provenance is unavailable");
    await f.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "revoked" })
      .where("operation_id", "=", operationId)
      .execute();
    await expect(dispatch()).rejects.toThrow("no current admitted execution identity");
  },
);
