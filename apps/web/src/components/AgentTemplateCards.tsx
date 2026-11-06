"use client";

import {
  Button,
  DangerConfirm,
  type MenuItem,
  ObjectCard,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  type AgentTemplateDeletePreview,
  type AgentTemplateView,
  deleteAgentTemplate,
  setAgentTemplateShareable,
} from "../lib/agents";
import { type OwnerSide, ownerSide } from "../lib/catalog";
import { maybeOwnTemplate, type OrgComponent, type UsableRow } from "../lib/components";
import { agentTemplateDeletePreviewQuery, agentTemplateQuery } from "../lib/query/agents";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { CreateFromTemplateDialog } from "./agent/CreateFromTemplateDialog";
import type { ComponentAction } from "./ComponentSwitch";
import type { PluginStateLabel } from "./PluginSwitch";

const isDanger = (m: MenuItem): boolean => typeof m === "object" && m.danger === true;

/** The template page (phase 4 Task 9: the read view, the editor for owner-org admins). */
export const templateHref = (id: string) => `/agents/templates/${encodeURIComponent(id)}`;

/** A template card's row: the org's own template, or a platform one offered to the org. */
export type TemplateRow = UsableRow<AgentTemplateView>;

/** The row's id, name, description and version, from the usable set or the offered component. */
export function templateFacts(r: TemplateRow): {
  id: string;
  name: string;
  description: string;
  version: string | number;
  plugin: string | null;
} {
  if (r.kind === "own") {
    const x = r.item;
    return {
      id: x.id,
      name: x.name,
      description: x.description,
      version: x.version,
      plugin: x.plugin,
    };
  }
  const x = r.item;
  const c = r.component;
  return {
    id: x?.id ?? c?.id ?? "",
    name: x?.name ?? c?.name ?? "",
    description: x?.description ?? c?.description ?? "",
    version: x?.version ?? c?.version ?? "",
    plugin: x?.plugin ?? c?.plugin ?? null,
  };
}

/** Whether the search text matches the template's name, type or description. */
export function matchesTemplate(r: TemplateRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const f = templateFacts(r);
  const type = r.item?.type ?? "";
  return `${f.name} ${type} ${f.description}`.toLowerCase().includes(q);
}

/**
 * The card's source (ruling P4-15): its plugin, else whose it is: 平台, 本组织 or the owner org's
 * name.
 */
export function useTemplateSource(): (plugin: string | null, owner: OwnerSide) => string {
  const t = useTranslations("agents.templates.source");
  return (plugin, owner) =>
    plugin !== null
      ? t("plugin", { plugin })
      : owner.kind === "platform"
        ? t("platform")
        : owner.kind === "self"
          ? t("org")
          : t("orgNamed", { org: owner.name });
}

/**
 * One template as a card (rulings P4-15, P4-16): the initial square, the name (the whole card
 * opens the template page), the description, the meta line source · v<version> (and the state in
 * `warn` when a platform template is off here), then:
 * - the primary 用它创建 on a template usable in the org, opening the create dialog (P4-18); on one
 *   that is off, an org admin's 启用 (the existing switch) instead, else none;
 * - ⋯: 查看; for owner-org admins (the detail says `owned`) 编辑 instead (the template page is the
 *   editor for them), 设为可共享 / 取消共享 and 删除 (previewed, the name typed); the org admin's
 *   other switch actions on a platform template (停用 with its preview, 查看插件).
 * Members get 用它创建 and 查看 only; the role decides, never a refused action shown.
 */
