import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type KernelRequest,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  SandboxScopeValidationError,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { PolicyStore } from "../src/policy-store.js";
import { serveOperationV3 } from "../src/server-ops.js";
import { DEFAULT_POLICY, readPolicy, writePolicy } from "../src/state.js";

const scope = {
  operationId: "op",
  admitBeforeMs: 1000,
  deviceId: "d",
  rootConversationId: "r",
  profileRevision: 0,
  ceilingRevision: "c",
  profile: "approve-for-me",
  actor: { accountId: "a", conversationId: "r" },
  tag: "op",
  filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
  network: { kind: "none" },
};
const handle = { id: "d" };
const request = (op: string, args: unknown) =>
  ({ type: "req", id: "request", op, args, deadlineMs: 1000 }) as KernelRequest;
const signal = new AbortController().signal;
describe("dormant v3 dispatch", () => {
  it("validates before any factory and binds authenticated exec grants to this operation", async () => {
    const exec = vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
      })),
      operation = vi.fn(async () => ({ exec }));
    const forExecution = vi.fn(() => ({ operation }));
    const backend = { forExecution } as unknown as MacOperationBackend;
    const limits = {
      cpu: 1,
      memoryMb: 512,
      diskMb: 1024,
      network: { kind: "allowlist", hosts: ["api.example.com"] },
    };
    const grants = {
      hosts: ["api.example.com"],
      source: { kind: "run", id: "run", accountId: "a" },
    };
    expect(
      await serveOperationV3(
        backend,
        handle,
        request("exec", { command: "true", timeoutMs: 100, maxOutputBytes: 100, limits, grants }),
        signal,
      ),
    ).toMatchObject({ ok: false });
    expect(forExecution).not.toHaveBeenCalled();
    expect(
      await serveOperationV3(
        backend,
        handle,
        request("exec", {
          scope,
          command: "true",
          timeoutMs: 100,
          maxOutputBytes: 100,
          limits,
          grants,
        }),
        signal,
      ),
    ).toMatchObject({ ok: true });
    expect(forExecution).toHaveBeenCalledWith({
      operationId: "op",
      orgNetwork: limits.network,
      grants,
    });
    expect(exec).toHaveBeenCalledWith({
      command: "true",
      timeoutMs: 100,
      maxOutputBytes: 100,
      signal,
    });
  });
  it("preserves denial, unsupported and unknown outcomes without native fallback", async () => {
    for (const [error, kind] of [
      [new SandboxScopeDeniedError("denied"), "denied"],
      [new SandboxPermissionUnsupportedError("unsupported"), "unsupported"],
      [new SandboxOperationOutcomeUnknownError("unknown"), "unknown"],
      [new SandboxScopeValidationError("invalid"), "invalid"],
    ] as const) {
      const raw = vi.fn();
      const backend = {
        operation: async () => {
          throw error;
        },
        stat: raw,
      } as unknown as MacOperationBackend;
      expect(
        await serveOperationV3(
          backend,
          handle,
          request("stat", { scope, path: "/work/file" }),
          signal,
        ),
      ).toMatchObject({ ok: false, error: { kind } });
      expect(raw).not.toHaveBeenCalled();
    }
  });
  it("refuses a scope the contract makes invalid with the typed invalid kind, before any factory", async () => {
    const operation = vi.fn();
    const backend = { operation } as unknown as MacOperationBackend;
    // the environment network is legal only with the device filesystem (the escalated pair)
    const response = await serveOperationV3(
      backend,
      handle,
      request("stat", { scope: { ...scope, network: { kind: "environment" } }, path: "/work/f" }),
      signal,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { kind: "invalid", message: expect.stringMatching(/environment/) },
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it("preparation exposes its own narrow factory and encodes native bytes", async () => {
    const readFile = vi.fn(async () => ({ data: new Uint8Array([65]), truncated: false })),
      prepare = vi.fn(async () => ({ readFile }));
    const backend = { prepare } as unknown as MacOperationBackend;
    const prep = {
      operationId: "prep",
      deviceId: "d",
      purpose: "skills",
      writeRoots: ["/skills"],
      tag: "prep",
    };
    expect(
      await serveOperationV3(
        backend,
        handle,
        request("prepareReadFile", { scope: prep, path: "/skills/marker", maxBytes: 10 }),
        signal,
      ),
    ).toMatchObject({ ok: true, result: { dataB64: "QQ==", truncated: false } });
    expect(prepare).toHaveBeenCalledWith(handle, prep, signal);
    expect(readFile).toHaveBeenCalledWith("/skills/marker", { maxBytes: 10, signal });
  });
});

describe("deployment policy ops and keepAwake", () => {
  it("a deployment policy op keeps keepAwake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "device-ops-keep-awake-"));
    try {
      writePolicy(dir, {
        ...DEFAULT_POLICY,
        allowedDomains: ["a.com", "b.com"],
        keepAwake: "connected",
      });
      const store = new PolicyStore(dir);
      const res = await serveOperationV3(
        {} as MacOperationBackend,
        handle,
        request("policy", {
          opId: "op_keep_awake_1",
          source: { approvalId: "a", accountId: "acc", accountName: "Ada", via: "web" },
          remove: ["a.com"],
        }),
        signal,
        undefined,
        {
          store,
          report: () => ({
            version: 3,
            sequence: 0,
            revision: "rev",
            outsideSandbox: false,
            network: "allowlist",
            restrictedProjectReach: "workspace",
            allowedDomains: [],
          }),
          reconcile: async () => {},
        } as never,
      );
      expect(res).toMatchObject({ ok: true });
      expect(readPolicy(dir)).toMatchObject({ allowedDomains: ["b.com"], keepAwake: "connected" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
