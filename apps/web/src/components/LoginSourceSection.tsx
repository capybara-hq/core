"use client";

import {
  Button,
  Callout,
  CopyField,
  Field,
  FormSection,
  RadioGroup,
  Stack,
  SwitchField,
  Text,
  Textarea,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { labelLocale } from "../lib/extension-label";
import {
  firstInvalidTenant,
  type LoginSource,
  type LoginSourcePatch,
  tenantsOf,
  updateLoginSource,
} from "../lib/login-sources";
import { loginSourceChangeKeys } from "../lib/query/admin";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

const head = (t: (k: string) => string) => ({
  id: "login",
  title: t("title"),
  description: t("description"),
});

/**
 * The sign-in section on an identity source's extension page (`/admin/extensions/<name>`, login
 * extensions spec §3): the switch "show on the sign-in page" (off while the deployment config is
 * invalid or the extension is not running, with the hint), unlinked accounts (the link page or a
 * new account), trusted tenants (one tenant per line, named and checked by the source's tenant
 * declaration, with the trust warning) and the callback URL to register at the identity provider.
 * The switch and the radio save at once; the tenants with their own button. Every write invalidates
 * the methods, the login page's sources and the audit log.
 *
 * `source` is null for an identity source the methods list does not hold yet (an extension waiting
 * for its deployment config is not loaded): only the switch shows, off, with the hint. `"loading"`
 * draws the section's placeholder, `{ error, retry }` the failed read with a retry.
 */
export function LoginSourceSection({
  source,
}: {
  source: LoginSource | null | "loading" | { error: unknown; retry: () => void };
}) {
  const t = useTranslations("loginSources.section");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  if (source === "loading") {
    return (
      <FormSection
        {...head(t)}
        loading={{
          fields: [
            { control: "switch" },
            { control: "radio-cards", options: 2 },
            { control: "textarea", rows: 3, help: true },
          ],
        }}
      />
    );
  }
  if (source !== null && "error" in source) {
    return (
      <FormSection {...head(t)}>
        <Callout tone="fail" action={{ label: tc("retry"), onSelect: source.retry }}>
          {errorMessage(source.error)}
        </Callout>
      </FormSection>
    );
  }
  if (source === null) {
    return (
      <FormSection {...head(t)}>
        <Stack gap={4}>
          <SwitchField label={t("show")} checked={false} disabled onChange={() => {}} />
          <Text variant="small" tone="muted">
            {t("needsConfig")}
          </Text>
        </Stack>
      </FormSection>
    );
  }
  return <LoginSourceEditor key={source.plugin} source={source} />;
}

function LoginSourceEditor({ source }: { source: LoginSource }) {
  const t = useTranslations("loginSources.section");
  const lang = labelLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  const update = useAppMutation({
    fn: (patch: LoginSourcePatch) => updateLoginSource(source.plugin, patch),
    invalidates: () => loginSourceChangeKeys(),
  });
  const name = source.label[lang];

  const save = (patch: LoginSourcePatch, done: string) =>
    update.mutate(patch, {
      onSuccess: () => {
        if (patch.trustedTenants !== undefined) setDraft(undefined);
        setServerError(null);
        toast.success(done);
      },
      onError: (e) => {
        if (e instanceof ApiClientError && e.code === "login_sources.invalid_tenant") {
          setServerError(errorMessage(e));
        }
        toast.error(errorMessage(e));
      },
    });

  const tenantLabel = source.tenant?.label[lang] ?? t("tenants.defaultTenant");
  const text = draft ?? source.trustedTenants.join("\n");
  const tenants = tenantsOf(text);
  const invalid = firstInvalidTenant(source.tenant, tenants);
  const fieldError =
    invalid === null
      ? draft === undefined
        ? null
        : serverError
      : invalid.reason === "pattern"
        ? t("tenants.invalidPattern", { tenant: invalid.tenant, label: tenantLabel })
        : t("tenants.neverTrusted", { tenant: invalid.tenant });
  const dirty = draft !== undefined && tenants.join("\n") !== source.trustedTenants.join("\n");
  const help = source.tenant?.help?.[lang];
  // turning off is always allowed; turning on waits for a valid deployment config and a running
  // extension
  const switchOff =
    update.isPending || (!source.enabled && (source.needsConfig || !source.available));

  return (
    <FormSection {...head(t)}>
      <Stack gap={16}>
        <Stack gap={4}>
          <SwitchField
            label={t("show")}
            checked={source.enabled}
            disabled={switchOff}
            onChange={(on) =>
              save({ enabled: on }, on ? t("turnedOn", { name }) : t("turnedOff", { name }))
            }
          />
          {source.needsConfig ? (
            <Text variant="small" tone="muted">
              {t("needsConfig")}
            </Text>
          ) : !source.available ? (
            <Text variant="small" tone="muted">
              {t("unavailable")}
            </Text>
          ) : null}
        </Stack>
        <RadioGroup
          label={t("signUp.label")}
          variant="card"
          value={source.signUp}
          disabled={update.isPending}
          onChange={(v) => save({ signUp: v as LoginSource["signUp"] }, t("saved"))}
          options={(["link", "create"] as const).map((v) => ({
            value: v,
            label: t(`signUp.${v}`),
            description: t(`signUp.${v}Hint`),
          }))}
        />
        <Stack gap={8}>
          <Field
            label={t("tenants.label", { tenant: tenantLabel })}
            help={help === undefined ? t("tenants.help") : `${help} ${t("tenants.help")}`}
            {...(fieldError === null ? {} : { error: fieldError })}
          >
            <Textarea
              rows={3}
              value={text}
              {...(source.tenant?.placeholder !== undefined && {
                placeholder: source.tenant.placeholder,
              })}
              onChange={(e) => {
                setServerError(null);
                setDraft(e.target.value);
              }}
            />
          </Field>
          <Callout tone="warn">{t("tenants.warning")}</Callout>
          <Stack direction="row" gap={8}>
            <Button
              variant="default"
              disabled={!dirty || invalid !== null || update.isPending}
              onClick={() => save({ trustedTenants: tenants }, t("saved"))}
            >
              {t("tenants.save")}
            </Button>
          </Stack>
        </Stack>
        {source.callbackUrl === null ? (
          <Text variant="small" tone="muted">
            {t("callback.missing")}
          </Text>
        ) : (
          <CopyField
            label={t("callback.label")}
            value={source.callbackUrl}
            help={t("callback.help")}
          />
        )}
      </Stack>
    </FormSection>
  );
}
