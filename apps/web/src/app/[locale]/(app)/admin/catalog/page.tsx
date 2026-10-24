"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  Dialog,
  Field,
  FileButton,
  Input,
  ListPage,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../components/AdminGate";
import { useAdminParent } from "../../../../../components/admin-nav";
import { PolicyBadge, useKindLabel, useSourceLabel } from "../../../../../components/CatalogParts";
import { FormError } from "../../../../../components/form-error";
import { Link, useRouter } from "../../../../../i18n/navigation";
import { ApiClientError, issueLines } from "../../../../../lib/api";
import {
  type CatalogItem,
  displayNameOf,
  importCatalogNpm,
  listCatalogItems,
  listMarketplaces,
  PACKAGE_KINDS,
  type PackageKind,
  sourceKeyOf,
  uploadCatalogPackage,
} from "../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/admin/catalog`: the catalog (enterprise admins, ListPage). Columns: name, kind, version
 * (marked "new version" when the marketplace has a newer compatible version, from the kernel's
 * newerInMarketplace), source (manual / official marketplace / enterprise marketplace), policy,
 * number of orgs that installed it; the Rail filters by kind and source. The header's "Import" opens
 * the import dialog (upload a file or an npm package name), "Import plugin" goes to the plugin
 * review page, and the menu holds marketplace entries, marketplaces and deployment requests.
 */
export default function AdminCatalogPage() {
  return (
    <AdminGate>
      <AdminDirectory />
    </AdminGate>
  );
}

function AdminDirectory() {
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const parent = useAdminParent();
  const router = useRouter();
  const kindLabel = useKindLabel();
  const { state, reload } = useLoad(listCatalogItems, []);
  const sources = useLoad(
    () => listMarketplaces().catch(() => ({ items: [], offline: false })),
    [],
  );
  const sourceList = sources.state.kind === "ready" ? sources.state.data.items : [];
  const sourceLabel = useSourceLabel(sourceList);
  const [kind, setKind] = useState<PackageKind | "">("");
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const all = state.kind === "ready" ? state.data.items : [];
  const rows = all.filter(
    (i) => (kind === "" || i.kind === kind) && (source === "" || sourceKeyOf(i) === source),
  );
  const sourceOptions = [
    { value: "manual", label: td("source.manual") },
    ...sourceList.map((s) => ({
      value: `marketplace:${s.id}`,
      label: s.builtin ? td("source.official") : s.name,
    })),
  ];

  const columns: Column<CatalogItem>[] = [
    {
      key: "name",
      header: t("columns.name"),
      cell: (i) => (
        <Stack gap={0}>
          <Text>{displayNameOf(i, locale)}</Text>
          {i.displayName !== null && (
            <Text variant="small" tone="muted">
              {i.name}
            </Text>
          )}
        </Stack>
      ),
    },
    { key: "kind", header: t("columns.kind"), cell: (i) => kindLabel(i.kind) },
    {
      key: "version",
      header: t("columns.version"),
      cell: (i) => (
        <Stack direction="row" gap={8} align="center">
          <Text tone="muted">{i.latestVersion}</Text>
          {i.newerInMarketplace && <Badge tone="accent">{td("newer")}</Badge>}
        </Stack>
      ),
    },
    { key: "source", header: t("columns.source"), cell: (i) => sourceLabel(i) },
    { key: "policy", header: t("columns.policy"), cell: (i) => <PolicyBadge policy={i.policy} /> },
    {
      key: "installs",
      header: t("columns.installs"),
      tone: "muted",
      cell: (i) => String(i.installs),
    },
  ];

  return (
    <ListPage
      header={{
        parent,
        title: t("title"),
        count: String(all.length),
        actions: [
          { label: t("actions.import"), variant: "primary", onSelect: () => setImporting(true) },
          {
            label: t("actions.importPlugin"),
            variant: "default",
            href: "/admin/catalog/plugins/review",
          },
          { label: t("actions.entries"), variant: "default", href: "/admin/marketplaces/entries" },
          {
            label: t("actions.more"),
            menu: [
              { label: t("actions.marketplaces"), href: "/admin/marketplaces" },
              { label: t("actions.requests"), href: "/admin/catalog/requests" },
            ],
          },
        ],
      }}
      rail={
        <Stack gap={16}>
          <RadioGroup
            label={t("filters.kind")}
            value={kind}
            onChange={(v) => setKind(v as PackageKind | "")}
            options={[
              { value: "", label: t("filters.allKinds") },
              ...PACKAGE_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
            ]}
          />
          <RadioGroup
            label={t("filters.source")}
            value={source}
            onChange={setSource}
            options={[{ value: "", label: t("filters.allSources") }, ...sourceOptions]}
          />
        </Stack>
      }
    >
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(i) => i.id}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          error={{ code: state.kind === "error" ? state.code : "unknown", onRetry: reload }}
          empty={{ title: t("empty") }}
          {...(all.length > 0 && {
            noResults: {
              description: t("noResults"),
              onClear: () => {
                setKind("");
                setSource("");
              },
            },
          })}
          onOpen={(i) => router.push(`/admin/catalog/${i.id}`)}
          rowLabel={(i) => i.name}
        />
      </Stack>
      <ImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={(item) => {
          setImporting(false);
          router.push(`/admin/catalog/${item.id}`);
        }}
      />
    </ListPage>
  );
}

