import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { type HookRunner, hookRequestOf, hookScope } from "../../src/runtime/hook-calls.js";

/** I-3 (F10): hook payloads carry no media bytes and no attachment ids. */
describe("hookRequestOf", () => {
  const png = Buffer.alloc(1000, 7).toString("base64");
  const pdf = Buffer.alloc(2, 1).toString("base64");
  const request: ModelRequest = {
    model: "m",
    system: [{ text: "sys", cache: true }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            mediaType: "image/png",
            name: "secret-plan.png",
            source: { kind: "base64", data: png },
          },
          { type: "document", mediaType: "application/pdf", source: { kind: "base64", data: pdf } },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "system", content: "reminder" },
    ],
    tools: [],
    maxOutputTokens: 10,
    params: {},
  };

  it("replaces images and documents with placeholders (kind, mediaType, decoded size)", () => {
    const out = hookRequestOf(request);
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "media_omitted", kind: "image", mediaType: "image/png", size: 1000 },
        { type: "media_omitted", kind: "document", mediaType: "application/pdf", size: 2 },
      ],
    });
    expect(out.messages.slice(1)).toEqual(request.messages.slice(1));
    expect(out.system).toBe(request.system);
    const json = JSON.stringify(out);
    expect(json).not.toContain(png);
    expect(json).not.toContain("secret-plan.png");
    // the request itself (sent to the provider and logged) is untouched
    expect(request.messages[0]?.content).toHaveLength(3);
    expect(JSON.stringify(request)).toContain(png);
  });

  it("a ref source never leaks its attachment id (size 0, warning)", () => {
    const warn = vi.fn();
    const id = "11111111-2222-4333-8444-555555555555";
    const out = hookRequestOf(
      {
        ...request,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/gif", source: { kind: "ref", attachmentId: id } },
            ],
          },
        ],
      },
      { warn },
    );
    expect(out.messages[0]?.content).toEqual([
      { type: "media_omitted", kind: "image", mediaType: "image/gif", size: 0 },
    ]);
    expect(JSON.stringify(out)).not.toContain(id);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** Sub-agents spec §11: hooks fire for chat and sub-agent conversations, never for eval replays. */
describe("hookScope", () => {
  const hooks = { has: () => true, run: async () => ({ allowed: true }) } as unknown as HookRunner;
  const base = {
    orgId: "o",
    accountId: "a",
    agentId: "g",
    agentVersion: 2,
    conversationId: "c-child",
    runId: "r-child",
  };
  const parent = { conversationId: "c-parent", runId: "r-parent", callId: "call-1" };

  it("a sub-agent's scope carries parent; a chat's has none", () => {
    expect(hookScope(hooks, { ...base, conversationKind: "subagent", parent })).toEqual({
      ...base,
      parent,
    });
    expect(hookScope(hooks, { ...base, conversationKind: "chat" })).toEqual(base);
  });

  it("eval replays fire none, with or without parent; nor without a registry", () => {
    expect(hookScope(hooks, { ...base, conversationKind: "eval", parent })).toBeNull();
    expect(hookScope(undefined, { ...base, conversationKind: "subagent", parent })).toBeNull();
  });
});
