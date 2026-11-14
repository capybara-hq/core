import { type JSX, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../controls/button";
import { Input } from "../controls/inputs";
import { Checkbox, Switch } from "../controls/toggles";
import { Callout, type CalloutAction } from "../display/callout";
import { CodeBlock } from "../display/chat";
import { initialOf } from "../display/initial";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { registrableDomain } from "./registrable";
import { fillCopy } from "./tool-copy";

// Human-in-the-loop blocks (spec §6.16.11–§6.16.13): the pending approval (the only accent card),
// questions (AskUserQuestion and connector elicitation) and connect requests, and their one-line forms
// once handled.

// ── Approval ────────────────────────────────────────────────────────────────

export type ApprovalScope = "once" | "session" | "always";

export type ApprovalState =
  | { kind: "pending"; busy?: boolean }
  | {
      kind: "decided";
      /** `skipped`: the person sent a message instead of answering (network asks only). */
      decision: "approved" | "denied" | "expired" | "cancelled" | "skipped";
      who: string;
      when: string;
      scope?: ApprovalScope;
      reason?: string;
      /** A network ask: the hosts the decision covers (the checked ones when approved). */
      hosts?: string[];
      /**
       * A network ask decided "always" that became "this time": the device was offline, or does
       * not accept remote changes (refused, or a program without the feature).
       */
      fallback?: NetworkFallback;
    };

export type NetworkFallback = "offline" | "refused" | "unsupported";

/** A network ask (network ask spec §6.5): a command on a device was refused these hosts. */
export type NetworkAsk = {
  /** The device-layer hosts asked for (model-controlled: drawn as code, never markup). */
  hosts: string[];
  /** The refused command (model-controlled), clipped to {@link NETWORK_COMMAND_MAX} characters. */
  command: string;
  /** The command's description (model-controlled), when it had one. */
  description?: string;
};

/** How much of a network ask's command the card shows. */
export const NETWORK_COMMAND_MAX = 300;

/**
 * A command review ask (auto mode spec §5.4): the run waits for the device owner to allow a shell
 * command, or a file write outside the workspace, before it runs. The command is model-controlled:
 * drawn as code, never markup, and clipped to {@link NETWORK_COMMAND_MAX} characters.
 */
export type CommandAsk = {
  /** A shell command (`Bash`) or a file write outside the workspace (`Write` / `Edit`). */
  kind: "command" | "write";
  /** The command text (display-clipped), or the tool key of the write. */
  command: string;
  /** A write's target path. */
  path?: string;
  /** The review's reason: why this command is held. */
  reason: string;
};

export type ApprovalBlockProps = {
  /** The tool as people read it: "<connector>: <title>", or the source and localized name. */
  tool: string;
  /** The model-visible tool key, always shown: a title is unreviewed display text. */
  toolKey: string;
  /** What the call does, in one sentence, rendered by the kernel; shown above the input. */
  summary?: string;
  /** The whole tool input. Every property is shown. */
  input: Record<string, unknown>;
  /** The tool's key arguments: shown first, in this order. */
  keyArgs?: string[];
  /** The scopes the request allows; one approve button each, the first is the primary one. */
  scopes: ApprovalScope[];
  /** Button labels per scope in place of the defaults (a network ask has its own). */
  scopeLabels?: Partial<Record<ApprovalScope, string>>;
  /** A small line under a scope's button saying what it means. */
  scopeHints?: Partial<Record<ApprovalScope, string>>;
  /** The rule that asked (shown on the right of the actions). */
  policy?: string;
  /**
   * A network ask instead of a tool call: the head names the hosts, the body the command, and
   * with more than one host each has a checkbox (all checked); `tool`, `toolKey` and `input` are
   * not shown.
   */
  network?: NetworkAsk;
  /**
   * A command review ask instead of a tool call: the head is the question, the body the review's
   * reason and the held command (a write: its path); `input` is not shown. The offered `scopes`
   * decide the buttons — a classifier ask offers `once` only.
   */
  command?: CommandAsk;
  state: ApprovalState;
  /** `hosts`: a network ask's checked hosts (every host when it has one). */
  onApprove?(scope: ApprovalScope, hosts?: string[]): void;
  onDeny?(reason?: string): void;
  /** Start in the deny form with this reason (a restored draft). */
  defaultDeny?: { reason: string };
};

const valueText = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * Every input property as key / value text: the key arguments first (in their order, those present),
 * then the rest in input order; strings as they are, anything else as compact JSON.
 */
export function approvalArgs(
  input: Record<string, unknown>,
  keyArgs: readonly string[] = [],
): [string, string][] {
  const first = keyArgs.filter((k, i) => Object.hasOwn(input, k) && keyArgs.indexOf(k) === i);
  const rest = Object.keys(input).filter((k) => !first.includes(k));
  return [...first, ...rest].map((k) => [k, valueText(input[k])]);
}

const fullInput = (input: Record<string, unknown>): string => {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
};

const SCOPE_LABEL = {
  once: "hitl.approve",
  session: "hitl.approveSession",
  always: "hitl.approveAlways",
} as const;

/** An approval request (§6.16.11). */
export function ApprovalBlock(p: ApprovalBlockProps): JSX.Element {
  const t = useDesignT();
  const [denying, setDenying] = useState(p.defaultDeny !== undefined);
  const [reason, setReason] = useState(p.defaultDeny?.reason ?? "");
  const [showInput, setShowInput] = useState(false);
  const inputId = useId();
  const s = p.state;

  if (p.network) {
    return <NetworkApproval {...p} network={p.network} />;
  }

  if (p.command) {
    return <CommandApproval {...p} command={p.command} />;
  }

  if (s.kind === "decided") {
    const scope = s.scope ? t(`hitl.scope.${s.scope}`) : undefined;
    if (s.decision === "approved") {
      return (
        <div className="cb-tool-line" data-part="tool-line" data-decision="approved">
          <Icon name="check" size={12} />
          <span className="cb-tool-label">
            {fillCopy(t("hitl.approvedBy"), { who: s.who, tool: p.tool })}{" "}
            <span className="cb-faint" data-part="tool-key">
              {[p.toolKey, scope, s.when].filter(Boolean).join(" · ")}
            </span>
          </span>
        </div>
      );
    }
    const lead =
      s.decision === "denied"
        ? fillCopy(t("hitl.deniedBy"), { who: s.who, tool: p.tool })
        : fillCopy(
            t(
              s.decision === "expired"
                ? "hitl.expired"
                : s.decision === "skipped"
                  ? "hitl.skippedApproval"
                  : "hitl.cancelled",
            ),
            { tool: p.tool },
          );
    return (
      <div className="cb-tool-line" data-part="tool-line" data-decision={s.decision}>
        <Icon name="x" size={12} />
        <span className="cb-tool-label">
          {lead}{" "}
          <span className="cb-faint" data-part="tool-key">
            {p.toolKey}
          </span>
          {s.reason ? (
            <span className="cb-muted">
              {` · ${fillCopy(t("hitl.reasonQuote"), { reason: s.reason })}`}
            </span>
          ) : null}
          {s.when ? <span className="cb-faint">{` · ${s.when}`}</span> : null}
        </span>
      </div>
    );
  }

  const busy = s.busy === true;
  const args = approvalArgs(p.input, p.keyArgs);
  const title = t("hitl.approvalNeeded");
  let actions: ReactNode;
  if (denying) {
    const trimmed = reason.trim();
    actions = (
      <div className="cb-hcard-deny">
        <Input
          id={inputId}
          aria-label={t("hitl.denyReason")}
          placeholder={t("hitl.denyPlaceholder")}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              p.onDeny?.(trimmed === "" ? undefined : trimmed);
            }
          }}
        />
        <div className="cb-hcard-actions">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => p.onDeny?.(trimmed === "" ? undefined : trimmed)}
          >
            {t("hitl.deny")}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDenying(false)}>
            {t("hitl.cancel")}
          </Button>
          <span className="cb-hcard-note" data-part="card-note">
            {t("hitl.denyNote")}
          </span>
        </div>
      </div>
    );
  } else {
    actions = (
      <div
        className="cb-hcard-actions"
        data-hints={p.scopeHints && Object.keys(p.scopeHints).length > 0 ? "true" : undefined}
      >
        {p.scopes.map((scope, i) => (
          <ScopeChoice
            key={scope}
            primary={i === 0}
            disabled={busy}
            label={p.scopeLabels?.[scope] ?? t(SCOPE_LABEL[scope])}
            hint={p.scopeHints?.[scope]}
            onClick={() => p.onApprove?.(scope)}
          />
        ))}
        <Button disabled={busy} onClick={() => setDenying(true)}>
          {t("hitl.denyEllipsis")}
        </Button>
        {p.policy ? (
          <span className="cb-hcard-note" data-part="card-note">
            {p.policy}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div
      className="cb-hcard"
      data-part="approval-block"
      data-pending="true"
      role="group"
      aria-label={title}
    >
      <div className="cb-hcard-head">
        <span className="cb-hcard-dot" aria-hidden="true" />
        <strong className="cb-hcard-strong">{title}</strong>
        <span className="cb-muted cb-small">{p.tool}</span>
        <span className="cb-faint cb-small cb-hcard-key" data-part="tool-key">
          {p.toolKey}
        </span>
      </div>
      {p.summary ? (
        <div className="cb-small" data-part="summary">
          {p.summary}
        </div>
      ) : null}
      {args.length === 0 ? (
        <div className="cb-muted cb-small">{t("hitl.noArgs")}</div>
      ) : (
        <div className="cb-hcard-args">
          <div className="cb-kv cb-kv-capped" data-part="kv">
            {args.map(([k, v], i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: keys are unique; order is stable
              <span key={i} className="cb-kv-pair">
                <span className="cb-kv-key" data-part="kv-key">
                  {k}
                </span>
                <span className="cb-kv-value" data-part="kv-value" title={v}>
                  {v}
                </span>
              </span>
            ))}
          </div>
          <button
            type="button"
            className="cb-link-btn cb-small"
            aria-expanded={showInput}
            onClick={() => setShowInput((o) => !o)}
          >
            {t(showInput ? "hitl.hideInput" : "hitl.showInput")}
          </button>
          {showInput ? (
            <pre className="cb-hcard-json" data-part="full-input">
              {fullInput(p.input)}
            </pre>
          ) : null}
        </div>
      )}
      {actions}
    </div>
  );
}

/** One approve button; with a hint, the hint is a small line under it. */
function ScopeChoice({
  primary,
  disabled,
  label,
  hint,
  onClick,
}: {
  primary: boolean;
  disabled: boolean;
  label: string;
  hint: ReactNode | undefined;
  onClick(): void;
}) {
  const button = (
    <Button variant={primary ? "primary" : "default"} disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
  if (hint === undefined || hint === null || hint === "") return button;
  return (
    <span className="cb-hcard-choice" data-part="scope-choice">
      {button}
      <span className="cb-muted cb-small" data-part="scope-hint">
        {hint}
      </span>
    </span>
  );
}

/**
 * A fixed copy string with `{name}` placeholders filled with plain text and backtick pairs drawn
 * as inline code. The template is split first, so a value is never read as markup.
 */
export function richCopy(tpl: string, vars: Record<string, string | number> = {}): ReactNode[] {
  return tpl.split(/`([^`\n]+)`/).map((part, i) => {
    const text = fillCopy(part, vars);
    return i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
      <code key={i} className="cb-md-code" data-part="inline-code">
        {text}
      </code>
    ) : (
      text
    );
  });
}

/** The plain text of {@link richCopy} (an accessible name). */
const plainCopy = (tpl: string, vars: Record<string, string | number> = {}) =>
  fillCopy(tpl.replace(/`/g, ""), vars);

/** A command clipped for the card. */
export function clipCommand(command: string, max = NETWORK_COMMAND_MAX): string {
  const chars = Array.from(command);
  return chars.length <= max ? command : `${chars.slice(0, max - 1).join("")}…`;
}

/** One host: its registrable domain prominent, the full host in code style (spec §6.4). */
function HostName({ host }: { host: string }) {
  return (
    <span className="cb-net-host" data-part="network-host">
      <strong className="cb-hcard-strong" data-part="registrable">
        {registrableDomain(host)}
      </strong>
      <code className="cb-md-code" data-part="inline-code">
        {host}
      </code>
    </span>
  );
}

const NETWORK_DECIDED = {
  denied: "hitl.network.denied",
  expired: "hitl.network.expired",
  cancelled: "hitl.network.cancelled",
  skipped: "hitl.network.skipped",
} as const;

/** The network variant of {@link ApprovalBlock} (network ask spec §6.5). */
function NetworkApproval(p: ApprovalBlockProps & { network: NetworkAsk }): JSX.Element {
  const t = useDesignT();
  const hosts = p.network.hosts;
  const [checked, setChecked] = useState<string[]>(hosts);
  const [denying, setDenying] = useState(p.defaultDeny !== undefined);
  const [reason, setReason] = useState(p.defaultDeny?.reason ?? "");
  const inputId = useId();
  const s = p.state;

  if (s.kind === "decided") {
    const shown = s.hosts && s.hosts.length > 0 ? s.hosts : hosts;
    const d = s.decision;
    const approved = d === "approved";
    const word =
      d === "approved"
        ? t(s.scope === "always" ? "hitl.network.allowedAlways" : "hitl.network.allowedOnce")
        : t(NETWORK_DECIDED[d]);
    // who decided: an approval, a denial, a skip (the person who wrote); expiry and cancel name no one
    const who = s.decision === "expired" || s.decision === "cancelled" ? "" : s.who;
    return (
      <div
        className="cb-tool-line"
        data-part="tool-line"
        data-decision={s.decision}
        data-network="true"
      >
        <Icon name={approved ? "check" : "x"} size={12} />
        <span className="cb-tool-label">
          {word}{" "}
          <span className="cb-faint" data-part="tool-key">
            {[shown.join(", "), who].filter(Boolean).join(" · ")}
          </span>
          {s.fallback ? (
            <span className="cb-muted" data-part="network-fallback">
              {` · ${t(s.fallback === "offline" ? "hitl.network.fallbackOffline" : "hitl.network.fallbackRefused")}`}
            </span>
          ) : null}
          {s.reason ? (
            <span className="cb-muted">
              {` · ${fillCopy(t("hitl.reasonQuote"), { reason: s.reason })}`}
            </span>
          ) : null}
          {s.when ? <span className="cb-faint">{` · ${s.when}`}</span> : null}
        </span>
      </div>
    );
  }

  const busy = s.busy === true;
  const one = hosts.length === 1;
  const titleTpl = one ? t("hitl.network.titleOne") : t("hitl.network.titleMany");
  const vars = { host: hosts[0] ?? "", count: hosts.length };
  const description = p.network.description?.trim();
  const picked = one ? hosts : hosts.filter((h) => checked.includes(h));
  const none = picked.length === 0;
  const label = (scope: ApprovalScope) =>
    p.scopeLabels?.[scope] ??
    t(
      scope === "always"
        ? "hitl.network.always"
        : scope === "once"
          ? "hitl.network.once"
          : SCOPE_LABEL[scope],
    );
  const hint = (scope: ApprovalScope): ReactNode =>
    p.scopeHints?.[scope] ??
    (scope === "once"
      ? t("hitl.network.hintOnce")
      : scope === "always"
        ? richCopy(t("hitl.network.hintAlways"))
        : undefined);
  const remoteOff = !p.scopes.includes("always");

  let actions: ReactNode;
  if (denying) {
    const trimmed = reason.trim();
    actions = (
      <div className="cb-hcard-deny">
        <Input
          id={inputId}
          aria-label={t("hitl.denyReason")}
          placeholder={t("hitl.denyPlaceholder")}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              p.onDeny?.(trimmed === "" ? undefined : trimmed);
            }
          }}
        />
        <div className="cb-hcard-actions">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => p.onDeny?.(trimmed === "" ? undefined : trimmed)}
          >
            {t("hitl.deny")}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDenying(false)}>
            {t("hitl.cancel")}
          </Button>
          <span className="cb-hcard-note" data-part="card-note">
            {t("hitl.denyNote")}
          </span>
        </div>
      </div>
    );
  } else {
    actions = (
      <div className="cb-hcard-actions" data-hints="true">
        {p.scopes.map((scope, i) => (
          <ScopeChoice
            key={scope}
            primary={i === 0}
            disabled={busy || none}
            label={label(scope)}
            hint={hint(scope)}
            onClick={() => p.onApprove?.(scope, picked)}
          />
        ))}
        <Button disabled={busy} onClick={() => setDenying(true)}>
          {t("hitl.network.deny")}
        </Button>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div
      className="cb-hcard"
      data-part="approval-block"
      data-pending="true"
      data-network="true"
      role="group"
      aria-label={plainCopy(titleTpl, vars)}
    >
      <div className="cb-hcard-head">
        <span className="cb-hcard-dot" aria-hidden="true" />
        <strong className="cb-hcard-strong" data-part="network-title">
          {richCopy(titleTpl, vars)}
        </strong>
      </div>
      <div data-part="network-body">
        {description
          ? fillCopy(t("hitl.network.body"), { description })
          : t("hitl.network.bodyPlain")}
      </div>
      <pre className="cb-hcard-json" data-part="network-command">
        {clipCommand(p.network.command)}
      </pre>
      {one ? (
        <div className="cb-net-hosts">
          <HostName host={hosts[0] ?? ""} />
        </div>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
        <div className="cb-net-hosts" role="group" aria-label={t("hitl.network.hosts")}>
          {hosts.map((h) => (
            <Checkbox
              key={h}
              aria-label={h}
              checked={checked.includes(h)}
              disabled={busy}
              onChange={(on) =>
                setChecked((cur) =>
                  on ? hosts.filter((x) => x === h || cur.includes(x)) : cur.filter((x) => x !== h),
                )
              }
              label={<HostName host={h} />}
            />
          ))}
        </div>
      )}
      {actions}
      {remoteOff && !denying ? (
        <div className="cb-muted cb-small" data-part="network-remote-off">
          {richCopy(t("hitl.network.remoteOff"), { host: one ? (hosts[0] ?? "") : "<host>" })}
        </div>
      ) : null}
    </div>
  );
}

