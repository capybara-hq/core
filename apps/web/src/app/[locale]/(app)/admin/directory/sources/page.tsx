"use client";

import {
  Button,
  DangerConfirm,
  Field,
  FormSection,
  Input,
  SettingsPage,
  Skeleton,
  Stack,
  Switch,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { formatTime } from "../../../../../../components/ApprovalCard";
import { useAdminNav } from "../../../../../../components/admin-nav";
import { FormError } from "../../../../../../components/form-error";
import { ApiClientError, issueLines } from "../../../../../../lib/api";
import {
  addCatalogSource,
  type CatalogSource,
  listCatalogSources,
  refreshCatalogSource,
  removeCatalogSource,
  updateCatalogSource,
} from "../../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/**
 * `/[locale]/admin/directory/sources`：目录来源（企业管理员，SettingsPage）。官方清单：启用开关（部署配置关闭时显示
 * 离线模式、开关只读）与只读的地址；企业清单：增删改（名称、地址、启用、令牌）；各来源的状态与「立即刷新」。
 */
export default function SourcesPage() {
  return (
    <AdminGate>
      <Sources />
    </AdminGate>
  );
}

type Problem = { message: string; extra: string[] };

function Sources() {
  const t = useTranslations("directory.admin.sources");
  const nav = useAdminNav();
  const errorMessage = useErrorMessage();
  const { state, reload, set } = useLoad(listCatalogSources, []);
  const replace = (next: CatalogSource) => {
    if (state.kind !== "ready") return;
    set({ ...state.data, items: state.data.items.map((s) => (s.id === next.id ? next : s)) });
  };
  const official = state.kind === "ready" ? state.data.items.find((s) => s.builtin) : undefined;
  const enterprise = state.kind === "ready" ? state.data.items.filter((s) => !s.builtin) : [];

  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="directory">
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : (
        <>
          <FormSection id="official" title={t("official")} description={t("officialHint")}>
            {state.data.offline && <Text tone="warn">{t("offline")}</Text>}
            {official !== undefined && (
              <SourceEditor
                key={official.id}
                source={official}
                onChanged={replace}
                onRemoved={reload}
              />
            )}
          </FormSection>
          <FormSection id="enterprise" title={t("enterprise")} description={t("enterpriseHint")}>
            <Stack gap={24}>
              {enterprise.length === 0 && <Text tone="muted">{t("enterpriseEmpty")}</Text>}
              {enterprise.map((s) => (
                <SourceEditor key={s.id} source={s} onChanged={replace} onRemoved={reload} />
              ))}
              <AddSource onAdded={reload} />
            </Stack>
          </FormSection>
        </>
      )}
    </SettingsPage>
  );
}

/** 来源状态的一行文字。 */
function SourceStatus({ source }: { source: CatalogSource }) {
  const t = useTranslations("directory.admin.sources");
  const locale = useLocale();
  if (source.lastStatus === "error") {
    return <Text tone="fail">{t("statusValue.error", { error: source.lastError ?? "" })}</Text>;
  }
  if (source.lastStatus === "never") return <Text tone="muted">{t("statusValue.never")}</Text>;
  return (
    <Text tone="muted">
      {t("statusValue.ok", {
        n: source.entryCount,
        at: source.lastRefreshedAt ? formatTime(source.lastRefreshedAt, locale) : "—",
      })}
    </Text>
  );
}

