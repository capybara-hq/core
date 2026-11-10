"use client";

import {
  Avatar,
  Badge,
  Button,
  CodeBlock,
  DateTime,
  DetailPage,
  Dialog,
  EmptyState,
  Field,
  FormSection,
  ItemList,
  ItemListItem,
  KeyValue,
  Select,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import { type AdminAgentDetail, adminAvatarValue } from "../../../../../lib/admin-items";
import { labelLocale, modelLabel } from "../../../../../lib/extension-label";
import { adminAgentQuery, adminOrgMembersQuery } from "../../../../../lib/query/admin-items";
import { useDeleteAgent, useTransferAgent } from "../../../../../lib/query/admin-items-mutations";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

/**
 * `/admin/agents/[id]` (super admins; spec 2026-11-10-admin-agents-connectors §3.3): one agent of
 * any org, read-only. The facts (org, owner with 待重新指派, visibility and members, model,
 * fallback and effort, the template it came from, versions, times), then the description, the
 * instructions in full, the quick actions by label, the org skills it selects (how many: their
 * names are the org's), the connectors it waits to bind and its sub-agents. Never its
 * conversations, runs or credentials. Actions: 转移所有者 (a member of the agent's org, never its
 * anonymous guest) and 删除 (a confirmation naming the org and the owner, then back to the list).
 * From the query cache (the layout prefetched the agent on a first load).
 */
export default function AdminAgentView({ id }: { id: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminAgentRead id={id} />;
}

function AdminAgentRead({ id }: { id: string }) {
  const scope = usePagePath("admin");
  const read = usePageQuery(adminAgentQuery(id));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "agents", href: "/admin/agents" }, { label: id }],
          title: "",
          loading: { avatar: true, actions: 2 },
        }}
        loading={{ facts: { rows: 8, keyWidth: "10ch", columns: 2 }, blocks: 2 }}
      />
    );
  }
  return <AdminAgent agent={read.data} />;
}

function AdminAgent({ agent }: { agent: AdminAgentDetail }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminItems.agents");
  const [open, setOpen] = useState<"transfer" | "delete" | null>(null);
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "agents", href: "/admin/agents" }, { label: agent.name }],
          title: agent.name,
          avatar: <Avatar value={adminAvatarValue(agent.avatar)} name={agent.name} size={40} />,
          actions: [
            {
              label: t("actions.transfer"),
              variant: "default",
              onSelect: () => setOpen("transfer"),
            },
            { label: t("actions.delete"), variant: "default", onSelect: () => setOpen("delete") },
          ],
        }}
        facts={<AgentFacts agent={agent} />}
      >
        <AgentSections agent={agent} />
      </DetailPage>
      {open === "transfer" && <TransferDialog agent={agent} onClose={() => setOpen(null)} />}
      {open === "delete" && <DeleteDialog agent={agent} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The agent's facts: a KeyValue in two columns under the head. */
function AgentFacts({ agent }: { agent: AdminAgentDetail }) {
  const t = useTranslations("adminItems.agents.detail");
  const tl = useTranslations("adminItems.agents");
  const te = useTranslations("agents.templatePage.effort");
  const locale = labelLocale(useLocale());
  const def = agent.definition;
  const effort = def.modelParams?.effort;
  const model = (m: { provider: string; model: string }) =>
    modelLabel({ name: m.provider }, m.model, locale);
  return (
    <KeyValue
      keyWidth="10ch"
      columns={2}
      rows={[
        { k: t("facts.org"), v: agent.orgName },
        {
          k: t("facts.owner"),
          v: (
            <Stack direction="row" gap={8} align="center">
              <Text>{agent.ownerName}</Text>
              {agent.needsReassignment && <Badge tone="warn">{tl("needsReassignment")}</Badge>}
            </Stack>
          ),
        },
        {
          k: t("facts.visibility"),
          v:
            agent.visibility === "members" && agent.memberIds !== null
              ? `${tl("visibility.members")} · ${t("membersCount", { count: agent.memberIds.length })}`
              : tl(`visibility.${agent.visibility}`),
        },
        { k: t("facts.model"), v: model(def.model) },
        ...(def.fallback ? [{ k: t("facts.fallback"), v: model(def.fallback) }] : []),
        ...(typeof effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(effort)
          ? [{ k: t("facts.effort"), v: te(effort as "low") }]
          : []),
        { k: t("facts.from"), v: agent.createdFrom?.name ?? t("none") },
        { k: t("facts.versions"), v: String(agent.versions) },
        { k: t("facts.updated"), v: <DateTime value={agent.updatedAt} /> },
        { k: t("facts.created"), v: <DateTime value={agent.createdAt} /> },
      ]}
    />
  );
}

/** The read-only sections, one box each on the page ground. */
function AgentSections({ agent }: { agent: AdminAgentDetail }) {
  const t = useTranslations("adminItems.agents.detail");
  const def = agent.definition;
  const description = agent.profile.description ?? def.description ?? "";
  const skills = def.skills?.orgSkills ?? [];
  const pending = def.pendingConnectors ?? [];
  const sub = def.subagents;
  const subRows = [
    ...(sub?.general !== undefined
      ? [{ k: t("subagents.general"), v: sub.general ? t("subagents.on") : t("subagents.off") }]
      : []),
    ...((sub?.templates ?? []).length > 0
      ? [{ k: t("subagents.templates"), v: (sub?.templates ?? []).join(", ") }]
      : []),
    ...((sub?.inline ?? []).length > 0
      ? [{ k: t("subagents.inline"), v: (sub?.inline ?? []).map((x) => x.name).join(", ") }]
      : []),
    ...((sub?.agents ?? []).length > 0
      ? [{ k: t("subagents.agents"), v: (sub?.agents ?? []).map((x) => x.as).join(", ") }]
      : []),
  ];
  return (
    <Stack gap={16}>
      {description !== "" && (
        <Text variant="prose" tone="muted" pre>
          {description}
        </Text>
      )}
      <FormSection id="instructions" title={t("sections.instructions")}>
        {def.instructions.trim() === "" ? (
          <Text tone="faint">{t("instructionsEmpty")}</Text>
        ) : (
          <CodeBlock language="markdown" text={def.instructions} />
        )}
      </FormSection>
      <FormSection id="quick-actions" title={t("sections.quickActions")} flush>
        <ItemList label={t("sections.quickActions")} inset="flush" empty={t("quickActionsEmpty")}>
          {agent.profile.quickActions.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; the order is the agent's
            <ItemListItem key={i} title={a.label} />
          ))}
        </ItemList>
      </FormSection>
      <FormSection id="skills" title={t("sections.skills")}>
        <Text tone={skills.length === 0 ? "muted" : "ink"}>
          {skills.length === 0 ? t("skillsNone") : t("skillsCount", { count: skills.length })}
        </Text>
      </FormSection>
      {pending.length > 0 && (
        <FormSection id="connectors" title={t("sections.connectors")} flush>
          <ItemList label={t("sections.connectors")} inset="flush">
            {pending.map((c) => (
              <ItemListItem key={c.key} title={c.label} />
            ))}
          </ItemList>
        </FormSection>
      )}
      <FormSection id="subagents" title={t("sections.subagents")}>
        {subRows.length === 0 ? (
          <Text tone="muted">{t("subagentsNone")}</Text>
        ) : (
          <KeyValue keyWidth="10ch" rows={subRows} />
        )}
      </FormSection>
    </Stack>
  );
}

