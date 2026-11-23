"use client";

import { AppShell } from "@capybara-hq/design";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import EvalSetView from "../../app/(app)/evals/[setId]/view";
import EvalRunView from "../../app/(app)/evals/runs/[runId]/view";
import EvalSetsView from "../../app/(app)/evals/view";
import ExtensionsView from "../../app/(app)/extensions/view";
import AuditView from "../../app/(app)/settings/audit/view";
import MembersView from "../../app/(app)/settings/members/view";
import ScheduleSettingsView from "../../app/(app)/settings/schedules/view";
import TokensView from "../../app/(app)/settings/tokens/view";
import TrajectoriesView from "../../app/(app)/trajectories/view";
import { type Session, SessionContext } from "../../components/shell/session";
import type { AuditEvent, AuditPage } from "../../lib/admin";
import type { EvalResultRow, EvalRun, EvalSet, EvalSetDetail } from "../../lib/evals";
import type { OrgExtension } from "../../lib/extensions";
import type { Invitation, Member } from "../../lib/members";
import type { ServiceToken } from "../../lib/orgs";
import { agentQuery } from "../../lib/query/agents";
import { orgExtensionsQuery } from "../../lib/query/channels";
import {
  type EvalRunState,
  evalRunQuery,
  evalRunsQuery,
  evalSetQuery,
  evalSetsQuery,
} from "../../lib/query/evals";
import { membersQuery } from "../../lib/query/members";
import { schedulesQuery } from "../../lib/query/schedules";
import { invitationsQuery, orgAuditQuery, serviceTokensQuery } from "../../lib/query/settings";
import { meQuery } from "../../lib/query/shell";
import { trajectoriesQuery, trajectoryFilters } from "../../lib/query/trajectories";
import type { Me } from "../../lib/session";
import type { TrajectoryListItem } from "../../lib/trajectories";
import { COMMANDS } from "./fixtures";
import { AGENTS, ME, ORG, RECENT, SCHEDULES, seeded, T } from "./member-pages";
import type { AdminPage } from "./routes";
import { sidebarProps, statusFixture } from "./shell-fixture";

/**
 * `/dev/ui/pages/org-<page>`: the org admin pages phase 2 changed (settings members, tokens,
 * schedules and audit, extensions, trajectories, evals with a set and a run) drawn from a seeded
 * query cache at an admin's role, for the responsive matrix (`visual/responsive.spec.ts`). They
 * are desktop-only on touch, so the matrix draws them with a fine pointer at every width.
 */

const ADMIN_ME: Me = {
  ...ME,
  memberships: [{ orgId: ORG, slug: "acme", name: "Acme", role: "admin" }],
};

const SESSION: Session = { me: ADMIN_ME, reload: async () => {}, switchOrg: async () => {} };

const PEOPLE: [string, string, string, Member["role"]][] = [
  ["a1", "Grant", "grant@example.com", "admin"],
  ["a2", "林晓", "lin@example.com", "owner"],
  ["a3", "Marta Ruiz", "marta@example.com", "member"],
  ["a4", "陈默", "chen@example.com", "guest"],
];

const MEMBERS: Member[] = PEOPLE.map(([id, displayName, email, role]) => ({
  account: { id, displayName, email, avatarUrl: null },
  role,
  joinedAt: T,
  anonymous: false,
}));

const INVITATIONS: Invitation[] = [
  ["i1", "member", "pending"],
  ["i2", "guest", "expired"],
].map(([id, role, status]) => ({
  id: id as string,
  orgId: ORG,
  role: role as Invitation["role"],
  createdBy: "a1",
  createdAt: T,
  expiresAt: "2026-11-30T08:30:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  status: status as Invitation["status"],
}));

const TOKENS: ServiceToken[] = [
  ["t1", "CI deploy", "member", null, RECENT],
  ["t2", "Reporting 导出", "guest", "2026-12-31T00:00:00.000Z", null],
  ["t3", "Old integration", "member", "2026-10-01T00:00:00.000Z", T],
].map(([id, name, role, expiresAt, lastUsedAt]) => ({
  id: id as string,
  name: name as string,
  role: role as ServiceToken["role"],
  createdAt: T,
  lastUsedAt: lastUsedAt as string | null,
  expiresAt: expiresAt as string | null,
}));

