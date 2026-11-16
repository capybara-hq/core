import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FileSystemGoneError,
  isPermissionProfile,
  isSandboxGoneError,
  isSandboxOperationOutcomeUnknownError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  isSandboxScopeValidationError,
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  type SandboxBackground,
  type SandboxBrowse,
  SandboxGoneError,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  SandboxScopeValidationError,
} from "../src/index.js";

describe("isPermissionProfile", () => {
  it.each(["request-approval", "approve-for-me", "full-access"])("accepts %s", (value) => {
    expect(isPermissionProfile(value)).toBe(true);
  });

  it("rejects legacy modes, unknown names, inherited keys and non-string inputs", () => {
    for (const value of [
      "auto",
      "sandbox",
      "unknown",
      "",
      " full-access",
      "Full-access",
      "constructor",
      "toString",
      "__proto__",
      undefined,
      null,
      true,
      1,
      {},
      ["full-access"],
      { toString: () => "full-access" },
    ]) {
      expect(isPermissionProfile(value)).toBe(false);
    }
  });
});

describe.each([
  {
    name: "SandboxPermissionUnsupportedError",
    tag: "sandboxPermissionUnsupported",
    ErrorClass: SandboxPermissionUnsupportedError,
    isError: isSandboxPermissionUnsupportedError,
  },
  {
    name: "SandboxScopeDeniedError",
    tag: "sandboxScopeDenied",
    ErrorClass: SandboxScopeDeniedError,
    isError: isSandboxScopeDeniedError,
  },
  {
    name: "SandboxScopeValidationError",
    tag: "sandboxScopeValidation",
    ErrorClass: SandboxScopeValidationError,
    isError: isSandboxScopeValidationError,
  },
  {
    name: "SandboxOperationOutcomeUnknownError",
    tag: "sandboxOperationOutcomeUnknown",
    ErrorClass: SandboxOperationOutcomeUnknownError,
    isError: isSandboxOperationOutcomeUnknownError,
  },
])("$name", ({ name, tag, ErrorClass, isError }) => {
  it("preserves the caller's message and cause and is distinct from a gone instance", () => {
    const cause = new Error("The requested operation could not be authorized.");
    const message = "Choose a supported permission profile and retry the operation.";
    const error = new ErrorClass(message, { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(message);
    expect(error.cause).toBe(cause);
    expect(isError(error)).toBe(true);
    expect(isSandboxGoneError(error)).toBe(false);
    expect(isError(new ErrorClass(message))).toBe(true);
  });

  it("recognizes matching Error instances from another SDK copy", () => {
    const error = Object.assign(new Error("Operation refused."), { name, [tag]: true });
    expect(isError(error)).toBe(true);
  });

  it("requires an Error with both the exact name and a true tag", () => {
    for (const error of [
      new Error("Operation failed."),
      new SandboxGoneError("Instance gone."),
      new FileSystemGoneError("File system gone."),
      Object.assign(new Error("Wrong name."), { [tag]: true }),
      Object.assign(new Error("Missing tag."), { name }),
      Object.assign(new Error("False tag."), { name, [tag]: false }),
      Object.assign(new Error("Non-boolean tag."), { name, [tag]: "true" }),
      { name, [tag]: true },
      null,
      undefined,
    ]) {
      expect(isError(error)).toBe(false);
    }
  });
});

const validationError = expect.objectContaining({
  name: "SandboxScopeValidationError",
  sandboxScopeValidation: true,
});

const operationScope = () => ({
  operationId: "operation-1",
  admitBeforeMs: 1_800_000_000_000,
  deviceId: "device-1",
  rootConversationId: "root-1",
  profileRevision: 0,
  ceilingRevision: "ceiling-1",
  profile: "approve-for-me",
  actor: { accountId: "account-1", conversationId: "child-1", runId: "run-1" },
  tag: "operation-1",
  filesystem: { kind: "scoped", readRoots: ["/project"], writeRoots: ["/project/output"] },
  network: { kind: "allowlist", hosts: ["example.com", "*.example.org"] },
});

const browseScope = () => ({
  operationId: "browse-1",
  admitBeforeMs: 1_800_000_000_000,
  deviceId: "device-1",
  accountId: "account-1",
  ceilingRevision: "ceiling-1",
  readRoots: ["/"],
  tag: "browse-1",
});

const preparationScope = () => ({
  operationId: "prepare-1",
  deviceId: "device-1",
  purpose: "skills",
  writeRoots: ["/skills"],
  tag: "prepare-1",
});

const executionRef = () => ({
  executionId: "execution-1",
  operationId: "operation-1",
  instanceId: "instance-1",
  instanceGeneration: "generation-1",
});

describe("immutable operation scope parsing", () => {
  it("copies and deeply freezes all nested grants and actor fields", () => {
    const input = operationScope();
    const parsed = parseSandboxOperationScope(input);
    input.actor.accountId = "other-account";
    input.filesystem.readRoots.push("/private");
    input.filesystem.writeRoots[0] = "/";
    input.network.hosts.push("other.example.com");
    expect(parsed).toEqual(operationScope());
    expect(parsed).not.toBe(input);
    for (const value of [parsed, parsed.actor, parsed.filesystem, parsed.network]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    if (parsed.filesystem.kind !== "scoped" || parsed.network.kind !== "allowlist") {
      throw new Error("Expected scoped filesystem and allowlist grants.");
    }
    for (const value of [
      parsed.filesystem.readRoots,
      parsed.filesystem.writeRoots,
      parsed.network.hosts,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("accepts strict variants, empty grants and explicitly supplied root paths", () => {
    expect(
      parseSandboxOperationScope({
        ...operationScope(),
        profile: "full-access",
        filesystem: { kind: "device" },
        network: { kind: "environment" },
        actor: { accountId: "a", conversationId: "c" },
      }).filesystem,
    ).toEqual({ kind: "device" });
    expect(
      parseSandboxOperationScope({
        ...operationScope(),
        profile: "request-approval",
        filesystem: { kind: "scoped", readRoots: ["/"], writeRoots: [] },
        network: { kind: "none" },
      }).network,
    ).toEqual({ kind: "none" });
    expect(
      parseSandboxOperationScope({
        ...operationScope(),
        filesystem: { kind: "scoped", readRoots: [], writeRoots: [] },
        network: { kind: "allowlist", hosts: [] },
      }).filesystem,
    ).toEqual({ kind: "scoped", readRoots: [], writeRoots: [] });
  });

  it.each([
    { profile: "auto" },
    { profileRevision: -1 },
    { profileRevision: 0.5 },
    { profileRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ceilingRevision: "" },
    { ceilingRevision: "r".repeat(129) },
    { actor: { accountId: "a" } },
    { actor: { accountId: "a", conversationId: "c", admin: true } },
    { actor: { accountId: "a", conversationId: "c", runId: "" } },
    { tag: "invalid.tag" },
    { tag: "a".repeat(65) },
    { filesystem: { kind: "unknown" } },
    { filesystem: { kind: "device", readRoots: [] } },
    { network: { kind: "open-public" } },
    { network: { kind: "none", hosts: [] } },
    { network: { kind: "environment", hosts: [] } },
    { network: { kind: "allowlist", hosts: ["127.0.0.1"] } },
    { network: { kind: "allowlist", hosts: ["https://example.com"] } },
    { network: { kind: "allowlist", hosts: ["a".repeat(254)] } },
    { network: { kind: "allowlist", hosts: Array(101).fill("example.com") } },
  ])("rejects invalid or unknown operation fields: %j", (patch) => {
    expect(() => parseSandboxOperationScope({ ...operationScope(), ...patch })).toThrow(
      validationError,
    );
  });

  it("accepts exact maximum bounds without coercing revisions or deadlines", () => {
    const parsed = parseSandboxOperationScope({
      ...operationScope(),
      operationId: "o".repeat(128),
      ceilingRevision: "r".repeat(128),
      profileRevision: Number.MAX_SAFE_INTEGER,
      admitBeforeMs: Number.MAX_SAFE_INTEGER,
      tag: "a".repeat(64),
      filesystem: { kind: "scoped", readRoots: Array(64).fill("/"), writeRoots: [] },
      network: { kind: "allowlist", hosts: Array(100).fill("example.com") },
    });
    expect(parsed.profileRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsed.admitBeforeMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["request-approval", "approve-for-me"])(
    "preserves explicit expanded grants for %s without inferring policy",
    (profile) => {
      const parsed = parseSandboxOperationScope({
        ...operationScope(),
        profile,
        filesystem: { kind: "device" },
        network: { kind: "environment" },
      });
      expect(parsed.profile).toBe(profile);
      expect(parsed.filesystem).toEqual({ kind: "device" });
      expect(parsed.network).toEqual({ kind: "environment" });
    },
  );
});

describe.each([
  { name: "operation", parse: parseSandboxOperationScope, make: operationScope },
  { name: "browse", parse: parseSandboxBrowseScope, make: browseScope },
  { name: "preparation", parse: parseSandboxPreparationScope, make: preparationScope },
  { name: "execution reference", parse: parseSandboxExecutionRef, make: executionRef },
  {
    name: "operation reference",
    parse: parseSandboxOperationRef,
    make: () => ({ operationId: "operation-1", admitBeforeMs: 1_800_000_000_000 }),
  },
])("strict $name parser", ({ parse, make }) => {
  it("returns a frozen copy and rejects missing, unknown and invalid ID fields", () => {
    const input = make();
    const parsed = parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parse(Object.assign(Object.create(null), input))).toEqual(input);
    for (const value of [
      null,
      [],
      {},
      { ...input, extra: true },
      { ...input, operationId: "" },
      { ...input, operationId: "o".repeat(129) },
      { ...input, operationId: 1 },
    ]) {
      expect(() => parse(value)).toThrow(validationError);
    }
    for (const key of Object.keys(input)) {
      const missing = { ...input } as Record<string, unknown>;
      delete missing[key];
      expect(() => parse(missing)).toThrow(validationError);
    }
  });

  it("rejects inherited data, accessors and hidden unknown keys without evaluating getters", () => {
    const inherited = Object.create(make());
    expect(() => parse(inherited)).toThrow(validationError);
    const getter = Object.defineProperty(make(), "operationId", {
      get() {
        throw new Error("Getter must not execute.");
      },
      enumerable: true,
    });
    expect(() => parse(getter)).toThrow(validationError);
    expect(() => parse(Object.defineProperty(make(), "extra", { value: true }))).toThrow(
      validationError,
    );
    expect(() => parse({ ...make(), [Symbol("extra")]: true })).toThrow(validationError);
  });

  it("rejects missing required fields even when Object.prototype supplies valid data", () => {
    const input = make() as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      const missing = { ...input };
      delete missing[key];
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
      let failure: unknown;
      try {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          writable: true,
          value: input[key],
        });
        try {
          parse(missing);
        } catch (error) {
          failure = error;
        }
      } finally {
        if (previous) Object.defineProperty(Object.prototype, key, previous);
        else Reflect.deleteProperty(Object.prototype, key);
      }
      expect(failure, key).toEqual(validationError);
    }
  });

  it("rejects missing required fields without invoking Object.prototype getters", () => {
    const input = make() as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      const missing = { ...input };
      delete missing[key];
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
      let reads = 0;
      let failure: unknown;
      try {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            reads++;
            return input[key];
          },
        });
        try {
          parse(missing);
        } catch (error) {
          failure = error;
        }
      } finally {
        if (previous) Object.defineProperty(Object.prototype, key, previous);
        else Reflect.deleteProperty(Object.prototype, key);
      }
      expect(reads, key).toBe(0);
      expect(failure, key).toEqual(validationError);
    }
  });
});

describe.each([
  { parse: parseSandboxOperationScope, make: operationScope },
  { parse: parseSandboxBrowseScope, make: browseScope },
  { parse: parseSandboxOperationRef, make: () => ({ operationId: "op", admitBeforeMs: 1 }) },
])("admission deadline validation", ({ parse, make }) => {
  it("rejects nonpositive, unsafe and non-integer deadlines but does not perform a clock lookup", () => {
    for (const admitBeforeMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "123"]) {
      expect(() => parse({ ...make(), admitBeforeMs })).toThrow(validationError);
    }
    expect(parse({ ...make(), admitBeforeMs: 1 }).admitBeforeMs).toBe(1);
  });
});

