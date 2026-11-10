"use client";

import {
  Button,
  Callout,
  Card,
  CodeBlock as CopyBlock,
  DangerConfirm,
  DetailPage,
  EmptyState,
  Field,
  Grid,
  Icon,
  Input,
  KeyValue,
  ObjectMark,
  Select,
  Stack,
  StatusMark,
  Subsection,
  Switch,
  Text,
  Textarea,
  ToolPolicyList,
  type ToolPolicyRow,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  buildCredential,
  buildOAuthClient,
  CredentialFields,
  EMPTY_CREDENTIAL,
  EMPTY_OAUTH_CLIENT,
  OAuthClientFields,
} from "../../../../components/ConnectorForm";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { SetupGuideSection } from "../../../../components/SetupGuideSection";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import { displayNameOf } from "../../../../lib/catalog";
import {
  ackConnectorGuide,
  type ConnectorDetail,
  type ConnectorTool,
  canManageConnectors,
  deleteConnector,
  refreshConnector,
  reviewTool,
  setOrgCredential,
  type ToolDefinition,
  type ToolPolicy,
  type UpdateConnectorInput,
  updateConnector,
} from "../../../../lib/connectors";
import { labelLocale } from "../../../../lib/extension-label";
import { orgCatalogItemQuery } from "../../../../lib/query/catalog";
import { retryOnMountOf } from "../../../../lib/query/client";
import { connectorQuery } from "../../../../lib/query/conversation";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { setupGuideQuery } from "../../../../lib/query/setup";
import { useWorkspace } from "../../../../lib/query/workspace";
import { toolDisplayName, toolTooltip } from "../../../../lib/tool-key";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

const TABS = ["tools", "review", "credentials", "settings"] as const;
/** The tabs, and 接入指南 for org admins on a connector whose template has a setup guide. */
type Tab = (typeof TABS)[number] | "guide";
const isTab = (v: string | undefined): v is Tab =>
  v === "guide" || (TABS as readonly string[]).includes(v ?? "");
const POLICIES = ["allow", "ask", "deny"] as const satisfies readonly ToolPolicy[];

/** Saves a change to the connector; resolves with the connector the kernel answered. */
type Update = (input: UpdateConnectorInput) => Promise<ConnectorDetail>;

/**
 * `/connectors/[connectorId]`: a connector's detail (DetailPage, one centred column): the facts
 * (connector, endpoint, auth, credential) first, then the tabs 工具（启停、默认策略）、复核（定义变化的新旧对比）、
 * 凭据（含 OAuth 客户端轮换）、设置（改名、启停、删除）。From the query cache (the layout prefetched it
 * on a first load); a missing connector is the not-found state. A change the kernel answers with
 * the connector replaces the cached one; a credential change reads it again.
 */
export default function ConnectorView({
  connectorId,
  tab,
}: {
  connectorId: string;
  /**
   * `?tab=<id>`: open on that tab (`guide`: 接入指南, the member sheet's link for org admins;
   * `settings`: the cards' 修改配置).
   */
  tab?: string | undefined;
}) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <Connector
      key={connectorId}
      orgId={ws.orgId}
      connectorId={connectorId}
      manage={canManageConnectors(ws.me)}
      initialTab={isTab(tab) ? tab : "tools"}
    />
  );
}

