import { describe, expect, it } from "vitest";
import { validatePermissions } from "../src/index.js";

const check = (deviceAccess: unknown) => validatePermissions("browser", { deviceAccess });

describe("permissions.deviceAccess", () => {
  it('accepts deviceAccess with services ["browser"]', () => {
    expect(check({ services: ["browser"] })).toEqual([]);
  });

  it("does not need provides", () => {
    expect(
      validatePermissions("browser", { deviceAccess: { services: ["a", "b-2"] } }, []),
    ).toEqual([]);
  });

  it("rejects an empty services list", () => {
    expect(check({ services: [] }).join("\n")).toMatch(/deviceAccess/);
  });

  it('rejects "Browser" and a 33-char name', () => {
    expect(check({ services: ["Browser"] }).join("\n")).toMatch(/deviceAccess/);
    expect(check({ services: [`a${"b".repeat(32)}`] }).join("\n")).toMatch(/deviceAccess/);
    expect(check({ services: [`a${"b".repeat(31)}`] })).toEqual([]);
  });

  it("rejects more than 4 services", () => {
    expect(check({ services: ["a", "b", "c", "d", "e"] }).join("\n")).toMatch(/deviceAccess/);
    expect(check({ services: ["a", "b", "c", "d"] })).toEqual([]);
  });

  it("rejects other shapes", () => {
    expect(check(true)).not.toEqual([]);
    expect(check({ services: ["a"], exec: true })).not.toEqual([]);
    expect(check({ services: ["a", "a"] })).not.toEqual([]);
  });
});

describe("permissions.deviceAccess.loopbackPorts", () => {
  it("accepts deviceAccess.loopbackPorts and refuses other keys", () => {
    expect(check({ services: ["browser"], loopbackPorts: true })).toEqual([]);
    expect(check({ services: ["browser"], loopbackPorts: false })).toEqual([]);
    expect(check({ services: ["browser"], loopbackPorts: "yes" })).not.toEqual([]);
    expect(check({ services: ["browser"], ports: [1] }).join("\n")).toContain(
      "permissions.deviceAccess must be { services: string[], loopbackPorts?: boolean }",
    );
  });
});