/** 一个来源：官方清单只能开关与刷新（地址只读）；企业清单可改名称、地址、令牌，可删除。 */
function SourceEditor({
  source,
  onChanged,
  onRemoved,
}: {
  source: CatalogSource;
  onChanged(next: CatalogSource): void;
  onRemoved(): void;
}) {
  const t = useTranslations("directory.admin.sources");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(source.name);
  const [url, setUrl] = useState(source.url);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "toggle" | "refresh" | "token">();
  const [error, setError] = useState<Problem>();
  const [confirm, setConfirm] = useState(false);
  const builtin = source.builtin;
  const dirty = !builtin && (name !== source.name || url !== source.url || token !== "");

  const run = async (
    kind: NonNullable<typeof busy>,
    op: () => Promise<CatalogSource>,
    done: string,
  ) => {
    setBusy(kind);
    setError(undefined);
    try {
      const next = await op();
      onChanged(next);
      if (kind === "save") setToken("");
      toast.success(done);
    } catch (e) {
      setError({ message: errorMessage(e), extra: issueLines(e) });
      // 刷新失败时状态也已记好：重读来源，显示最新状态
      if (kind === "refresh") onRemoved();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Stack gap={8}>
      <Switch
        checked={source.enabled}
        disabled={source.disabledByConfig || busy !== undefined}
        label={`${t("enabled")} · ${builtin ? t("official") : source.name}`}
        onChange={(enabled) =>
          void run(
            "toggle",
            () => updateCatalogSource(source.id, { enabled }),
            t("saved", { name: source.name }),
          )
        }
      />
      {!builtin && (
        <Field label={t("name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
      <Field label={t("url")}>
        {builtin ? (
          <Input value={source.url} readOnly aria-readonly="true" />
        ) : (
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
        )}
      </Field>
      {source.mirrors.length > 0 && (
        <Text variant="small" tone="muted">{`${t("mirrors")}: ${source.mirrors.join(", ")}`}</Text>
      )}
      {!builtin && (
        <Field label={t("token")} help={source.hasToken ? t("tokenSet") : t("tokenHelp")} optional>
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      )}
      <Stack direction="row" gap={8} align="center">
        <Text variant="small">{`${t("status")}:`}</Text>
        <SourceStatus source={source} />
      </Stack>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      <Stack direction="row" gap={8}>
        <Button
          loading={busy === "refresh"}
          disabled={busy !== undefined || !source.enabled}
          onClick={() =>
            void run(
              "refresh",
              () => refreshCatalogSource(source.id),
              t("refreshed", { name: source.name }),
            )
          }
        >
          {t("refresh")}
        </Button>
        {!builtin && (
          <>
            <Button
              variant="primary"
              loading={busy === "save"}
              disabled={busy !== undefined || !dirty || name.trim() === "" || url.trim() === ""}
              onClick={() =>
                void run(
                  "save",
                  () =>
                    updateCatalogSource(source.id, {
                      ...(name !== source.name && { name: name.trim() }),
                      ...(url !== source.url && { url: url.trim() }),
                      ...(token !== "" && { token }),
                    }),
                  t("saved", { name: name.trim() }),
                )
              }
            >
              {t("save")}
            </Button>
            {source.hasToken && (
              <Button
                loading={busy === "token"}
                disabled={busy !== undefined}
                onClick={() =>
                  void run(
                    "token",
                    () => updateCatalogSource(source.id, { token: null }),
                    t("saved", { name: source.name }),
                  )
                }
              >
                {t("clearToken")}
              </Button>
            )}
            <Button variant="danger" disabled={busy !== undefined} onClick={() => setConfirm(true)}>
              {t("remove")}
            </Button>
          </>
        )}
      </Stack>
      {!builtin && (
        <DangerConfirm
          open={confirm}
          onOpenChange={setConfirm}
          title={t("removeConfirm.title", { name: source.name })}
          description={t("removeConfirm.hint")}
          confirmName={source.name}
          confirmLabel={t("removeConfirm.confirm")}
          onConfirm={async () => {
            await removeCatalogSource(source.id).catch((e: unknown) => {
              throw new Error(errorMessage(e));
            });
            toast.success(t("removed", { name: source.name }));
            setConfirm(false);
            onRemoved();
          }}
        />
      )}
    </Stack>
  );
}

function AddSource({ onAdded }: { onAdded(): void }) {
  const t = useTranslations("directory.admin.sources");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const s = await addCatalogSource({
        name: name.trim(),
        url: url.trim(),
        ...(token !== "" && { token }),
      });
      toast.success(t("added", { name: s.name }));
      setName("");
      setUrl("");
      setToken("");
      onAdded();
    } catch (e) {
      setError({ message: errorMessage(e), extra: issueLines(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap={8}>
      <Text>{t("add")}</Text>
      <Field label={t("name")} required>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t("url")} required>
        <Input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label={t("token")} optional>
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      <Stack direction="row">
        <Button
          loading={busy}
          disabled={busy || name.trim() === "" || url.trim() === ""}
          onClick={() => void add()}
        >
          {t("add")}
        </Button>
      </Stack>
    </Stack>
  );
}
