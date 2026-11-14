"use client";

import { Checkbox, Field, FormSection, Input, Stack, SwitchField, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  COMPACTION_BOUNDS,
  type CompactionSettings,
  type CompactionSettingsPatch,
} from "../../lib/compaction";

/** The org page's "follow the platform" checkbox state (the platform page has none). */
export interface CompactionFollow {
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}

/**
 * 对话压缩 (context compaction spec §4.8): the section the platform settings page (the deployment
 * defaults) and the organization settings page (the org's override) share. On the org page the
 * `follow` checkbox clears the override; while it is checked the fields show the platform's values
 * and cannot be edited.
 */
export function CompactionSection({
  value,
  disabled = false,
  onChange,
  follow,
}: {
  value: CompactionSettings;
  disabled?: boolean;
  onChange(patch: CompactionSettingsPatch): void;
  follow?: CompactionFollow;
}) {
  const t = useTranslations("compaction");
  return (
    <FormSection id="compaction" title={t("title")} description={t("description")}>
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
            label={t("enabled")}
            checked={value.enabled}
            disabled={disabled}
            onChange={(next) => onChange({ enabled: next })}
          />
          <Text variant="small" tone="muted">
            {t("enabledHint")}
          </Text>
        </Stack>
        <NumberField
          field="threshold"
          value={value.threshold}
          disabled={disabled}
          onChange={(threshold) => onChange({ threshold })}
        />
        <NumberField
          field="keepRecentTurns"
          value={value.keepRecentTurns}
          disabled={disabled}
          onChange={(keepRecentTurns) => onChange({ keepRecentTurns })}
        />
        <NumberField
          field="reserveTokens"
          value={value.reserveTokens}
          disabled={disabled}
          onChange={(reserveTokens) => onChange({ reserveTokens })}
        />
        <NumberField
          field="maxOutputTokens"
          value={value.maxOutputTokens}
          disabled={disabled}
          onChange={(maxOutputTokens) => onChange({ maxOutputTokens })}
        />
      </Stack>
    </FormSection>
  );
}

/**
 * A number field that commits only an in-range value (the kernel refuses the others with a 400) and
 * drops an invalid draft on blur, showing the last committed value again.
 */
function NumberField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: keyof typeof COMPACTION_BOUNDS;
  value: number;
  disabled: boolean;
  onChange(next: number): void;
}) {
  const t = useTranslations("compaction");
  const bounds = COMPACTION_BOUNDS[field];
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={t(`${field}.label`)} help={t(`${field}.help`)}>
      <Input
        value={draft ?? String(value)}
        disabled={disabled}
        inputMode={bounds.decimal ? "decimal" : "numeric"}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const n = Number(text);
          if (text.trim() === "" || !Number.isFinite(n)) return;
          if (n < bounds.min || n > bounds.max) return;
          if (!bounds.decimal && !Number.isInteger(n)) return;
          onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}
