"use client";

import { ListPage, type MenuItem, ObjectCard } from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useOwnerLabel } from "../../../components/CatalogParts";
import { useComponentSwitch } from "../../../components/ComponentSwitch";
import { connectorAdminItem, usePersonalConnections } from "../../../components/ConnectionActions";
import { useMemberGuides } from "../../../components/ConnectorGuides";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { componentDescription, componentLabel, type OrgComponent } from "../../../lib/components";
import {
  type ConnectorDetail,
  type ConnectorSummary,
  canManageConnectors,
  connectorDescriptionOf,
  personalConnectors,
} from "../../../lib/connectors";
import { retryOnMountOf } from "../../../lib/query/client";
import { orgComponentsQuery } from "../../../lib/query/components";
import { connectorQuery, connectorsQuery } from "../../../lib/query/conversation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import type { Me } from "../../../lib/session";
import NotFound from "../not-found";

/**
 * `/connectors` (maintainer decision 2026-11-09): one card per connector of the org and per
 * connector template of a plugin on in the org that has no connector here yet, switched off or
 * not, each with its plugin's icon. Template cards: 未启用 with 启用 for org admins (the component
 * switch, which creates its connector: that connector's card follows); one on without a connector
 * (its connector deleted, ruling R31) says so, with create connector for org admins (the
 * switch-on again). Connector cards (one button each, the rest in ⋯, maintainer decision 2026-11-09): one that lacks the org input its auth needs (`setup: needs_config`, plugin pages
 * spec §5.2.4) is needs-configuration with configure (its credentials tab: the template's guide, the editable endpoint, the
 * credential or client) for org admins, waiting for an admin without a button for everyone else; a
 * personal one shows the viewer's own state, 连接 (OAuth: the connect route, back here; a
 * credential: its sheet) and, once connected, 权限 (the viewer's own tool policies for their
 * connection), with 如何连接 / 重新连接 / 断开连接 in ⋯ (`usePersonalConnections`); org admins have
 * 修改配置 in ⋯ on every connector card (its detail's 设置 tab). Members read the template cards
 * without actions; guests see the connectors only.
 * From the query cache (the layout prefetched the list, the templates and the personal
 * connectors' details on a first load).
 */
export default function ConnectorsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Connectors orgId={ws.orgId} me={ws.me} />;
}

/** configure on a needs-configuration connector: its credentials tab, the form that takes the missing input. */
export const configureHref = (connectorId: string) =>
  `/connectors/${encodeURIComponent(connectorId)}?tab=credentials`;

const roleOf = (me: Me) => me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;