describe("browse and preparation grants", () => {
  it("accepts owner browsing without a conversation and copies its bounded read roots", () => {
    const input = browseScope();
    const parsed = parseSandboxBrowseScope(input);
    input.readRoots.push("/private");
    expect(parsed.readRoots).toEqual(["/"]);
    expect(Object.isFrozen(parsed.readRoots)).toBe(true);
    for (const key of [
      "rootConversationId",
      "profile",
      "exec",
      "writeFile",
      "writeRoots",
      "purpose",
    ]) {
      expect(() => parseSandboxBrowseScope({ ...browseScope(), [key]: "unexpected" })).toThrow(
        validationError,
      );
    }
  });

  it("accepts only trusted preparation purposes and copies its write roots", () => {
    const input = preparationScope();
    const parsed = parseSandboxPreparationScope(input);
    input.writeRoots.push("/");
    expect(parsed.writeRoots).toEqual(["/skills"]);
    expect(Object.isFrozen(parsed.writeRoots)).toBe(true);
    expect(
      parseSandboxPreparationScope({ ...preparationScope(), purpose: "attachments" }).purpose,
    ).toBe("attachments");
    for (const patch of [
      { purpose: "exec" },
      { network: { kind: "environment" } },
      { profile: "full-access" },
    ]) {
      expect(() => parseSandboxPreparationScope({ ...preparationScope(), ...patch })).toThrow(
        validationError,
      );
    }
  });

  it.each([[], ["/"], [`/${"a".repeat(4095)}`]].map((roots) => ({ roots })))(
    "preserves valid path list %#",
    ({ roots }) => {
      expect(parseSandboxBrowseScope({ ...browseScope(), readRoots: roots }).readRoots).toEqual(
        roots,
      );
    },
  );

  it.each(
    [
      ["relative"],
      ["/../secret"],
      ["/%2e%2e/secret"],
      ["/a//b"],
      ["/a\\b"],
      ["/a\u0000b"],
      [`/${"a".repeat(4096)}`],
      Array(65).fill("/"),
      [1],
      "not-an-array",
    ].map((roots) => ({ roots })),
  )("rejects malformed or unbounded roots %#", ({ roots }) => {
    for (const parse of [
      () => parseSandboxBrowseScope({ ...browseScope(), readRoots: roots }),
      () => parseSandboxPreparationScope({ ...preparationScope(), writeRoots: roots }),
      () =>
        parseSandboxOperationScope({
          ...operationScope(),
          filesystem: { kind: "scoped", readRoots: roots, writeRoots: [] },
        }),
      () =>
        parseSandboxOperationScope({
          ...operationScope(),
          filesystem: { kind: "scoped", readRoots: [], writeRoots: roots },
        }),
    ])
      expect(parse).toThrow(validationError);
  });
});

