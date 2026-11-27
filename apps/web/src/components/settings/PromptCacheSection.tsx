"use client";

import { Checkbox, FormSection, Stack, SwitchField, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

/** The org page's "follow the platform" checkbox state (the platform page has none). */
export interface PromptCacheFollow {
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}

/**
 * 提示缓存 (idle compaction spec §6.4): the section the platform settings page (the deployment
 * default) and the organization settings page (the org's override) share. On the org page the
 * `follow` checkbox clears the override; while it is checked the switch shows the platform's value
 * and cannot be edited.
 */
export function PromptCacheSection({
  longTtl,
  disabled = false,
  onChange,
  follow,
}: {
  longTtl: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
  follow?: PromptCacheFollow;
}) {
  const t = useTranslations("promptCache");
  return (
    <FormSection id="prompt-cache" title={t("title")} description={t("description")}>
      <Stack gap={12}>
        {follow !== undefined && (
          <Stack gap={4}>
            <Checkbox
              label={t("follow")}
              checked={follow.checked}
              {...(follow.disabled !== undefined && { disabled: follow.disabled })}
              onChange={follow.onChange}
            />
            <Text variant="small" tone="muted">
              {t("followHint")}
            </Text>
          </Stack>
        )}
        <Stack gap={4}>
          <SwitchField
            label={t("longTtl")}
            checked={longTtl}
            disabled={disabled}
            onChange={onChange}
          />
          <Text variant="small" tone="muted">
            {t("longTtlHint")}
          </Text>
        </Stack>
      </Stack>
    </FormSection>
  );
}
