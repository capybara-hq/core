"use client";

import { Callout, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  type ModelDisableResult,
  putAdminDisabledModels,
  putOrgDisabledModels,
} from "../lib/models";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

type Notice = { provider: string; previous: string[]; result: ModelDisableResult };

/**
 * Writes a provider's disabled list (spec B §5.3) and keeps what the kernel answers: a disabling is
 * never refused, so when agents or purposes already use a model it turned off, `notice` is a warn
 * Callout (drawn above the section) that names them and offers 「撤销」, which writes the list
 * from before. `change(provider, previous, next)` is the catalog's `onChange` with its context.
 */
export function useModelDisabling({
  scope,
  invalidates,
}: {
  /** An org's own list (`org.models.manage`) or the platform's (super admin). */
  scope: { orgId: string } | "platform";
  invalidates(): (readonly unknown[])[];
}): {
  change(provider: string, previous: string[], next: string[]): void;
  pending: boolean;
  notice: ReactNode;
} {
  const t = useTranslations("models.catalog");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [notice, setNotice] = useState<Notice | null>(null);
  const write = useAppMutation({
    fn: (v: { provider: string; models: string[] }) =>
      scope === "platform"
        ? putAdminDisabledModels(v.provider, v.models)
        : putOrgDisabledModels(scope.orgId, v.provider, v.models),
    invalidates,
  });

  const run = (provider: string, models: string[], previous: string[] | null) =>
    write.mutate(
      { provider, models },
      {
        onSuccess: (result) => {
          const used = result.affected.agents.length + result.affected.purposes.length;
          setNotice(previous !== null && used > 0 ? { provider, previous, result } : null);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const names = (n: Notice) =>
    [
      ...n.result.affected.agents.map((a) => a.name),
      ...n.result.affected.purposes.map((p) => p.purpose),
    ].join(locale === "zh" ? "、" : ", ");

  return {
    change: (provider, previous, next) => run(provider, next, previous),
    pending: write.isPending,
    notice:
      notice === null ? null : (
        <Callout
          tone="warn"
          action={{
            label: t("undo"),
            onSelect: () => {
              run(notice.provider, notice.previous, null);
            },
          }}
        >
          {t("affected")} {names(notice)}
        </Callout>
      ),
  };
}
