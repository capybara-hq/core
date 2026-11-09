"use client";

import {
  Button,
  Callout,
  CheckRow,
  type CheckRowState,
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
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError } from "../lib/api";
import { labelLocale } from "../lib/extension-label";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { adminSetupGuideQuery, setupGuideQuery } from "../lib/query/setup";
import { setupCheckStatesQuery } from "../lib/query/setup-checks";
import { draftConversationPath } from "../lib/routes";
import {
  type RenderedSetupGuide,
  runSetupCheck,
  type SetupCheckSelection,
  type SetupCheckState,
  type SetupCheckText,
  type SetupGuideAudience,
  type SetupGuideRef,
  type UnresolvedReason,
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
  /**
   * `live`: a saved target's check rows read their cached states, run the rows without a fresh
   * result and offer 重新检查 (spec §10.4). Otherwise (and always without a saved target) the rows
   * only show the check.
   */
  checks?: "static" | "live";
  /** The super admin's platform route: no org, no target (spec §9.3). */
  admin?: boolean;
  /** The plugin's display name for the drift notice; defaults to the plugin's name. */
  pluginLabel?: string;
  /**
   * What the guide sets up, as the person knows it (the connection's or connector's name) for the
   * 让智能体协助 draft; defaults to the name typed so far, else the plugin's label.
   */
  targetLabel?: string;
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
  checks = "static",
  admin = false,
  pluginLabel,
  targetLabel,
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
      {checks === "live" && !admin && saved ? (
        <LiveGuideDocument
          // a mode's rows are their own: switching starts over
          key={g.mode ?? ""}
          orgId={orgId}
          guide={guide}
          g={g}
          selection={{
            ...(query.connectionId !== undefined && { connectionId: query.connectionId }),
            ...(query.connectorId !== undefined && { connectorId: query.connectorId }),
            ...(g.mode !== null && { mode: g.mode }),
            ...(query.audience !== undefined && { audience: query.audience }),
          }}
        />
      ) : (
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
      )}
      {unresolvedLines(g).map(([reason, names]) => (
        <Text key={reason} variant="small" tone="muted">
          {t(`unresolved.${reason}`, { names: names.map((n) => `{{${n}}}`).join(", ") })}
        </Text>
      ))}
      {admin ? null : (
        <AskAgent
          g={g}
          query={query}
          target={targetLabel ?? query.name ?? pluginLabel ?? g.plugin}
        />
      )}
    </Stack>
  );
}

/**
 * 让智能体协助 / Ask an agent (spec §12): a new conversation (`/`, the agent the home picks) with a
 * drafted message in the composer, not sent, naming the guide (plugin, catalog item, guide id,
 * place) and its target by id, so the agent finds it with the Platform `setup` operations. The
 * draft is built from names and ids only, never from config values (the guide's text is not in
 * it either). Shown wherever the section is, since the guide is only rendered for someone who
 * can act on it (its page, or the member's 如何连接); never in the platform preview.
 */
function AskAgent({
  g,
  query,
  target,
}: {
  g: RenderedSetupGuide;
  query: SetupGuideSectionProps["query"];
  target: string;
}) {
  const t = useTranslations("setupGuide.askAgent");
  const router = useRouter();
  const connectionId = g.target?.kind === "channel-connection" ? g.target.id : query.connectionId;
  const connectorId = g.target?.kind === "connector" ? g.target.id : query.connectorId;
  const targetRef =
    connectionId !== undefined
      ? t("targetConnection", { id: connectionId })
      : connectorId !== undefined
        ? t("targetConnector", { id: connectorId })
        : t("targetNone");
  const draft = [
    t("draft", { title: g.title, target }),
    t("reference", {
      plugin: g.plugin,
      itemId: g.itemId,
      guideId: g.id,
      place: g.place,
      audience: g.audience,
      target: targetRef,
    }),
  ].join("\n\n");
  return (
    <Stack direction="row">
      <Button variant="ghost" onClick={() => router.push(draftConversationPath(draft))}>
        {t("action")}
      </Button>
    </Stack>
  );
}

/** How often a row running elsewhere is read again, and for how long at most (spec §10.4). */
const POLL_MS = 1000;
const POLL_WINDOW_MS = 10_000;
/** Runs started on view at once per page (spec §10.4). */
const MAX_IN_FLIGHT = 4;
/** Runs a row gets on view (a run answered `running` that left no result is tried again). */
const MAX_AUTO_RUNS = 3;