// ── Command review ──────────────────────────────────────────────────────────

/**
 * A command ask's decided line. `skipped` never happens for a command ask — a message never skips
 * one — and is drawn as cancelled rather than the generic 已跳过 so the card cannot claim it.
 */
const COMMAND_DECIDED = {
  denied: "hitl.command.denied",
  expired: "hitl.command.expired",
  cancelled: "hitl.command.cancelled",
  skipped: "hitl.command.cancelled",
} as const;

/** The command review variant of {@link ApprovalBlock} (auto mode spec §5.4). */
function CommandApproval(p: ApprovalBlockProps & { command: CommandAsk }): JSX.Element {
  const t = useDesignT();
  const [denying, setDenying] = useState(p.defaultDeny !== undefined);
  const [reason, setReason] = useState(p.defaultDeny?.reason ?? "");
  const inputId = useId();
  const s = p.state;
  const write = p.command.kind === "write";
  const title = write ? t("hitl.command.titleWrite") : t("hitl.command.title");

  if (s.kind === "decided") {
    const approved = s.decision === "approved";
    const word =
      s.decision === "approved"
        ? t(s.scope === "session" ? "hitl.command.allowedSession" : "hitl.command.allowedOnce")
        : t(COMMAND_DECIDED[s.decision]);
    // expiry and cancel name no one; a skip is drawn like a cancel (it never happens here)
    const who =
      s.decision === "expired" || s.decision === "cancelled" || s.decision === "skipped"
        ? ""
        : s.who;
    return (
      <div
        className="cb-tool-line"
        data-part="tool-line"
        data-decision={s.decision}
        data-command="true"
      >
        <Icon name={approved ? "check" : "x"} size={12} />
        <span className="cb-tool-label">
          {word}{" "}
          <span className="cb-faint" data-part="tool-key">
            {[p.toolKey, who].filter(Boolean).join(" · ")}
          </span>
          {s.reason ? (
            <span className="cb-muted">
              {` · ${fillCopy(t("hitl.reasonQuote"), { reason: s.reason })}`}
            </span>
          ) : null}
          {s.when ? <span className="cb-faint">{` · ${s.when}`}</span> : null}
        </span>
      </div>
    );
  }

  const busy = s.busy === true;
  // a write names its target path; the command text there is the tool key, which says nothing
  const shown = write ? (p.command.path ?? p.command.command) : p.command.command;
  const label = (scope: ApprovalScope) =>
    p.scopeLabels?.[scope] ??
    t(
      scope === "session"
        ? "hitl.command.allowSession"
        : scope === "once"
          ? "hitl.command.allowOnce"
          : SCOPE_LABEL[scope],
    );

  let actions: ReactNode;
  if (denying) {
    const trimmed = reason.trim();
    actions = (
      <div className="cb-hcard-deny">
        <Input
          id={inputId}
          aria-label={t("hitl.denyReason")}
          placeholder={t("hitl.denyPlaceholder")}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              p.onDeny?.(trimmed === "" ? undefined : trimmed);
            }
          }}
        />
        <div className="cb-hcard-actions">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => p.onDeny?.(trimmed === "" ? undefined : trimmed)}
          >
            {t("hitl.deny")}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDenying(false)}>
            {t("hitl.cancel")}
          </Button>
          <span className="cb-hcard-note" data-part="card-note">
            {t("hitl.denyNote")}
          </span>
        </div>
      </div>
    );
  } else {
    actions = (
      <div className="cb-hcard-actions">
        {p.scopes.map((scope, i) => (
          <ScopeChoice
            key={scope}
            primary={i === 0}
            disabled={busy}
            label={label(scope)}
            hint={p.scopeHints?.[scope]}
            onClick={() => p.onApprove?.(scope)}
          />
        ))}
        <Button disabled={busy} onClick={() => setDenying(true)}>
          {t("hitl.command.deny")}
        </Button>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div
      className="cb-hcard"
      data-part="approval-block"
      data-pending="true"
      data-command="true"
      role="group"
      aria-label={title}
    >
      <div className="cb-hcard-head">
        <span className="cb-hcard-dot" aria-hidden="true" />
        <strong className="cb-hcard-strong">{title}</strong>
        <span className="cb-muted cb-small">{p.tool}</span>
        <span className="cb-faint cb-small cb-hcard-key" data-part="tool-key">
          {p.toolKey}
        </span>
      </div>
      <div className="cb-small" data-part="command-reason">
        {p.command.reason}
      </div>
      <CodeBlock
        text={clipCommand(shown)}
        framed={false}
        {...(write ? { title: t("hitl.command.path") } : {})}
      />
      {actions}
    </div>
  );
}

