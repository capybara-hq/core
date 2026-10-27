import { type JSX, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../controls/button";
import { Input } from "../controls/inputs";
import { Switch } from "../controls/toggles";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

// Human-in-the-loop blocks (spec §6.16.11–§6.16.13): the pending approval (the only accent card),
// questions (ask_user and connector elicitation) and connect requests, and their one-line forms
// once handled.

// ── Approval ────────────────────────────────────────────────────────────────

export type ApprovalScope = "once" | "session" | "always";

export type ApprovalState =
  | { kind: "pending"; busy?: boolean }
  | {
      kind: "decided";
      decision: "approved" | "denied" | "expired" | "cancelled";
      who: string;
      when: string;
      scope?: ApprovalScope;
      reason?: string;
    };

export type ApprovalBlockProps = {
  /** The tool as people read it: "<connector>: <title>", or the source and localized name. */
  tool: string;
  /** The model-visible tool key, always shown: a title is unreviewed display text. */
  toolKey: string;
  /** The whole tool input. Every property is shown. */
  input: Record<string, unknown>;
  /** The tool's key arguments: shown first, in this order. */
  keyArgs?: string[];
  /** The scopes the request allows; one approve button each. */
  scopes: ApprovalScope[];
  /** The rule that asked (shown on the right of the actions). */
  policy?: string;
  state: ApprovalState;
  onApprove?(scope: ApprovalScope): void;
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
        : fillCopy(t(s.decision === "expired" ? "hitl.expired" : "hitl.cancelled"), {
            tool: p.tool,
          });
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
      <div className="cb-hcard-actions">
        {p.scopes.map((scope, i) => (
          <Button
            key={scope}
            variant={i === 0 ? "primary" : "default"}
            disabled={busy}
            onClick={() => p.onApprove?.(scope)}
          >
            {t(SCOPE_LABEL[scope])}
          </Button>
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
  | { kind: "skipped"; who?: string }
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
  children,
}: {
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
      className="cb-q-option"
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
        <OptionRow
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
        </OptionRow>
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

/** A question (§6.16.12): `ask_user` or a connector's elicitation. */
export function QuestionBlock(p: QuestionBlockProps): JSX.Element {
  const t = useDesignT();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(p.fields, p.defaultDraft));
  const [missing, setMissing] = useState<string[]>([]);
  const [opened, setOpened] = useState(false);
  const s = p.state;

  if (s.kind !== "pending") {
    const who =
      s.kind !== "expired" && s.who ? <span className="cb-faint">{` · ${s.who}`}</span> : null;
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
            {t(s.kind === "skipped" ? "hitl.skipped" : "hitl.expiredQuestion")}
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
  const initial = [...p.service.trim()][0]?.toUpperCase() ?? "?";
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
