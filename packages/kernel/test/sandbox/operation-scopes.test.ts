import {
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  guardProviderConnection,
  providerConnectionFailure,
  SandboxProviderUnreachableError,
} from "../../src/sandbox/unreachable.js";

describe("nested operation boundaries", () => {
  const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  it("wraps operation, preparation, browse and background transport failures", async () => {
    const native = {
      async stat() {
        throw refused;
      },
    };
    const p = guardProviderConnection({
      async operation() {
        return native;
      },
      async prepare() {
        return native;
      },
      async browse() {
        return native;
      },
      background: {
        async stop() {
          throw refused;
        },
      },
    });
    for (const factory of [p.operation, p.prepare, p.browse]) {
      await expect((await factory()).stat()).rejects.toBeInstanceOf(
        SandboxProviderUnreachableError,
      );
    }
    await expect(p.background.stop()).rejects.toBeInstanceOf(SandboxProviderUnreachableError);
  });
  it("keeps permission and unknown-outcome verdicts distinct from connectivity", () => {
    for (const error of [
      new SandboxScopeDeniedError("denied", { cause: refused }),
      new SandboxPermissionUnsupportedError("unsupported", { cause: refused }),
      new SandboxOperationOutcomeUnknownError("unknown", { cause: refused }),
    ]) {
      expect(providerConnectionFailure(error)).toBeUndefined();
    }
  });
});

import type { SandboxOperationScope, SandboxProvider } from "@capybara-hq/plugin-sdk";
import { createHeldOperations, withKernelGeneration } from "../../src/sandbox/held-operations.js";

const scope = (revision: number): SandboxOperationScope => ({
  operationId: `op-${revision}`,
  admitBeforeMs: Date.now() + 30000,
  deviceId: "device",
  rootConversationId: "root",
  profileRevision: revision,
  ceilingRevision: `ceiling-${revision}`,
  profile: "approve-for-me",
  actor: { accountId: "owner", conversationId: "root" },
  tag: `op-${revision}`,
  filesystem: {
    kind: "scoped",
    readRoots: [`/root-${revision}`],
    writeRoots: [`/root-${revision}`],
  },
  network: { kind: "none" },
});
it("resolves once per actual native method and exposes no lifecycle or authority surface", async () => {
  const scopes: SandboxOperationScope[] = [];
  let revision = 1;
  const handle = { id: "device" };
  const signal = new AbortController().signal;
  const provider = {
    async permissionSupport() {
      return {
        version: 1,
        restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
        fullAccess: false,
        background: false,
      };
    },
    async revokeOperation() {},
    async operation(_h: unknown, s: SandboxOperationScope, sig: AbortSignal) {
      expect(sig).toBe(signal);
      scopes.push(s);
      return {
        async stat() {
          return { size: 1, isDir: false };
        },
        async readFile() {
          return { data: new Uint8Array([revision]), truncated: false };
        },
      };
    },
  } as unknown as SandboxProvider;
  const held = createHeldOperations(provider, handle, signal, async (_method, _input, invoke) =>
    invoke(scope(revision), signal),
  );
  expect(Object.keys(held).sort()).toEqual(["exec", "readFile", "stat", "writeFile"]);
  await held.stat(handle, "/root-1/file", signal);
  revision = 2;
  await held.readFile(handle, "/root-2/file", { maxBytes: 10, signal });
  expect(scopes.map((s) => s.profileRevision)).toEqual([1, 2]);
});
it("missing factories and unsupported runtime never fall back to raw exec", async () => {
  let rawCalls = 0;
  const signal = new AbortController().signal;
  for (const extra of [
    {},
    {
      async operation() {
        throw new Error("factory must not run");
      },
      async revokeOperation() {},
      async permissionSupport() {
        return { version: 1, restricted: null, fullAccess: true, background: false };
      },
    },
  ]) {
    const provider = {
      async exec() {
        rawCalls++;
      },
      ...extra,
    } as unknown as SandboxProvider;
    const held = createHeldOperations(
      provider,
      { id: "device" },
      signal,
      async (_method, _input, invoke) => invoke(scope(1), signal),
    );
    await expect(
      held.exec({ id: "device" }, { command: "true", timeoutMs: 100, maxOutputBytes: 100, signal }),
    ).rejects.toBeInstanceOf(SandboxPermissionUnsupportedError);
  }
  expect(rawCalls).toBe(0);
});

import { ownerPolicyRevokes } from "../../src/local-devices/policy-summary.js";

it("owner baseline removal preserves Full and explicit additions but revokes baseline-only exec", () => {
  const restricted = {
    ...scope(1),
    network: { kind: "allowlist" as const, hosts: ["api.example.com"] },
  };
  const next = { mode: "auto" as const, allowedDomains: [] };
  expect(ownerPolicyRevokes(next, restricted, "exec", [])).toBe(true);
  expect(ownerPolicyRevokes(next, restricted, "exec", ["api.example.com"])).toBe(false);
  expect(ownerPolicyRevokes(next, restricted, "stat", [])).toBe(false);
  expect(ownerPolicyRevokes(next, { ...restricted, profile: "full-access" }, "exec", [])).toBe(
    false,
  );
  expect(
    ownerPolicyRevokes(
      { ...next, mode: "sandbox" },
      { ...restricted, profile: "full-access" },
      "exec",
      [],
    ),
  ).toBe(true);
});

// final review m4: a cloud provider's background start is told the kernel's generation of the
// held instance; nothing else about the provider changes
describe("withKernelGeneration", () => {
  const ref = {
    executionId: "x",
    operationId: "op-1",
    instanceId: "i",
    instanceGeneration: "1700000000000",
  };
  it("adds instanceGeneration to start only; the other methods are the provider's own, bound to it", async () => {
    const seen: { self: unknown; args: unknown }[] = [];
    const background = {
      async start(this: unknown, _h: unknown, _s: unknown, args: unknown) {
        seen.push({ self: this, args });
        return ref;
      },
      async status(this: unknown) {
        seen.push({ self: this, args: "status" });
        return { state: "running" as const };
      },
      async stop(this: unknown) {
        seen.push({ self: this, args: "stop" });
        return { outcome: "stopped" as const };
      },
    };
    const provider = { concurrentExec: true, background } as unknown as SandboxProvider;
    const wrapped = withKernelGeneration(provider, "1700000000000");
    const signal = new AbortController().signal;
    const args = { command: "sleep 1", timeoutMs: 1000, signal } as never;
    expect(await wrapped.background?.start({ id: "i" }, scope(1), args)).toBe(ref);
    await wrapped.background?.status({ id: "i" }, ref, { signal } as never);
    await wrapped.background?.stop({ id: "i" }, ref, { graceMs: 5000, signal });
    expect(seen).toEqual([
      {
        self: background,
        args: { command: "sleep 1", timeoutMs: 1000, signal, instanceGeneration: "1700000000000" },
      },
      { self: background, args: "status" },
      { self: background, args: "stop" },
    ]);
    // the caller's input is not changed, nor is the provider
    expect(args).not.toHaveProperty("instanceGeneration");
    expect(provider.background).toBe(background);
    // every other member reads through to the provider
    expect(wrapped.concurrentExec).toBe(true);
  });
  it("a provider without background tasks is returned as it is", () => {
    const provider = { concurrentExec: true } as unknown as SandboxProvider;
    expect(withKernelGeneration(provider, "1")).toBe(provider);
  });
});
