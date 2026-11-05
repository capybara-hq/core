import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import {
  type DehydratedState,
  hashKey,
  hydrate,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { AppFrame } from "../../src/components/shell/AppFrame";
import type { OrgReadiness } from "../../src/lib/agents";
import { makeQueryClient, reviveDehydrated } from "../../src/lib/query/client";
import {
  conversationGroupsQuery,
  extensionPagesQuery,
  inboxCountQuery,
  meQuery,
  readinessQuery,
} from "../../src/lib/query/shell";
import type { ShellData } from "../../src/lib/server/session";
import type { Me } from "../../src/lib/session";
import { Link } from "./navigation";
import { ME } from "./render";

export const READY: OrgReadiness = { modelProvider: "ready", agents: 1 };
export const NOT_READY: OrgReadiness = { modelProvider: "none", agents: 0 };
export const PROVIDER_ONLY: OrgReadiness = { modelProvider: "ready", agents: 0 };

/**
 * The shell data the `(app)` layout would read for `me` (`getShell()`): a ready org with no
 * conversations, nothing pending and no extension pages; nothing org-scoped without an org.
 */
export function shellOf(me: Me = ME, o: Partial<ShellData> = {}): ShellData {
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  return {
    me,
    org,
    readiness: org === null ? null : READY,
    groups: org === null ? null : { groups: [], next: null, archivedCount: 0 },
    pending: org === null ? null : { count: 0, more: false },
    extensions: org === null ? null : [],
    ...o,
  };
}

let seededAt = Date.now();

/**
 * The cache the `(app)` layout would hand to the browser for `initial`, as the browser hydrates
 * it: a section that is `null` is a failed query (500 `internal`), anything else a success.
 */
export function shellState(initial: ShellData): DehydratedState {
  // each seed is newer than the last, as a later server render is
  const at = ++seededAt;
  const ok = (queryKey: readonly unknown[], data: unknown): DehydratedState["queries"][number] => ({
    queryKey,
    queryHash: hashKey(queryKey),
    dehydratedAt: at,
    state: {
      ...base,
      data,
      dataUpdateCount: 1,
      dataUpdatedAt: at,
      status: "success",
    },
  });
  const failed = (queryKey: readonly unknown[]): DehydratedState["queries"][number] => ({
    queryKey,
    queryHash: hashKey(queryKey),
    dehydratedAt: at,
    state: {
      ...base,
      error: { status: 500, code: "internal", message: "internal" } as unknown as Error,
      errorUpdateCount: 1,
      errorUpdatedAt: at,
      fetchFailureCount: 1,
      status: "error",
    },
  });
  const section = (queryKey: readonly unknown[], data: unknown) =>
    data === null ? failed(queryKey) : ok(queryKey, data);
  const orgId = initial.org?.orgId ?? null;
  return {
    mutations: [],
    queries: [
      ok(meQuery().queryKey, initial.me),
      ...(orgId === null
        ? []
        : [
            ok(readinessQuery(orgId).queryKey, initial.readiness),
            section(conversationGroupsQuery(orgId).queryKey, initial.groups),
            section(inboxCountQuery(orgId).queryKey, initial.pending),
            section(extensionPagesQuery(orgId).queryKey, initial.extensions),
          ]),
    ],
  };
}

const base = {
  data: undefined,
  dataUpdateCount: 0,
  dataUpdatedAt: 0,
  error: null,
  errorUpdateCount: 0,
  errorUpdatedAt: 0,
  fetchFailureCount: 0,
  fetchFailureReason: null,
  fetchMeta: null,
  isInvalidated: false,
  fetchStatus: "idle" as const,
};

/** A browser query client holding the shell data of `initial`. */
export function shellClient(initial: ShellData): QueryClient {
  const client = makeQueryClient();
  hydrate(client, reviveDehydrated(shellState(initial)));
  return client;
}

/**
 * The `(app)` layout's output for `initial` around `children`, inside the root providers; the
 * shell data sits in `client` (a fresh one holding `initial` unless given).
 */
export function frameElement(
  initial: ShellData,
  children: ReactNode = <p>page body</p>,
  { locale = "zh", version = "v9.9.9" }: { locale?: "zh" | "en"; version?: string } = {},
  client: QueryClient = shellClient(initial),
) {
  return (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
        <DesignProvider locale={locale} link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version={version}>{children}</AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

/**
 * Renders the frame; `update(next)` stands for the server sending new shell data
 * (`router.refresh()` resolved: the layout's fresh state hydrated into the same cache), keeping the
 * same children.
 */
export function renderFrame(
  initial: ShellData,
  children: ReactNode = <p>page body</p>,
  opts: { locale?: "zh" | "en"; version?: string } = {},
) {
  const client = shellClient(initial);
  const view = render(frameElement(initial, children, opts, client));
  return {
    ...view,
    client,
    update: (next: ShellData, nextChildren: ReactNode = children) => {
      act(() => hydrate(client, reviveDehydrated(shellState(next))));
      view.rerender(frameElement(next, nextChildren, opts, client));
    },
  };
}