export function TemplateCard({
  orgId,
  row,
  admin,
  switchActions,
  stateOf,
}: {
  orgId: string;
  row: TemplateRow;
  admin: boolean;
  /** The org admin's switch actions of the offered component ([] for members and own rows). */
  switchActions: ComponentAction[];
  stateOf(c: OrgComponent): PluginStateLabel;
}) {
  const t = useTranslations("agents.templates");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const sourceOf = useTemplateSource();
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const f = templateFacts(row);
  const c = row.kind === "platform" ? row.component : undefined;
  const owner: OwnerSide = row.kind === "own" ? { kind: "self" } : ownerSide(c?.owner, orgId);
  // Usable here: the org's own row, or a platform template in the usable set (on in the org)
  const usable = row.kind === "own" || row.item !== undefined;
  // The org's own template (an org-created one, promoted or not): the detail tells for certain
  // (`owned`), read only for the org admins who could act on it
  const maybeOwned = admin && maybeOwnTemplate(row, orgId);
  const detail = useQuery({ ...agentTemplateQuery(orgId, f.id), enabled: maybeOwned });
  const owned = maybeOwned && detail.data?.owned === true;
  const k = keys.org(orgId);
  const share = useAppMutation({
    fn: (shareable: boolean) => setAgentTemplateShareable(orgId, f.id, shareable),
    invalidates: () => [k.agentTemplate(f.id), k.agentTemplates(), k.componentsAll()],
  });
  const remove = useAppMutation({
    fn: () => deleteAgentTemplate(orgId, f.id),
    invalidates: () => [k.agentTemplates(), k.componentsAll(), k.agentTemplateAll()],
  });
  // One call at a time: the item is disabled while it runs and a second select does nothing
  const toggleShare = (next: boolean) => {
    if (share.isPending) return;
    void share.mutateAsync(next).then(
      () => toast.success(t(next ? "shareOn" : "shareOff", { name: f.name })),
      (e: unknown) => toast.error(errorMessage(e)),
    );
  };

  const enable = switchActions.find((a) => a.id === "enable");
  const href = templateHref(f.id);
  const state = c !== undefined && !c.on ? stateOf(c) : undefined;
  const shareable = detail.data?.shareable === true;
  const ownerItems: MenuItem[] = owned
    ? [
        { label: t("edit"), href },
        ...(detail.data !== undefined
          ? [
              {
                label: t(shareable ? "unshare" : "share"),
                disabled: share.isPending,
                onSelect: () => toggleShare(!shareable),
              },
            ]
          : []),
      ]
    : [{ label: t("view"), href }];
  const switchItems: MenuItem[] = switchActions
    .filter((a) => a !== enable || usable)
    .map((a) =>
      a.href !== undefined
        ? { label: a.label, href: a.href }
        : {
            label: a.label,
            ...(a.danger === true && { danger: true }),
            onSelect: a.onSelect ?? (() => {}),
          },
    );
  const menu: MenuItem[] = [
    ...ownerItems,
    ...switchItems.filter((m) => !isDanger(m)),
    ...(owned ? [{ label: t("delete"), danger: true, onSelect: () => setDeleting(true) }] : []),
    ...switchItems.filter(isDanger),
  ];
  return (
    <>
      <ObjectCard
        title={f.name}
        href={href}
        {...(f.description !== "" ? { description: f.description } : {})}
        meta={[
          sourceOf(f.plugin, owner),
          t("version", { version: f.version }),
          ...(state !== undefined ? [{ label: state.label, tone: "warn" as const }] : []),
        ]}
        {...(usable
          ? { primary: { label: t("create"), onSelect: () => setCreating(true) } }
          : enable?.onSelect !== undefined
            ? {
                primary: {
                  label: enable.label,
                  onSelect: enable.onSelect,
                  ...(enable.loading === true && { loading: true }),
                },
              }
            : {})}
        menu={menu}
      />
      {creating ? (
        <CreateFromTemplateDialog
          orgId={orgId}
          template={{ id: f.id, name: f.name }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {owned && deleting ? (
        <TemplateDeleteDialog
          orgId={orgId}
          id={f.id}
          name={f.name}
          onClose={() => setDeleting(false)}
          onDelete={async () => {
            // the toast tells what the delete did (its answer), not what the preview foresaw
            const { outcome } = await remove.mutateAsync(undefined);
            setDeleting(false);
            toast.success(
              outcome === "transferred"
                ? t("deletedTransferred", { name: f.name })
                : t("deleted", { name: f.name }),
            );
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The delete confirmation of the org's own template (P3 owner rules, ruling P4-12): it reads what
 * the delete does first and says it (one other orgs use is transferred to the platform, the orgs
 * named; the org's agents whose roster names it); 删除 stays disabled until that preview is read
 * and the name typed; a preview that cannot be read says so with 重试. Agents created from it are
 * never touched.
 */
export function TemplateDeleteDialog({
  orgId,
  id,
  name,
  onClose,
  onDelete,
}: {
  orgId: string;
  id: string;
  name: string;
  onClose(): void;
  onDelete(outcome: AgentTemplateDeletePreview["outcome"]): Promise<void>;
}) {
  const t = useTranslations("agents.templates");
  const td = useTranslations("plugins.delete");
  const sep = useLocale() === "zh" ? "、" : ", ";
  const errorMessage = useErrorMessage();
  const preview = useQuery({
    ...agentTemplateDeletePreviewQuery(orgId, id),
    refetchOnMount: "always",
  });
  // the preview shown, unless a read is in flight (a retry): only a settled preview is confirmed
  const p = preview.isFetching ? undefined : preview.data;
  return (
    <DangerConfirm
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("deleteTitle", { name })}
      confirmName={name}
      confirmLabel={t("delete")}
      confirmDisabled={p === undefined}
      onConfirm={async () => {
        if (p === undefined) return;
        try {
          await onDelete(p.outcome);
        } catch (e) {
          // DangerConfirm shows the message: the localized one, never the kernel's English
          throw new Error(errorMessage(e));
        }
      }}
      description={
        <Stack gap={12}>
          {p !== undefined && p.outcome === "transferred" && (
            <Text variant="prose" tone="warn">
              {td("transferred", { orgs: p.orgs.map((o) => o.name).join(sep) })}
            </Text>
          )}
          <Text variant="prose">{t("deleteHint")}</Text>
          {p === undefined && !preview.isError && (
            <Text variant="small" tone="muted">
              {td("loading")}
            </Text>
          )}
          {preview.isError && !preview.isFetching && (
            <Stack direction="row" gap={8} align="center" wrap>
              <Text variant="small" tone="fail">
                {t("previewFailed")}
              </Text>
              <Button onClick={() => void preview.refetch()}>{t("previewRetry")}</Button>
            </Stack>
          )}
          {p !== undefined && p.agents.length > 0 && (
            <Stack gap={4}>
              <Text variant="small" tone="warn">
                {t("deleteAgents")}
              </Text>
              {p.agents.map((a) => (
                <Text key={a.id} variant="small">
                  {`· ${a.name}`}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      }
    />
  );
}