// ── Network facts ───────────────────────────────────────────────────────────

/** A host refused by a layer no card can lift: the org's allowlist, or a private address. */
export type NetworkFact = { host: string; layer: "org" | "address" };

export type NetworkBlockedFactsProps = {
  hosts: NetworkFact[];
  /**
   * The org-layer action (phase 2: 「请管理员添加」 for a member, a settings link for an org admin);
   * none in phase 1.
   */
  action?: CalloutAction;
};

/**
 * What a command was refused that no one in the conversation can lift (network ask spec §6.5):
 * hosts outside the org's network allowlist, and private or local addresses. Text only, under the
 * command's row; device-layer hosts are the ask's, never listed here.
 */
export function NetworkBlockedFacts({
  hosts,
  action,
}: NetworkBlockedFactsProps): JSX.Element | null {
  const t = useDesignT();
  const org = hosts.filter((h) => h.layer === "org");
  const address = hosts.filter((h) => h.layer === "address");
  if (org.length === 0 && address.length === 0) return null;
  return (
    <div className="cb-net-facts" data-part="network-facts">
      {org.length > 0 ? (
        <Callout tone="info" {...(action ? { action } : {})}>
          {org.map((h) => (
            <span key={h.host} className="cb-net-fact" data-part="network-fact" data-layer="org">
              {richCopy(t("hitl.network.org"), { host: h.host })}
            </span>
          ))}
        </Callout>
      ) : null}
      {address.length > 0 ? (
        <Callout tone="info">
          {address.map((h) => (
            <span
              key={h.host}
              className="cb-net-fact"
              data-part="network-fact"
              data-layer="address"
            >
              {richCopy(t("hitl.network.address"), { host: h.host })}
            </span>
          ))}
        </Callout>
      ) : null}
    </div>
  );
}

