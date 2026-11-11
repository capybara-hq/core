"use client";

import { AppShell } from "@capybara-hq/design";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import AdminOverviewView from "../../app/(app)/admin/view";
import { ADMIN_PAGES } from "../../components/admin-nav";
import type {
  AdminAttention,
  AdminHealth,
  AdminHealthQueue,
  AdminOverview,
  PlatformAuditPage,
} from "../../lib/admin";
import type { PlatformInboxView } from "../../lib/admin-inbox";
import {
  adminAttentionQuery,
  adminHealthQuery,
  adminInboxQuery,
  adminOverviewQuery,
  platformAuditQuery,
} from "../../lib/query/admin";
import { meQuery } from "../../lib/query/shell";
import type { Me } from "../../lib/session";
import { COMMANDS } from "./fixtures";
import type { PageRoute } from "./routes";
import { sidebarProps, statusFixture } from "./shell-fixture";

// Real app pages drawn from a seeded query cache (no kernel), for the screenshot tests of pages
// whose sections each read for themselves (apps/web/visual/admin-overview.spec.ts).

const T = "2026-11-10T08:30:00.000Z";

const ME: Me = {
  account: { id: "a1", displayName: "Grant", email: null, isSuperAdmin: true },
  via: "session",
  currentOrgId: "o1",
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "owner" }],
  canCreateOrg: true,
};

const OVERVIEW: AdminOverview = { orgs: 4, accounts: 37, attentionTotal: 11 };

const INBOX: PlatformInboxView = {
  items: [],
  truncated: false,
  total: 6,
  byType: {
    catalog_request: 3,
    permission_confirmation: 1,
    scope_sync_failed: 2,
    platform_migration: 0,
    ownership_transferred: 0,
    org_upload_pending: 0,
  },
};

const ATTENTION: AdminAttention = {
  extensions: [
    {
      name: "lark",
      displayName: { zh: "飞书", en: "Lark" },
      icon: null,
      status: "pending_config",
      reason: "config",
    },
    {
      name: "sandbox-e2b",
      displayName: null,
      icon: null,
      status: "failed",
      reason: "load_failed",
    },
  ],
  updates: [
    {
      itemId: "11111111-1111-4111-8111-111111111111",
      name: "slack",
      displayName: { zh: "Slack", en: "Slack" },
      icon: null,
      version: "1.2.0",
      marketplaceVersion: "1.3.0",
      marketplaceId: "official",
      marketplaceName: "Capybara Official",
    },
  ],
  providers: [
    {
      plugin: "model-openai-compatible",
      displayName: { zh: "OpenAI 兼容", en: "OpenAI compatible" },
      icon: null,
      problem: "list_failed",
    },
  ],
  more: { extensions: 0, updates: 0, providers: 0 },
  unavailable: [],
};

const AUDIT: PlatformAuditPage = {
  events: [
    {
      id: "12",
      at: T,
      actor: { id: "a1", name: "Grant", email: null },
      viaToken: false,
      viaAgent: false,
      action: "deployment.settings.updated",
      target: null,
    },
    {
      id: "11",
      at: T,
      actor: { id: "a1", name: "Grant", email: null },
      viaToken: false,
      viaAgent: true,
      action: "catalog.scope_changed",
      target: "11111111-1111-4111-8111-111111111111",
    },
    {
      id: "10",
      at: T,
      actor: null,
      viaToken: false,
      viaAgent: false,
      action: "bootstrap.completed",
      target: null,
    },
    {
      id: "9",
      at: T,
      actor: { id: "a2", name: "Mia", email: "mia@example.com" },
      viaToken: true,
      viaAgent: false,
      action: "marketplace.added",
      target: "official",
    },
  ],
  next: null,
};

const QUEUE = (name: string, over: Partial<AdminHealthQueue> = {}): AdminHealthQueue => ({
  name,
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  failedLastDay: 0,
  ...over,
});

const HEALTH: AdminHealth = {
  kernel: { version: "0.1.0" },
  replicas: [
    { id: "kernel-7f9c2", roles: ["api"], version: "0.1.0", startedAt: T, httpReplicaId: "a" },
    { id: "kernel-1b04e", roles: ["api"], version: "0.1.0", startedAt: T, httpReplicaId: "b" },
    {
      id: "kernel-c55a1",
      roles: ["worker", "gateway"],
      version: "0.1.0",
      startedAt: T,
      httpReplicaId: null,
    },
  ],
  roles: { api: 2, worker: 1, gateway: 1 },
  queues: [
    QUEUE("cap-kernel-runs", { waiting: 3, active: 2, failed: 4, failedLastDay: 2 }),
    QUEUE("cap-kernel-subagent-runs", { active: 1 }),
    QUEUE("cap-kernel-channels", { waiting: 1, delayed: 2 }),
    QUEUE("cap-kernel-maintenance", { delayed: 6 }),
    QUEUE("cap-kernel-plugin-scope"),
    QUEUE("cap-kernel-titles"),
    QUEUE("cap-kernel-usage-report", { delayed: 1 }),
    QUEUE("cap-kernel-evals"),
  ],
  channels: { online: 5, offline: 1, webhook: 2, disabled: 1, error: 0 },
  devices: { online: 3, local: 7 },
  sandboxes: {
    running: 4,
    suspended: 2,
    byProvider: [
      { provider: "sandbox-docker", running: 3 },
      { provider: "sandbox-e2b", running: 1 },
    ],
  },
  unavailable: [],
};

/** A query cache holding the page's answers, never read again (no kernel behind the catalog). */
function seeded(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  qc.setQueryData(meQuery().queryKey, ME);
  qc.setQueryData(adminOverviewQuery().queryKey, OVERVIEW);
  qc.setQueryData(adminInboxQuery().queryKey, INBOX);
  qc.setQueryData(adminAttentionQuery().queryKey, ATTENTION);
  qc.setQueryData(adminHealthQuery().queryKey, HEALTH);
  qc.setQueryData(platformAuditQuery().queryKey, AUDIT);
  return qc;
}

/** `/dev/ui/pages/<page>`: one app page in the admin console's shell. */
export function PageCatalog({ route }: { route: PageRoute }) {
  const [client] = useState(seeded);
  const { onOpenCommands: _, ...sidebar } = sidebarProps(
    { active: "overview", context: "admin", level: "superAdmin" },
    // the console's real routes (the catalog has no kernel behind them); anything else goes nowhere
    (id) => ADMIN_PAGES.find((p) => p.id === id)?.href ?? "#",
  );
  return (
    <QueryClientProvider client={client}>
      <AppShell sidebar={sidebar} commands={COMMANDS} status={statusFixture("/admin")}>
        {route === "pages/admin-overview" ? <AdminOverviewView /> : null}
      </AppShell>
    </QueryClientProvider>
  );
}