function Connectors({ orgId, me }: { orgId: string; me: Me }) {
  const scope = usePagePath("org");
  const t = useTranslations("connectors");
  const tc = useTranslations("orgComponents");
  const tn = useTranslations("connections");
  const locale = useLocale();
  const manage = canManageConnectors(me);
  // the offered templates are a catalog read: members up (guests see the connectors only)
  const member = roleOf(me) !== undefined && roleOf(me) !== "guest";
  const [tab, setTab] = useState<"all" | "disabled">("all");
  const list = usePageQuery(connectorsQuery(orgId));
  const cq = orgComponentsQuery(orgId, { kind: "connector_template" });
  const offered = useQuery({ ...cq, enabled: member, retryOnMount: retryOnMountOf(cq.queryKey) });
  const personal = list.kind === "ready" ? personalConnectors(list.data.connectors) : [];
  const details = useQueries({
    queries: personal.map((a) => {
      const q = connectorQuery(orgId, a.id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  // the personal connectors whose template's guide has a member section: 如何连接 on their card
  const memberGuides = useMemberGuides(orgId, personal);
  const loaded = details.flatMap((d) => (d.data === undefined ? [] : [d.data]));
  const connection = usePersonalConnections({
    orgId,
    admin: manage,
    page: "connectors",
    connectors: loaded,
    guides: memberGuides,
  });
  const ownerLabel = useOwnerLabel(orgId);
  const { actionsOf, createConnectorOf, dialog, error } = useComponentSwitch({
    orgId,
    admin: manage,
  });
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? list.data.connectors : [];
  const detailOf = new Map(loaded.map((d) => [d.id, d] as const));
  // The templates of plugins on here without a connector (one with a connector is that card)
  const made = new Set(all.flatMap((c) => (c.platformTemplateId ? [c.platformTemplateId] : [])));
  const templates = (offered.data?.components ?? [])
    .filter((c) => c.kind === "connector_template" && c.pluginOn && !made.has(c.id))
    .sort((a, b) => componentLabel(a, locale).localeCompare(componentLabel(b, locale), locale));
  const disabled = all.filter((c) => c.status === "disabled");
  // A tab only when it holds something different from "all".
  const active = tab === "disabled" && disabled.length > 0 ? "disabled" : "all";
  const rows = active === "disabled" ? disabled : all;
  const header = {
    path: [...scope, { label: "connectors" }],
    title: t("title"),
    actions: [
      ...(manage
        ? [{ label: t("new"), variant: "primary" as const, href: "/connectors/install" }]
        : []),
      { label: t("myConnections"), variant: "default" as const, href: "/account/connections" },
    ],
    ...(disabled.length > 0
      ? {
          tabs: [
            {
              id: "all",
              label: t("tabs.all"),
              count: all.length + templates.length,
              onSelect: () => setTab("all"),
            },
            {
              id: "disabled",
              label: t("tabs.disabled"),
              count: disabled.length,
              onSelect: () => setTab("disabled"),
            },
          ],
          activeTab: active,
        }
      : {}),
  };
  const empty =
    all.length === 0 && templates.length === 0
      ? {
          text: t("empty"),
          ...(manage
            ? {
                action: {
                  label: t("new"),
                  variant: "primary" as const,
                  href: "/connectors/install",
                },
              }
            : {}),
        }
      : undefined;
  const callout =
    error !== undefined
      ? {
          callout: {
            tone: "fail" as const,
            children: <FormError message={error.message} extra={error.extra} />,
          },
        }
      : member && offered.data === undefined && offered.error !== null
        ? // the offered templates could not be read: their cards are missing until a retry
          {
            callout: {
              tone: "warn" as const,
              children: tc("listUnavailable"),
              action: { label: tc("retry"), onSelect: () => void offered.refetch() },
            },
          }
        : {};
  if (list.kind === "loading") return <ListPage header={header} variant="cards" loading />;

  /** A connector's card: its state, and for a personal one the viewer's own connection. */
  const connectorCard = (c: ConnectorSummary) => {
    const d: ConnectorDetail | undefined = detailOf.get(c.id);
    const own = personal.some((p) => p.id === c.id);
    // for org admins: the connector's 凭据 tab, or 设置 without credentials (alone, the one button)
    const config: MenuItem[] = manage ? [connectorAdminItem(c, tn)] : [];
    const description = connectorDescriptionOf(c, locale);
    const base = {
      avatar: { image: c.icon ?? null },
      title: c.name,
      ...(description !== null ? { description } : {}),
      href: `/connectors/${encodeURIComponent(c.id)}`,
      meta: [t(`auth.${c.auth.type}`), c.slug],
      ...(config.length > 0 ? { menu: config } : {}),
    };
    if (c.status === "disabled") {
      return (
        <ObjectCard key={c.id} {...base} state={{ label: t("status.disabled"), tone: "muted" }} />
      );
    }
    // Lacks the org input its auth needs: never called, so no member's connect either
    if (c.setup === "needs_config") {
      return manage ? (
        <ObjectCard
          key={c.id}
          {...base}
          state={{ label: t("setup.needsConfig"), tone: "warn" }}
          primary={{ label: t("setup.configure"), href: configureHref(c.id) }}
        />
      ) : (
        <ObjectCard key={c.id} {...base} state={{ label: t("setup.needsAdmin"), tone: "warn" }} />
      );
    }
    const parts = own && d !== undefined ? connection.parts(d) : null;
    if (parts === null) {
      return <ObjectCard key={c.id} {...base} state={{ label: t("status.active"), tone: "ok" }} />;
    }
    return <ObjectCard key={c.id} {...base} {...parts} />;
  };

  /** A template's card: off (enable for admins), or on without a connector (create for admins). */
  const templateCard = (c: OrgComponent) => {
    const name = componentLabel(c, locale);
    const description = componentDescription(c, locale);
    const base = {
      avatar: { image: c.icon ?? null },
      title: name,
      ...(description !== null ? { description } : {}),
      // where it came from (its plugin, else its owner) and its id, unless the plugin says it
      meta: [
        tc("kind.connector_template"),
        c.plugin ? tc("from.plugin", { plugin: c.plugin }) : ownerLabel(c.owner),
        ...(c.name !== c.plugin ? [c.name] : []),
      ],
    };
    const switches = actionsOf(c);
    const off = switches.find((a) => a.id === "disable");
    const menu: MenuItem[] =
      off?.onSelect !== undefined
        ? [{ label: off.label, danger: true, onSelect: off.onSelect }]
        : [];
    if (c.on) {
      // On without a connector here (one an admin deleted is not made again, ruling R31): org
      // admins create it, everyone else waits for them
      const create = createConnectorOf(c);
      return (
        <ObjectCard
          key={`template:${c.id}`}
          {...base}
          description={t("setup.noConnectorHint")}
          state={{
            label: manage ? t("setup.noConnector") : t("setup.needsAdmin"),
            tone: "warn",
          }}
          {...(create?.onSelect !== undefined
            ? {
                primary: {
                  label: create.label,
                  onSelect: create.onSelect,
                  ...(create.loading === true ? { loading: true } : {}),
                },
              }
            : {})}
          {...(menu.length > 0 ? { menu } : {})}
        />
      );
    }
    const enable = switches.find((a) => a.id === "enable");
    return (
      <ObjectCard
        key={`template:${c.id}`}
        {...base}
        state={{ label: tc("state.off"), tone: "muted" }}
        {...(enable?.onSelect !== undefined
          ? {
              primary: {
                label: enable.label,
                onSelect: enable.onSelect,
                ...(enable.loading === true ? { loading: true } : {}),
              },
            }
          : {})}
      />
    );
  };

  return (
    <>
      <ListPage header={header} variant="cards" {...callout} {...(empty ? { empty } : {})}>
        {rows.map(connectorCard)}
        {active === "all" && templates.map(templateCard)}
      </ListPage>
      {dialog}
      {connection.overlays}
    </>
  );
}