function Connector({
  orgId,
  connectorId,
  manage,
  initialTab,
}: {
  orgId: string;
  connectorId: string;
  manage: boolean;
  initialTab: Tab;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const [requested, setTab] = useState<Tab>(initialTab);
  const read = usePageQuery(connectorQuery(orgId, connectorId));
  const key = connectorQuery(orgId, connectorId).queryKey;
  const saved = (next: ConnectorDetail) => qc.setQueryData(key, next);
  // The kernel answers a change with the connector: it replaces the cached one; the list (names,
  // status) is read again when shown, and so are the setup checks' states (a new input reruns them).
  const save = useAppMutation({
    fn: (input: UpdateConnectorInput) => updateConnector(orgId, connectorId, input),
    invalidates: () => [keys.org(orgId).connectors(), keys.org(orgId).setupChecksAll()],
    onSuccess: (r) => saved(r.connector),
  });
  const update: Update = (input) => save.mutateAsync(input).then((r) => r.connector);
  const refresh = useAppMutation({
    fn: () => refreshConnector(orgId, connectorId),
    invalidates: () => [],
    onSuccess: (r) => saved(r.connector),
  });

  async function onRefresh() {
    try {
      await refresh.mutateAsync(undefined);
      toast.success(t("detail.refreshed"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "connectors", href: "/connectors" }],
          title: "",
          // the template's plugin mark keeps its place
          loading: { title: true, avatar: true },
        }}
        tabs={{
          label: t("detail.tabsLabel"),
          items: TABS.map((id) => ({ id, label: t(`detail.tabs.${id}`) })),
          value: requested === "guide" ? "tools" : requested,
          onChange: (id) => setTab(id as Tab),
        }}
        // The facts (connector, endpoint, auth, credential; ownership comes with the data), then
        // the tools tab's card
        loading={{
          facts: { rows: 4, keyWidth: "10ch" },
          content: [
            // the tools card: its title (and, for a manager, the refresh button) over the rows
            { kind: "card", card: { lines: 6, actions: manage ? 1 : 0 } },
          ],
        }}
      />
    );
  }
  const app = read.data;
  // 接入指南: the admin text with the drift notice, for those who manage connectors (members read
  // the member text on their connection's 如何连接 sheet)
  const guide = manage ? (app.setupGuide ?? null) : null;
  const tabs: Tab[] = guide !== null ? [...TABS, "guide"] : [...TABS];
  const tab: Tab = tabs.includes(requested) ? requested : "tools";

  return (
    <DetailPage
      header={{
        path: [...scope, { label: "connectors", href: "/connectors" }, { label: app.name }],
        // its template's plugin icon (the name's initial without one)
        avatar: <ObjectMark size={40} text={app.name} image={app.icon ?? null} />,
        title: app.name,
        count: app.slug,
        status:
          app.status === "active" ? (
            <StatusMark status="success" label={t("status.active")} />
          ) : (
            <StatusMark status="cancelled" label={t("status.disabled")} />
          ),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: tabs.map((id) => ({
          id,
          label: t(`detail.tabs.${id}`),
          ...(id === "tools" ? { count: app.tools.length } : {}),
          ...(id === "review" && reviewCount(app) > 0 ? { count: reviewCount(app) } : {}),
        })),
        value: tab,
        onChange: (id) => setTab(id as Tab),
      }}
      facts={<ConnectorFacts app={app} />}
    >
      {guide !== null && tab !== "guide" && app.guideDrift ? (
        <GuideDriftCallout
          orgId={orgId}
          connectorId={app.id}
          guide={guide}
          drift={app.guideDrift}
          onOpen={() => setTab("guide")}
        />
      ) : null}
      {tab === "guide" && guide !== null ? (
        <GuideTab orgId={orgId} app={app} guide={guide} onSaved={saved} />
      ) : tab === "tools" ? (
        <ToolsTab
          app={app}
          manage={manage}
          update={update}
          refresh={{ onRefresh: () => void onRefresh(), refreshing: refresh.isPending }}
          onOpenReview={() => setTab("review")}
        />
      ) : tab === "review" ? (
        <ReviewTab orgId={orgId} app={app} manage={manage} onSaved={saved} />
      ) : tab === "credentials" ? (
        <CredentialsTab orgId={orgId} app={app} manage={manage} />
      ) : (
        <SettingsTab orgId={orgId} app={app} manage={manage} update={update} />
      )}
    </DetailPage>
  );
}

/**
 * The plugin's display name for the drift notice, from the org's catalog; when the item cannot be
 * read, the plugin's name from the guide rendered for the connector (the guide tab's read).
 */
