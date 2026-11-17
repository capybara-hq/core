import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type Connector,
  type ConnectorOpenArgs,
  type ExtensionContext,
  type ExtensionNet,
  isNetDeniedError,
  NetDeniedError,
} from "../src/index.js";

describe("ctx.net", () => {
  it("NetDeniedError carries name, code and host", () => {
    const e = new NetDeniedError("net.private_address", "10.0.0.1", "refused 10.0.0.1");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NetDeniedError");
    expect(e.code).toBe("net.private_address");
    expect(e.host).toBe("10.0.0.1");
    expect(e.message).toBe("refused 10.0.0.1");
  });

  it("NetDeniedError carries the status of a refused redirect", () => {
    expect(new NetDeniedError("net.redirect", "a.example", "redirect", 302).status).toBe(302);
    expect(new NetDeniedError("net.dns_failed", "a.example", "dns").status).toBeUndefined();
  });

  it("isNetDeniedError recognises the class and a copy from another package by name", () => {
    expect(isNetDeniedError(new NetDeniedError("net.redirect", "a.example", "redirect"))).toBe(
      true,
    );
    const copy = Object.assign(new Error("refused"), {
      name: "NetDeniedError",
      code: "net.insecure_url",
      host: "a.example",
    });
    expect(isNetDeniedError(copy)).toBe(true);
    expect(
      isNetDeniedError({
        name: "NetDeniedError",
        code: "net.dns_failed",
        host: "a.example",
        message: "no",
      }),
    ).toBe(true);
  });

  it("isNetDeniedError is false for anything else", () => {
    expect(isNetDeniedError(new Error("x"))).toBe(false);
    expect(isNetDeniedError({ name: "ModelError", code: "net.redirect", host: "a" })).toBe(false);
    expect(isNetDeniedError({ name: "NetDeniedError" })).toBe(false);
    expect(isNetDeniedError(null)).toBe(false);
    expect(isNetDeniedError(undefined)).toBe(false);
    expect(isNetDeniedError("NetDeniedError")).toBe(false);
  });

  it("ctx.net and ConnectorOpenArgs.orgId are part of the contract", () => {
    expectTypeOf<ExtensionContext["net"]>().toEqualTypeOf<ExtensionNet>();
    expectTypeOf<ConnectorOpenArgs["orgId"]>().toEqualTypeOf<string>();
    expectTypeOf<
      Parameters<NonNullable<Connector["inspect"]>>[0]["orgId"]
    >().toEqualTypeOf<string>();
  });
});
