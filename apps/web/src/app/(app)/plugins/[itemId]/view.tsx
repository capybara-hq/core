"use client";

import {
  Badge,
  Button,
  Card,
  DetailPage,
  KeyValue,
  LinkButton,
  Stack,
  SwitchField,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { CatalogIcon, ComponentSection } from "../../../../components/CatalogParts";
import { ComponentSwitchList } from "../../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { OwnedItemDeleteDialog } from "../../../../components/OwnedItemDeleteDialog";
import { PluginInstallsSection } from "../../../../components/PluginInstallCards";
import { usePluginActions, usePluginState } from "../../../../components/PluginSwitch";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  agentTemplateNameOf,
  descriptionOf,
  displayNameOf,
  endpointLeaves,
  type OrgCatalogDetail,
  type OrgCatalogItem,
  orgIconUrl,
  ownedBy,
  setOwnedShareable,
  showValue,
  skillNameOf,
} from "../../../../lib/catalog";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { orgCatalogItemQuery } from "../../../../lib/query/catalog";
import { orgExtensionsQuery } from "../../../../lib/query/channels";
import { retryOnMountOf } from "../../../../lib/query/client";
import { orgComponentsQuery } from "../../../../lib/query/components";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import type { Me } from "../../../../lib/session";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/plugins/[itemId]`: a plugin from the org's view (DetailPage). Summary, its state in the org
 * with the actions of the 插件 page (启用 / 组织配置 / 停用 with its preview / 申请; members
 * 申请启用), for org admins this org's installs of it (status, components, upgrade, clean-up; see
 * PluginInstallsSection), then the latest version's components (its extension, skills, connector
 * templates with endpoint and auth, dependencies installed with it). The org's own plugin (spec
 * §14) is marked 本组织上传 and has the 可共享 switch and 删除 (org admins; members see the
 * state). Inspector: the icon (shown as
 * `<img>` through the kernel route) and basic facts. From the query cache (the layout prefetched it
 * on a first load); a missing item is the not-found state. An action invalidates the item, which
 * is read again.
 */
export default function PluginItemView({ itemId }: { itemId: string }) {
  const ws = useWorkspace({ min: "member", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <CatalogItem key={itemId} orgId={ws.orgId} itemId={itemId} me={ws.me} />;
}

function CatalogItem({ orgId, itemId, me }: { orgId: string; itemId: string; me: Me }) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org");
  const read = usePageQuery(orgCatalogItemQuery(orgId, itemId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, { label: "plugins", href: "/plugins" }], title: "" }}
        tabs={{
          label: t("detail.tabsLabel"),
          items: [{ id: "overview", label: t("detail.tabs.overview") }],
          value: "overview",
          onChange: () => {},
        }}
        // The overview: the description, the install action and the five component sections
        // (extension, skills, agent templates, connector templates, dependencies); the
        // inspector's facts (publisher, version, status)
        loading={{
          inspector: { rows: 3, keyWidth: "10ch" },
          content: [
            { kind: "lines", lines: 2 },
            { kind: "buttons" },
            { kind: "list" },
            { kind: "list" },
            { kind: "list" },
            { kind: "list" },
            { kind: "list" },
          ],
        }}
      />
    );
  }
  return <CatalogItemDetail orgId={orgId} detail={read.data} me={me} />;
}

function CatalogItemDetail({
  orgId,
  detail,
  me,
}: {
  orgId: string;
  detail: OrgCatalogDetail;
  me: Me;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org");
  const tr = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  const locale = useLocale();
  const stateOf = usePluginState();
  const item = detail.item;
  const admin = canUpdateOrg(me);
  const eq = orgExtensionsQuery(orgId);
  const extensions = useQuery({ ...eq, enabled: admin, retryOnMount: retryOnMountOf(eq.queryKey) })
    .data?.extensions;
  const { actionsOf, dialog, error, busy } = usePluginActions({ orgId, admin, extensions });
  const actions = actionsOf(item);
  const owned = ownedBy(item, orgId);
  const tp = useTranslations("plugins");

  return (
    <DetailPage
      header={{
        path: [
          ...scope,
          { label: "plugins", href: "/plugins" },
          { label: displayNameOf(item, locale) },
        ],
        title: displayNameOf(item, locale),
        count: versionLabel(item.latestVersion),
        ...(owned && { status: <Badge>{tp("chips.ownUpload")}</Badge> }),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: [{ id: "overview", label: t("detail.tabs.overview") }],
        value: "overview",
        onChange: () => {},
      }}
      inspectorTitle={item.name}
      inspector={
        <Stack gap={12}>
          {detail.hasIcon && <CatalogIcon src={orgIconUrl(orgId, item.id)} name={item.name} />}
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.fields.publisher"), v: item.publisher || "—" },
              { k: t("detail.fields.version"), v: versionLabel(item.latestVersion) },
              { k: t("detail.fields.status"), v: stateOf(item).label },
            ]}
          />
        </Stack>
      }
    >
      <Stack gap={16}>
        {descriptionOf(item, locale) !== "" && (
          <Text variant="prose">{descriptionOf(item, locale)}</Text>
        )}
        <Stack gap={4}>
          <Stack direction="row" gap={8} align="center">
            <Text tone={stateOf(item).tone}>{stateOf(item).label}</Text>
            {actions.map((a) =>
              a.href !== undefined ? (
                <LinkButton key={a.id} href={a.href}>
                  {a.label}
                </LinkButton>
              ) : (
                <Button
                  key={a.id}
                  {...(a.danger === true ? { variant: "danger" as const } : {})}
                  disabled={busy}
                  onClick={a.onSelect}
                >
                  {a.label}
                </Button>
              ),
            )}
          </Stack>
          {item.awaitingConfirmation !== true && item.pendingVersion != null && (
            <Text variant="small" tone="warn">
              {tp("chips.pendingVersion", { version: versionLabel(item.pendingVersion) })}
            </Text>
          )}
          {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        </Stack>
        {dialog}
        {owned && <OwnedSection orgId={orgId} item={item} admin={admin} />}
        {admin && <PluginInstallsSection orgId={orgId} itemId={item.id} />}
        <OrgComponentsSection orgId={orgId} itemId={item.id} admin={admin} />
        <ComponentSection
          title={tc("extension")}
          count={detail.extension === null ? 0 : 1}
          empty={tc("extensionNone")}
        >
          <Text>{`· ${detail.extension ?? ""}`}</Text>
        </ComponentSection>
        <ComponentSection
          title={tc("skills")}
          count={detail.skills.length}
          empty={tc("skillsNone")}
        >
          {detail.skills.map((s) => (
            <Text key={s}>{`· ${skillNameOf(s)}`}</Text>
          ))}
        </ComponentSection>
        <ComponentSection
          title={tc("agentTemplates")}
          count={detail.agents?.length ?? 0}
          empty={tc("agentTemplatesNone")}
        >
          {(detail.agents ?? []).map((a) => (
            <Text key={a}>{`· ${agentTemplateNameOf(a)}`}</Text>
          ))}
        </ComponentSection>
        <ComponentSection
          title={tc("templates")}
          count={detail.templates.length}
          empty={tc("templatesNone")}
        >
          {detail.templates.map((c) => (
            <Card
              key={c.id}
              title={
                c.displayName
                  ? displayNameOf({ name: c.id, displayName: c.displayName }, locale)
                  : c.connector
              }
            >
              <Stack gap={8}>
                {c.description !== "" && (
                  <Text variant="prose" tone="muted">
                    {c.description}
                  </Text>
                )}
                <KeyValue
                  keyWidth="14ch"
                  rows={endpointLeaves(c.endpoint).map(([k, v]) => ({ k, v: showValue(v) }))}
                />
                {c.editableEndpoint.length > 0 && (
                  <Text variant="small" tone="muted">
                    {tr("editable", { paths: c.editableEndpoint.join(", ") })}
                  </Text>
                )}
                <Text variant="small">{tr("auth", { type: String(c.auth.type ?? "none") })}</Text>
              </Stack>
            </Card>
          ))}
        </ComponentSection>
        <ComponentSection
          title={tc("dependencies")}
          count={detail.dependencies.length}
          empty={tc("dependenciesNone")}
        >
          <Text variant="small" tone="muted">
            {tc("dependenciesHint")}
          </Text>
          {detail.dependencies.map((d) => (
            <Text key={d.name}>{`· ${d.name} ${d.range}`}</Text>
          ))}
        </ComponentSection>
      </Stack>
    </DetailPage>
  );
}

/**
 * The plugin's skills, agent templates and connector templates in this org (spec §9, §13.5): each
 * one's state and, for org admins, its own switch (a component of an `all` plugin or scope has
 * none). A section: nothing while it loads, a line when it failed.
 */
function OrgComponentsSection({
  orgId,
  itemId,
  admin,
}: {
  orgId: string;
  itemId: string;
  admin: boolean;
}) {
  const t = useTranslations("orgComponents");
  const q = orgComponentsQuery(orgId, { itemId });
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  if (read.data === undefined) {
    return read.error === null ? null : <Text tone="muted">{t("unavailable")}</Text>;
  }
  return (
    <ComponentSection title={t("inOrg")} count={read.data.components.length} empty={t("noneInOrg")}>
      <ComponentSwitchList orgId={orgId} admin={admin} components={read.data.components} />
    </ComponentSection>
  );
}

/**
 * The org's own plugin (spec §14, P3-17 to P3-19): the 可共享 switch with its help text, and
 * 删除, which opens {@link OwnedItemDeleteDialog} with the preview (transferred to the platform
 * when another org uses it). Members see the switch's state, without acting.
 */
function OwnedSection({
  orgId,
  item,
  admin,
}: {
  orgId: string;
  item: OrgCatalogItem;
  admin: boolean;
}) {
  const t = useTranslations("plugins");
  const locale = useLocale();
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const name = displayNameOf(item, locale);
  // 可共享 is copied to the plugin's components (P3-2): the plugin and its components read again
  const share = useAppMutation({
    fn: (shareable: boolean) => setOwnedShareable(orgId, item.id, shareable),
    invalidates: () => [
      keys.org(orgId).catalog(),
      keys.org(orgId).catalogItemsAll(),
      keys.org(orgId).componentsAll(),
    ],
  });
  const toggle = async (next: boolean) => {
    setError(undefined);
    try {
      await share.mutateAsync(next);
      toast.success(next ? t("toast.shareOn", { name }) : t("toast.shareOff", { name }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card title={t("owned.title")}>
      <Stack gap={8}>
        <SwitchField
          label={t("owned.shareable")}
          checked={item.shareable}
          onChange={(next) => void toggle(next)}
          disabled={!admin || share.isPending}
        />
        <Text variant="prose" tone="muted">
          {t("owned.shareableHelp")}
        </Text>
        {admin && (
          <Stack direction="row">
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t("action.delete")}
            </Button>
          </Stack>
        )}
        {error !== undefined && <FormError message={error} />}
      </Stack>
      {deleting && (
        <OwnedItemDeleteDialog
          orgId={orgId}
          itemId={item.id}
          name={name}
          onClose={() => setDeleting(false)}
          onDeleted={() => router.push("/plugins")}
        />
      )}
    </Card>
  );
}