/**
 * The guide with live check rows (spec §10.3, §10.4): the cached states first (`GET …/checks`,
 * which runs nothing), then a run without `force` for each row without a fresh result (at most
 * four at a time), the states read again every second while a row runs elsewhere (up to ten
 * seconds), and 重新检查 as a forced run (refused within the cooldown: the button waits for
 * `cooldownUntil`). Over the per-account limit (429 `rate_limited`) the rows keep their last state
 * and a muted line says so; runs on view stop.
 */
function LiveGuideDocument({
  orgId,
  guide,
  g,
  selection,
}: {
  orgId: string;
  guide: SetupGuideRef;
  g: RenderedSetupGuide;
  selection: SetupCheckSelection;
}) {
  const t = useTranslations("setupGuide");
  const locale = labelLocale(useLocale());
  const qc = useQueryClient();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const q = setupCheckStatesQuery(orgId, guide, selection);
  const pollingSince = useRef<number | null>(null);
  const states = useQuery({
    ...q,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || !Object.values(data).some((s) => s.status === "running")) {
        pollingSince.current = null;
        return false;
      }
      pollingSince.current ??= Date.now();
      return Date.now() - pollingSince.current < POLL_WINDOW_MS ? POLL_MS : false;
    },
  });
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [rateLimited, setRateLimited] = useState(false);
  const run = useAppMutation({
    fn: (v: { id: string; force: boolean }) =>
      runSetupCheck(orgId, guide, v.id, { ...selection, ...(v.force && { force: true }) }),
    // the answer is the row's new state; a `running` one is polled through the states read
    invalidates: () => [],
    onSuccess: (r, v) =>
      qc.setQueryData<Record<string, SetupCheckState>>(q.queryKey, (old) => ({
        ...old,
        [v.id]: r.result,
      })),
  });

  async function start(id: string, force: boolean): Promise<"ok" | "limited" | "failed"> {
    setInFlight((s) => new Set(s).add(id));
    try {
      await run.mutateAsync({ id, force });
      setRateLimited(false);
      return "ok";
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 429) {
        setRateLimited(true);
        return "limited";
      }
      if (force) toast.error(errorMessage(e));
      return "failed";
    } finally {
      setInFlight((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  // Runs on view: each row without a fresh result, a few at a time, until the limit answers 429
  const auto = useRef({ attempts: new Map<string, number>(), queue: [] as string[], active: 0 });
  const stopped = useRef(false);
  const data = states.data;
  const idsKey = g.checks.map((c) => c.id).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids are keyed by `idsKey`; `start` is the latest render's
  useEffect(() => {
    if (data === undefined || stopped.current) return;
    const a = auto.current;
    for (const id of new Set(idsKey.split("\n"))) {
      if (id === "" || (data[id]?.status ?? "not_run") !== "not_run" || a.queue.includes(id)) {
        continue;
      }
      const n = a.attempts.get(id) ?? 0;
      if (n >= MAX_AUTO_RUNS) continue;
      a.attempts.set(id, n + 1);
      a.queue.push(id);
    }
    const pump = () => {
      while (!stopped.current && a.active < MAX_IN_FLIGHT && a.queue.length > 0) {
        const id = a.queue.shift() as string;
        a.active += 1;
        void start(id, false).then((outcome) => {
          a.active -= 1;
          if (outcome === "limited") {
            stopped.current = true;
            a.queue.length = 0;
          }
          pump();
        });
      }
    };
    pump();
  }, [data, idsKey]);

  const rowState = (id: string): CheckRowState => {
    if (inFlight.has(id)) return { status: "running" };
    const s = data?.[id];
    if (s === undefined) return { status: "not_run" };
    return {
      status: s.status,
      ...(s.reason && { reason: textIn(s.reason, locale) }),
      ...(s.fix && { fix: textIn(s.fix, locale) }),
      ...(s.checkedAt !== undefined && { checkedAt: s.checkedAt }),
      ...(s.cooldownUntil !== undefined && { cooldownUntil: s.cooldownUntil }),
    };
  };

  return (
    <>
      <GuideDocument
        blocks={g.blocks}
        renderCheck={(c) => (
          <CheckRow
            label={c.label}
            state={rowState(c.id)}
            onRecheck={() => void start(c.id, true)}
          />
        )}
      />
      {rateLimited && (
        <Text variant="small" tone="muted">
          {t("checksRateLimited")}
        </Text>
      )}
      {data === undefined && states.error !== null && (
        <Text variant="small" tone="muted">
          {t("checksUnavailable")}
        </Text>
      )}
    </>
  );
}

/** A check's text in the UI language (Chinese when the plugin wrote it, else English). */
const textIn = (text: SetupCheckText, locale: "en" | "zh"): string =>
  locale === "zh" ? (text.zh ?? text.en) : text.en;

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