function usePluginLabel(
  orgId: string,
  connectorId: string,
  guide: NonNullable<ConnectorDetail["setupGuide"]>,
): string | undefined {
  const locale = useLocale();
  const q = orgCatalogItemQuery(orgId, guide.itemId);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const gq = setupGuideQuery(orgId, guide, {
    connectorId,
    audience: "admin",
    locale: labelLocale(locale),
  });
  const fallback = useQuery({
    ...gq,
    enabled: read.isError,
    retryOnMount: retryOnMountOf(gq.queryKey),
  }).data?.plugin;
  const item = read.data?.item;
  return item === undefined ? fallback : displayNameOf(item, locale);
}

/**
 * On the other tabs, the plugin changed the template's setup since the connector was set up: the
 * notice, leading to 接入指南 where 「我已更新应用」 records it.
 */
function GuideDriftCallout({
  orgId,
  connectorId,
  guide,
  drift,
  onOpen,
}: {
  orgId: string;
  connectorId: string;
  guide: NonNullable<ConnectorDetail["setupGuide"]>;
  drift: { from: string; to: string };
  onOpen(): void;
}) {
  const t = useTranslations("setupGuide");
  const plugin = usePluginLabel(orgId, connectorId, guide);
  if (plugin === undefined) return null;
  return (
    <Callout tone="warn" action={{ label: t("openGuide"), onSelect: onOpen }}>
      {t("connectorDriftNotice", {
        plugin,
        from: versionLabel(drift.from),
        to: versionLabel(drift.to),
      })}
    </Callout>
  );
}

/**
 * 接入指南 (setup guides v2 spec §9.3, §11): the template's guide rendered for this connector, the
 * admin text, with the notice when an upgrade changed its code or checks since the connector was
 * set up and 「我已更新应用」 (records the shown guide by its hash).
 */
function GuideTab({
  orgId,
  app,
  guide,
  onSaved,
}: {
  orgId: string;
  app: ConnectorDetail;
  guide: NonNullable<ConnectorDetail["setupGuide"]>;
  onSaved(next: ConnectorDetail): void;
}) {
  const t = useTranslations("setupGuide");
  const plugin = usePluginLabel(orgId, app.id, guide);
  const ack = useAppMutation({
    fn: (hash: string) => ackConnectorGuide(orgId, app.id, hash),
    invalidates: () => [keys.org(orgId).connectors()],
    onSuccess: (r) => onSaved(r.connector),
  });
  const drift = app.guideDrift ?? null;
  return (
    <Card title={t("title")}>
      <Stack gap={16}>
        <Text variant="prose" tone="muted">
          {t("connectorHint")}
        </Text>
        <SetupGuideSection
          key={guide.version}
          orgId={orgId}
          guide={guide}
          query={{ connectorId: app.id, audience: "admin" }}
          targetLabel={app.name}
          checks="live"
          {...(plugin !== undefined ? { pluginLabel: plugin } : {})}
          drift={
            drift === null
              ? null
              : {
                  ...drift,
                  onAck: async (hash) => {
                    await ack.mutateAsync(hash);
                  },
                }
          }
        />
      </Stack>
    </Card>
  );
}

/**
 * The connector's facts at the top of the column (spec §5.2). The slug is the head's count and the
 * status the head's mark, so neither is repeated here.
 */
function ConnectorFacts({ app }: { app: ConnectorDetail }) {
  const t = useTranslations("connectors");
  const ownership = app.auth.type === "none" ? null : app.auth.ownership;
  return (
    <KeyValue
      keyWidth="10ch"
      rows={[
        { k: t("inspector.connector"), v: app.connector },
        { k: t("inspector.endpoint"), v: app.endpoint.url ?? "—" },
        { k: t("inspector.auth"), v: t(`auth.${app.auth.type}`) },
        ...(ownership ? [{ k: t("inspector.ownership"), v: t(`ownership.${ownership}`) }] : []),
        {
          k: t("inspector.credential"),
          v:
            app.credential.ownership === null
              ? t("credential.notNeeded")
              : t(`credential.${app.credential.status}`),
        },
      ]}
    />
  );
}