// ── Question ────────────────────────────────────────────────────────────────

/** One field of a question form, already localized (the web maps its `InputForm` fields). */
export type QuestionField = {
  key: string;
  label: string;
  description?: string;
  kind: "enum" | "multi" | "string" | "number" | "boolean";
  /** The choices of `enum` / `multi` fields (the schema enum). */
  options?: string[];
  allowOther?: boolean;
  required?: boolean;
  /** `number`: whole numbers only. */
  integer?: boolean;
  min?: number;
  max?: number;
  /** `string`: the longest answer. */
  maxLength?: number;
};

export type QuestionAnswer = Record<string, string | number | boolean | string[]>;

export type QuestionState =
  | { kind: "pending"; busy?: boolean }
  | { kind: "answered"; pairs: [string, string][]; who?: string }
  /** The run's starter sent a message instead of answering. */
  | { kind: "skipped"; who?: string }
  /** The run ended (stopped, failed) before an answer. */
  | { kind: "cancelled" }
  | { kind: "expired" };

export type QuestionBlockProps = {
  /** The question (the form title). */
  title: string;
  /** URL mode: a page the person opens in their browser (http(s) only; anything else is hidden). */
  url?: string;
  fields: QuestionField[];
  state: QuestionState;
  onAnswer?(answer: QuestionAnswer): void;
  onSkip?(): void;
  /** Initial values (a restored draft); an `enum` value outside its options fills Other. */
  defaultDraft?: QuestionAnswer;
};