const ACTIONS = [
  "member.role_changed",
  "service_token.created",
  "agent.updated",
  "invitation.created",
  "trajectory.viewed",
  "extension.enabled",
];

const AUDIT: AuditPage = {
  events: ACTIONS.map(
    (action, i): AuditEvent => ({
      id: `e${i}`,
      at: new Date(Date.parse(RECENT) - i * 3_600_000).toISOString(),
      actor: { id: "a1", name: "Grant", email: "grant@example.com", avatarUrl: null },
      viaToken: i === 1,
      viaAgent: i === 2,
      action,
      target: i % 2 === 0 ? `target-${i}` : null,
    }),
  ),
  next: null,
};

const EXTENSIONS: OrgExtension[] = [
  ["search-web", "1.2.0", true, ["web-search@1"], false],
  ["lark", "0.9.3", true, ["channel@1"], true],
  ["model-fake", "0.1.0", false, ["model-provider@2"], false],
  ["memory", "0.4.1", true, ["agent-memory@1"], false],
].map(([plugin, version, enabled, provides, needsConfig]) => ({
  plugin: plugin as string,
  version: version as string,
  enabled: enabled as boolean,
  // An extension with overridable fields is configurable, and an org that saved no copy follows
  configurable: needsConfig as boolean,
  permissions: [],
  provides: provides as string[],
  needsConfig: needsConfig as boolean,
  available: true,
  switchable: true,
  catalogItem: { itemId: `item-${plugin}`, scope: "optional" },
  overrideState: needsConfig ? "following" : "none",
})) as OrgExtension[];

const RUN_STATUSES = ["completed", "failed", "running", "completed", "aborted"] as const;

const TRAJECTORIES: TrajectoryListItem[] = RUN_STATUSES.map((status, i) => {
  const a = AGENTS[i % AGENTS.length];
  return {
    conversationId: `cv${i + 1}`,
    agentId: a?.id ?? "ag1",
    agentName: a?.definition.name ?? "",
    accountId: "a1",
    title:
      ["Competitor pricing brief", null, "Refund wording", "Interview notes", "Q3 invoice"][i] ??
      null,
    updatedAt: new Date(Date.parse(RECENT) - i * 86_400_000).toISOString(),
    lastRun: { runId: `r${i}`, status, startedAt: RECENT },
  };
});

const SET_ID = "es1";

const EVAL_SETS: EvalSet[] = [
  {
    id: SET_ID,
    agentId: "ag1",
    name: "Brief quality",
    description: "Sampled briefs with citations.",
    rubric: "The brief cites every claim.",
    caseCount: 3,
    createdAt: T,
  },
  {
    id: "es2",
    agentId: "ag2",
    name: "Ledger matching",
    description: "",
    rubric: null,
    caseCount: 0,
    createdAt: T,
  },
];

const EVAL_SET: EvalSetDetail = {
  ...(EVAL_SETS[0] as EvalSet),
  cases: ["Competitor pricing", "Interview notes", "Refund wording"].map((title, i) => ({
    id: `c${i + 1}`,
    sourceConversationId: `cv${i + 1}`,
    sourceRunId: `r${i}`,
    agentVersion: 1,
    title,
    replayableSteps: 3 + i,
    createdAt: T,
  })),
};

const RUN_ID = "er1";

const EVAL_RUN: EvalRun = {
  id: RUN_ID,
  setId: SET_ID,
  mode: "step",
  candidate: { agentVersion: 2 },
  judge: true,
  status: "completed",
  tokenCap: 200_000,
  tokensUsed: 48_200,
  casesTotal: 3,
  casesDone: 3,
  estimate: {
    cases: 3,
    modelRequests: 9,
    judgeRequests: 9,
    estimatedTokens: 60_000,
    estimatedCost: 0.42,
    currency: "USD",
  },
  summary: {
    done: 8,
    errors: 1,
    skipped: 0,
    toolCallsMatchRate: 0.75,
    meanTextSimilarity: 0.81,
    judgePassRate: 0.67,
    judgeErrors: 0,
    humanPassRate: null,
    labeled: 0,
    drifted: 0,
  },
  error: null,
  createdAt: T,
  finishedAt: RECENT,
};

