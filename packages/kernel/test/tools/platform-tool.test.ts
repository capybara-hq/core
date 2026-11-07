import { ToolError } from "@capybara-hq/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "../../src/errors.js";
import type { ActorFacts } from "../../src/platform/actor.js";
import { toToolError } from "../../src/platform/errors.js";
import { defineOperation, type PlatformOperation } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { PLATFORM_UNAVAILABLE_OFF, platformTool } from "../../src/tools/builtins/platform.js";
import type {
  BuiltinCallContext,
  BuiltinTool,
  CallPolicyContext,
} from "../../src/tools/registry.js";

/**
 * The `Platform` builtin (spec §3, §5, §6) on a test registry of three operations and fake actor
 * facts: the five actions, the per-call policy, the re-check before `run` (Review Focus 3) and the
 * actionable errors for bad params and unknown operations (Review Focus 1).
 */

const ran: { id: string; input: unknown; agentId: string }[] = [];
let failWith: unknown = null;

const listOp = defineOperation({
  id: "skills.list",
  description: "List the org's skills. Each entry has an id and a name.",
  input: z.object({ cursor: z.string().max(100).optional() }),
  example: {},
  authz: { orgAction: "org.read" },
  mirrors: ["GET /api/v1/orgs/:orgId/skills"],
  confirm: "read",
  run: async (input, ctx) => {
    ran.push({ id: "skills.list", input, agentId: ctx.agentId });
    return Array.from({ length: 60 }, (_, i) => ({ id: `s${i}` }));
  },
});

const personalOp = defineOperation({
  id: "requests.create",
  description: "Create a request to the org admins. They see it in their inbox.",
  input: z.object({ text: z.string().min(1).max(500) }),
  example: { text: "Please enable the todo plugin." },
  authz: { orgAction: "org.read" },
  mirrors: ["POST /api/v1/orgs/:orgId/requests"],
  confirm: "personal",
  summary: (i) => ({ zh: `提交申请：${i.text}`, en: `Create a request: ${i.text}` }),
  run: async (input, ctx) => {
    ran.push({ id: "requests.create", input, agentId: ctx.agentId });
    return { id: "r1" };
  },
});

const orgOp = defineOperation({
  id: "skills.create",
  description: "Create an org skill from a name and a body.",
  input: z.object({ name: z.string().min(1).max(64), body: z.string().max(10_000) }),
  example: { name: "weekly-report", body: "# Weekly report" },
  authz: { orgAction: "org.update" },
  mirrors: ["POST /api/v1/orgs/:orgId/skills"],
  confirm: "org",
  summary: (i) => ({ zh: `创建组织技能 ${i.name}`, en: `Create the org skill ${i.name}` }),
  run: async (input, ctx) => {
    ran.push({ id: "skills.create", input, agentId: ctx.agentId });
    if (failWith !== null) throw failWith;
    return { name: input.name };
  },
});

const ADMIN: ActorFacts = {
  role: "admin",
  isSuperAdmin: false,
  personPresent: true,
  agentPrivateToActor: true,
  setting: "on",
};

let facts: ActorFacts;
let factsCalls: unknown[];
let setting: "on" | "read-only" | "off";
let tool: BuiltinTool;

beforeEach(() => {
  ran.length = 0;
  failWith = null;
  facts = ADMIN;
  factsCalls = [];
  setting = "on";
  const ops = new PlatformOperations();
  ops.register([listOp, personalOp, orgOp] as PlatformOperation[]);
  tool = platformTool({
    ops,
    actor: {
      facts: async (ctx) => {
        factsCalls.push(ctx);
        return facts;
      },
    },
    docs: {
      topics: () => [
        { id: "plugin-format", title: "The plugin format" },
        { id: "extension-points/channel", title: "channel@1" },
      ],
      read: (id) => (id === "plugin-format" ? "# The plugin format\n\nA tgz." : null),
    },
    setting: async () => setting,
  });
});

const ctx: BuiltinCallContext = {
  orgId: "org-1",
  accountId: "acc-1",
  agentId: "agent-1",
  conversationId: "conv-1",
  callId: "call-1",
  runId: "run-1",
  signal: new AbortController().signal,
};
const policyCtx: CallPolicyContext = {
  orgId: "org-1",
  accountId: "acc-1",
  agentId: "agent-1",
  conversationId: "conv-1",
  runId: "run-1",
};

/** Runs the tool and parses its JSON text result. */
async function run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await tool.run(input, ctx);
  if (!("content" in res) || typeof res.content === "string") throw new Error("no content");
  const block = res.content[0];
  if (block?.type !== "text") throw new Error("no text block");
  return JSON.parse(block.text) as Record<string, unknown>;
}