type Draft = {
  values: Record<string, string | boolean | string[] | undefined>;
  other: Record<string, string>;
  /** `enum` fields whose Other row is picked. */
  otherPicked: Record<string, boolean>;
};

/** Only absolute http(s) addresses; `javascript:` and the rest are never linked. */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function buildAnswer(
  fields: QuestionField[],
  d: Draft,
): { answer: QuestionAnswer; missing: string[] } {
  const answer: QuestionAnswer = {};
  const missing: string[] = [];
  for (const f of fields) {
    const v = d.values[f.key];
    const other = (d.other[f.key] ?? "").trim();
    let out: QuestionAnswer[string] | undefined;
    switch (f.kind) {
      case "enum":
        out = d.otherPicked[f.key] ? other || undefined : typeof v === "string" ? v : undefined;
        break;
      case "multi": {
        const picked = Array.isArray(v) ? [...v] : [];
        if (d.otherPicked[f.key] && other !== "") picked.push(other);
        out = picked.length > 0 ? picked : undefined;
        break;
      }
      case "boolean":
        out = v === true;
        break;
      case "number": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
        out = Number.isFinite(n) ? n : undefined;
        break;
      }
      default:
        out = typeof v === "string" && v.trim() !== "" ? v : undefined;
    }
    if (out === undefined) {
      if (f.required) missing.push(f.key);
    } else {
      answer[f.key] = out;
    }
  }
  return { answer, missing };
}

