"use client";

import { ListPage, type MenuItem, ObjectCard } from "@capybara-hq/design";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useOwnerLabel } from "../../../components/CatalogParts";
import { useComponentSwitch } from "../../../components/ComponentSwitch";
import { ConnectorPermissionsSheet } from "../../../components/ConnectorPermissions";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { useRouter } from "../../../i18n/navigation";
import { componentLabel, type OrgComponent } from "../../../lib/components";
import { useStartConnect } from "../../../lib/connect";
import {
  type ConnectorDetail,
  type ConnectorSummary,
  canManageConnectors,
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
 * switch, then straight to 补充配置 for the template's input), 需要配置 with 配置 once on without its
 * connector. Connector cards: a personal one shows the viewer's own state, 连接 (OAuth: the connect
 * route, back here) and, once connected, 权限 (the viewer's own tool policies for their
 * connection). Members read the template cards without actions; guests see the connectors only.
 * From the query cache (the layout prefetched the list, the templates and the personal
 * connectors' details on a first load).
 */
export default function ConnectorsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Connectors orgId={ws.orgId} me={ws.me} />;
}

/** The setup of a template on in the org without its connector (ruling P2-10, 补充配置). */
export const setupHref = (itemId: string) =>
  `/plugins/${encodeURIComponent(itemId)}/connectors?from=connectors`;

const roleOf = (me: Me) => me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;

function Connectors({ orgId, me }: { orgId: string; me: Me }) {
  const scope = usePagePath("org");
  const t = useTranslations("connectors");
  const tc = useTranslations("orgComponents");
  const locale = useLocale();
  const router = useRouter();
  const manage = canManageConnectors(me);
  // the offered templates are a catalog read: members up (guests see the connectors only)
  const member = roleOf(me) !== undefined && roleOf(me) !== "guest";
  const [tab, setTab] = useState<"all" | "disabled">("all");
  const [permissions, setPermissions] = useState<string | null>(null);
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
  const ownerLabel = useOwnerLabel(orgId);
  const { start, starting } = useStartConnect(orgId);
  const { actionsOf, dialog, error } = useComponentSwitch({
    orgId,
    admin: manage,
    // A template on now has no connector yet: enter its input at once
    onEnabled: (c) => {
      if (c.kind === "connector_template" && c.itemId !== null) router.push(setupHref(c.itemId));
    },
  });
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? list.data.connectors : [];
  const detailOf = new Map(
    details.flatMap((d) => (d.data === undefined ? [] : [[d.data.id, d.data] as const])),
  );
  // The templates of plugins on here without a connector (one with a connector is that card)
  const made = new Set(all.flatMap((c) => (c.platformTemplateId ? [c.platformTemplateId] : [])));
  const templates = (offered.data?.components ?? [])
    .filter((c) => c.kind === "connector_template" && c.pluginOn && !made.has(c.id))
    .sort((a, b) => componentLabel(a, locale).localeCompare(componentLabel(b, locale)));
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
    const d = detailOf.get(c.id);
    const own = personal.some((p) => p.id === c.id);
    const connected = d?.credential.status === "connected";
    const base = {
      avatar: { image: c.icon ?? null },
      title: c.name,
      href: `/connectors/${encodeURIComponent(c.id)}`,
      meta: [t(`auth.${c.auth.type}`), c.slug],
    };
    if (c.status === "disabled") {
      return (
        <ObjectCard key={c.id} {...base} state={{ label: t("status.disabled"), tone: "muted" }} />
      );
    }
    if (!own || d === undefined) {
      return <ObjectCard key={c.id} {...base} state={{ label: t("status.active"), tone: "ok" }} />;
    }
    if (!connected) {
      return (
        <ObjectCard
          key={c.id}
          {...base}
          state={{ label: t("cards.notConnected"), tone: "warn" }}
          primary={
            c.auth.type === "oauth_code"
              ? { label: t("cards.connect"), onSelect: () => void start(c.id), loading: starting }
              : { label: t("cards.connect"), href: `/account/connections#app-${c.id}` }
          }
        />
      );
    }
    return (
      <ObjectCard
        key={c.id}
        {...base}
        state={{ label: t("cards.connected"), tone: "ok" }}
        primary={{ label: t("cards.permissions"), onSelect: () => setPermissions(c.id) }}
      />
    );
  };

  /** A template's card: off (启用 for admins) or on without its connector (配置 for admins). */
  const templateCard = (c: OrgComponent) => {
    const name = componentLabel(c, locale);
    const base = {
      avatar: { image: c.icon ?? null },
      title: name,
      ...(c.description ? { description: c.description } : {}),
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
      return (
        <ObjectCard
          key={`template:${c.id}`}
          {...base}
          state={{ label: t("templates.needsConfig"), tone: "warn" }}
          {...(manage && c.itemId !== null
            ? { primary: { label: t("templates.configure"), href: setupHref(c.itemId) } }
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

  const open = permissions === null ? undefined : detailOf.get(permissions);
  return (
    <>
      <ListPage header={header} variant="cards" {...callout} {...(empty ? { empty } : {})}>
        {rows.map(connectorCard)}
        {active === "all" && templates.map(templateCard)}
      </ListPage>
      {dialog}
      {open !== undefined && (
        <ConnectorPermissionsSheet
          orgId={orgId}
          connector={open as ConnectorDetail}
          onClose={() => setPermissions(null)}
        />
      )}
    </>
  );
}
