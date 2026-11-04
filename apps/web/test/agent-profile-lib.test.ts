// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Agent, avatarValue } from "../src/lib/agents";
import { agentQuery, agentsQuery } from "../src/lib/query/agents";
import { useUpdateProfile } from "../src/lib/query/mutation";
import { bodyOf, json, stubApi } from "./support/api";

const profile = (over: Partial<Agent["profile"]> = {}): Agent["profile"] => ({
  avatar: null,
  description: "",
  quickActions: [],
  updatedAt: "2026-11-04T10:00:00.000Z",
  ...over,
});
const agent = (over: Partial<Agent["profile"]> = {}): Agent =>
  ({ id: "a1", orgId: "o1", profile: profile(over) }) as unknown as Agent;

afterEach(() => vi.unstubAllGlobals());

describe("agent profile lib", () => {
  it("avatarValue maps presets, uploads and null", () => {
    expect(avatarValue(agent(), "o1")).toBeNull();
    expect(avatarValue(agent({ avatar: { kind: "preset", id: "fox" } }), "o1")).toEqual({
      kind: "preset",
      id: "fox",
    });
    const src = "/api/v1/orgs/o1/agents/a1/avatar?v=2026-11-04T10%3A00%3A00.000Z";
    expect(avatarValue(agent({ avatar: { kind: "upload", uploadId: "u" } }), "o1")).toEqual({
      kind: "image",
      src,
    });
    expect(
      avatarValue(agent({ avatar: { kind: "external", url: "https://x.test/a.png" } }), "o1"),
    ).toEqual({ kind: "image", src });
  });

  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(agentQuery("o1", "a1").queryKey, agent());
    qc.setQueryData(agentsQuery("o1").queryKey, { agents: [agent()] });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    return { qc, wrapper };
  }

  it("a 409 surfaces agent.profile_conflict", async () => {
    const calls = stubApi({
      "PATCH /api/v1/orgs/o1/agents/a1/profile": () =>
        json(409, { error: { code: "agent.profile_conflict", message: "conflict" } }),
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useUpdateProfile("o1", "a1"), { wrapper });
    await act(async () => {
      result.current.mutate({ description: "x" });
    });
    await waitFor(() => expect(result.current.error?.code).toBe("agent.profile_conflict"));
    expect(bodyOf(calls[0])).toEqual({
      description: "x",
      expectedUpdatedAt: "2026-11-04T10:00:00.000Z",
    });
  });

  it("a profile update sets the cached agent without a refetch", async () => {
    const next = profile({ description: "new", updatedAt: "2026-11-04T11:00:00.000Z" });
    const calls = stubApi({
      "PATCH /api/v1/orgs/o1/agents/a1/profile": () => json(200, { profile: next }),
    });
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useUpdateProfile("o1", "a1"), { wrapper });
    await act(async () => {
      result.current.mutate({ description: "new" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(qc.getQueryData<Agent>(agentQuery("o1", "a1").queryKey)?.profile).toEqual(next);
    expect(
      qc.getQueryData<{ agents: Agent[] }>(agentsQuery("o1").queryKey)?.agents[0]?.profile,
    ).toEqual(next);
    expect(calls).toHaveLength(1);
  });
});
