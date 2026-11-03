"use client";

import {
  Button,
  DangerConfirm,
  ErrorDetail,
  Field,
  FormSection,
  formatDateTime,
  Input,
  ListPage,
  RadioGroup,
  Stack,
  SwitchField,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCatalogErrorLines } from "../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { marketplaceTabs } from "../../../../lib/admin-tabs";
import { issueLines } from "../../../../lib/api";
import {
  addMarketplace,
  type Marketplace,
  type MarketplaceForm,
  marketplaceErrorKind,
  refreshMarketplace,
  removeMarketplace,
  shortCommit,
  updateMarketplace,
} from "../../../../lib/catalog";
import { marketplacesQuery } from "../../../../lib/query/admin";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

type SourceList = { items: Marketplace[]; offline: boolean };

/**
 * What a change to a marketplace changes besides the marketplaces: the entries to browse and the
 * catalog's "newer in the marketplace" marks.
 */
const sourceChangeKeys = (): (readonly unknown[])[] => [
  keys.deployment().marketplaceEntriesAll(),
  keys.deployment().catalog(),
  keys.deployment().catalogItemsAll(),
];

type Problem = { message: string; extra: string[] };

/** The error and its detail lines (the kernel's line naming the host or ref for git / network codes). */
function useProblem(): (e: unknown) => Problem {
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  return (e) => ({ message: errorMessage(e), extra: [...issueLines(e), ...catalogLines(e)] });
}

/**
 * `/admin/marketplaces`: marketplaces (enterprise admins, ListPage with the tabs Browse / Sources). The official
 * marketplace: the enable switch (offline mode with a read-only switch when the deployment config
 * turns it off) and its read-only address; enterprise marketplaces: add, edit, remove (name,
 * address, enabled, token); each marketplace's status and "Refresh now". An enterprise marketplace
 * is a marketplace.json URL or a git repository (`owner/repo` or an https git URL, with an optional
 * branch / tag / commit; the repository holds `.capybara-plugin/marketplace.json`); a git
 * marketplace shows the ref it follows and the commit of its last refresh.
 * From the query cache (the layout prefetched it on a first load): a change's answer replaces that
 * marketplace in the cache; adding or removing one reads the list again; each change also
 * invalidates the entries and the catalog's marks.
 */
export default function SourcesView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <SourcesRead />;
}

function SourcesRead() {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin.marketplaces");
  const ta = useTranslations("catalog.admin");
  const read = usePageQuery(marketplacesQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    // The two static sections: the official marketplace (its switch, its address, its status)
    // and the enterprise ones (the add form; the editors above it come with the data).
    return (
      <ListPage
        header={{
          path: [...scope, { label: "marketplaces" }],
          title: t("title"),
          description: t("description"),
          tabs: marketplaceTabs(ta).map((tab) => ({ ...tab, pending: true })),
          activeTab: "sources",
          search: { label: t("search"), value: "", onChange: () => {} },
        }}
        loading={{ keep: true }}
      >
        <FormSection
          id="official"
          title={t("official")}
          description={t("officialHint")}
          loading={{ fields: [{ control: "switch" }, {}, { control: "text" }] }}
        />
        <FormSection
          id="enterprise"
          title={t("enterprise")}
          description={t("enterpriseHint")}
          loading={{
            fields: [{ control: "text" }, { control: "segmented" }, {}, {}, {}],
          }}
        />
      </ListPage>
    );
  }
  return <Sources data={read.data} />;
}