/** 导入对话框：上传 tgz / zip 或 npm 包名加版本。应用包提示改用「导入应用」。 */
function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose(): void;
  onImported(item: CatalogItem): void;
}) {
  const t = useTranslations("catalog.admin.import");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [source, setSource] = useState<"file" | "npm">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[]; app: boolean }>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const item =
        source === "file"
          ? file === null
            ? null
            : await uploadCatalogPackage<CatalogItem>(file, "item")
          : await importCatalogNpm(pkg.trim(), version.trim());
      if (item === null) return;
      toast.success(t("done", { name: item.name }));
      setFile(null);
      setPkg("");
      setVersion("");
      onImported(item);
    } catch (e) {
      const app = e instanceof ApiClientError && e.code === "catalog.wrong_kind";
      setError({ message: app ? t("isPlugin") : errorMessage(e), extra: issueLines(e), app });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("title")}
      size={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={busy || (source === "file" ? file === null : pkg.trim() === "")}
            onClick={() => void submit()}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="small" tone="muted">
          {t("hint")}
        </Text>
        <RadioGroup
          label={t("sourceLabel")}
          value={source}
          onChange={(v) => {
            setSource(v as "file" | "npm");
            setError(undefined);
          }}
          options={[
            { value: "file", label: t("sourceFile") },
            { value: "npm", label: t("sourceNpm") },
          ]}
        />
        {source === "file" ? (
          <Stack direction="row" gap={8} align="center">
            <FileButton
              label={t("choose")}
              accept=".tgz,.zip,application/gzip,application/x-gzip,application/zip"
              disabled={busy}
              onFiles={(files) => {
                setFile(files[0] ?? null);
                setError(undefined);
              }}
            />
            <Text tone="muted">{file === null ? t("noFile") : file.name}</Text>
          </Stack>
        ) : (
          <Stack gap={12}>
            <Field label={t("npmPackage")}>
              <Input value={pkg} onChange={(e) => setPkg(e.target.value)} />
            </Field>
            <Field label={t("npmVersion")} help={t("npmVersionHelp")}>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} />
            </Field>
          </Stack>
        )}
        {error !== undefined && (
          <Stack gap={4}>
            <FormError message={error.message} extra={error.extra} />
            {error.app && (
              <Text>
                <Link href="/admin/catalog/plugins/review">{t("pluginLink")}</Link>
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Dialog>
  );
}