/** How many tools make the tab draw its filter field (as ToolPolicyList's own, spec §6.36). */
const SEARCH_FROM = 9;

/**
 * 工具页签（spec §6.36）：一张卡片，工具按声明分成「只读」与「可能写入」两组（与成员的权限 Sheet 同组），每组一个
 * `ToolPolicyList`（`control: "switch"`）：每行是工具的显示名（声明的标题，否则不带 `mcp__<slug>__` 前缀的名字；
 * 完整的键与说明在悬停提示里）、默认策略和启用开关。待复核等不能启用的工具开关锁定，注释说明原因并链到复核页签。
 * 工具多时上方有一个跨两组的搜索框。成员只读：策略是文字，停用的工具在注释里写明。「刷新工具」在卡片头部，刷新期间
 * 为加载中且不可再点。
 */
function ToolsTab({
  app,
  manage,
  update,
  refresh,
  onOpenReview,
}: {
  app: ConnectorDetail;
  manage: boolean;
  update: Update;
  refresh: { onRefresh(): void; refreshing: boolean };
  onOpenReview(): void;
}) {
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState("");

  async function patch(
    tool: ConnectorTool,
    change: { status?: "enabled" | "disabled"; defaultPolicy?: ToolPolicy },
  ) {
    setBusy(tool.name);
    try {
      await update({ tools: { [tool.name]: change } });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const byName = new Map(app.tools.map((x) => [x.name, x]));
  /** Why a tool cannot be switched on now, with the way to the 复核 tab when it is resolved there. */
  const noteOf = (x: ConnectorTool): ToolPolicyRow["note"] => {
    const review = reviewable(x)
      ? {
          action: {
            label: t("tools.openReview"),
            ariaLabel: t("tools.openReviewLabel", { tool: toolDisplayName(x) }),
            onClick: onOpenReview,
          },
        }
      : {};
    if (x.missing === true) return { text: t("tools.missing"), tone: "warn" };
    if (x.issue !== null) return { text: x.issue, tone: "warn", ...review };
    if (x.status === "pending_review")
      return { text: t("tools.pendingReview"), tone: "warn", ...review };
    if (neverReviewedDisabled(x))
      return { text: t("tools.neverReviewed"), tone: "warn", ...review };
    if ((x.pending ?? null) !== null)
      return { text: t("tools.pendingReview"), tone: "warn", ...review };
    if (!manage && x.status === "disabled") return { text: t("tools.disabled") };
    return undefined;
  };
  const rowOf = (x: ConnectorTool): ToolPolicyRow => {
    const note = noteOf(x);
    return {
      id: x.name,
      label: toolDisplayName(x),
      tooltip: toolTooltip(x),
      checked: x.status === "enabled",
      // a disabled tool switches on only once nothing stands in its way (reviewed, valid, offered)
      checkLocked:
        x.status === "pending_review" ||
        (x.status === "disabled" &&
          (x.issue !== null ||
            x.missing === true ||
            x.reviewedAt === null ||
            (x.pending ?? null) !== null)),
      policy: x.defaultPolicy,
      ...(note !== undefined ? { note } : {}),
    };
  };
  const q = query.trim().toLowerCase();
  const shown =
    q === ""
      ? app.tools
      : app.tools.filter(
          (x) => toolDisplayName(x).toLowerCase().includes(q) || x.name.toLowerCase().includes(q),
        );
  // grouped by what a tool declares, as the member's 权限 sheet groups them
  const groups = (["read", "write"] as const).map((g) => ({
    id: g,
    tools: shown.filter((x) => (x.annotations?.readOnlyHint === true) === (g === "read")),
  }));
  const policyOptions = POLICIES.map((p) => ({ value: p, label: t(`policy.${p}`) }));

  return (
    <Card
      title={t("tools.title")}
      {...(manage
        ? {
            actions: (
              <Button density="dense" loading={refresh.refreshing} onClick={refresh.onRefresh}>
                {t("detail.refresh")}
              </Button>
            ),
          }
        : {})}
    >
      {app.tools.length === 0 ? (
        <EmptyState size="panel" text={t("tools.empty")} />
      ) : (
        <Stack gap={12}>
          <Text variant="prose" tone="muted">
            {manage ? t("tools.hintManage") : t("tools.hintRead")}
          </Text>
          {app.tools.length >= SEARCH_FROM ? (
            <Input
              type="search"
              density="dense"
              prefix={<Icon name="search" size={14} />}
              placeholder={t("tools.search")}
              aria-label={t("tools.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}
          {shown.length === 0 ? (
            <EmptyState size="panel" text={t("tools.noMatch")} />
          ) : (
            groups.map((g) =>
              g.tools.length === 0 ? null : (
                <Subsection
                  key={g.id}
                  variant="divided"
                  title={t(`tools.groups.${g.id}`)}
                  count={g.tools.length}
                  description={t(`tools.groups.${g.id}Hint`)}
                >
                  <ToolPolicyList
                    label={t(`tools.groups.${g.id}`)}
                    rows={g.tools.map(rowOf)}
                    policyOptions={policyOptions}
                    control="switch"
                    readOnly={!manage}
                    disabled={busy !== undefined}
                    onCheck={(name, on) => {
                      const x = byName.get(name);
                      if (x) void patch(x, { status: on ? "enabled" : "disabled" });
                    }}
                    onPolicy={(name, v) => {
                      const x = byName.get(name);
                      if (x) void patch(x, { defaultPolicy: v as ToolPolicy });
                    }}
                  />
                </Subsection>
              ),
            )
          )}
        </Stack>
      )}
    </Card>
  );
}

function CredentialsTab({
  orgId,
  app,
  manage,
}: {
  orgId: string;
  app: ConnectorDetail;
  manage: boolean;
}) {
  const t = useTranslations("connectors");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_CREDENTIAL);
  const [pending, setPending] = useState(false);
  // A credential change is not answered with the connector: its status is read again.
  const setCredential = useAppMutation({
    fn: (credential: Parameters<typeof setOrgCredential>[2]) =>
      setOrgCredential(orgId, app.id, credential),
    invalidates: () => [keys.org(orgId).connector(app.id), keys.org(orgId).setupChecksAll()],
  });
  const status = (
    <StatusMark
      status={app.credential.status === "connected" ? "success" : "waiting"}
      label={t(`credential.${app.credential.status}`)}
    />
  );

  if (app.auth.type === "none") {
    return (
      <Card title={t("credential.title")}>
        <Text tone="muted">{t("credential.notNeeded")}</Text>
      </Card>
    );
  }
  const auth = app.auth;

  const personalCard = (
    <Card title={t("credential.personalTitle")} actions={status}>
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("credential.personalHint")}
        </Text>
        <Stack direction="row">
          <Button onClick={() => router.push("/account/connections")}>
            {t("credential.openConnections")}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );

  if (auth.type === "oauth_client") {
    // 客户端凭据流：组织 token 由客户端换取，不在界面手填；管理员可轮换客户端（内核先验证再替换）
    return (
      <Card title={t("credential.orgTitle")} actions={status}>
        <Stack gap={12}>
          <Text variant="prose" tone="muted">
            {t("credential.oauthOrgHint")}
          </Text>
          {manage && <RotateClient orgId={orgId} app={app} />}
        </Stack>
      </Card>
    );
  }

  if (auth.type === "oauth_code") {
    return (
      <Stack gap={16}>
        {personalCard}
        {manage && (
          <Card title={t("credential.clientTitle")}>
            <Stack gap={16}>
              {app.oauthCallbackUrl != null && (
                <Stack gap={8}>
                  <Text variant="h3">{t("credential.callbackTitle")}</Text>
                  <Text variant="prose" tone="muted">
                    {t("credential.callbackHint")}
                  </Text>
                  <CopyBlock text={app.oauthCallbackUrl} copyable />
                </Stack>
              )}
              {auth.client === "manual" ? (
                <RotateClient orgId={orgId} app={app} />
              ) : (
                <Text tone="muted">{t("credential.clientDcr")}</Text>
              )}
            </Stack>
          </Card>
        )}
      </Stack>
    );
  }

  if (auth.ownership === "personal") return personalCard;

  const names = auth.type === "headers" ? auth.names : [];
  const credential = buildCredential(auth.type, values, names);

  async function save() {
    if (credential === undefined) return;
    setPending(true);
    try {
      await setCredential.mutateAsync(credential);
      setValues(EMPTY_CREDENTIAL);
      toast.success(t("credential.saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("credential.orgTitle")} actions={status}>
      <Stack gap={12}>
        <Text tone="muted">{t(manage ? "credential.orgHint" : "credential.orgReadonly")}</Text>
        {manage && (
          <>
            <CredentialFields auth={auth} values={values} onChange={setValues} />
            <Stack direction="row">
              <Button
                variant="primary"
                loading={pending}
                disabled={credential === undefined}
                onClick={() => void save()}
              >
                {t("credential.save")}
              </Button>
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}

function SettingsTab({
  orgId,
  app,
  manage,
  update,
}: {
  orgId: string;
  app: ConnectorDetail;
  manage: boolean;
  update: Update;
}) {
  const t = useTranslations("connectors");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(app.name);
  const [active, setActive] = useState(app.status === "active");
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // A delete invalidates the org's connectors (the list this page goes back to) and forgets the
  // connector once this page is left.
  const remove = useAppMutation({
    fn: () => deleteConnector(orgId, app.id),
    invalidates: () => [keys.org(orgId).connectors()],
    forgetsOnLeave: () => [keys.org(orgId).connector(app.id)],
  });
  const dirty = name.trim() !== app.name || active !== (app.status === "active");

  async function save() {
    if (name.trim() === "") return;
    setPending(true);
    try {
      await update({ name: name.trim(), status: active ? "active" : "disabled" });
      toast.success(t("settings.saved"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Stack gap={16}>
      <Card title={t("settings.title")}>
        <Stack gap={12}>
          <Field label={t("form.nameLabel")} required>
            <Input
              value={name}
              maxLength={80}
              disabled={!manage}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Stack direction="row" gap={12} align="center">
            <Switch
              label={t("settings.activeLabel")}
              checked={active}
              disabled={!manage}
              onChange={setActive}
            />
            <Text>{t("settings.activeLabel")}</Text>
          </Stack>
          {manage && (
            <Stack direction="row">
              <Button
                variant="primary"
                loading={pending}
                disabled={!dirty || name.trim() === ""}
                onClick={() => void save()}
              >
                {t("settings.save")}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>
      {manage && (
        <Card tone="danger" title={t("settings.dangerTitle")}>
          <Stack gap={12}>
            <Text variant="prose" tone="muted">
              {t("settings.deleteHint")}
            </Text>
            <Stack direction="row">
              <Button variant="danger" onClick={() => setConfirm(true)}>
                {t("settings.delete")}
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}
      <DangerConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={t("settings.deleteTitle", { name: app.name })}
        description={t("settings.deleteHint")}
        confirmName={app.name}
        confirmLabel={t("settings.delete")}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(undefined);
          } catch (e) {
            // 对话框保持打开并显示原因（翻译后的文案）
            throw new Error(errorMessage(e));
          }
          setConfirm(false);
          router.push("/connectors");
        }}
      />
    </Stack>
  );
}

/** 从未复核过、已停用的工具（被拒的新工具）：不能在工具页签启用，只能在复核页签批准。 */
const neverReviewedDisabled = (x: ConnectorTool) =>
  x.status === "disabled" && x.reviewedAt === null && x.missing !== true && x.issue === null;

/**
 * 复核页签列出的工具：待复核的、有待复核新定义的（含不合规而停用的，只能拒绝），以及被拒的新工具（仍可批准）。
 */
const reviewable = (x: ConnectorTool) =>
  x.missing !== true &&
  (x.status === "pending_review" || (x.pending ?? null) !== null || neverReviewedDisabled(x));

/**
 * 页签计数（漂移检测）：待复核的工具，加上带待复核新定义而停用的（如新定义不合规），
 * 后者不能在工具页签启用、只能在复核页签处理，要让管理员注意到。
 */
const reviewCount = (app: ConnectorDetail) =>
  app.tools.filter(
    (x) =>
      x.status === "pending_review" ||
      (x.status === "disabled" && x.missing !== true && (x.pending ?? null) !== null),
  ).length;

/**
 * OAuth 客户端轮换（Ruling A18，`PUT credentials/org`）：客户端凭据流在内核先用新客户端取 token 验证；
 * 手填客户端的授权码流不验证，填错会让所有成员重新连接（提示）。
 */
function RotateClient({ orgId, app }: { orgId: string; app: ConnectorDetail }) {
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_OAUTH_CLIENT);
  const [pending, setPending] = useState(false);
  const setClient = useAppMutation({
    fn: (client: Parameters<typeof setOrgCredential>[2]) => setOrgCredential(orgId, app.id, client),
    invalidates: () => [keys.org(orgId).connector(app.id), keys.org(orgId).setupChecksAll()],
  });
  const clientFlow = app.auth.type === "oauth_client";
  const value = buildOAuthClient(values);
  const ready = value !== undefined && (!clientFlow || values.clientSecret !== "");

  async function rotate() {
    if (!ready || value === undefined) return;
    setPending(true);
    try {
      await setClient.mutateAsync(value);
      setValues(EMPTY_OAUTH_CLIENT);
      toast.success(t("credential.rotated"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Stack gap={12}>
      <Text variant="small" tone={clientFlow ? "muted" : "warn"}>
        {t(clientFlow ? "credential.rotateVerified" : "credential.rotateUnverified")}
      </Text>
      <OAuthClientFields values={values} onChange={setValues} secretRequired={clientFlow} />
      <Stack direction="row">
        <Button variant="primary" loading={pending} disabled={!ready} onClick={() => void rotate()}>
          {t("credential.rotate")}
        </Button>
      </Stack>
    </Stack>
  );
}

const pretty = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v, null, 2));

/** 只读的代码样式文本框（JSON 对比用）。 */
function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <Textarea
        code
        readOnly
        rows={Math.min(14, Math.max(3, value.split("\n").length))}
        value={value}
      />
    </Field>
  );
}

/** 复核的一项对比：当前（上次复核通过的）定义 vs 新定义；没有旧定义（新工具）时只显示新的一侧。 */
function DiffRow({
  label,
  before,
  after,
}: {
  label: string;
  before: string | undefined;
  after: string;
}) {
  const t = useTranslations("connectors.review");
  const changed = before !== undefined && before !== after;
  return (
    <Stack gap={4}>
      {changed && (
        <Text variant="small" tone="warn">
          {t("changed", { field: label })}
        </Text>
      )}
      {before === undefined ? (
        <CodeBlock label={`${label} · ${t("new")}`} value={after} />
      ) : (
        <Grid columns={2} gap={8}>
          <CodeBlock label={`${label} · ${t("current")}`} value={before} />
          <CodeBlock label={`${label} · ${t("new")}`} value={after} />
        </Grid>
      )}
    </Stack>
  );
}

/**
 * 复核页签（漂移检测）：待复核的工具逐个列出新旧定义（描述、inputSchema、注解、连接器路由数据），
 * 管理员批准（采用新定义并启用）或拒绝（停用、保留旧定义）；远端已不再提供的工具单独列出。
 * 从未复核过的工具（`reviewedAt` 为 null）没有复核过的旧定义：按「新工具」显示完整定义，不做对比。
 */
function ReviewTab({
  orgId,
  app,
  manage,
  onSaved,
}: {
  orgId: string;
  app: ConnectorDetail;
  manage: boolean;
  onSaved(app: ConnectorDetail): void;
}) {
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState<string>();
  // The kernel answers a decision with the connector (the caller sets it in the cache).
  const review = useAppMutation({
    fn: (v: { tool: string; action: "approve" | "reject" }) =>
      reviewTool(orgId, app.id, v.tool, v.action),
    invalidates: () => [],
  });
  const pendingTools = app.tools.filter(reviewable);
  const missing = app.tools.filter((x) => x.missing === true);

  async function decide(tool: ConnectorTool, action: "approve" | "reject") {
    setBusy(tool.name);
    try {
      const { connector: next } = await review.mutateAsync({ tool: tool.name, action });
      onSaved(next);
      toast.success(
        t(action === "approve" ? "review.approved" : "review.rejected", {
          tool: toolDisplayName(tool),
        }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Stack gap={16}>
      {pendingTools.length === 0 ? (
        <Card title={t("review.title")}>
          <EmptyState size="panel" text={t("review.empty")} />
        </Card>
      ) : (
        // A standing note about every tool below: the quiet info Callout first in the tab (spec
        // §6.19), not a loose paragraph between the cards
        <Callout tone="info">{t("review.hint")}</Callout>
      )}
      {pendingTools.map((tool) => {
        // 复核过且有新定义 → 对比当前（上次复核通过的）与新定义；从未复核过 → 新工具，只显示完整定义
        const fresh = tool.reviewedAt === null;
        const next: ToolDefinition = tool.pending ?? tool;
        const before: ToolDefinition | undefined = !fresh && tool.pending ? tool : undefined;
        const rejectedNew = neverReviewedDisabled(tool) && (tool.pending ?? null) === null;
        const name = toolDisplayName(tool);
        return (
          <section key={tool.name} aria-label={name}>
            <Card
              // the display name; the key and the description in its hover text
              title={<Text title={toolTooltip(tool)}>{name}</Text>}
              actions={
                <StatusMark
                  status={rejectedNew ? "cancelled" : "waiting"}
                  label={
                    rejectedNew
                      ? t("review.rejectedNewTool")
                      : before
                        ? t("review.changedTool")
                        : t("review.newTool")
                  }
                />
              }
            >
              <Stack gap={12}>
                {tool.issue !== null && (
                  <Text variant="small" tone="fail" icon="circle-x">
                    {tool.issue}
                  </Text>
                )}
                <DiffRow
                  label={t("review.description")}
                  before={before?.description}
                  after={next.description}
                />
                <DiffRow
                  label={t("review.inputSchema")}
                  before={before && pretty(before.inputSchema)}
                  after={pretty(next.inputSchema)}
                />
                <DiffRow
                  label={t("review.annotations")}
                  before={before && pretty(before.annotations)}
                  after={pretty(next.annotations)}
                />
                {(next.connectorData !== null || (before && before.connectorData !== null)) && (
                  <DiffRow
                    label={t("review.connectorData")}
                    before={before && pretty(before.connectorData)}
                    after={pretty(next.connectorData)}
                  />
                )}
                {manage && (
                  <Stack direction="row" gap={8}>
                    <Button
                      loading={busy === tool.name}
                      disabled={busy !== undefined || tool.issue !== null}
                      aria-label={t("review.approveLabel", { tool: name })}
                      onClick={() => void decide(tool, "approve")}
                    >
                      {t("review.approve")}
                    </Button>
                    {!rejectedNew && (
                      <Button
                        variant="danger"
                        disabled={busy !== undefined}
                        aria-label={t("review.rejectLabel", { tool: name })}
                        onClick={() => void decide(tool, "reject")}
                      >
                        {t("review.reject")}
                      </Button>
                    )}
                  </Stack>
                )}
              </Stack>
            </Card>
          </section>
        );
      })}
      {missing.length > 0 && (
        <Card title={t("review.missingTitle")}>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("review.missingHint")}
            </Text>
            {missing.map((x) => (
              <Text key={x.name} tone="warn" icon="circle-alert" title={toolTooltip(x)}>
                {toolDisplayName(x)}
              </Text>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