function initialDraft(fields: QuestionField[], given: QuestionAnswer = {}): Draft {
  const d: Draft = { values: {}, other: {}, otherPicked: {} };
  for (const f of fields) {
    const v = given[f.key];
    switch (f.kind) {
      case "boolean":
        d.values[f.key] = v === true;
        break;
      case "multi": {
        const list = Array.isArray(v) ? v : [];
        const known = list.filter((x) => f.options?.includes(x));
        const extra = list.filter((x) => !f.options?.includes(x));
        d.values[f.key] = known;
        if (extra.length > 0 && f.allowOther) {
          d.otherPicked[f.key] = true;
          d.other[f.key] = extra.join(", ");
        }
        break;
      }
      case "enum":
        if (typeof v === "string" && f.options?.includes(v)) d.values[f.key] = v;
        else if (typeof v === "string" && f.allowOther) {
          d.otherPicked[f.key] = true;
          d.other[f.key] = v;
        }
        break;
      default:
        if (v !== undefined && !Array.isArray(v)) d.values[f.key] = String(v);
    }
  }
  return d;
}

/** One option row: a radio or checkbox drawn as a bordered row (§6.16.12). */
function OptionRow({
  role,
  checked,
  label,
  disabled,
  tabIndex,
  onPick,
  onKeyDown,
  rowRef,
  inner,
  children,
}: {
  /** The choice inside the Other row (the row itself is a plain wrapper, m12). */
  inner?: boolean;
  role: "radio" | "checkbox";
  checked: boolean;
  label: string;
  disabled: boolean;
  tabIndex: number;
  onPick(): void;
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  rowRef?(el: HTMLDivElement | null): void;
  children?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is "radio" or "checkbox", both take aria-checked
    // biome-ignore lint/a11y/noStaticElementInteractions: the row is a radio or checkbox (role above)
    <div
      ref={rowRef}
      role={role}
      aria-checked={checked}
      aria-label={children ? label : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : tabIndex}
      className={inner ? "cb-q-other-choice" : "cb-q-option"}
      data-part="option"
      data-role={role}
      onClick={() => {
        if (!disabled) onPick();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || disabled) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onPick();
          return;
        }
        onKeyDown?.(e);
      }}
    >
      <span className="cb-q-mark" aria-hidden="true">
        {role === "checkbox" && checked ? <Icon name="check" size={12} /> : null}
      </span>
      {children ?? label}
    </div>
  );
}