const RESULT_ROWS: EvalResultRow[] = (
  [
    ["done", "pass", true, 0.92],
    ["done", "fail", false, 0.4],
    ["error", null, null, null],
    ["done", "pass", true, 0.88],
  ] as const
).map(([status, verdict, match, sim], i) => ({
  id: `er-${i + 1}`,
  caseId: `c${(i % 3) + 1}`,
  step: i + 1,
  modelCallSeq: i + 3,
  status,
  judgeStatus: verdict === null ? "none" : "done",
  verdict,
  label: null,
  driftCount: 0,
  errorCode: status === "error" ? "eval.model_failed" : null,
  toolCallsMatch: match,
  textSimilarity: sim,
  updatedAt: RECENT,
}));

function seededAdmin(): QueryClient {
  const qc = seeded();
  // the gate reads the session from the cache: an admin, not the member of the member pages
  qc.setQueryData(meQuery().queryKey, ADMIN_ME);
  qc.setQueryData(membersQuery(ORG).queryKey, { members: MEMBERS });
  qc.setQueryData(invitationsQuery(ORG).queryKey, { invitations: INVITATIONS });
  qc.setQueryData(serviceTokensQuery(ORG).queryKey, { tokens: TOKENS });
  qc.setQueryData(orgAuditQuery(ORG).queryKey, AUDIT);
  qc.setQueryData(schedulesQuery(ORG, "all").queryKey, { items: SCHEDULES });
  qc.setQueryData(orgExtensionsQuery(ORG).queryKey, { extensions: EXTENSIONS });
  qc.setQueryData(trajectoriesQuery(ORG, trajectoryFilters("", "")).queryKey, {
    items: TRAJECTORIES,
    next: null,
  });
  qc.setQueryData(evalSetsQuery(ORG).queryKey, { sets: EVAL_SETS });
  qc.setQueryData(evalSetQuery(ORG, SET_ID).queryKey, EVAL_SET);
  qc.setQueryData(evalRunsQuery(ORG, SET_ID).queryKey, { runs: [EVAL_RUN] });
  const state: EvalRunState = {
    run: EVAL_RUN,
    rows: RESULT_ROWS,
    next: null,
    asOf: RECENT,
    quiet: 0,
  };
  qc.setQueryData(evalRunQuery(ORG, RUN_ID).queryKey, state);
  const agent = AGENTS[0];
  if (agent !== undefined) qc.setQueryData(agentQuery(ORG, agent.id).queryKey, agent);
  return qc;
}

function Page({ page }: { page: AdminPage }) {
  switch (page) {
    case "members":
      return <MembersView />;
    case "tokens":
      return <TokensView />;
    case "schedules":
      return <ScheduleSettingsView />;
    case "audit":
      return <AuditView />;
    case "extensions":
      return <ExtensionsView tab="all" />;
    case "trajectories":
      return <TrajectoriesView filters={trajectoryFilters("", "")} />;
    case "evals":
      return <EvalSetsView />;
    case "eval-set":
      return <EvalSetView setId={SET_ID} />;
    case "eval-run":
      return <EvalRunView runId={RUN_ID} />;
  }
}

/** An org admin page in the workspace shell. */
export function AdminPageCatalog({ page }: { page: AdminPage }) {
  const [client] = useState(seededAdmin);
  const { onOpenCommands: _, ...sidebar } = sidebarProps(
    { active: "settings", level: "guest" },
    () => "#",
  );
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={SESSION}>
        <AppShell sidebar={sidebar} commands={COMMANDS} status={statusFixture(`/${page}`)}>
          <Page page={page} />
        </AppShell>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}
