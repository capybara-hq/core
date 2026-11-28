"use client";

import {
  Badge,
  Button,
  Callout,
  Card,
  ContentSection,
  DetailPage,
  ItemList,
  type ItemListRow,
  KeyValue,
  LinkButton,
  ObjectMark,
  Stack,
  SwitchField,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ComponentSection, useOwnerLabel } from "../../../../components/CatalogParts";
import { ComponentSwitchList, useComponentSwitch } from "../../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { OwnedItemDeleteDialog } from "../../../../components/OwnedItemDeleteDialog";
import { PluginInstallsSection } from "../../../../components/PluginInstallCards";
import { usePluginActions, usePluginState } from "../../../../components/PluginSwitch";
import { fromOrgDetail } from "../../../../components/plugin-contents/from-org";
import { PluginContents } from "../../../../components/plugin-contents/PluginContents";
import { usePagePath, usePathWord } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  descriptionOf,
  displayNameOf,
  type OrgCatalogDetail,
  type OrgCatalogItem,
  orgIconUrl,
  ownedBy,
  setOwnedShareable,
} from "../../../../lib/catalog";
import { componentLabel } from "../../../../lib/components";
import { personalConnectors } from "../../../../lib/connectors";
import { lockWhileRunning } from "../../../../lib/header-actions";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { orgCatalogItemQuery } from "../../../../lib/query/catalog";
import { orgExtensionsQuery } from "../../../../lib/query/channels";
import { retryOnMountOf } from "../../../../lib/query/client";
import { orgComponentsQuery } from "../../../../lib/query/components";
import { connectorQuery, connectorsQuery } from "../../../../lib/query/conversation";
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
 * §14) is marked 本组织上传 and has the 可共享 switch and 删除 (org admins, the head's ⋯ menu;
 * members see the state). One centred column: the full description first, the actions in the
 * head, the icon (an `<img>` through the kernel route) and the facts as a KeyValue. From the query cache (the layout prefetched it
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
  const pw = usePathWord("org");
  const read = usePageQuery(orgCatalogItemQuery(orgId, itemId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{ path: [...scope, pw("plugins", "/plugins")], title: "" }}
        // One column, no tab row (one view): the facts (the description over publisher, owner and
        // status) and the five component sections (extension, skills, agent templates, connector
        // templates, dependencies)
        loading={{
          facts: { rows: 3, keyWidth: "10ch", lead: true },
          content: [
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
  const pw = usePathWord("org");
  const t = useTranslations("catalog.org");
  const locale = useLocale();
  const stateOf = usePluginState();
  const item = detail.item;
  const admin = canUpdateOrg(me);
  const { actionsOf, dialog, error, busy } = usePluginActions({ orgId, admin });
  const actions = actionsOf(item);
  const owned = ownedBy(item, orgId);
  const tcm = useTranslations("common");
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const ownerLabel = useOwnerLabel(orgId);
  const tp = useTranslations("plugins");

  // The head's actions: the safe ones as buttons (drawn pending while they run); 停用 and the
  // org's own plugin's 删除 in the ⋯ menu (destructive items, spec §6.7)
  const menu = [
    ...actions
      .filter((a) => a.danger === true)
      .map((a) => ({
        label: a.label,
        danger: true,
        onSelect: a.onSelect ?? (() => {}),
      })),
    ...(owned && admin
      ? [{ label: tp("action.delete"), danger: true, onSelect: () => setDeleting(true) }]
      : []),
  ];
  const headActions = [
    ...actions
      .filter((a) => a.danger !== true)
      .map((a) =>
        a.href !== undefined
          ? { label: a.label, variant: "default" as const, href: a.href }
          : {
              label: a.label,
              variant: "default" as const,
              ...(a.loading === true ? { loading: true } : {}),
              onSelect: () => a.onSelect?.(),
            },
      ),
    ...(menu.length > 0 ? [{ label: tcm("moreActions"), menu }] : []),
  ];
  const description = descriptionOf(item, locale);
  const state = stateOf(item);
  return (
    <DetailPage
      header={{
        path: [...scope, pw("plugins", "/plugins"), { label: displayNameOf(item, locale) }],
        avatar: (
          <ObjectMark
            size={40}
            text={displayNameOf(item, locale)}
            image={detail.hasIcon ? orgIconUrl(orgId, item.id) : null}
          />
        ),
        title: displayNameOf(item, locale),
        count: versionLabel(item.latestVersion),
        ...(owned && { status: <Badge>{tp("chips.ownUpload")}</Badge> }),
        // while one runs (a switch-off preview from the menu too) the other buttons wait
        ...(headActions.length > 0 ? { actions: lockWhileRunning(headActions, busy) } : {}),
        ...(item.awaitingConfirmation !== true && item.pendingVersion != null
          ? {
              notice: (
                <Callout tone="warn">
                  {tp("chips.pendingVersion", { version: versionLabel(item.pendingVersion) })}
                </Callout>
              ),
            }
          : {}),
      }}
      facts={
        <Stack gap={12}>
          {/* The full description (the head's line would cut it), then the facts; the version is
              the head's */}
          {description !== "" && (
            <Text variant="prose" tone="muted" pre>
              {description}
            </Text>
          )}
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.fields.publisher"), v: item.publisher || "—" },
              { k: t("detail.fields.owner"), v: ownerLabel(item.owner) },
              { k: t("detail.fields.status"), v: <Text tone={state.tone}>{state.label}</Text> },
            ]}
          />
        </Stack>
      }
    >
      <Stack gap={16}>
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        {dialog}
        {owned && <OwnedSection orgId={orgId} item={item} admin={admin} />}
        {admin && <PluginInstallsSection orgId={orgId} itemId={item.id} />}
        <OrgConnectorsSection orgId={orgId} itemId={item.id} admin={admin} />
        <OrgComponentsSection orgId={orgId} itemId={item.id} admin={admin} />
        <OrgContents orgId={orgId} detail={detail} />
      </Stack>
      {deleting && (
        <OwnedItemDeleteDialog
          orgId={orgId}
          itemId={item.id}
          name={displayNameOf(item, locale)}
          onClose={() => setDeleting(false)}
          onDeleted={() => router.push("/plugins")}
        />
      )}
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
 * The latest version's contents (the shared contents view, detail stage, org audience): the
 * extension, skills, agent templates, connector templates and dependencies. The descriptions of
 * the skills and agent templates come from the org's components, the extension's name, what it
 * provides and whether it needs config from the org's extensions (read by members too).
 */
function OrgContents({ orgId, detail }: { orgId: string; detail: OrgCatalogDetail }) {
  const locale = useLocale();
  const cq = orgComponentsQuery(orgId, { itemId: detail.item.id });
  const components = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const eq = orgExtensionsQuery(orgId);
  const extensions = useQuery({ ...eq, retryOnMount: retryOnMountOf(eq.queryKey) });
  const own = extensions.data?.extensions.find((e) => e.plugin === detail.extension);
  const model = fromOrgDetail(detail, components.data?.components ?? [], own, locale);
  return <PluginContents model={model} audience="org" stage="detail" />;
}

/**
 * This organization's connectors: the connectors made from this plugin's connector templates
 * (matched by `platformTemplateId` to the template's platform component), each with its state and
 * a link to its page. A connector that needs each person's own credential shows the viewer's own
 * connection (connected or not, from its detail as the connectors page reads it); a member not
 * yet connected gets Connect, a link to the connector's page. Org admins also get a Create button on a
 * template with no connector (the connectors page's create-from-template action: the switch-on,
 * which makes it as an install would). Nothing to show: the section is left out.
 */
function OrgConnectorsSection({
  orgId,
  itemId,
  admin,
}: {
  orgId: string;
  itemId: string;
  admin: boolean;
}) {
  const t = useTranslations("catalog.org.detail.connectors");
  const tco = useTranslations("connectors");
  const tn = useTranslations("connections");
  const locale = useLocale();
  const cq = orgComponentsQuery(orgId, { itemId });
  const components = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const lq = connectorsQuery(orgId);
  const connectors = useQuery({ ...lq, retryOnMount: retryOnMountOf(lq.queryKey) });
  const { actionsOf, createConnectorOf, dialog, error } = useComponentSwitch({ orgId, admin });
  const templates = (components.data?.components ?? []).filter(
    (c) => c.kind === "connector_template" && c.itemId === itemId,
  );
  const ids = new Set(templates.map((c) => c.id));
  const made = (connectors.data?.connectors ?? []).filter(
    (m) => m.platformTemplateId != null && ids.has(m.platformTemplateId),
  );
  // The personal ones: their details carry the viewer's own credential status
  const personal = personalConnectors(made);
  const details = useQueries({
    queries: personal.map((a) => {
      const q = connectorQuery(orgId, a.id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  const credentialOf = new Map(
    details.flatMap((d) =>
      d.data === undefined ? [] : [[d.data.id, d.data.credential.status] as const],
    ),
  );
  const rows = templates.flatMap((c): ItemListRow[] => {
    const own = made.filter((m) => m.platformTemplateId === c.id);
    if (own.length > 0) {
      return own.map((m) => {
        const href = `/connectors/${encodeURIComponent(m.id)}`;
        const usable = m.status !== "disabled" && m.setup !== "needs_config";
        const mine = usable ? credentialOf.get(m.id) : undefined;
        return {
          id: m.id,
          mark: { text: m.name, image: m.icon ?? null },
          title: m.name,
          href,
          status:
            m.status === "disabled"
              ? { label: tco("status.disabled") }
              : m.setup === "needs_config"
                ? { label: tco("setup.needsConfig") }
                : mine === "connected"
                  ? { label: tn("connected") }
                  : mine === "missing"
                    ? { label: tn("missing"), tone: "accent" as const }
                    : { label: t("available") },
          // A member connects on the connector's page (its connect flow and credential sheet)
          ...(mine === "missing" &&
            !admin && {
              actions: <LinkButton href={href}>{tn("oauthConnect")}</LinkButton>,
            }),
        };
      });
    }
    // No connector yet: an org admin creates it (on: the create action; off: the switch-on)
    const create = createConnectorOf(c) ?? actionsOf(c).find((a) => a.id === "enable");
    if (create?.onSelect === undefined) return [];
    const name = componentLabel(c, locale);
    return [
      {
        id: `template:${c.id}`,
        mark: { text: name, image: c.icon ?? null },
        title: name,
        meta: t("noConnector"),
        actions: (
          <Button loading={create.loading === true} onClick={create.onSelect}>
            {t("create")}
          </Button>
        ),
      },
    ];
  });
  if (rows.length === 0 && error === undefined) return null;
  return (
    <ContentSection title={t("title")}>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      <ItemList label={t("title")} rows={rows} />
      {dialog}
    </ContentSection>
  );
}

/**
 * The org's own plugin (spec §14, P3-17 to P3-19): the 可共享 switch with its help text (its 删除,
 * which opens {@link OwnedItemDeleteDialog} with the preview, is the head's ⋯ menu item). Members
 * see the switch's state, without acting.
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
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string>();
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
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Card>
  );
}