function ChoiceField({
  field,
  draft,
  set,
  disabled,
}: {
  field: QuestionField;
  draft: Draft;
  set(next: Draft): void;
  disabled: boolean;
}) {
  const t = useDesignT();
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const multi = field.kind === "multi";
  const options = field.options ?? [];
  const v = draft.values[field.key];
  const otherPicked = draft.otherPicked[field.key] === true;
  const isChecked = (o: string) =>
    multi ? Array.isArray(v) && v.includes(o) : !otherPicked && v === o;
  const pick = (o: string) => {
    if (multi) {
      const cur = Array.isArray(v) ? v : [];
      const next = cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o];
      set({ ...draft, values: { ...draft.values, [field.key]: next } });
    } else {
      set({
        ...draft,
        values: { ...draft.values, [field.key]: o },
        otherPicked: { ...draft.otherPicked, [field.key]: false },
      });
    }
  };
  const pickOther = (on?: boolean) =>
    set({
      ...draft,
      otherPicked: { ...draft.otherPicked, [field.key]: on ?? (multi ? !otherPicked : true) },
    });
  const count = options.length + (field.allowOther ? 1 : 0);
  // Radios: one tab stop (the checked row, else the first); arrows move and pick.
  const checkedIndex = otherPicked ? options.length : options.findIndex((o) => isChecked(o));
  const stop = checkedIndex >= 0 ? checkedIndex : 0;
  const arrows = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (multi) return;
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const j = (i + step + count) % count;
    if (j < options.length) pick(options[j] as string);
    else pickOther(true);
    rows.current[j]?.focus();
  };
  const role = multi ? "checkbox" : "radio";
  const rowsEl = (
    <>
      {options.map((o, i) => (
        <OptionRow
          key={o}
          rowRef={(el) => {
            rows.current[i] = el;
          }}
          role={role}
          checked={isChecked(o)}
          label={o}
          disabled={disabled}
          tabIndex={multi || i === stop ? 0 : -1}
          onPick={() => pick(o)}
          onKeyDown={arrows(i)}
        />
      ))}
      {field.allowOther ? (
        // The Other row: a radio (or checkbox) and its text box side by side, the box outside the
        // radio, whose children are presentational (m12). Clicking the row's padding picks Other;
        // keys go to the radio.
        // biome-ignore lint/a11y/noStaticElementInteractions: a pointer convenience; the radio inside takes the keys
        // biome-ignore lint/a11y/useKeyWithClickEvents: as above
        <div
          className="cb-q-option"
          data-part="option-other"
          data-role={role}
          data-checked={otherPicked ? "true" : undefined}
          data-disabled={disabled ? "true" : undefined}
          onClick={(e) => {
            if (e.target === e.currentTarget && !disabled) pickOther();
          }}
        >
          <OptionRow
            inner
            rowRef={(el) => {
              rows.current[options.length] = el;
            }}
            role={role}
            checked={otherPicked}
            label={t("hitl.other")}
            disabled={disabled}
            tabIndex={multi || stop === options.length ? 0 : -1}
            onPick={() => pickOther()}
            onKeyDown={arrows(options.length)}
          >
            <span className="cb-q-other-label">{t("hitl.otherLabel")}</span>
          </OptionRow>
          <input
            className="cb-q-other-input"
            aria-label={t("hitl.other")}
            placeholder={t("hitl.otherPlaceholder")}
            value={draft.other[field.key] ?? ""}
            disabled={disabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              set({
                ...draft,
                other: { ...draft.other, [field.key]: e.target.value },
                otherPicked: {
                  ...draft.otherPicked,
                  [field.key]: e.target.value !== "" || (multi ? otherPicked : true),
                },
              })
            }
          />
        </div>
      ) : null}
    </>
  );
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is "group" or "radiogroup", both take a label
    <div className="cb-q-options" role={multi ? "group" : "radiogroup"} aria-label={field.label}>
      {rowsEl}
    </div>
  );
}

