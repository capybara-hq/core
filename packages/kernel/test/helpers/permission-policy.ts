import { randomUUID } from "node:crypto";
import {
  DEFAULT_SANDBOX_ROOTS,
  type SandboxOperationScope,
  type SandboxProvider,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { vi } from "vitest";
import { AgentDefinitionSchema } from "../../src/agents/definition.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import type { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import type { ExecutionClaim } from "../../src/runtime/run-execution.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { inSandboxOperations } from "../../src/tools/builtins/sandbox/common.js";
import { ToolPipeline, type ToolStepContext } from "../../src/tools/pipeline.js";
import { type ResolvedTool, specHash, ToolRegistry } from "../../src/tools/registry.js";
import { seedInstalledEvidence } from "../helpers/installed-evidence.js";
import type { TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

export async function permissionFixture(
  k: TestKernel,
  raw: ReturnType<typeof createDb>,
  toolKey = "Read",
  input: Record<string, unknown> = { file_path: "/work/a" },
  staged = false,
) {
  const seed = await seedConversation(raw),
    db = kernelDb(raw),
    deviceId = randomUUID(),
    runId = randomUUID(),
    executionId = randomUUID(),
    callId = randomUUID();
  await db
    .insertInto("memberships")
    .values({ org_id: seed.orgId, account_id: seed.accountId, role: "admin" })
    .execute();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: seed.orgId,
      owner_kind: "personal",
      owner_account_id: seed.accountId,
      source: "local",
      provider: "@permission-policy-test",
      name: "Laptop",
    })
    .execute();
  await db
    .insertInto("device_machines")
    .values({
      org_id: seed.orgId,
      device_id: deviceId,
      account_id: seed.accountId,
      credential_hash: randomUUID(),
      name: "Laptop",
      os: "darwin",
      arch: "arm64",
      features: ["mode", "projects"],
      roots: JSON.stringify({ workspace: "/work" }),
      home: "/home/owner",
      local_policy: JSON.stringify({ mode: "auto", allowedDomains: [] }),
    })
    .execute();
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", seed.conversationId)
    .execute();
  const roots = { ...DEFAULT_SANDBOX_ROOTS, workspace: "/work" };
  await db
    .insertInto("device_instances")
    .values({
      device_id: deviceId,
      org_id: seed.orgId,
      provider: "@permission-policy-test",
      status: "running",
      handle: JSON.stringify({ id: deviceId, roots }),
      created_at: new Date(1700000000000),
      fs_status: "ready",
      had_instance: true,
      instance_limits: JSON.stringify({
        mode: "auto",
        network: { kind: "open-public", hosts: [] },
      }),
    })
    .execute();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: seed.conversationId,
      execution_id: executionId,
      trigger_account_id: seed.accountId,
      status: "running",
      agent_version: 1,
      trigger_seq: 0,
    })
    .execute();
  let effects = 0;
  let nativeMethods: ("stat" | "readFile" | "writeFile")[] | undefined;
  const failures: unknown[] = [];
  const scopes: SandboxOperationScope[] = [];
  let effectHook: ((scope: SandboxOperationScope, method: string) => Promise<void>) | undefined;
  const provider = {
    async permissionSupport() {
      return {
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: true,
        background: false,
      };
    },
    async revokeOperation() {},
    async prepare() {
      return {
        async mkdir() {},
        async writeFile() {},
        async stat() {
          return null;
        },
      };
    },
    async operation(_h: unknown, scope: SandboxOperationScope) {
      scopes.push(scope);
      const check = (target: string, write: boolean) => {
        if (scope.filesystem.kind === "device") return;
        const roots = write ? scope.filesystem.writeRoots : scope.filesystem.readRoots;
        if (!roots.some((root) => target === root || target.startsWith(`${root}/`)))
          throw new SandboxScopeDeniedError(
            "Fixture enforcement refused access outside the admitted directories",
          );
      };
      return {
        async stat(target: string) {
          check(target, false);
          await effectHook?.(scope, "stat");
          effects++;
          return { size: 1, isDir: false };
        },
        async readFile(target: string) {
          check(target, false);
          await effectHook?.(scope, "readFile");
          effects++;
          return new Uint8Array([1]);
        },
        async writeFile(target: string) {
          check(target, true);
          await effectHook?.(scope, "writeFile");
          effects++;
        },
        async exec() {
          await effectHook?.(scope, "exec");
          effects++;
          return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
        },
      };
    },
  } as unknown as SandboxProvider;
  k.app
    .get(SandboxProviders)
    .register({ plugin: "@permission-policy-test", version: "test-1", impl: provider });
  const spec = {
    name: toolKey,
    description: "Operate on a project file.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" }, command: { type: "string" } },
    },
  };
  const tool: ResolvedTool = {
    key: toolKey,
    source: { kind: "builtin", name: toolKey },
    spec,
    specHash: specHash(spec),
    defaultPolicy: "allow",
  };
  const eventLog = k.app.get(EventLog);
  Object.assign((k.app.get(ToolPipeline) as unknown as { deps: object }).deps, {
    permissionOperations: new Set(staged ? [toolKey] : []),
  });
  if (!provider.permissionSupport) throw new Error("Missing staged support");
  // the runtime report, committed roots and installed binding admission proves (B-16)
  await seedInstalledEvidence(k, raw, {
    orgId: seed.orgId,
    deviceId,
    provider: "@permission-policy-test",
    version: "test-1",
    report: await provider.permissionSupport({ id: deviceId }, new AbortController().signal),
  });
  const install = (replica: TestKernel) => {
    replica.app
      .get(SandboxProviders)
      .register({ plugin: "@permission-policy-test", version: "test-1", impl: provider });
    Object.assign((replica.app.get(ToolPipeline) as unknown as { deps: object }).deps, {
      permissionOperations: new Set(staged ? [toolKey] : []),
    });
    const registry = replica.app.get(ToolRegistry);
    vi.spyOn(registry, "forAgent").mockResolvedValue({
      tools: [tool],
      unavailable: [],
      hidden: [],
      toolSearch: false,
    });
    vi.spyOn(registry, "handler").mockReturnValue(async (_input, ctx) => {
      const result = await inSandboxOperations<unknown>(
        {
          sandbox: replica.app.get(SandboxService),
          devices: replica.app.get(ConversationDevices),
          eventLog,
          config: replica.app.get(KernelConfigService),
          attachments: {
            listForConversation: async () => [],
            openForConversation: async () => {
              throw new Error("No attachments");
            },
          },
          storage: { available: () => false } as never,
        },
        ctx,
        async (s) => {
          if (nativeMethods) {
            for (const method of nativeMethods) {
              const target = String(input.file_path);
              if (method === "stat") await s.p.stat(s.h, target, s.signal);
              else if (method === "readFile")
                await s.p.readFile(s.h, target, { maxBytes: 100, signal: s.signal });
              else await s.p.writeFile(s.h, target, new Uint8Array([1]), s.signal);
            }
            return;
          }
          return toolKey === "Write" || toolKey === "Edit"
            ? s.p.writeFile(s.h, String(input.file_path), new Uint8Array([1]), s.signal)
            : toolKey === "Bash"
              ? s.p.exec(s.h, {
                  command: String(input.command),
                  cwd: "/work",
                  timeoutMs: 1000,
                  maxOutputBytes: 100,
                  signal: s.signal,
                })
              : s.p.stat(s.h, "/work/a", s.signal);
        },
      ).catch((error) => {
        failures.push(error);
        throw error;
      });
      return { content: [{ type: "text", text: JSON.stringify(result.value) }] };
    });
  };
  install(k);
  const claim: ExecutionClaim = {
    orgId: seed.orgId,
    conversationId: seed.conversationId,
    rootId: seed.conversationId,
    runId,
    executionId,
  };
  const ctx: ToolStepContext = {
    ...seed,
    runId,
    step: 1,
    agentVersion: 1,
    agent: AgentDefinitionSchema.parse({
      name: "Helper",
      instructions: "Help.",
      model: { provider: "model-fake", model: "fake-1" },
    }),
    source: "web",
    ownerAccountId: seed.accountId,
    role: "admin",
    signal: new AbortController().signal,
  };
  await eventLog.append(seed.conversationId, [
    {
      type: "assistant_message",
      runId,
      idemKey: assistantIdemKey(runId, 1),
      payload: {
        step: 1,
        stopReason: "tool_use",
        content: [{ type: "tool_call", id: callId, name: toolKey, input }],
      },
    },
  ]);
  await db
    .insertInto("agent_versions")
    .values({
      agent_id: seed.agentId,
      version: 1,
      definition: JSON.stringify(ctx.agent),
      created_by: seed.accountId,
    })
    .execute();
  return {
    setNativeMethods: (methods: typeof nativeMethods) => {
      nativeMethods = methods;
    },
    setEffectHook: (hook: typeof effectHook) => {
      effectHook = hook;
    },
    install,
    ...seed,
    db,
    deviceId,
    runId,
    callId,
    claim,
    ctx,
    effects: () => effects,
    scopes,
    failures,
  };
}