/** 转移所有者: pick a member of the agent's org (anonymous guests can't own agents). */
function TransferDialog({ agent, onClose }: { agent: AdminAgentDetail; onClose(): void }) {
  const t = useTranslations("adminItems.agents.transfer");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const membersQ = useQuery(adminOrgMembersQuery(agent.orgId));
  const transfer = useTransferAgent({
    onSuccess: () => {
      toast.success(t("done"));
      onClose();
    },
  });
  const [picked, setPicked] = useState<string | null>(null);
  const members = (membersQ.data?.members ?? []).filter((m) => !m.anonymous);
  const owner = agent.ownerAccountId;
  const value = picked ?? (members.some((m) => m.account.id === owner) ? owner : "");
  const error = transfer.error ? errorMessage(transfer.error) : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={transfer.isPending}
            // Confirming the current owner clears 待重新指派, so it is a change then
            disabled={value === "" || (value === owner && !agent.needsReassignment)}
            onClick={() =>
              transfer.mutate({ agentId: agent.id, orgId: agent.orgId, accountId: value })
            }
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      {membersQ.data === undefined && membersQ.error === null ? (
        <Skeleton rows={2} />
      ) : membersQ.data === undefined ? (
        <FormError message={errorMessage(membersQ.error)} />
      ) : members.length === 0 ? (
        <EmptyState size="panel" text={t("none")} />
      ) : (
        <Field label={t("owner")} help={t("help", { org: agent.orgName })}>
          <Select
            value={value}
            onChange={(e) => setPicked(e.target.value)}
            options={[
              ...(value === "" ? [{ value: "", label: "—" }] : []),
              ...members.map((m) => ({
                value: m.account.id,
                label: m.account.email
                  ? `${m.account.displayName} · ${m.account.email}`
                  : m.account.displayName,
              })),
            ]}
          />
        </Field>
      )}
      {error !== null && <FormError message={error} />}
    </Dialog>
  );
}

/** 删除: a confirmation naming the org and the owner; then back to the list. */
function DeleteDialog({ agent, onClose }: { agent: AdminAgentDetail; onClose(): void }) {
  const t = useTranslations("adminItems.agents.delete");
  const tc = useTranslations("common");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const remove = useDeleteAgent({
    onSuccess: () => {
      toast.success(t("done", { name: agent.name }));
      router.push("/admin/agents");
    },
  });
  const error = remove.error ? errorMessage(remove.error) : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("title", { name: agent.name })}
      danger
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={remove.isPending}
            onClick={() => remove.mutate({ agentId: agent.id, orgId: agent.orgId })}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{t("hint", { org: agent.orgName, owner: agent.ownerName })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
