"use client";

import { AppShell, AVATAR_PRESET_IDS } from "@capybara-hq/design";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import AccountProfileView from "../../app/(app)/account/profile/view";
import AgentsView from "../../app/(app)/agents/view";
import AutomationsView from "../../app/(app)/automations/view";
import ConnectorsView from "../../app/(app)/connectors/view";
import ConversationsView from "../../app/(app)/conversations/view";
import FilesView from "../../app/(app)/files/view";
import InboxView from "../../app/(app)/inbox/view";
import SkillsView from "../../app/(app)/skills/view";
import { type Session, SessionContext } from "../../components/shell/session";
import type { Agent } from "../../lib/agents";
import type { AutomationListItem } from "../../lib/automations";
import type { ConnectorSummary } from "../../lib/connectors";
import type { Conversation, ConversationListRow } from "../../lib/conversations";
import type { InboxItem } from "../../lib/inbox";
import type { LibraryFileView } from "../../lib/library-files";
import { agentsQuery, agentTemplatesQuery } from "../../lib/query/agents";
import { authSourcesQuery } from "../../lib/query/auth";
import { acceptanceRulesQuery, automationsQuery } from "../../lib/query/automations";
import { orgComponentsQuery } from "../../lib/query/components";
import { connectorsQuery } from "../../lib/query/conversation";
import { inboxQuery } from "../../lib/query/inbox";
import { libraryFilesQuery, libraryUsageQuery } from "../../lib/query/library";
import { membersQuery } from "../../lib/query/members";
import { orgSettingsQuery } from "../../lib/query/settings";
import {
  conversationGroupsQuery,
  conversationListQuery,
  meQuery,
  readinessQuery,
} from "../../lib/query/shell";
import { skillsQuery } from "../../lib/query/skills";
import type { Me } from "../../lib/session";
import type { SkillSummary } from "../../lib/skills";
import { COMMANDS } from "./fixtures";
import type { MemberPage } from "./routes";
import { sidebarProps } from "./shell-fixture";

/**
 * `/dev/ui/pages/member-<page>`: the member pages (agents, skills, connectors, automations'
 * list, files, conversations, inbox, account profile) drawn from a seeded query cache in the workspace
 * shell (no kernel), for the responsive matrix (`visual/responsive.spec.ts`). A member role, so
 * the compact rows, the actions of each row and the page's own primary show as a person sees them.
 */

export const ORG = "o1";
export const T = "2026-11-10T08:30:00.000Z";
/** Within the day of the fixed "today" of the shots; the rows only show relative sections. */
export const RECENT = "2026-11-12T09:00:00.000Z";

export const ME: Me = {
  account: {
    id: "a1",
    displayName: "Grant",
    email: "grant@example.com",
    isSuperAdmin: false,
    avatarUrl: null,
    avatarSource: null,
  },
  via: "session",
  currentOrgId: ORG,
  memberships: [{ orgId: ORG, slug: "acme", name: "Acme", role: "member" }],
  canCreateOrg: false,
};

const AGENT_NAMES: [string, string, string][] = [
  ["ag1", "研究助手", "Reads sources and writes a short brief with citations."],
  ["ag2", "财务对账", "Matches invoices with the ledger and lists the differences."],
  ["ag3", "客服助手", "Drafts replies to support tickets in the house style."],
];

export const AGENTS: Agent[] = AGENT_NAMES.map(([id, name, description], i) => ({
  id,
  orgId: ORG,
  ownerAccountId: "a1",
  visibility: "org",
  memberIds: null,
  currentVersion: i + 1,
  profile: {
    avatar: { kind: "preset", id: AVATAR_PRESET_IDS[i % AVATAR_PRESET_IDS.length] ?? "" } as never,
    description,
    quickActions: [],
    updatedAt: T,
  },
  definition: {
    name,
    description,
    instructions: "",
    model: { provider: "fake", model: "fake" },
    fallback: null,
  },
  createdFrom: null,
  updatedAt: T,
}));

const SKILLS: SkillSummary[] = [
  ["sk1", "meeting-notes", "Turns a transcript into decisions and owners.", "org"],
  ["sk2", "invoice-check", "Checks an invoice against the purchase order.", "org"],
  ["sk3", "web-research", "Searches, reads and cites public pages.", "platform"],
].map(([id, name, description, origin]) => ({
  id: id as string,
  scope: "org",
  agentId: null,
  name: name as string,
  description: description as string,
  currentVersion: 2,
  createdBy: "a1",
  createdAt: T,
  updatedAt: T,
  origin: origin as "org" | "platform",
  shareable: false,
}));