it("validates every execution locator without accepting PID or path substitutes", () => {
  for (const key of ["executionId", "operationId", "instanceId", "instanceGeneration"]) {
    for (const value of ["", "x".repeat(129), 123, null]) {
      expect(() => parseSandboxExecutionRef({ ...executionRef(), [key]: value })).toThrow(
        validationError,
      );
    }
  }
  expect(() => parseSandboxExecutionRef({ ...executionRef(), pid: 123 })).toThrow(validationError);
});

it("keeps browse methods read-only and background controls precisely reference-bound", () => {
  expectTypeOf<keyof SandboxBrowse>().toEqualTypeOf<"stat" | "list" | "scan">();
  expectTypeOf<Parameters<SandboxBackground["tail"]>[2]>().toEqualTypeOf<{
    maxBytes: number;
    signal: AbortSignal;
  }>();
  expectTypeOf<Parameters<SandboxBackground["stop"]>[2]>().toEqualTypeOf<{
    graceMs: number;
    signal: AbortSignal;
  }>();
  expectTypeOf<Awaited<ReturnType<SandboxBackground["stop"]>>>().toEqualTypeOf<
    | { outcome: "already-exited"; exitCode: number | null; timedOut: boolean }
    | { outcome: "stopped" }
    | { outcome: "cancel-pending" }
    | { outcome: "lost" }
  >();
  expectTypeOf<Awaited<ReturnType<SandboxBackground["tail"]>>>().toEqualTypeOf<
    { data: Uint8Array; truncated: boolean } | { unavailable: "lost" | "expired" }
  >();
  expectTypeOf<Parameters<SandboxBackground["tail"]>[1]>().toEqualTypeOf<{
    readonly executionId: string;
    readonly operationId: string;
    readonly instanceId: string;
    readonly instanceGeneration: string;
  }>();
  expectTypeOf<Parameters<SandboxBackground["start"]>[2]>().toMatchTypeOf<{
    taskId: string;
    outputPath: string;
    retainUntilMs: number;
  }>();
});

it("distinguishes unsupported permissions from denied scopes", () => {
  expect(isSandboxScopeDeniedError(new SandboxPermissionUnsupportedError("Unsupported."))).toBe(
    false,
  );
  expect(isSandboxPermissionUnsupportedError(new SandboxScopeDeniedError("Denied."))).toBe(false);
});