async function text(input: Record<string, unknown>): Promise<string> {
  const res = await tool.run(input, ctx);
  if (!("content" in res) || typeof res.content === "string") throw new Error("no content");
  const block = res.content[0];
  if (block?.type !== "text") throw new Error("no text block");
  return block.text;
}

async function toolError(input: Record<string, unknown>): Promise<string> {
  try {
    await tool.run(input, ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as ToolError).message;
  }
  throw new Error("expected a ToolError");
}

const policy = (input: Record<string, unknown>) => tool.callPolicy?.(input, policyCtx);

describe("the Platform tool definition", () => {
  it("is named Platform, allowed by default, with its key arguments and fixed description", () => {
    expect(tool.spec.name).toBe("Platform");
    expect(tool.defaultPolicy).toBe("allow");
    expect(tool.spec.keyArgs).toEqual(["action", "operation", "domain"]);
    expect(tool.spec.description).toBe(
      'Discover and use the platform\'s own operations (skills, agents, templates, plugins, marketplaces, requests, connectors, extensions) and its documentation, as the person you are working for. Start with action "browse", then "describe" an operation before you "call" it; never guess parameters. Writes ask the person to confirm. Use "read" for how-to documentation (plugin format, skills, extension points).',
    );
  });

  it("is unavailable when the org turned it off", async () => {
    expect(await tool.unavailable?.({ orgId: "org-1" })).toBeNull();
    setting = "read-only";
    expect(await tool.unavailable?.({ orgId: "org-1" })).toBeNull();
    setting = "off";
    expect(await tool.unavailable?.({ orgId: "org-1" })).toBe(PLATFORM_UNAVAILABLE_OFF);
    expect(PLATFORM_UNAVAILABLE_OFF).toBe(
      "The org turned the Platform tool off; ask an org admin to turn it on.",
    );
  });
});