const CONNECTORS: ConnectorSummary[] = [
  ["c1", "wiki", "公司 Wiki", "active"],
  ["c2", "tickets", "Ticket system", "active"],
  ["c3", "crm", "CRM", "disabled"],
].map(([id, slug, name, status]) => ({
  id: id as string,
  slug: slug as string,
  name: name as string,
  connector: "connector-mcp",
  endpoint: { url: `https://${slug}.example.com/mcp` },
  auth: { type: "bearer", ownership: "org" },
  status: status as "active" | "disabled",
  git: null,
  gitPushPolicy: "ask",
  createdAt: T,
  updatedAt: T,
})) as ConnectorSummary[];

const TASKS: [string, string, string, string][] = [
  ["s1", "每日简报", "ag1", "0 9 * * *"],
  ["s2", "对账检查", "ag2", "0 14 * * 1-5"],
  ["s3", "工单回顾", "ag3", "0 9 * * 2"],
];

export const AUTOMATIONS: AutomationListItem[] = TASKS.map(([id, name, agentId, expr]) => ({
  id,
  name,
  agentId,
  accountId: "a1",
  status: "active",
  pauseReason: null,
  trigger: { kind: "cron", expr, timeZone: "Asia/Shanghai" },
  mode: "new",
  jitterSeconds: 0,
  nextRunAt: "2026-11-13T01:00:00.000Z",
  orgId: ORG,
  prompt: "",
  conversationId: null,
  chat: null,
  model: null,
  effort: null,
  deviceId: null,
  pausedBy: null,
  expiresAt: null,
  consecutiveFailures: 0,
  unattendedAsk: null,
  origin: "person",
  lastRun: null,
  createdAt: T,
  updatedAt: T,
}));

const conversation = (id: string, agentId: string, title: string, at: string): Conversation => ({
  id,
  orgId: ORG,
  agentId,
  title,
  titleSource: "generated",
  lastSeq: 4,
  activity: null,
  createdAt: at,
  updatedAt: at,
  deviceId: null,
});

const TITLES: [string, string, string][] = [
  ["cv1", "ag1", "Competitor pricing brief"],
  ["cv2", "ag2", "October ledger differences"],
  ["cv3", "ag3", "Refund wording for the new policy"],
  ["cv4", "ag1", "Interview notes summary"],
  ["cv5", "ag2", "Q3 invoice check"],
];

const CONVERSATIONS: ConversationListRow[] = TITLES.map(([id, agentId, title], i) => {
  const a = AGENTS.find((x) => x.id === agentId) as Agent;
  return {
    ...conversation(
      id,
      agentId,
      title,
      new Date(Date.parse(RECENT) - i * 86_400_000).toISOString(),
    ),
    agent: { id: a.id, name: a.definition.name, profile: a.profile },
  };
});

const INBOX_ITEMS: InboxItem[] = [
  {
    type: "skill_change",
    id: "ic1",
    createdAt: RECENT,
    skillChange: {
      id: "sc1",
      orgId: ORG,
      kind: "version",
      agent: { id: "ag1", name: "研究助手" },
      skillId: "sk1",
      name: "meeting-notes",
      description: "Turns a transcript into decisions and owners.",
      version: 3,
      files: [{ path: "SKILL.md", size: 1200 }],
      status: "pending",
      requestedBy: "a1",
      requestedByName: "Grant",
      requestedByAvatarUrl: null,
      requestedInConversation: null,
      conversationPath: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: RECENT,
    },
  },
  {
    type: "automation_attention",
    id: "s2:paused",
    createdAt: T,
    attention: {
      taskId: "s2",
      name: "对账检查",
      reason: "failed",
      pausedBy: null,
      missing: [],
      needsRole: [],
      needsAdmin: [],
      error: "The ledger export was empty.",
    },
  },
];

const libraryFile = (
  id: string,
  name: string,
  contentType: string,
  size: number,
  at: string,
  agentId: string | null,
): LibraryFileView => ({
  id,
  name,
  contentType,
  size,
  origin: agentId === null ? "upload" : "delivered",
  agentId,
  sourceConversation:
    agentId === null ? null : { id: "cv1", title: TITLES[0]?.[2] ?? null, deleted: false },
  versions: 1,
  createdAt: at,
  previewable: contentType.startsWith("image/")
    ? "image"
    : contentType.startsWith("text/")
      ? "text"
      : null,
});

