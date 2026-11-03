// @vitest-environment jsdom
import {
  hashKey,
  hydrate,
  type QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQuery,
} from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/lib/api";
import {
  isHydratedError,
  makeQueryClient,
  noteClientPath,
  reviveDehydrated,
} from "../src/lib/query/client";
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

  describe("failed queries", () => {
    const key = keys.org("o").all;
    const failing = () => {
      throw new ApiClientError(404, "conversation.not_found", "gone");
    };

    async function hydratedClient() {
      const server = makeQueryClient();
      await server.fetchQuery({ queryKey: key, queryFn: failing, retry: false }).catch(() => {});
      // survives the server -> client serialization
      const wire = JSON.parse(JSON.stringify(dehydrateFor(server)));
      const client = makeQueryClient();
      hydrate(client, reviveDehydrated(wire));
      return client;
    }

    /** Mounts an observer the way a page does, waits a tick, then unmounts. */
    async function mount(client: QueryClient, queryFn: () => unknown) {
      const queryHash = hashKey(key);
      const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn: queryFn as () => Promise<unknown>,
        retryOnMount: !isHydratedError(queryHash),
      });
      const off = observer.subscribe(() => {});
      await new Promise((r) => setTimeout(r, 10));
      off();
    }

    /** A fresh document at `path`: the provider's first render records it. */
    let doc = 0;
    function openDocument() {
      // a path no earlier test used, then the document's own: the earlier errors are forgotten
      noteClientPath(`/__reset/${++doc}`);
      noteClientPath(`/doc/${doc}`);
      return `/doc/${doc}`;
    }

    it("a failed query is dehydrated with its kernel code", async () => {
      const client = await hydratedClient();
      const query = client.getQueryCache().find({ queryKey: key });
      expect(query?.state.status).toBe("error");
      const error = query?.state.error as ApiClientError;
      expect(error).toBeInstanceOf(ApiClientError);
      expect(error.code).toBe("conversation.not_found");
      expect(error.status).toBe(404);
    });

    it("a hydrated error is not refetched on its first mount, nor on a re-mount on the same path", async () => {
      const path = openDocument();
      const client = await hydratedClient();
      const fn = vi.fn(failing);
      await mount(client, fn);
      // StrictMode mounts twice; the provider renders again with the same path
      noteClientPath(path);
      await mount(client, fn);
      expect(fn).not.toHaveBeenCalled();
    });

    it("a hydrated error is refetched on a mount after a client navigation", async () => {
      openDocument();
      const client = await hydratedClient();
      await mount(client, failing);
      noteClientPath("/elsewhere");
      const fn = vi.fn(failing);
      await mount(client, fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("in StrictMode, a page's first mount does not refetch a hydrated error", async () => {
      openDocument();
      const client = await hydratedClient();
      const fn = vi.fn(failing);
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, createElement(QueryClientProvider, { client }, children));
      const { result } = renderHook(
        () =>
          useQuery({
            queryKey: key,
            queryFn: fn,
            retryOnMount: !isHydratedError(hashKey(key)),
          }),
        { wrapper },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(result.current.status).toBe("error");
      expect(fn).not.toHaveBeenCalled();
    });

    it("a query that failed in the browser is refetched on the next mount", async () => {
      openDocument();
      const client = makeQueryClient();
      await client.fetchQuery({ queryKey: key, queryFn: failing, retry: false }).catch(() => {});
      const fn = vi.fn(failing);
      await mount(client, fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
