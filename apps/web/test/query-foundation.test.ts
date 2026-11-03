import { hydrate } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/lib/api";
import { makeQueryClient, reviveDehydrated } from "../src/lib/query/client";
import { defineQuery } from "../src/lib/query/define";
import { FRESHNESS } from "../src/lib/query/freshness";
import { keys } from "../src/lib/query/keys";
import { dehydrateFor } from "../src/lib/server/query";

vi.mock("server-only", () => ({}));

describe("query foundation", () => {
  it("freshness classes have the spec's values", () => {
    expect(FRESHNESS).toEqual({
      mine: Infinity,
      orgConfig: 30_000,
      live: 30_000,
      events: Infinity,
      deployment: 30_000,
      unclassified: 0,
    });
  });

  it("every key starts with its scope", () => {
    expect(keys.org("o1").all).toEqual(["org", "o1"]);
    expect(keys.account("a1").all).toEqual(["account", "a1"]);
    expect(keys.deployment().all).toEqual(["deployment"]);
  });

  it("defineQuery maps freshness to staleTime", () => {
    const o = defineQuery({
      key: keys.org("o").all,
      fn: async () => 1,
      freshness: "orgConfig",
    });
    expect(o.staleTime).toBe(30_000);
    expect(o.queryKey).toEqual(["org", "o"]);
  });

  it("no retry for 4xx, one retry for network and 5xx", () => {
    const retry = makeQueryClient().getDefaultOptions().queries?.retry as (
      n: number,
      e: Error,
    ) => boolean;
    expect(retry(0, new ApiClientError(404, "x", "x"))).toBe(false);
    expect(retry(0, new ApiClientError(503, "x", "x"))).toBe(true);
    expect(retry(1, new ApiClientError(503, "x", "x"))).toBe(false);
    expect(retry(0, new ApiClientError(0, "network", "x"))).toBe(true);
  });

  it("refetch flags", () => {
    const q = makeQueryClient().getDefaultOptions().queries;
    expect(q?.refetchOnWindowFocus).toBe(false);
    expect(q?.refetchOnMount).toBe(true);
    expect(q?.refetchOnReconnect).toBe(true);
  });

  it("a failed query is dehydrated with its kernel code and is not retried on mount", async () => {
    const server = makeQueryClient();
    const key = keys.org("o").all;
    await server
      .fetchQuery({
        queryKey: key,
        queryFn: async () => {
          throw new ApiClientError(404, "conversation.not_found", "gone");
        },
        retry: false,
      })
      .catch(() => {});
    const dehydrated = dehydrateFor(server);
    // survives the server -> client serialization
    const wire = JSON.parse(JSON.stringify(dehydrated));
    const client = makeQueryClient();
    hydrate(client, reviveDehydrated(wire));
    const query = client.getQueryCache().find({ queryKey: key });
    expect(query?.state.status).toBe("error");
    const error = query?.state.error as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.code).toBe("conversation.not_found");
    expect(error.status).toBe(404);
    expect(client.getDefaultOptions().queries?.retryOnMount).toBe(false);
  });
});