const day = (n: number) => new Date(Date.parse(RECENT) - n * 86_400_000).toISOString();

const LIBRARY: LibraryFileView[] = [
  libraryFile("fl1", "Competitor pricing brief.pdf", "application/pdf", 2_400_000, RECENT, "ag1"),
  libraryFile("fl2", "Funnel chart.png", "image/png", 312_000, RECENT, "ag2"),
  libraryFile("fl3", "Interview notes.md", "text/markdown", 18_000, day(2), null),
  libraryFile("fl4", "Store sales.xlsx", "application/vnd.ms-excel", 1_100_000, day(3), "ag2"),
  libraryFile("fl5", "Supplier agreement.docx", "application/msword", 204_000, day(20), null),
];

/** The layout's session (no kernel behind it: nothing reloads or switches). */
const SESSION: Session = {
  me: ME,
  reload: async () => {},
  switchOrg: async () => {},
};

export function seeded(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  qc.setQueryData(meQuery().queryKey, ME);
  qc.setQueryData(readinessQuery(ORG).queryKey, {
    modelProvider: "ready",
    orgFixableProviders: [],
    unusableProviders: [],
    agents: AGENTS.length,
  });
  qc.setQueryData(authSourcesQuery().queryKey, []);
  qc.setQueryData(agentsQuery(ORG).queryKey, { agents: AGENTS });
  qc.setQueryData(agentTemplatesQuery(ORG).queryKey, { templates: [] });
  qc.setQueryData(membersQuery(ORG).queryKey, {
    members: [{ account: ME.account, role: "member", joinedAt: T }],
  });
  for (const kind of ["agent_template", "skill", "connector_template"] as const) {
    qc.setQueryData(orgComponentsQuery(ORG, { kind }).queryKey, { components: [] });
  }
  qc.setQueryData(skillsQuery(ORG).queryKey, { skills: SKILLS });
  qc.setQueryData(connectorsQuery(ORG).queryKey, { connectors: CONNECTORS });
  qc.setQueryData(orgSettingsQuery(ORG).queryKey, {
    settings: { automations: { enabled: true, minIntervalMinutes: 60 } },
  });
  qc.setQueryData(automationsQuery(ORG).queryKey, { items: AUTOMATIONS });
  qc.setQueryData(acceptanceRulesQuery(ORG).queryKey, { items: [], directedDefault: "auto" });
  qc.setQueryData(conversationListQuery(ORG).queryKey, {
    conversations: CONVERSATIONS,
    next: null,
    total: 42,
  });
  qc.setQueryData(conversationGroupsQuery(ORG).queryKey, {
    groups: AGENTS.map((a) => ({
      agent: { id: a.id, name: a.definition.name, profile: a.profile },
      latestAt: RECENT,
      conversations: [],
      more: false,
    })),
    next: null,
  });
  qc.setQueryData(inboxQuery(ORG).queryKey, { items: INBOX_ITEMS, truncated: false });
  qc.setQueryData(libraryFilesQuery(ORG).queryKey, { files: LIBRARY, next: null });
  qc.setQueryData(libraryUsageQuery(ORG).queryKey, {
    bytes: LIBRARY.reduce((n, f) => n + f.size, 0),
    files: LIBRARY.length,
  });
  return qc;
}

function Page({ page }: { page: MemberPage }) {
  switch (page) {
    case "agents":
      return <AgentsView />;
    case "skills":
      return <SkillsView />;
    case "connectors":
      return <ConnectorsView />;
    case "automations":
      return (
        <AutomationsView
          initial={{ view: "list", range: "week", date: null, scope: "mine", rules: false }}
        />
      );
    case "files":
      return <FilesView initial={{ origin: "", agent: "", type: "", q: "" }} />;
    case "conversations":
      return <ConversationsView />;
    case "inbox":
      return <InboxView />;
    case "profile":
      return <AccountProfileView />;
  }
}

/** A member page in the workspace shell. */
export function MemberPageCatalog({ page }: { page: MemberPage }) {
  const [client] = useState(seeded);
  const { onOpenCommands: _, ...sidebar } = sidebarProps(
    { active: page, level: "guest" },
    () => "#",
  );
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={SESSION}>
        <AppShell sidebar={sidebar} commands={COMMANDS}>
          <Page page={page} />
        </AppShell>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}
