"use client";

import {
  Button,
  DangerConfirm,
  Field,
  FormSection,
  Input,
  RadioGroup,
  SettingsPage,
  Skeleton,
  Stack,
  Switch,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../components/AdminGate";
import { formatTime } from "../../../../../components/ApprovalCard";
import { useAdminNav } from "../../../../../components/admin-nav";
import { useCatalogErrorLines } from "../../../../../components/CatalogParts";
import { FormError } from "../../../../../components/form-error";
import { ApiClientError, issueLines } from "../../../../../lib/api";
import {
  addMarketplace,
  listMarketplaces,
  type Marketplace,
  type MarketplaceForm,
  refreshMarketplace,
  removeMarketplace,
  shortCommit,
  updateMarketplace,
} from "../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/admin/marketplaces`: marketplaces (enterprise admins, SettingsPage). The official
 * marketplace: the enable switch (offline mode with a read-only switch when the deployment config
 * turns it off) and its read-only address; enterprise marketplaces: add, edit, remove (name,
 * address, enabled, token); each marketplace's status and "Refresh now". An enterprise marketplace
 * is a marketplace.json URL or a git repository (`owner/repo` or an https git URL, with an optional
 * branch / tag / commit; the repository holds `.capybara-plugin/marketplace.json`); a git
 * marketplace shows the ref it follows and the commit of its last refresh.
 */
export default function MarketplacesPage() {
  return (
    <AdminGate>
      <Sources />
    </AdminGate>
  );
}

type Problem = { message: string; extra: string[] };

/** The error and its detail lines (the kernel's line naming the host or ref for git / network codes). */
function useProblem(): (e: unknown) => Problem {
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  return (e) => ({ message: errorMessage(e), extra: [...issueLines(e), ...catalogLines(e)] });
}

function Sources() {
  const t = useTranslations("catalog.admin.marketplaces");
  const nav = useAdminNav();
  const errorMessage = useErrorMessage();
  const { state, reload, set } = useLoad(listMarketplaces, []);
  const replace = (next: Marketplace) => {
    if (state.kind !== "ready") return;
    set({ ...state.data, items: state.data.items.map((s) => (s.id === next.id ? next : s)) });
  };
  const official = state.kind === "ready" ? state.data.items.find((s) => s.builtin) : undefined;
  const enterprise = state.kind === "ready" ? state.data.items.filter((s) => !s.builtin) : [];

  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="catalog">
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
function SourceStatus({ source }: { source: Marketplace }) {
  const t = useTranslations("catalog.admin.marketplaces");
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
  source: Marketplace;
  onChanged(next: Marketplace): void;
  onRemoved(): void;
}) {
  const t = useTranslations("catalog.admin.marketplaces");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const problem = useProblem();
  const [name, setName] = useState(source.name);
  const [url, setUrl] = useState(source.url);
  const [ref, setRef] = useState(source.ref ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "toggle" | "refresh" | "token">();
  const [error, setError] = useState<Problem>();
  const [confirm, setConfirm] = useState(false);
  const builtin = source.builtin;
  const git = source.form === "git";
  const refChanged = git && ref.trim() !== (source.ref ?? "");
  const dirty =
    !builtin && (name !== source.name || url !== source.url || token !== "" || refChanged);

  const run = async (
    kind: NonNullable<typeof busy>,
    op: () => Promise<Marketplace>,
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
      setError(problem(e));
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
            () => updateMarketplace(source.id, { enabled }),
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
      {git && (
        <>
          <Stack direction="row" gap={8}>
            <Text variant="small" tone="muted">
              {t("gitInfo", { ref: source.ref ?? t("defaultBranch") })}
            </Text>
            {source.lastCommit !== null && (
              <Text variant="small" tone="muted">
                {t("lastCommit", { commit: shortCommit(source.lastCommit) })}
              </Text>
            )}
          </Stack>
          <Field label={t("ref")} help={t("refHelp")} optional>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
        </>
      )}
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
              () => refreshMarketplace(source.id),
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
                    updateMarketplace(source.id, {
                      ...(name !== source.name && { name: name.trim() }),
                      ...(url !== source.url && { url: url.trim() }),
                      ...(refChanged && { ref: ref.trim() === "" ? null : ref.trim() }),
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
                    () => updateMarketplace(source.id, { token: null }),
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
            await removeMarketplace(source.id).catch((e: unknown) => {
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

/**
 * Adding an enterprise marketplace: a marketplace.json URL, or a git repository (`form: "git"`, with
 * an optional ref; the kernel also recognises `owner/repo` and `….git` URLs by themselves).
 */
function AddSource({ onAdded }: { onAdded(): void }) {
  const t = useTranslations("catalog.admin.marketplaces");
  const toast = useToast();
  const problem = useProblem();
  const [form, setForm] = useState<MarketplaceForm>("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const s = await addMarketplace({
        name: name.trim(),
        url: url.trim(),
        ...(form === "git" && { form, ...(ref.trim() !== "" && { ref: ref.trim() }) }),
        ...(token !== "" && { token }),
      });
      toast.success(t("added", { name: s.name }));
      setName("");
      setUrl("");
      setRef("");
      setToken("");
      onAdded();
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("add")}>
      <Stack gap={8}>
        <Text>{t("add")}</Text>
        <RadioGroup
          label={t("form")}
          value={form}
          onChange={(v) => setForm(v as MarketplaceForm)}
          options={[
            { value: "http", label: t("formHttp") },
            { value: "git", label: t("formGit") },
          ]}
        />
        <Field label={t("name")} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("url")} required {...(form === "git" && { help: t("gitUrlHelp") })}>
          <Input
            value={url}
            placeholder={form === "git" ? "owner/repo" : "https://"}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {form === "git" && (
          <Field label={t("ref")} help={t("refHelp")} optional>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
        )}
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
    </section>
  );
}
