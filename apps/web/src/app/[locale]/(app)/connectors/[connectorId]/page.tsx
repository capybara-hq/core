"use client";

import {
  Button,
  Card,
  type Column,
  DangerConfirm,
  DataTable,
  DetailPage,
  Field,
  Grid,
  Input,
  KeyValue,
  Select,
  Skeleton,
  Stack,
  StatusMark,
  Switch,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  buildCredential,
  buildOAuthClient,
  CredentialFields,
  EMPTY_CREDENTIAL,
  EMPTY_OAUTH_CLIENT,
  OAuthClientFields,
} from "../../../../../components/ConnectorForm";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import { useRouter } from "../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../lib/api";
import {
  type ConnectorDetail,
  type ConnectorTool,
  canManageConnectors,
  deleteConnector,
  getConnector,
  refreshConnector,
  reviewTool,
  setOrgCredential,
  type ToolDefinition,
  type ToolPolicy,
  updateConnector,
} from "../../../../../lib/connectors";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

const TABS = ["tools", "review", "credentials", "settings"] as const;
type Tab = (typeof TABS)[number];
const POLICIES = ["allow", "ask", "deny"] as const satisfies readonly ToolPolicy[];

/**
 * `/[locale]/connectors/[connectorId]`：连接器详情（DetailPage）：工具（启停、默认策略）、复核（定义变化的新旧对比）、
 * 凭据（含 OAuth 客户端轮换）、设置（改名、启停、删除）。
 */
export default function ConnectorDetailPage() {
  const { connectorId } = useParams<{ connectorId: string }>();
  return <OrgGate>{(orgId) => <ConnectorInOrg orgId={orgId} connectorId={connectorId} />}</OrgGate>;
}

/**
 * 连接器属于打开它时的当前组织：切换组织后（AppFrame 正在跳回列表）不再以新组织 + 旧连接器 id 渲染，
 * 免得用新组织去读旧连接器、或显示上一组织的数据。
 */
function ConnectorInOrg({ orgId, connectorId }: { orgId: string; connectorId: string }) {
  const [openedIn] = useState(orgId);
  if (orgId !== openedIn) return null;
  return <ConnectorView orgId={orgId} connectorId={connectorId} />;
}

