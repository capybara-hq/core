import { type JSX, type ReactNode, useId } from "react";
import { formatDuration } from "../display/duration";
import { Markdown } from "../display/markdown";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignLink, useDesignLocale, useDesignT } from "../provider";
import { RailList, type RailRow, useRailRow } from "./process-rail";
import { Spinner } from "./prose";
import { fillCopy } from "./tool-copy";
import { ErrorDot } from "./tool-row";
import { RailPlanning } from "./working-line";

// The process block (conversation process blocks spec §1.3, §3, §4; design spec §6.16.8a): one
// run's thinking, tool calls and narration as a head (kind chips, one summary line), a rail of
// steps and a fold row; the cards that used to sit inside it are drawn outside (PendingActions).

/** A kind's mark: a line icon of the set, or an image a plugin brings. */
export type ProcessIcon = { name: IconName } | { src: string };

export type ProcessBlockProps = {
  state: "running" | "waiting" | "finished" | "stopped" | "failed";
  /** Running / waiting: the current step's label. */
  current?: ReactNode;
  /**
   * Running only (ignored while waiting): the label assistive technology hears, when `current` follows a streaming call faster
   * than it should be announced. The visible `current` is then hidden from the live region and this
   * (throttled by the page) is read instead.
   */
  announce?: ReactNode;
  /** The waiting words ("Waiting for your approval") drawn in `accent` before the current step. */
  waiting?: ReactNode;
  /** Elapsed time of the run; null when unknown. */
  elapsedMs: number | null;
  summary: {
    thoughts: number;
    tools: number;
    errors: number;
    pinned?: { title: string; badge?: string };
  };
  /** The kinds the block used, first-use order; at most six are drawn as chips. */
  kinds: { key: string; icon: ProcessIcon; label: string }[];
  open: boolean;
  onToggle(): void;
  /** Steps folded above the rail's first drawn step ("N earlier steps"). */
  hiddenBefore?: number;
  onShowEarlier?(): void;
  /** The pinned state card, under the head. */
  pinned?: ReactNode;
  /** Background tasks still running after the run ended. */
  backgroundRunning?: number;
  /**
   * The rail's rows (`RailStep` / `RailSection` elements, each drawn when mounted): windowed once
   * there are many (#925). Takes the place of `children`.
   */
  rows?: readonly RailRow[];
  /** `RailStep` elements, all mounted (a short rail drawn by hand). */
  children?: ReactNode;
  /**
   * Running and no step is live (the model plans the next one): the rail ends in the planning row
   * (the capybara and the rotating caption, {@link RailPlanning}), shown even when the rail is
   * otherwise empty (the block stands from the run's start); the head reads only "Running" and
   * the time. Ignored unless `state` is `running`.
   */
  planning?: boolean;
  /** The planning row's still form (the reference set, screenshots). */
  planningStill?: boolean;
};

/** The most kind chips a head draws. */
export const MAX_PROCESS_CHIPS = 6;

/** A kind mark at `size` (14 on rails, 12 scaled to 11 in chips). */
function ProcessMark({ icon, size }: { icon: ProcessIcon; size: 12 | 14 }): JSX.Element {
  if ("src" in icon) {
    return <img className="cb-process-img" src={icon.src} alt="" width={size} height={size} />;
  }
  return <Icon name={icon.name} size={size} />;
}

