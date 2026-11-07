"use client";

import { Callout, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  invertDisableChange,
  type ModelDisableChange,
  type ModelDisableResult,
  type PurposeView,
  patchAdminDisabledModels,
  patchOrgDisabledModels,
} from "../lib/models";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

type Notice = { provider: string; change: ModelDisableChange; result: ModelDisableResult };

/**
 * Changes a provider's disabled list (spec B §5.3) and keeps what the kernel answers: a disabling is
 * never refused, so when agents or purposes already use a model it turned off, `notice` is a warn
 * Callout (drawn above the section) that names them and offers 「撤销」, which sends the inverse
 * change (only the ids the change named). `change(provider, change)` is the catalog's `onChange`
 * with its provider.
 */
export function useModelDisabling({
  scope,
  purposes = [],
  invalidates,
}: {
  /** An org's own list (`org.models.manage`) or the platform's (super admin). */
  scope: { orgId: string } | "platform";
  /** The purposes view, to name the affected purposes by their label. */
  purposes?: PurposeView[];
  invalidates(): (readonly unknown[])[];
}): {
  change(provider: string, change: ModelDisableChange): void;
  pending: boolean;
  notice: ReactNode;
} {
  const t = useTranslations("models.catalog");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [notice, setNotice] = useState<Notice | null>(null);
  const write = useAppMutation({
    fn: (v: { provider: string; change: ModelDisableChange }) =>
      scope === "platform"
        ? patchAdminDisabledModels(v.provider, v.change)
        : patchOrgDisabledModels(scope.orgId, v.provider, v.change),
    invalidates,
  });

  const run = (provider: string, change: ModelDisableChange, undoable: boolean) =>
    write.mutate(
      { provider, change },
      {
        onSuccess: (result) => {
          const used = result.affected.agents.length + result.affected.purposes.length;
          setNotice(undoable && used > 0 ? { provider, change, result } : null);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const purposeName = (id: string) => {
    const label = purposes.find((v) => v.purpose === id)?.label;
    return (locale === "zh" ? label?.zh : label?.en) || label?.en || id;
  };
  const names = (n: Notice) =>
    [
      ...new Set([
        ...n.result.affected.agents.map((a) => a.name),
        ...n.result.affected.purposes.map((p) => purposeName(p.purpose)),
      ]),
    ].join(locale === "zh" ? "、" : ", ");

  return {
    change: (provider, change) => run(provider, change, true),
    pending: write.isPending,
    notice:
      notice === null ? null : (
        <Callout
          tone="warn"
          action={{
            label: t("undo"),
            onSelect: () => {
              run(notice.provider, invertDisableChange(notice.change), false);
            },
          }}
        >
          {t("affected")} {names(notice)}
        </Callout>
      ),
  };
}