function Sources({ data }: { data: SourceList }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin.marketplaces");
  const ta = useTranslations("catalog.admin");
  const qc = useQueryClient();
  const listKey = marketplacesQuery().queryKey;
  // Added or removed: the list is read again.
  const reload = () => void qc.invalidateQueries({ queryKey: listKey });
  // The answer is the marketplace as it is now: it replaces that one in the cache.
  const replace = (next: Marketplace) =>
    qc.setQueryData<SourceList>(listKey, (d) =>
      d === undefined ? d : { ...d, items: d.items.map((s) => (s.id === next.id ? next : s)) },
    );
  // The head's search narrows the marketplaces shown, by name or address
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const matches = (s: Marketplace) =>
    needle === "" || s.name.toLowerCase().includes(needle) || s.url.toLowerCase().includes(needle);
  const official = data.items.find((s) => s.builtin);
  const enterprise = data.items.filter((s) => !s.builtin);
  const shownEnterprise = enterprise.filter(matches);
  const officialShown = official !== undefined && matches(official);

  return (
    <ListPage
      header={{
        path: [...scope, { label: "marketplaces" }],
        title: t("title"),
        // One head for both tabs (description, tab counts, search): switching never moves the tabs
        description: t("description"),
        tabs: marketplaceTabs(ta, data.items),
        activeTab: "sources",
        search: { label: t("search"), value: q, onChange: setQ },
      }}
    >
      {needle !== "" && !officialShown && shownEnterprise.length === 0 && (
        <Text tone="muted">{t("noMatch")}</Text>
      )}
      <FormSection id="official" title={t("official")} description={t("officialHint")}>
        {data.offline && <Text tone="warn">{t("offline")}</Text>}
        {officialShown && (
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
          {shownEnterprise.map((s) => (
            <SourceEditor key={s.id} source={s} onChanged={replace} onRemoved={reload} />
          ))}
          <AddSource onAdded={reload} />
        </Stack>
      </FormSection>
    </ListPage>
  );
}

/** Most skipped entries listed under a marketplace (the rest are counted). */
const SKIPPED_SHOWN = 20;

/**
 * A marketplace's status line, then the entries its last refresh skipped (with the reason): the
 * first {@link SKIPPED_SHOWN} and how many more. Names may repeat (an invalid entry next to a
 * duplicate), so rows are keyed by position.
 */
function SourceStatus({ source }: { source: Marketplace }) {
  const t = useTranslations("catalog.admin.marketplaces");
  const skipped = source.skipped ?? [];
  if (skipped.length === 0) return <StatusLine source={source} />;
  return (
    <Stack gap={4}>
      <StatusLine source={source} />
      <Text variant="small" tone="warn">
        {t("skipped.title", { n: skipped.length })}
      </Text>
      {skipped.slice(0, SKIPPED_SHOWN).map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the list is static
        <Text key={i} variant="small" tone="muted">
          {t("skipped.line", {
            name: x.name,
            reason: t.has(`skipped.reasons.${x.reason}`)
              ? t(`skipped.reasons.${x.reason}`)
              : x.reason,
          })}
        </Text>
      ))}
      {skipped.length > SKIPPED_SHOWN && (
        <Text variant="small" tone="muted">
          {t("skipped.more", { n: skipped.length - SKIPPED_SHOWN })}
        </Text>
      )}
    </Stack>
  );
}

/**
 * A marketplace's status: OK with the entry count and time, never fetched, or the last refresh
 * error as one sentence (by its kind) with the kernel's raw text behind the ErrorDetail toggle.
 */
function StatusLine({ source }: { source: Marketplace }) {
  const t = useTranslations("catalog.admin.marketplaces");
  if (source.lastStatus === "error") {
    const raw = source.lastError ?? "";
    return (
      <ErrorDetail
        summary={t(`statusValue.errors.${marketplaceErrorKind(raw)}`)}
        {...(raw !== "" ? { detail: raw } : {})}
      />
    );
  }
  if (source.lastStatus === "never") return <Text tone="muted">{t("statusValue.never")}</Text>;
  return (
    <Text tone="muted">
      {t("statusValue.ok", {
        n: source.entryCount,
        at: source.lastRefreshedAt ? formatDateTime(source.lastRefreshedAt) : "—",
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
  const update = useAppMutation({
    fn: (body: Parameters<typeof updateMarketplace>[1]) => updateMarketplace(source.id, body),
    invalidates: sourceChangeKeys,
  });
  const refresh = useAppMutation({
    fn: () => refreshMarketplace(source.id),
    invalidates: sourceChangeKeys,
  });
  const remove = useAppMutation({
    fn: () => removeMarketplace(source.id),
    invalidates: () => [marketplacesQuery().queryKey, ...sourceChangeKeys()],
  });

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
      <SwitchField
        checked={source.enabled}
        disabled={source.disabledByConfig || busy !== undefined}
        label={t("enabledLabel", { name: builtin ? t("official") : source.name })}
        onChange={(enabled) =>
          void run(
            "toggle",
            () => update.mutateAsync({ enabled }),
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
      {/* The label above its value, like the fields: a long status never squeezes it */}
      <Stack gap={4}>
        <Text variant="small">{t("status")}</Text>
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
              () => refresh.mutateAsync(undefined),
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
                    update.mutateAsync({
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
                    () => update.mutateAsync({ token: null }),
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
            await remove.mutateAsync(undefined).catch((e: unknown) => {
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
  const create = useAppMutation({
    fn: addMarketplace,
    invalidates: () => [marketplacesQuery().queryKey, ...sourceChangeKeys()],
  });
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const s = await create.mutateAsync({
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
