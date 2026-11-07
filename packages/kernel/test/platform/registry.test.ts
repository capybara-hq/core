import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineOperation,
  PLATFORM_DOMAINS,
  type PlatformOperation,
} from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";

const read = (id: string, description: string): PlatformOperation =>
  defineOperation({
    id,
    description,
    input: z.object({}),
    example: {},
    authz: { orgAction: "org.read" },
    mirrors: [],
    confirm: "read",
    run: async () => null,
  }) as PlatformOperation;

const write = (id: string, withSummary: boolean): PlatformOperation =>
  defineOperation({
    id,
    description: "Create something.",
    input: z.object({ name: z.string().max(64) }),
    example: { name: "x" },
    authz: { orgAction: "skills.manage" },
    mirrors: [],
    confirm: "org",
    ...(withSummary && {
      summary: (i: { name: string }) => ({ zh: `新建 ${i.name}`, en: `Create ${i.name}` }),
    }),
    run: async () => null,
  }) as PlatformOperation;

describe("PlatformOperations", () => {
  it("lists the phase 1 domains", () => {
    expect(new PlatformOperations().domains().map((d) => d.id)).toEqual(
      PLATFORM_DOMAINS.map((d) => d.id),
    );
    expect(PLATFORM_DOMAINS.map((d) => d.id)).toEqual([
      "platform",
      "skills",
      "agents",
      "agent-templates",
      "plugins",
      "marketplaces",
      "requests",
      "connectors",
      "extensions",
    ]);
  });

  it("throws on a duplicate id, within a batch or across batches", () => {
    const ops = new PlatformOperations();
    ops.register([read("skills.list", "List the org's skills.")]);
    expect(() => ops.register([read("skills.list", "Again.")])).toThrow(/duplicate/);
    expect(() =>
      new PlatformOperations().register([read("skills.get", "A."), read("skills.get", "B.")]),
    ).toThrow(/duplicate/);
  });

  it("throws on an id outside the domain list or not shaped <domain>.<verb>", () => {
    const ops = new PlatformOperations();
    expect(() => ops.register([read("billing.list", "List invoices.")])).toThrow(/domain/);
    expect(() => ops.register([read("skills", "No verb.")])).toThrow(/id/);
    expect(() => ops.register([read("skills.List", "Upper case.")])).toThrow(/id/);
  });

  it("throws on a write without a summary and accepts one with it", () => {
    const ops = new PlatformOperations();
    expect(() => ops.register([write("skills.create", false)])).toThrow(/summary/);
    ops.register([write("skills.create", true)]);
    expect(ops.get("skills.create")?.id).toBe("skills.create");
  });

  it("registers nothing from a batch that fails", () => {
    const ops = new PlatformOperations();
    expect(() =>
      ops.register([read("skills.list", "List."), write("skills.create", false)]),
    ).toThrow();
    expect(ops.all()).toEqual([]);
  });

  it("gets, lists by domain and lists all, sorted by id", () => {
    const ops = new PlatformOperations();
    ops.register([read("skills.list", "List."), read("agents.get", "Get.")]);
    ops.register([read("skills.get", "Get one.")]);
    expect(ops.get("agents.get")?.id).toBe("agents.get");
    expect(ops.get("agents.nope")).toBeNull();
    expect(ops.inDomain("skills").map((o) => o.id)).toEqual(["skills.get", "skills.list"]);
    expect(ops.inDomain("plugins")).toEqual([]);
    expect(ops.all().map((o) => o.id)).toEqual(["agents.get", "skills.get", "skills.list"]);
  });

  it("search ranks id words above description words", () => {
    const ops = new PlatformOperations();
    ops.register([
      read("agents.create", "Create an agent with its model, tools and skills."),
      read("plugins.list", "List the plugins: their skills, connectors and extensions."),
      read("skills.list", "List the org's library."),
      read("skills.get", "Get one entry of the library."),
      read("connectors.list", "List connectors."),
    ]);
    const hits = ops.search("skill", 10).map((o) => o.id);
    expect(hits.slice(0, 2).sort()).toEqual(["skills.get", "skills.list"]);
    expect(hits).toContain("agents.create");
    expect(hits).not.toContain("connectors.list");
    expect(ops.search("skill", 1)).toHaveLength(1);
    expect(ops.search("   ", 5)).toEqual([]);
  });
});
