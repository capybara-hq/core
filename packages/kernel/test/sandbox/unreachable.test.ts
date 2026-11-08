import { FileSystemGoneError, SandboxGoneError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  guardProviderConnection,
  providerConnectionFailure,
  SandboxProviderUnreachableError,
} from "../../src/sandbox/unreachable.js";

const sock = (message: string, code: string, syscall?: string) =>
  Object.assign(new Error(message), { code, ...(syscall !== undefined && { syscall }) });

describe("providerConnectionFailure", () => {
  it("never connected: refused, unknown host, unreachable, any error of connect / getaddrinfo", () => {
    expect(
      providerConnectionFailure(
        sock("connect ECONNREFUSED 127.0.0.1:2375", "ECONNREFUSED", "connect"),
      ),
    ).toBe("connect");
    expect(
      providerConnectionFailure(sock("getaddrinfo ENOTFOUND docker", "ENOTFOUND", "getaddrinfo")),
    ).toBe("connect");
    expect(providerConnectionFailure(sock("x", "EHOSTUNREACH"))).toBe("connect");
    expect(
      providerConnectionFailure(sock("connect ETIMEDOUT 10.0.0.1:2375", "ETIMEDOUT", "connect")),
    ).toBe("connect");
    // a unix socket that is not there
    expect(
      providerConnectionFailure(sock("connect ENOENT /var/run/docker.sock", "ENOENT", "connect")),
    ).toBe("connect");
    expect(
      providerConnectionFailure(sock("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT")),
    ).toBe("connect");
  });

  it("broke after connecting: reset, timed out while reading, socket hang up", () => {
    expect(providerConnectionFailure(sock("read ECONNRESET", "ECONNRESET", "read"))).toBe(
      "dropped",
    );
    expect(providerConnectionFailure(sock("x", "ETIMEDOUT"))).toBe("dropped");
    expect(providerConnectionFailure(new Error("socket hang up"))).toBe("dropped");
    expect(providerConnectionFailure(sock("other side closed", "UND_ERR_SOCKET"))).toBe("dropped");
  });

  it("finds a wrapped socket error: fetch's cause, an AggregateError per address", () => {
    const refused = sock("connect ECONNREFUSED 127.0.0.1:2375", "ECONNREFUSED", "connect");
    expect(providerConnectionFailure(new TypeError("fetch failed", { cause: refused }))).toBe(
      "connect",
    );
    const both = Object.assign(new AggregateError([refused, refused], ""), {
      code: "ECONNREFUSED",
    });
    expect(providerConnectionFailure(new TypeError("fetch failed", { cause: both }))).toBe(
      "connect",
    );
    expect(providerConnectionFailure(new AggregateError([refused]))).toBe("connect");
  });

  it("anything else is not a connection failure, nor the provider's gone verdicts", () => {
    expect(providerConnectionFailure(new Error("invalid sandbox tag"))).toBeUndefined();
    expect(providerConnectionFailure(sock("x", "EACCES", "open"))).toBeUndefined();
    expect(providerConnectionFailure("ECONNREFUSED")).toBeUndefined();
    expect(providerConnectionFailure(undefined)).toBeUndefined();
    const refused = sock("x", "ECONNREFUSED", "connect");
    expect(
      providerConnectionFailure(new SandboxGoneError("gone", { cause: refused })),
    ).toBeUndefined();
    expect(
      providerConnectionFailure(new FileSystemGoneError("gone", { cause: refused })),
    ).toBeUndefined();
  });
});

describe("guardProviderConnection", () => {
  const refused = sock("connect ECONNREFUSED 127.0.0.1:2375", "ECONNREFUSED", "connect");
  const impl = {
    concurrentExec: true as const,
    calls: 0,
    async ok(x: number) {
      this.calls++;
      return x + 1;
    },
    async refused() {
      throw refused;
    },
    async gone() {
      throw new SandboxGoneError("gone");
    },
    async other() {
      throw new Error("boom");
    },
  };
  const g = guardProviderConnection(impl);

  it("passes results, properties and `this` through", async () => {
    expect(g.concurrentExec).toBe(true);
    expect(await g.ok(1)).toBe(2);
    expect(impl.calls).toBe(1);
  });

  it("rethrows a connection failure as SandboxProviderUnreachableError with the raw cause", async () => {
    const e = await g.refused().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxProviderUnreachableError);
    expect((e as SandboxProviderUnreachableError).failure).toBe("connect");
    expect((e as Error).cause).toBe(refused);
  });

  it("leaves every other error unchanged", async () => {
    await expect(g.gone()).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(g.other()).rejects.toThrow("boom");
  });
});
