"use client";

import {
  Callout,
  CheckRow,
  GuideDocument,
  Segmented,
  Skeleton,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { labelLocale } from "../lib/extension-label";
import { keys } from "../lib/query/keys";
import { adminSetupGuideQuery, setupGuideQuery } from "../lib/query/setup";
import type {
  RenderedSetupGuide,
  SetupGuideAudience,
  SetupGuideRef,
  UnresolvedReason,
} from "../lib/setup-guides";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

const KNOWN_MODES = new Set(["long_connection", "webhook"]);

export type SetupGuideSectionProps = {
  orgId: string;
  guide: SetupGuideRef;
  /** The target (a saved connection or connector, or the name typed so far) and the audience. */
  query: {
    connectionId?: string;
    name?: string;
    connectorId?: string;
    audience?: SetupGuideAudience;
  };
  /**
   * The place has drift (spec §11): the versions and the ack of the guide shown for the target's
   * own mode (`onAck` gets its hash; a 409 `*.guide_changed` reads the guide again).
   */
  drift?: { from: string; to: string; onAck: (hash: string) => Promise<void> } | null;
  /** Live check rows (Task 12); without it check rows are static. */
  checks?: "static" | "live";
  /** The super admin's platform route: no org, no target (spec §9.3). */
  admin?: boolean;
  /** The plugin's display name for the drift notice; defaults to the plugin's name. */
  pluginLabel?: string;
};

/**
 * The body of a 接入指南 section (setup guides v2 spec §7.3, §8, §11): a plugin's Markdown setup
 * guide rendered by the kernel for the org and target, in the UI language. The drift notice and
 * its ack when the target's guide changed, the guide's title, the mode switch when the guide has
 * more than one mode (starting at the target's mode), the blocks (prose, copyable code, check
 * rows), and a muted line per reason naming the variables without a value (shown as written).
 * Prose is shown exactly as the kernel sent it (its U+2060 word joiners included). It draws no box:
 * the page puts it in a section card (a FormSection or a Card), where the notice is a line.
 */
export function SetupGuideSection({
  orgId,
  guide,
  query,
  drift = null,
  admin = false,
  pluginLabel,
}: SetupGuideSectionProps) {
  const t = useTranslations("setupGuide");
  const locale = labelLocale(useLocale());
  const errorMessage = useErrorMessage();
  // Undefined: the kernel's default (the target's mode, else the guide's first)
  const [mode, setMode] = useState<string>();
  const q = { ...query, locale };
  const read = useQuery(
    admin
      ? adminSetupGuideQuery(guide, locale)
      : setupGuideQuery(orgId, guide, { ...q, ...(mode && { mode }) }),
  );
  if (read.data === undefined) {
    if (read.error !== null) return <FormError message={errorMessage(read.error)} />;
    return <Skeleton rows={4} />;
  }
  const g = read.data;
  // Without a saved target the checks wait for it (保存后检查); with one, rows stay static until
  // live checks (`checks="live"`, spec §10) draw them.
  const saved =
    g.target !== null || query.connectionId !== undefined || query.connectorId !== undefined;
  return (
    <Stack gap={16}>
      {drift !== null && !admin ? (
        <DriftNotice
          orgId={orgId}
          guide={guide}
          query={q}
          drift={drift}
          plugin={pluginLabel ?? g.plugin}
          place={g.place}
        />
      ) : null}
      <Text variant="h3">{g.title}</Text>
      {g.modes.length > 1 && (
        <Segmented
          label={t("modeLabel")}
          value={g.mode ?? g.modes[0] ?? ""}
          onChange={setMode}
          options={g.modes.map((m) => ({
            value: m,
            label: KNOWN_MODES.has(m) ? t(`modes.${m as "long_connection" | "webhook"}`) : m,
          }))}
        />
      )}
      <GuideDocument
        blocks={g.blocks}
        renderCheck={(c) =>
          // the platform view has no target to check (spec §9.3): no rows
          admin ? null : saved ? (
            <CheckRow label={c.label} state={{ status: "not_run" }} />
          ) : (
            <CheckRow
              label={c.label}
              state={{ status: "static" }}
              staticNote={t("checkAfterSave")}
            />
          )
        }
      />
      {unresolvedLines(g).map(([reason, names]) => (
        <Text key={reason} variant="small" tone="muted">
          {t(`unresolved.${reason}`, { names: names.map((n) => `{{${n}}}`).join(", ") })}
        </Text>
      ))}
    </Stack>
  );
}

/** The unresolved variables grouped by reason, in the order the kernel listed them. */
function unresolvedLines(g: RenderedSetupGuide): [UnresolvedReason, string[]][] {
  const groups = new Map<UnresolvedReason, string[]>();
  for (const u of g.unresolved) groups.set(u.reason, [...(groups.get(u.reason) ?? []), u.name]);
  return [...groups];
}

/**
 * The plugin changed the guide's code or checks since the target was set up: the versions, and
 * 「我已更新 … 应用」, which acks the guide of the target's own mode (the read the section's default
 * view shares), whichever mode the person is looking at.
 */
function DriftNotice({
  orgId,
  guide,
  query,
  drift,
  plugin,
  place,
}: {
  orgId: string;
  guide: SetupGuideRef;
  query: SetupGuideSectionProps["query"] & { locale: "en" | "zh" };
  drift: NonNullable<SetupGuideSectionProps["drift"]>;
  plugin: string;
  place: RenderedSetupGuide["place"];
}) {
  const t = useTranslations("setupGuide");
  const qc = useQueryClient();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const own = useQuery(setupGuideQuery(orgId, guide, query));

  async function confirm() {
    const hash = own.data?.hash;
    if (hash === undefined) return;
    try {
      await drift.onAck(hash);
      toast.success(t("driftAcked"));
    } catch (e) {
      // the guide moved on since it was read: read it again before confirming
      if (e instanceof ApiClientError && e.code.endsWith(".guide_changed")) {
        void qc.invalidateQueries({ queryKey: keys.org(orgId).setupGuidesAll() });
      }
      toast.error(errorMessage(e));
    }
  }

  return (
    <Callout
      tone="warn"
      action={{ label: t("driftAck", { plugin }), onSelect: () => void confirm() }}
    >
      {t(place === "connector-template" ? "connectorDriftNotice" : "driftNotice", {
        plugin,
        from: versionLabel(drift.from),
        to: versionLabel(drift.to),
      })}
    </Callout>
  );
}
