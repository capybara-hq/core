"use client";

import { AppShell, PageLevelContext } from "@capybara-hq/design";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import AdminAgentTemplateView from "../../app/(app)/admin/agents/templates/[id]/view";
import AdminAgentTemplatesView from "../../app/(app)/admin/agents/templates/view";
import AdminSettingsView from "../../app/(app)/admin/settings/view";
import { ADMIN_PAGES as NAV } from "../../components/admin-nav";
import { pathLevel } from "../../components/shell/levels";
import { type Session, SessionContext } from "../../components/shell/session";
import type { AdminOrg, DeploymentSettings } from "../../lib/admin";
import type { ComponentVersion, PlatformComponent } from "../../lib/components";
import type { LoginSource } from "../../lib/login-sources";
import { adminOrgsQuery, deploymentSettingsQuery, loginSourcesQuery } from "../../lib/query/admin";
import { adminComponentsQuery, componentVersionsQuery } from "../../lib/query/components";
import { meQuery } from "../../lib/query/shell";
import type { Me } from "../../lib/session";
import { COMMANDS } from "./fixtures";
import { ME, ORG, RECENT, seeded, T } from "./member-pages";
import type { SuperAdminPage } from "./routes";
import { sidebarProps } from "./shell-fixture";

/**
 * `/dev/ui/pages/platform-<page>`: three super admin pages (a list of agent templates with the
 * owner scope chips, one template's detail, the deployment settings form) drawn from a seeded
 * query cache in the admin console's shell, for the sizing audit of the responsive matrix
 * (`visual/responsive.spec.ts`). The console is desktop-only on touch, so the matrix draws them
 * with a fine pointer at every width.
 */

const SUPER_ME: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: true },
};

const SESSION: Session = { me: SUPER_ME, reload: async () => {}, switchOrg: async () => {} };

const TEMPLATE_ID = "tpl1";

const TEMPLATES: PlatformComponent[] = [
  ["tpl1", "Research analyst", "Collects sources and writes cited briefs.", "all", "platform"],
  [
    "tpl2",
    "Support triage",
    "Sorts incoming requests and drafts first replies.",
    "optional",
    "platform",
  ],
  ["tpl3", "客户成功助手", "Keeps account notes and prepares renewal summaries.", "named", "org"],
  ["tpl4", "Ledger matcher", "Matches invoices to payments.", "all", "platform"],
].map(([id, name, description, scope, owner]) => ({
  kind: "agent_template",
  id: id as string,
  name: name as string,
  description: description as string,
  plugin: owner === "platform" ? "templates-core" : null,
  itemId: owner === "platform" ? "item-templates-core" : null,
  owner: owner === "platform" ? { kind: "platform" } : { kind: "org", orgId: ORG, name: "Acme" },
  shareable: owner === "org",
  promoted: false,
  builtin: false,
  scopeMode: "follow",
  scope: scope as PlatformComponent["scope"],
  orgs: scope === "named" ? [ORG] : [],
  disabled: false,
  pluginStopped: false,
  shownToOthers: owner === "org",
  version: "1.2.0",
  onIn: [ORG],
})) as PlatformComponent[];

const VERSIONS: ComponentVersion[] = [
  { version: "1.2.0", catalogVersion: "1.2.0", updatedOnOwn: false, createdAt: RECENT },
  { version: "1.1.0", catalogVersion: "1.1.0", updatedOnOwn: false, createdAt: T },
];

const ORGS: AdminOrg[] = [
  { id: ORG, slug: "acme", name: "Acme", createdAt: T, memberCount: 12 },
  { id: "o2", slug: "globex", name: "Globex", createdAt: T, memberCount: 4 },
];

const SETTINGS: DeploymentSettings = {
  orgCreation: "super_admin",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  uiTheme: { id: null },
  externalSharing: { value: "allow", source: "default" },
  shareMaxExpiryDays: { value: 30, source: "default" },
  htmlRenderCdnAllowlist: ["https://cdn.jsdelivr.net"],
  promptSuggestions: "on",
};

const LOGIN_SOURCES: LoginSource[] = [
  {
    plugin: "slack",
    label: { zh: "Slack", en: "Slack" },
    enabled: true,
    signUp: "link",
    trustedTenants: [],
    available: true,
    needsConfig: false,
    callbackUrl: "https://capybara.example.com/api/v1/auth/sso/slack/callback",
  },
  {
    plugin: "lark",
    label: { zh: "飞书", en: "Lark" },
    enabled: true,
    signUp: "link",
    trustedTenants: [],
    available: true,
    needsConfig: false,
    callbackUrl: "https://capybara.example.com/api/v1/auth/sso/lark/callback",
  },
  {
    plugin: "google",
    label: { zh: "Google", en: "Google" },
    enabled: false,
    signUp: "link",
    trustedTenants: [],
    available: true,
    needsConfig: true,
    callbackUrl: "https://capybara.example.com/api/v1/auth/sso/google/callback",
  },
];

function seededSuper(): QueryClient {
  const qc = seeded();
  qc.setQueryData(meQuery().queryKey, SUPER_ME);
  qc.setQueryData(adminComponentsQuery("agent_template").queryKey, { components: TEMPLATES });
  qc.setQueryData(adminComponentsQuery("theme").queryKey, { components: [] });
  qc.setQueryData(componentVersionsQuery("agent_template", TEMPLATE_ID).queryKey, {
    versions: VERSIONS,
  });
  qc.setQueryData(adminOrgsQuery().queryKey, { orgs: ORGS });
  qc.setQueryData(deploymentSettingsQuery().queryKey, SETTINGS);
  qc.setQueryData(loginSourcesQuery().queryKey, { items: LOGIN_SOURCES });
  return qc;
}

/** The app route each catalog page stands for (its navigation level, levels.ts). */
const ROUTE: Record<SuperAdminPage, string> = {
  "agent-templates": "/admin/agents/templates",
  "agent-template": "/admin/agents/templates/tpl1",
  settings: "/admin/settings",
};

function Page({ page }: { page: SuperAdminPage }) {
  switch (page) {
    case "agent-templates":
      return <AdminAgentTemplatesView />;
    case "agent-template":
      return <AdminAgentTemplateView id={TEMPLATE_ID} />;
    case "settings":
      return <AdminSettingsView />;
  }
}

/** A super admin page in the admin console's shell. */
export function SuperAdminPageCatalog({ page }: { page: SuperAdminPage }) {
  const [client] = useState(seededSuper);
  const { onOpenCommands: _, ...sidebar } = sidebarProps(
    { active: page === "settings" ? "settings" : "agents", context: "admin", level: "superAdmin" },
    (id) => NAV.find((p) => p.id === id)?.href ?? "#",
  );
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={SESSION}>
        <AppShell sidebar={sidebar} commands={COMMANDS}>
          {/* the page's real route's navigation level, as the app frame sets it */}
          <PageLevelContext.Provider value={pathLevel(ROUTE[page])}>
            <Page page={page} />
          </PageLevelContext.Provider>
        </AppShell>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}
