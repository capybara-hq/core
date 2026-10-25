"use client";

import {
  Badge,
  Card,
  Checkbox,
  Field,
  FileButton,
  Input,
  KeyValue,
  RadioGroup,
  Stack,
  Text,
  useToast,
  WizardPage,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { ComponentSection } from "../../../../../../components/CatalogParts";
import { FormError } from "../../../../../../components/form-error";
import { PermissionReview } from "../../../../../../components/PermissionReview";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import { issueLines } from "../../../../../../lib/api";
import {
  confirmPluginImport,
  dropPreparedImport,
  endpointLeaves,
  importPageHref,
  type PermissionsMismatch,
  type PluginConfirmResult,
  type PluginPrepared,
  type PluginReview,
  type PluginReviewExtension,
  pluginReviewSensitive,
  preparePluginNpm,
  readPreparedImport,
  showValue,
  stashPreparedImport,
  uploadPluginPackage,
} from "../../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../../lib/use-error-message";

/**
 * `/[locale]/admin/catalog/import`: import a plugin into the catalog (enterprise admins,
 * WizardPage), reviewed as a whole in one pass:
 * 1. choose the plugin package: upload a tgz or give an npm package name (prepare stages it for 24
 *    hours). A marketplace entry is prepared on the entries page, which opens this page with
 *    `?staging=<id>` and skips this step (the prepared review is kept in this tab's
 *    sessionStorage: the kernel does not return a staged review again);
 * 2. review: the extension (its action on the deployment and its permissions, sensitive items
 *    highlighted), the skills, the connector templates (endpoint and auth) and the dependencies
 *    (with the catalog version each resolves to); a warning when the marketplace's permission
 *    summary differs from the package;
 * 3. confirm: "Also install the extension on the deployment" when the plugin brings an extension to
 *    install or upgrade (unchecked, it is only recorded in the catalog and orgs cannot use it yet);
 *    with sensitive items, "I understand the sensitive items" must be checked too.
 */
export default function PluginImportPage() {
  return (
    <AdminGate>
      <PluginImportWizard />
    </AdminGate>
  );
}

/**
 * The `staging` query parameter, read in an effect after mount: on a client navigation
 * (router.push) the address bar may still show the old URL while the new page first renders (no
 * useSearchParams: it would need a Suspense boundary and turn the page client-rendered).
 */
const stagingParam = (): string | null =>
  new URLSearchParams(window.location.search).get("staging");

type Step = 0 | 1 | 2;
type Problem = { message: string; extra: string[] };
/** undefined: not read yet; null: no `staging` parameter; "gone": staged review not in this tab. */
type Staged = PluginPrepared | null | "gone" | undefined;

function PluginImportWizard() {
  const t = useTranslations("catalog.admin.review");
  const ta = useTranslations("catalog.admin");
  const tw = useTranslations("admin.extensions.wizard");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [staged, setStaged] = useState<Staged>(undefined);
  const [step, setStep] = useState<Step>(0);
  const [source, setSource] = useState<"file" | "npm">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<Problem>();
  const [prepared, setPrepared] = useState<PluginPrepared | null>(null);
  const [deployExtension, setDeployExtension] = useState(false);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Problem>();
  const [result, setResult] = useState<PluginConfirmResult | null>(null);

  const problem = (e: unknown): Problem => ({ message: errorMessage(e), extra: issueLines(e) });

  const accept = (p: PluginPrepared) => {
    setPrepared(p);
    setDeployExtension(false);
    setAck(false);
    setStep(1);
  };

  // A staged import prepared elsewhere (marketplace entries): read it once on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on mount only
  useEffect(() => {
    const id = stagingParam();
    if (id === null) {
      setStaged(null);
      return;
    }
    const p = readPreparedImport(id);
    setStaged(p ?? "gone");
    if (p !== null) accept(p);
  }, []);

  const fetchReview = async () => {
    setFetchError(undefined);
    setFetching(true);
    try {
      let p: PluginPrepared;
      if (source === "file") {
        if (file === null) return;
        p = await uploadPluginPackage(file);
      } else {
        p = await preparePluginNpm(pkg.trim(), version.trim());
      }
      stashPreparedImport(p);
      // The address names the staged import (a reload in this tab comes back to the review)
      router.replace(importPageHref(p.stagingId));
      accept(p);
    } catch (e) {
      setFetchError(problem(e));
    } finally {
      setFetching(false);
    }
  };

  const review = prepared?.review ?? null;
  const sensitive = review !== null && pluginReviewSensitive(review);
  const deployable = review?.extension !== undefined && review.extension.action !== "keep";
  const fromElsewhere = staged !== null && staged !== undefined;

  const submit = async () => {
    if (prepared === null) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const r = await confirmPluginImport(prepared.stagingId, {
        reviewHash: prepared.review.reviewHash,
        deployExtension: deployable && deployExtension,
      });
      dropPreparedImport(prepared.stagingId);
      toast.success(t("done", { name: r.item.name }));
      if (r.deploy === null || r.deploy.result !== "failed") {
        router.push(`/admin/catalog/${r.item.id}`);
      } else setResult(r);
    } catch (e) {
      setSubmitError(problem(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = { label: tw("cancel"), onSelect: () => router.push("/admin/catalog") };
  const back = () => {
    setSubmitError(undefined);
    setStep((s) => (s > 0 ? ((s - 1) as Step) : s));
  };
  const actionRow =
    step === 0
      ? {
          cancel,
          primary: {
            label: t("fetch"),
            onSelect: () => void fetchReview(),
            loading: fetching,
            disabled:
              fetching || fromElsewhere || (source === "file" ? file === null : pkg.trim() === ""),
          },
        }
      : step === 1
        ? {
            cancel,
            ...(!fromElsewhere && { secondary: { label: tw("back"), onSelect: back } }),
            primary: { label: tw("next"), onSelect: () => setStep(2) },
          }
        : {
            cancel,
            secondary: { label: tw("back"), onSelect: back, disabled: submitting },
            primary: {
              label: t("confirm"),
              onSelect: () => void submit(),
              loading: submitting,
              disabled: submitting || result !== null || (sensitive && !ack),
            },
          };

  return (
    <WizardPage
      header={{ parent: { label: ta("title"), href: "/admin/catalog" }, title: t("title") }}
      steps={[t("steps.source"), t("steps.review"), t("steps.confirm")]}
      current={step}
      actionRow={actionRow}
    >
      {step === 0 &&
        (staged === "gone" ? (
          <Card tone="danger">
            <Stack gap={8}>
              <Text tone="fail">{t("gone")}</Text>
              <Text>
                <Link href="/admin/catalog/import">{t("restart")}</Link>
              </Text>
            </Stack>
          </Card>
        ) : (
          <Stack gap={16}>
            <RadioGroup
              label={t("sourceLabel")}
              value={source}
              onChange={(v) => {
                setSource(v as "file" | "npm");
                setFetchError(undefined);
              }}
              options={[
                { value: "file", label: t("sourceFile") },
                { value: "npm", label: t("sourceNpm") },
              ]}
            />
            {source === "file" ? (
              <Stack direction="row" gap={8} align="center">
                <FileButton
                  label={tw("choose")}
                  accept=".tgz,application/gzip,application/x-gzip"
                  disabled={fetching}
                  onFiles={(files) => {
                    setFile(files[0] ?? null);
                    setFetchError(undefined);
                  }}
                />
                <Text tone="muted">{file === null ? tw("noFile") : file.name}</Text>
              </Stack>
            ) : (
              <Stack gap={12}>
                <Field label={tw("npmPackage")}>
                  <Input value={pkg} onChange={(e) => setPkg(e.target.value)} />
                </Field>
                <Field label={tw("npmVersion")} help={tw("npmVersionHelp")}>
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} />
                </Field>
              </Stack>
            )}
            {fetchError !== undefined && <ProminentError problem={fetchError} />}
          </Stack>
        ))}
      {step === 1 && review !== null && (
        <ReviewBody review={review} mismatch={prepared?.permissionsMismatch ?? null} />
      )}
      {step === 2 && review !== null && (
        <Stack gap={16}>
          <Text>{t("plugin", { name: review.name, version: review.version })}</Text>
          {review.extension === undefined ? (
            <Text tone="muted">{t("noExtension")}</Text>
          ) : !deployable ? (
            <Text tone="muted">
              {t("keepExtension", {
                name: review.extension.name,
                version: review.extension.currentVersion ?? review.extension.version,
              })}
            </Text>
          ) : (
            <Stack gap={4}>
              <Checkbox
                checked={deployExtension}
                onChange={setDeployExtension}
                label={t("deployExtension")}
                disabled={result !== null}
              />
              <Text variant="small" tone={deployExtension ? "muted" : "warn"}>
                {deployExtension ? t("deployOn") : t("deployOff")}
              </Text>
            </Stack>
          )}
          {sensitive && (
            <Stack gap={8}>
              <Text tone="warn">{t("ackHint")}</Text>
              <Checkbox checked={ack} onChange={setAck} label={t("ack")} />
            </Stack>
          )}
          {submitError !== undefined && <ProminentError problem={submitError} />}
          {result?.deploy && (
            <Card title={t("deployResult")}>
              <Stack gap={4}>
                <Text tone="fail">
                  {t("deployFailed", {
                    name: result.deploy.name,
                    version: result.deploy.version,
                    code: result.deploy.code ?? "",
                  })}
                </Text>
                <Text>
                  <Link href={`/admin/catalog/${result.item.id}`}>{t("openItem")}</Link>
                </Text>
              </Stack>
            </Card>
          )}
        </Stack>
      )}
    </WizardPage>
  );
}

/**
 * A prominent error (e.g. `marketplace.integrity_mismatch`, `catalog.legacy_format`): the error row
 * in a danger card.
 */
function ProminentError({ problem }: { problem: Problem }) {
  return (
    <Card tone="danger">
      <FormError message={problem.message} extra={problem.extra} />
    </Card>
  );
}

function ReviewBody({ review, mismatch }: { review: PluginReview; mismatch: PermissionsMismatch }) {
  const t = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  const tp = useTranslations("extensions");
  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <Stack direction="row" gap={8} align="center">
          <Text>{t("plugin", { name: review.name, version: review.version })}</Text>
          {review.sensitive && <Badge tone="accent">{tp("sensitive")}</Badge>}
        </Stack>
        <Text variant="small" tone="muted">
          {[
            t("package", { name: review.packageName }),
            ...(review.publisher !== "" ? [t("publisher", { publisher: review.publisher })] : []),
            ...(review.license !== undefined ? [t("license", { license: review.license })] : []),
          ].join(" · ")}
        </Text>
        {review.description !== "" && <Text tone="muted">{review.description}</Text>}
      </Stack>
      {mismatch !== null && (
        <Card tone="accent">
          <Stack gap={4}>
            <Text tone="warn">{t("mismatch")}</Text>
            {mismatch.missing.length > 0 && (
              <Text variant="small" tone="warn">
                {t("mismatchMissing", { keys: mismatch.missing.join(", ") })}
              </Text>
            )}
            {mismatch.extra.length > 0 && (
              <Text variant="small" tone="muted">
                {t("mismatchExtra", { keys: mismatch.extra.join(", ") })}
              </Text>
            )}
          </Stack>
        </Card>
      )}
      <ComponentSection
        title={tc("extension")}
        count={review.extension === undefined ? 0 : 1}
        empty={tc("extensionNone")}
      >
        {review.extension !== undefined && <ExtensionReview extension={review.extension} />}
      </ComponentSection>
      <ComponentSection title={tc("skills")} count={review.skills.length} empty={tc("skillsNone")}>
        {review.skills.map((s) => (
          <Stack key={s.path} gap={0}>
            <Text>{`${s.name} · ${tc("skillFiles", { n: s.files })}`}</Text>
            <Text variant="small" tone="muted">
              {s.description}
            </Text>
          </Stack>
        ))}
      </ComponentSection>
      <ComponentSection
        title={tc("templates")}
        count={review.connectorTemplates.length}
        empty={tc("templatesNone")}
      >
        {review.connectorTemplates.map((c) => (
          <Card key={c.id} title={`${c.id} · ${c.plugin} / ${c.connector}`}>
            <Stack gap={8}>
              <KeyValue
                keyWidth="14ch"
                rows={endpointLeaves(c.endpoint).map(([k, v]) => ({ k, v: showValue(v) }))}
              />
              {c.editableEndpoint.length > 0 && (
                <Text variant="small" tone="muted">
                  {t("editable", { paths: c.editableEndpoint.join(", ") })}
                </Text>
              )}
              <Text variant="small">{t("auth", { type: String(c.auth.type ?? "none") })}</Text>
              {!c.endpointChecked && (
                <Text variant="small" tone="warn">
                  {t("unchecked")}
                </Text>
              )}
            </Stack>
          </Card>
        ))}
      </ComponentSection>
      <ComponentSection
        title={tc("dependencies")}
        count={review.dependencies.length}
        empty={tc("dependenciesNone")}
      >
        <Text variant="small" tone="muted">
          {tc("dependenciesHint")}
        </Text>
        {review.dependencies.map((d) =>
          d.resolved !== null ? (
            <Text key={d.name}>
              {tc("dependencyResolved", { name: d.name, range: d.range, version: d.resolved })}
            </Text>
          ) : (
            <Text key={d.name} tone="warn">
              {tc("dependencyUnresolved", { name: d.name, range: d.range })}
            </Text>
          ),
        )}
      </ComponentSection>
    </Stack>
  );
}

function ExtensionReview({ extension }: { extension: PluginReviewExtension }) {
  const t = useTranslations("catalog.admin.review");
  const tp = useTranslations("extensions");
  const action =
    extension.action === "install"
      ? t("action.install", { version: extension.version })
      : extension.action === "upgrade"
        ? t("action.upgrade", { from: extension.currentVersion ?? "", to: extension.version })
        : t("action.keep", { version: extension.currentVersion ?? extension.version });
  return (
    <Card
      tone={extension.sensitive ? "accent" : "default"}
      title={extension.name}
      {...(extension.sensitive && { actions: <Badge tone="accent">{tp("sensitive")}</Badge> })}
    >
      <Stack gap={8}>
        <Text>{action}</Text>
        <PermissionReview
          plugin={extension.name}
          groups={extension.permissions}
          {...(extension.action === "upgrade" && {
            added: extension.addedItems,
            removed: extension.removed,
          })}
          warnings={extension.warnings}
        />
      </Stack>
    </Card>
  );
}