/** A question (§6.16.12): `AskUserQuestion` or a connector's elicitation. */
export function QuestionBlock(p: QuestionBlockProps): JSX.Element {
  const t = useDesignT();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(p.fields, p.defaultDraft));
  const [missing, setMissing] = useState<string[]>([]);
  const [opened, setOpened] = useState(false);
  const s = p.state;

  if (s.kind !== "pending") {
    const by = s.kind === "answered" || s.kind === "skipped" ? s.who : undefined;
    const who = by ? <span className="cb-faint">{` · ${by}`}</span> : null;
    let answer: ReactNode;
    if (s.kind === "answered") {
      const single = s.pairs.length === 1;
      answer = s.pairs.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pairs keep their order
        <div key={i} className="cb-tool-line" data-part="tool-line">
          <Icon name="corner-down-right" size={12} />
          <span className="cb-tool-label">
            <span className="cb-ink">
              {single ? v : fillCopy(t("hitl.pair"), { key: k, value: v })}
            </span>
            {i === s.pairs.length - 1 ? who : null}
          </span>
        </div>
      ));
    } else {
      answer = (
        <div className="cb-tool-line" data-part="tool-line">
          <Icon name="corner-down-right" size={12} />
          <span className="cb-tool-label">
            {t(
              s.kind === "skipped"
                ? "hitl.skipped"
                : s.kind === "cancelled"
                  ? "hitl.cancelledQuestion"
                  : "hitl.expiredQuestion",
            )}
            {who}
          </span>
        </div>
      );
    }
    return (
      <div className="cb-qa" data-part="question-done" data-state={s.kind}>
        <div className="cb-tool-line" data-part="tool-line">
          <span className="cb-tool-label">{p.title}</span>
        </div>
        {answer}
      </div>
    );
  }

  const busy = s.busy === true;
  const link = safeHttpUrl(p.url);
  const single = p.fields.length === 1;
  const submit = () => {
    const built = buildAnswer(p.fields, draft);
    setMissing(built.missing);
    if (built.missing.length > 0) return;
    p.onAnswer?.(built.answer);
  };
  const fields = p.fields.map((f) => {
    const label = single && (f.kind === "enum" || f.kind === "multi") ? null : f.label;
    const err = missing.includes(f.key);
    let control: ReactNode;
    switch (f.kind) {
      case "enum":
      case "multi":
        control = <ChoiceField field={f} draft={draft} set={setDraft} disabled={busy} />;
        break;
      case "boolean":
        control = (
          <Switch
            label={f.label}
            checked={draft.values[f.key] === true}
            disabled={busy}
            onChange={(on) => setDraft({ ...draft, values: { ...draft.values, [f.key]: on } })}
          />
        );
        break;
      default: {
        const raw = draft.values[f.key];
        control = (
          <Input
            aria-label={f.label}
            type={f.kind === "number" ? "number" : "text"}
            {...(f.kind === "number"
              ? { min: f.min, max: f.max, step: f.integer ? 1 : "any" }
              : { maxLength: f.maxLength })}
            value={typeof raw === "string" ? raw : ""}
            invalid={err}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, values: { ...draft.values, [f.key]: e.target.value } })
            }
          />
        );
      }
    }
    return (
      <div key={f.key} className="cb-q-field" data-field={f.key}>
        {label !== null && f.kind !== "boolean" ? (
          <span className="cb-q-label">{label}</span>
        ) : null}
        {f.description ? <span className="cb-muted cb-small">{f.description}</span> : null}
        {control}
        {err ? (
          <span className="cb-q-error" role="alert">
            {t("hitl.required")}
          </span>
        ) : null}
      </div>
    );
  });
  const hasFields = p.fields.length > 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div className="cb-hcard" data-part="question-block" role="group" aria-label={p.title}>
      <div className="cb-hcard-title" data-part="question-title">
        {p.title}
      </div>
      {link ? (
        <a
          className="cb-q-url"
          data-part="question-url"
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpened(true)}
        >
          <Icon name="external-link" size={14} />
          <span>{link}</span>
        </a>
      ) : null}
      {fields}
      <div className="cb-hcard-actions">
        {link ? (
          <a
            className="cb-btn"
            data-part="button"
            data-variant={opened && !hasFields ? "default" : "primary"}
            data-density="default"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpened(true)}
          >
            <span className="cb-btn-body">
              <Icon name="external-link" size={14} />
              {t("hitl.openLink")}
            </span>
          </a>
        ) : null}
        {hasFields ? (
          <Button variant={link ? "default" : "primary"} disabled={busy} onClick={submit}>
            {t("hitl.answer")}
          </Button>
        ) : link && opened ? (
          // URL mode: once the page was opened, the person says they are done.
          <Button variant="primary" disabled={busy} onClick={() => p.onAnswer?.({})}>
            {t("hitl.done")}
          </Button>
        ) : null}
        {p.onSkip ? (
          <Button disabled={busy} onClick={p.onSkip}>
            {t("hitl.skip")}
          </Button>
        ) : null}
        {link ? (
          <span className="cb-hcard-note" data-part="card-note">
            {t("hitl.urlNote")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── Connect ─────────────────────────────────────────────────────────────────

export type ConnectBlockProps = {
  /** The service ("Acme 文档"); its first letter is drawn as the initial. */
  service: string;
  /** Which service and why ("连接 Acme 文档 后才能读取这个文件"). */
  reason: string;
  /** The line under the reason; defaults to "Only affects you". */
  note?: string;
  /** Set once connected: the block collapses to one line. */
  closed?: { who: string; when: string };
  busy?: boolean;
  onConnect?(): void;
};

/** A connect request (§6.16.13): the person authorizes a service for themselves. */
export function ConnectBlock(p: ConnectBlockProps): JSX.Element {
  const t = useDesignT();
  if (p.closed) {
    return (
      <div className="cb-tool-line" data-part="tool-line">
        <Icon name="connector" size={12} />
        <span className="cb-tool-label">
          {fillCopy(t("hitl.connected"), { who: p.closed.who, service: p.service })}
          <span className="cb-faint">{` · ${p.closed.when}`}</span>
        </span>
      </div>
    );
  }
  const initial = initialOf(p.service.trim()) || "?";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
    <div
      className="cb-hcard cb-hcard-row"
      data-part="connect-block"
      role="group"
      aria-label={p.reason}
    >
      <span className="cb-connect-initial" data-part="connect-initial" aria-hidden="true">
        {initial}
      </span>
      <div className="cb-hcard-text">
        <div>{p.reason}</div>
        <div className="cb-muted cb-small">{p.note ?? t("hitl.onlyYou")}</div>
      </div>
      <Button variant="primary" disabled={p.busy} onClick={p.onConnect}>
        {t("hitl.connect")}
      </Button>
    </div>
  );
}