describe("browse, search, describe, read", () => {
  it("browse without a domain returns every domain and the method", async () => {
    const out = await run({ action: "browse" });
    const domains = out.domains as { id: string; description: string; operations: number }[];
    expect(domains.map((d) => d.id)).toEqual([
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
    expect(domains.find((d) => d.id === "skills")?.operations).toBe(2);
    expect(out.method).toContain("describe");
    expect(out.method).toContain("Read before you write");
  });

  it("browse a domain lists its operations, read / write, and why one is unavailable", async () => {
    facts = { ...ADMIN, role: "member" };
    const out = await run({ action: "browse", domain: "skills" });
    expect(out.operations).toEqual([
      {
        id: "skills.create",
        description: "Create an org skill from a name and a body.",
        kind: "write",
        available: false,
        reason: expect.stringContaining("admin"),
      },
      {
        id: "skills.list",
        description: "List the org's skills.",
        kind: "read",
        available: true,
      },
    ]);
    // the facts come from the runtime context, never from the model's input
    expect(factsCalls).toEqual([policyCtx]);
  });

  it("browse an unknown domain names the domains", async () => {
    expect(await toolError({ action: "browse", domain: "nope" })).toMatch(
      /Unknown domain "nope".*skills.*browse/,
    );
  });

  it("search finds operations by a word of their id", async () => {
    const out = await run({ action: "search", query: "requests" });
    expect((out.operations as { id: string }[]).map((o) => o.id)).toEqual(["requests.create"]);
    expect(await toolError({ action: "search" })).toContain('"query"');
  });

  it("describe returns the input schema, the example, the class and the availability", async () => {
    const out = await run({ action: "describe", operation: "skills.create" });
    expect(out).toMatchObject({
      id: "skills.create",
      description: orgOp.description,
      kind: "write",
      confirm: "org",
      example: orgOp.example,
      available: true,
      related: ["skills.list"],
    });
    expect(out.inputSchema).toEqual(
      z.toJSONSchema(orgOp.input, { io: "input", unrepresentable: "any" }),
    );
  });

  it("an unknown operation is a tool error naming browse", async () => {
    for (const action of ["describe", "call"]) {
      expect(await toolError({ action, operation: "skills.nope" })).toMatch(
        /Unknown operation "skills.nope".*browse/,
      );
    }
    expect(await toolError({ action: "describe" })).toContain('"operation"');
  });

  it("read without a topic lists the topics; with one returns it; an unknown one says how to list", async () => {
    const out = await run({ action: "read" });
    expect(out.topics).toEqual([
      { id: "plugin-format", title: "The plugin format" },
      { id: "extension-points/channel", title: "channel@1" },
    ]);
    expect(await text({ action: "read", topic: "plugin-format" })).toContain("A tgz.");
    expect(await toolError({ action: "read", topic: "nope" })).toMatch(
      /Unknown topic "nope".*read without a topic/,
    );
  });
});

describe("call", () => {
  it("runs a read operation and caps a list at 50 entries", async () => {
    const out = await run({ action: "call", operation: "skills.list" });
    expect((out.items as unknown[]).length).toBe(50);
    expect(out).toMatchObject({ total: 60, truncated: true });
    expect(ran).toEqual([{ id: "skills.list", input: {}, agentId: "agent-1" }]);
  });

  it("invalid params are a tool error naming describe, and nothing runs (Review Focus 1)", async () => {
    const msg = await toolError({
      action: "call",
      operation: "skills.create",
      params: { name: 3 },
    });
    expect(msg).toContain("Invalid params for skills.create");
    expect(msg).toContain("describe");
    expect(ran).toEqual([]);
  });

  it("re-checks availability with fresh facts right before running (Review Focus 3)", async () => {
    const input = { action: "call", operation: "skills.create", params: orgOp.example };
    expect((await policy(input))?.policy).toBe("ask");
    // removed from the org between the confirmation and the run
    facts = { ...ADMIN, role: null };
    const msg = await toolError(input);
    expect(msg).toContain("skills.create is unavailable");
    expect(msg).toContain("not a member");
    expect(ran).toEqual([]);
  });

  it("an ApiError from an operation keeps its code and says what to do next", async () => {
    failWith = new ApiError("skill.name_exists", "A skill with this name already exists");
    const msg = await toolError({
      action: "call",
      operation: "skills.create",
      params: orgOp.example,
    });
    expect(msg).toBe(
      "skill.name_exists: A skill with this name already exists. Check the input with describe and call again, or ask the person.",
    );
  });

  it("an unexpected error is rethrown for the pipeline to log", async () => {
    failWith = new Error("boom");
    await expect(
      tool.run({ action: "call", operation: "skills.create", params: orgOp.example }, ctx),
    ).rejects.toThrow("boom");
  });
});

describe("callPolicy", () => {
  it("is null for every action but call (the tool's default allow)", async () => {
    for (const action of ["browse", "search", "describe", "read"]) {
      expect(await policy({ action, operation: "skills.create" })).toBeNull();
    }
  });

  it("an org operation asks, is never remembered and carries the kernel's summary", async () => {
    expect(
      await policy({ action: "call", operation: "skills.create", params: orgOp.example }),
    ).toEqual({
      key: "Platform:skills.create",
      policy: "ask",
      remember: false,
      summary: { zh: "创建组织技能 weekly-report", en: "Create the org skill weekly-report" },
    });
  });

  it("a personal operation asks and may be remembered; a read runs", async () => {
    expect(
      await policy({ action: "call", operation: "requests.create", params: { text: "hi" } }),
    ).toEqual({
      key: "Platform:requests.create",
      policy: "ask",
      remember: true,
      summary: { zh: "提交申请：hi", en: "Create a request: hi" },
    });
    expect(await policy({ action: "call", operation: "skills.list" })).toEqual({
      key: "Platform:skills.list",
      policy: "allow",
      remember: false,
    });
  });

  it("an unavailable operation is denied with its reason", async () => {
    facts = { ...ADMIN, role: "member" };
    const p = await policy({ action: "call", operation: "skills.create", params: orgOp.example });
    expect(p).toMatchObject({ key: "Platform:skills.create", policy: "deny", remember: false });
    expect(p?.denyReason).toContain("skills.create is unavailable");
    expect(p?.denyReason).toContain("admin");
  });

  it("an unknown operation or invalid params are denied with an actionable reason, never thrown", async () => {
    const unknown = await policy({ action: "call", operation: "skills.nope" });
    expect(unknown).toMatchObject({ key: "Platform:skills.nope", policy: "deny" });
    expect(unknown?.denyReason).toContain("browse");
    const bad = await policy({ action: "call", operation: "Not An Id!" });
    expect(bad).toMatchObject({ key: "Platform:unknown", policy: "deny" });
    const missing = await policy({ action: "call" });
    expect(missing).toMatchObject({ key: "Platform:unknown", policy: "deny" });
    expect(missing?.denyReason).toContain('"operation"');
    const invalid = await policy({ action: "call", operation: "skills.create", params: {} });
    expect(invalid).toMatchObject({ key: "Platform:skills.create", policy: "deny" });
    expect(invalid?.denyReason).toContain("describe");
  });
});

describe("toToolError", () => {
  it("passes a ToolError, rewrites an ApiError with its details, rethrows the rest", () => {
    const t = new ToolError("Use browse.");
    expect(toToolError(t)).toBe(t);
    expect(
      toToolError(new ApiError("validation_failed", "Bad input.", [{ path: "name" }])).message,
    ).toBe(
      'validation_failed: Bad input. Details: [{"path":"name"}] Check the input with describe and call again, or ask the person.',
    );
    expect(() => toToolError(new Error("x"))).toThrow("x");
  });
});
