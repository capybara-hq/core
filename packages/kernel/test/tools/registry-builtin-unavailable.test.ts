import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createLogger } from "../../src/log.js";
import {
  type BuiltinCallContext,
  type BuiltinTool,
  ToolRegistry,
} from "../../src/tools/registry.js";
import { noRowsDb } from "../helpers/disabled-tools.js";
import { pipelineFor } from "../helpers/tools.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

const probe = (
  unavailable: BuiltinTool["unavailable"],
  run: BuiltinTool["run"] = async () => ({ content: [{ type: "text", text: "ok" }] }),
): BuiltinTool => ({
  // a builtin name agents have by default (tools default-on spec §4)
  spec: { name: "CurrentTime", description: "A probe.", inputSchema: { type: "object" } },
  defaultPolicy: "allow",
  run,
  ...(unavailable !== undefined && { unavailable }),
});

// the org has no connectors here, so the registry runs without a database
const registryOf = (tool: BuiltinTool): ToolRegistry =>
  new ToolRegistry(
    noRowsDb(),
    { tools: () => [], enabledPlugins: async () => new Set() },
    { list: () => [] },
    { list: () => [tool] },
    { get: async () => ({ ok: true, config: {}, source: "platform" }) },
    { offKeys: async () => new Set() },
  );

const def = { disabledTools: [] };

describe("BuiltinTool.unavailable", () => {
  it("is awaited and receives the org id: unavailable for one org, resolved for another", async () => {
    const seen: string[] = [];
    const registry = registryOf(
      probe(async ({ orgId }) => {
        seen.push(orgId);
        return orgId === ORG_A ? "Probe is not configured for this organization." : null;
      }),
    );
    const a = await registry.forAgent(ORG_A, def);
    expect(a.tools).toEqual([]);
    // never asked for by the agent: explained only if the model names it (hidden)
    expect(a.unavailable).toEqual([]);
    expect(a.hidden).toEqual([
      { ref: "CurrentTime", reason: "Probe is not configured for this organization." },
    ]);
    const b = await registry.forAgent(ORG_B, def);
    expect(b.tools.map((t) => t.key)).toEqual(["CurrentTime"]);
    expect(b.hidden).toEqual([]);
    expect(seen).toEqual([ORG_A, ORG_B]);
  });

  it("still accepts a synchronous implementation", async () => {
    const registry = registryOf(probe(() => "nope"));
    expect((await registry.forAgent(ORG_A, def)).hidden).toEqual([
      { ref: "CurrentTime", reason: "nope" },
    ]);
  });
});

describe("BuiltinCallContext.parentRunId", () => {
  const exec = async (parent: { runId: string } | undefined): Promise<BuiltinCallContext> => {
    let got: BuiltinCallContext | undefined;
    const handler = async (_input: unknown, ctx: BuiltinCallContext) => {
      got = ctx;
      return { content: [{ type: "text" as const, text: "ok" }] };
    };
    const pipeline = pipelineFor({
      db: {} as never,
      registry: { handler: () => handler } as never,
      config: () =>
        KernelConfigSchema.parse({
          db: { url: "postgres://x" },
          redis: { url: "redis://x" },
          masterKey: Buffer.alloc(32, 1).toString("base64"),
        }),
      log: createLogger("error", { write: () => {} }),
    } as never);
    await pipeline.execute(
      {
        key: "Probe",
        source: { kind: "builtin", name: "Probe" },
      } as never,
      {},
      {
        orgId: ORG_A,
        conversationId: "c1",
        runId: "child-run",
        step: 0,
        agentId: "ag",
        accountId: "acc",
        signal: new AbortController().signal,
        ...(parent !== undefined && {
          parent: { conversationId: "parent-conv", runId: parent.runId, callId: "pc" },
        }),
      } as never,
      "call-1",
    );
    return got as BuiltinCallContext;
  };

  it("is the parent run for a sub-agent's call and absent otherwise", async () => {
    expect((await exec({ runId: "parent-run" })).parentRunId).toBe("parent-run");
    expect((await exec(undefined)).parentRunId).toBeUndefined();
  });
});