export function ProcessBlock({
  state,
  current,
  announce,
  waiting,
  elapsedMs,
  summary,
  kinds,
  open,
  onToggle,
  hiddenBefore,
  onShowEarlier,
  pinned,
  backgroundRunning,
  rows,
  children,
  planning,
  planningStill,
}: ProcessBlockProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const railId = useId();
  const live = state === "running" || state === "waiting";
  // the planning row is the rail's last row; while it stands the head names no step
  const plans = planning === true && state === "running";
  const step = plans ? undefined : current;
  const heard = plans ? undefined : announce;

  const time =
    elapsedMs === null
      ? t("process.workedNoTime")
      : fillCopy(t("process.worked"), { time: formatDuration(elapsedMs, locale) });
  const parts = [
    time,
    summary.pinned ? [summary.pinned.title, summary.pinned.badge].filter(Boolean).join(" ") : null,
    summary.thoughts === 1
      ? t("process.thoughts1")
      : summary.thoughts > 0
        ? fillCopy(t("process.thoughts"), { n: summary.thoughts })
        : null,
    summary.tools === 1
      ? t("process.tools1")
      : summary.tools > 0
        ? fillCopy(t("process.tools"), { n: summary.tools })
        : null,
  ].filter((p): p is string => p !== null);

  const errorLabel =
    summary.errors === 1
      ? t("tool.errorCount1")
      : fillCopy(t("tool.errorCount"), { n: summary.errors });

  let line: JSX.Element;
  if (live) {
    line = (
      <div className="cb-tool-line" data-part="tool-line">
        {state === "waiting" ? (
          <span className="cb-process-lead cb-accent-word" data-part="process-lead">
            <Icon name="hand" size={16} />
          </span>
        ) : (
          <Spinner size={16} />
        )}
        <span
          className="cb-tool-label"
          data-part="process-summary"
          aria-hidden={heard !== undefined && state === "running" ? true : undefined}
        >
          {state === "waiting" ? (
            <>
              <span className="cb-accent-word" data-part="process-waiting">
                {waiting}
              </span>
              {step ? ` · ` : null}
            </>
          ) : (
            <>
              {t("process.running")}
              {step ? ` · ` : null}
            </>
          )}
          {step}
        </span>
        {heard !== undefined && state === "running" ? (
          <span className="cb-sr-only" data-part="process-announce">
            {t("process.running")}
            {heard ? ` · ` : null}
            {heard}
          </span>
        ) : null}
        {elapsedMs === null ? null : (
          // a ticking timer: hidden from assistive technology so the live head does not chatter
          <span className="cb-process-time cb-faint" data-part="process-time" aria-hidden="true">
            {formatDuration(elapsedMs, locale, { live: true })}
          </span>
        )}
      </div>
    );
  } else {
    const chips = kinds.slice(0, MAX_PROCESS_CHIPS);
    line = (
      <button
        type="button"
        className="cb-tool-line"
        data-part="tool-line"
        aria-expanded={open}
        aria-controls={open ? railId : undefined}
        onClick={onToggle}
      >
        {chips.length > 0 ? (
          <span className="cb-process-chips" data-part="process-chips">
            {chips.map((k) => (
              <span
                key={k.key}
                className="cb-process-chip"
                data-part="process-chip"
                data-kind={k.key}
                role="img"
                aria-label={k.label}
                title={k.label}
              >
                <ProcessMark icon={k.icon} size={12} />
              </span>
            ))}
          </span>
        ) : null}
        <span className="cb-tool-label" data-part="process-summary">
          {parts.join(" · ")}
        </span>
        {summary.errors > 0 ? (
          <span className="cb-tool-errors" data-part="tool-errors">
            <ErrorDot label={errorLabel} />
            <span aria-hidden="true">{summary.errors}</span>
          </span>
        ) : null}
        {state === "stopped" ? (
          <span className="cb-process-word cb-muted" data-part="process-state-word">
            {t("process.stopped")}
          </span>
        ) : null}
        {state === "failed" ? (
          <span className="cb-process-word cb-fail-word" data-part="process-state-word">
            {t("run.failed")}
          </span>
        ) : null}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
    );
  }

  return (
    <div className="cb-process" data-part="process-block" data-state={state}>
      <div className="cb-process-head" data-part="process-head" aria-live="polite">
        {line}
      </div>
      {backgroundRunning !== undefined && backgroundRunning > 0 ? (
        <div className="cb-process-bg cb-faint" data-part="process-background">
          {backgroundRunning === 1
            ? t("process.background1")
            : fillCopy(t("process.background"), { n: backgroundRunning })}
        </div>
      ) : null}
      {pinned ? (
        <div className="cb-process-pinned" data-part="process-pinned">
          {pinned}
        </div>
      ) : null}
      {open || plans ? (
        <div id={railId} className="cb-process-rail" data-part="process-rail">
          {open && hiddenBefore !== undefined && hiddenBefore > 0 ? (
            <button
              type="button"
              className="cb-process-fold"
              data-part="process-fold"
              onClick={onShowEarlier}
            >
              <span className="cb-rail-gutter" aria-hidden="true">
                <Icon name="chevron-up" size={12} />
              </span>
              <span>
                {hiddenBefore === 1
                  ? t("process.earlier1")
                  : fillCopy(t("process.earlier"), { n: hiddenBefore })}
              </span>
            </button>
          ) : null}
          {rows !== undefined ? (
            <RailList
              rows={
                plans
                  ? [
                      ...(open ? rows : []),
                      {
                        key: "planning",
                        render: () => <RailPlanning still={planningStill === true} />,
                      },
                    ]
                  : rows
              }
            />
          ) : (
            <>
              {open ? children : null}
              {plans ? <RailPlanning still={planningStill === true} /> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export type RailStepProps = {
  /**
   * The step's mark in the gutter: its kind icon, or a bare dot (narration). Always the kind, live
   * or not: the block's head carries the spinner and a live row says its state in words (§6.16.8a).
   */
  icon: ProcessIcon | "dot";
  children: ReactNode;
};

/** One step of the rail: a 20 px gutter holding the icon on the rule, and the step's row. */
export function RailStep({ icon, children }: RailStepProps): JSX.Element {
  // its place on the rail, when a RailList draws it
  const row = useRailRow();
  const mark =
    icon === "dot" ? (
      <span className="cb-rail-dot" data-part="rail-dot" />
    ) : (
      <ProcessMark icon={icon} size={14} />
    );
  return (
    <div className="cb-rail-step" data-part="rail-step" {...row}>
      <span className="cb-rail-gutter" data-part="rail-gutter" aria-hidden="true">
        {mark}
      </span>
      <div className="cb-rail-body">{children}</div>
    </div>
  );
}

/**
 * A narration step's text (§1.3): `prose-small` in `muted`, the dot in the gutter holds the place.
 * A string is the model's Markdown, rendered compactly (inline code, bold, links, lists).
 */
export function RailText({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="cb-rail-say" data-part="rail-text">
      {typeof children === "string" ? <Markdown text={children} /> : children}
    </div>
  );
}

export type PendingAction = {
  key: string;
  icon: ProcessIcon;
  title: string;
  description?: string;
  /** A link to the page where it is done, or a button that starts it here (`busy` while it runs). */
  action: { label: string; href: string } | { label: string; onClick(): void; busy?: boolean };
};

/**
 * Things that need the person but do not block the run (handoffs; spec §4): one box under the
 * block, rows divided by hairlines; with two or more a first line says the run carried on. Each
 * row's action is a link to its page, or a button that starts it in place (a connection).
 */
export function PendingActions({ items }: { items: PendingAction[] }): JSX.Element | null {
  const t = useDesignT();
  // the app's link: a page link navigates on the client, like every other design link
  const Link = useDesignLink();
  if (items.length === 0) return null;
  return (
    <div className="cb-pending" data-part="pending-actions">
      {items.length >= 2 ? (
        <div className="cb-pending-many" data-part="pending-many">
          {fillCopy(t("pending.many"), { n: items.length })}
        </div>
      ) : null}
      <ul className="cb-pending-list">
        {items.map((it) => (
          <li key={it.key} className="cb-pending-item" data-part="pending-item">
            <span className="cb-pending-icon" aria-hidden="true">
              <ProcessMark icon={it.icon} size={14} />
            </span>
            <span className="cb-pending-text">
              <span className="cb-pending-title" data-part="pending-title">
                {it.title}
              </span>
              {it.description ? (
                <span className="cb-pending-desc" data-part="pending-desc">
                  {it.description}
                </span>
              ) : null}
            </span>
            {"href" in it.action ? (
              <Link className="cb-pending-action" data-part="pending-action" href={it.action.href}>
                {it.action.label}
              </Link>
            ) : (
              <button
                type="button"
                className="cb-pending-action"
                data-part="pending-action"
                disabled={it.action.busy === true}
                aria-busy={it.action.busy === true ? true : undefined}
                onClick={it.action.onClick}
              >
                {it.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