function ConnectorView({ orgId, connectorId }: { orgId: string; connectorId: string }) {
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const manage = canManageConnectors(me);
  const [tab, setTab] = useState<Tab>("tools");
  const { state, reload, set } = useLoad(
    () => getConnector(orgId, connectorId).then((r) => r.connector),
    [orgId, connectorId],
  );
  const [refreshing, setRefreshing] = useState(false);

  async function onRefresh() {
    setRefreshing(true);
    try {
      const r = await refreshConnector(orgId, connectorId);
      set(r.connector);
      toast.success(t("detail.refreshed"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  const app = state.kind === "ready" ? state.data : undefined;
  return (
    <DetailPage
      header={{
        parent: { label: t("title"), href: "/connectors" },
        title: app?.name ?? t("title"),
        ...(app
          ? {
              count: app.slug,
              status:
                app.status === "active" ? (
                  <StatusMark status="success" label={t("status.active")} />
                ) : (
                  <StatusMark status="cancelled" label={t("status.disabled")} />
                ),
            }
          : {}),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: TABS.map((id) => ({
          id,
          label: t(`detail.tabs.${id}`),
          ...(id === "tools" && app ? { count: app.tools.length } : {}),
          ...(id === "review" && app && reviewCount(app) > 0 ? { count: reviewCount(app) } : {}),
        })),
        value: tab,
        onChange: (id) => setTab(id as Tab),
      }}
      inspectorTitle={t("detail.inspectorTitle")}
      inspector={app ? <ConnectorInspector app={app} /> : undefined}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <Stack gap={12}>
          <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
          <Stack direction="row">
            <Button onClick={reload}>{t("detail.retry")}</Button>
          </Stack>
        </Stack>
      ) : tab === "tools" ? (
        <ToolsTab
          orgId={orgId}
          app={state.data}
          manage={manage}
          onSaved={set}
          refresh={{ onRefresh: () => void onRefresh(), refreshing }}
        />
      ) : tab === "review" ? (
        <ReviewTab orgId={orgId} app={state.data} manage={manage} onSaved={set} />
      ) : tab === "credentials" ? (
        <CredentialsTab orgId={orgId} app={state.data} manage={manage} onSaved={reload} />
      ) : (
        <SettingsTab orgId={orgId} app={state.data} manage={manage} onSaved={set} />
      )}
    </DetailPage>
  );
}

function ConnectorInspector({ app }: { app: ConnectorDetail }) {
  const t = useTranslations("connectors");
  const ownership = app.auth.type === "none" ? null : app.auth.ownership;
  return (
    <KeyValue
      keyWidth="10ch"
      rows={[
        { k: t("inspector.slug"), v: app.slug },
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

/** 工具页签；「刷新工具」放在表格工具栏（PageHeader 的按钮没有加载态），刷新期间为加载中且不可再点。 */
function ToolsTab({
  orgId,
  app,
  manage,
  onSaved,
  refresh,
}: {
  orgId: string;
  app: ConnectorDetail;
  manage: boolean;
  onSaved(app: ConnectorDetail): void;
  refresh: { onRefresh(): void; refreshing: boolean };
}) {
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState<string>();

  async function patch(
    tool: ConnectorTool,
    change: { status?: "enabled" | "disabled"; defaultPolicy?: ToolPolicy },
  ) {
    setBusy(tool.name);
    try {
      const { connector: next } = await updateConnector(orgId, app.id, {
        tools: { [tool.name]: change },
      });
      onSaved(next);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const columns: Column<ConnectorTool>[] = [
    {
      key: "name",
      header: t("tools.columns.name"),
      cell: (x) => (
        <Stack gap={0}>
          <Text>{x.key}</Text>
          {x.missing ? (
            <Text variant="small" tone="warn">
              {t("tools.missing")}
            </Text>
          ) : neverReviewedDisabled(x) ? (
            <Text variant="small" tone="warn">
              {t("tools.neverReviewed")}
            </Text>
          ) : (
            <Text variant="small" tone="muted" truncate>
              {x.issue ?? x.description}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: "policy",
      header: t("tools.columns.policy"),
      width: 160,
      cell: (x) =>
        manage ? (
          <Select
            aria-label={t("tools.policyLabel", { tool: x.key })}
            value={x.defaultPolicy}
            disabled={busy !== undefined}
            onChange={(e) => void patch(x, { defaultPolicy: e.target.value as ToolPolicy })}
            options={POLICIES.map((p) => ({ value: p, label: t(`policy.${p}`) }))}
          />
        ) : (
          t(`policy.${x.defaultPolicy}`)
        ),
    },
    {
      key: "status",
      header: t("tools.columns.status"),
      width: 120,
      cell: (x) =>
        x.status === "pending_review" ? (
          <StatusMark status="waiting" label={t("tools.pendingReview")} />
        ) : manage ? (
          <Switch
            label={t("tools.enabledLabel", { tool: x.key })}
            checked={x.status === "enabled"}
            disabled={
              busy !== undefined ||
              (x.status === "disabled" &&
                (x.issue !== null ||
                  x.missing === true ||
                  x.reviewedAt === null ||
                  (x.pending ?? null) !== null))
            }
            onChange={(on) => void patch(x, { status: on ? "enabled" : "disabled" })}
          />
        ) : x.status === "enabled" ? (
          <StatusMark status="success" label={t("tools.enabled")} />
        ) : (
          <StatusMark status="cancelled" label={t("tools.disabled")} />
        ),
    },
  ];

  return (
    <DataTable<ConnectorTool>
      label={t("detail.tabs.tools")}
      {...(manage
        ? {
            toolbar: (
              <Button size={24} loading={refresh.refreshing} onClick={refresh.onRefresh}>
                {t("detail.refresh")}
              </Button>
            ),
          }
        : {})}
      columns={columns}
      rows={app.tools}
      rowKey={(x) => x.name}
      rowLabel={(x) => x.key}
      empty={{ title: t("tools.empty") }}
    />
  );
}

function CredentialsTab({
  orgId,
  app,
  manage,
  onSaved,
}: {
  orgId: string;
  app: ConnectorDetail;
  manage: boolean;
  onSaved(): void;
}) {
  const t = useTranslations("connectors");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_CREDENTIAL);
  const [pending, setPending] = useState(false);
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
        <Text tone="muted">{t("credential.personalHint")}</Text>
        <Stack direction="row">
          <Button onClick={() => router.push("/settings/connections")}>
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
          <Text tone="muted">{t("credential.oauthOrgHint")}</Text>
          {manage && <RotateClient orgId={orgId} app={app} onSaved={onSaved} />}
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
            {auth.client === "manual" ? (
              <RotateClient orgId={orgId} app={app} onSaved={onSaved} />
            ) : (
              <Text tone="muted">{t("credential.clientDcr")}</Text>
            )}
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
      await setOrgCredential(orgId, app.id, credential);
      setValues(EMPTY_CREDENTIAL);
      toast.success(t("credential.saved"));
      onSaved();
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
  onSaved,
}: {
  orgId: string;
  app: ConnectorDetail;
  manage: boolean;
  onSaved(app: ConnectorDetail): void;
}) {
  const t = useTranslations("connectors");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(app.name);
  const [active, setActive] = useState(app.status === "active");
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = name.trim() !== app.name || active !== (app.status === "active");

  async function save() {
    if (name.trim() === "") return;
    setPending(true);
    try {
      const { connector: next } = await updateConnector(orgId, app.id, {
        name: name.trim(),
        status: active ? "active" : "disabled",
      });
      onSaved(next);
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
            <Text tone="muted">{t("settings.deleteHint")}</Text>
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
            await deleteConnector(orgId, app.id);
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
function RotateClient({
  orgId,
  app,
  onSaved,
}: {
  orgId: string;
  app: ConnectorDetail;
  onSaved(): void;
}) {
  const t = useTranslations("connectors");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_OAUTH_CLIENT);
  const [pending, setPending] = useState(false);
  const clientFlow = app.auth.type === "oauth_client";
  const value = buildOAuthClient(values);
  const ready = value !== undefined && (!clientFlow || values.clientSecret !== "");

  async function rotate() {
    if (!ready || value === undefined) return;
    setPending(true);
    try {
      await setOrgCredential(orgId, app.id, value);
      setValues(EMPTY_OAUTH_CLIENT);
      toast.success(t("credential.rotated"));
      onSaved();
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
  const pendingTools = app.tools.filter(reviewable);
  const missing = app.tools.filter((x) => x.missing === true);

  async function decide(tool: ConnectorTool, action: "approve" | "reject") {
    setBusy(tool.name);
    try {
      const { connector: next } = await reviewTool(orgId, app.id, tool.name, action);
      onSaved(next);
      toast.success(
        t(action === "approve" ? "review.approved" : "review.rejected", { tool: tool.key }),
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
          <Text tone="muted">{t("review.empty")}</Text>
        </Card>
      ) : (
        <Text tone="muted">{t("review.hint")}</Text>
      )}
      {pendingTools.map((tool) => {
        // 复核过且有新定义 → 对比当前（上次复核通过的）与新定义；从未复核过 → 新工具，只显示完整定义
        const fresh = tool.reviewedAt === null;
        const next: ToolDefinition = tool.pending ?? tool;
        const before: ToolDefinition | undefined = !fresh && tool.pending ? tool : undefined;
        const rejectedNew = neverReviewedDisabled(tool) && (tool.pending ?? null) === null;
        return (
          <section key={tool.name} aria-label={tool.key}>
            <Card
              title={tool.key}
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
                  <Text variant="small" tone="fail">{`✗ ${tool.issue}`}</Text>
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
                      aria-label={t("review.approveLabel", { tool: tool.key })}
                      onClick={() => void decide(tool, "approve")}
                    >
                      {t("review.approve")}
                    </Button>
                    {!rejectedNew && (
                      <Button
                        variant="danger"
                        disabled={busy !== undefined}
                        aria-label={t("review.rejectLabel", { tool: tool.key })}
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
              <Text key={x.name} tone="warn">{`‖ ${x.key}`}</Text>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
