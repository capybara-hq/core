/**
 * Setup checks (spec `2026-11-09-setup-guides-v2-design.md` §10): a check answers one question
 * about one target ("does this bot token work?") for a `::check` line of a setup guide. An
 * extension registers its checks in `setup` with `ctx.setup.check(id, def)`; each id must be
 * listed in `permissions.setupChecks`. The kernel runs a check only when a person or an agent asks
 * (never in the background), caches, single-flights and rate-limits it, and redacts the result.
 *
 * Contract rules (backed by review and kernel redaction, not by isolation: extensions are fully
 * trusted):
 * - A check never writes, at the third party or in Capybara, and stays cheap (one or two reads).
 * - Pass `signal` to every request; the kernel aborts it at {@link SETUP_CHECK_LIMITS}.timeoutMs.
 * - No retries inside the check: the person retries, retry policy is the kernel's.
 * - Never put a secret in `reason` or `fix`. The kernel replaces known secret values with
 *   `[REDACTED]` before caching or returning, but it can only redact what it knows.
 *
 * What a check receives is what the extension already receives for the same target, nothing more:
 * a channel connection's config (as `channel@1` `verify` and `connect` get it), or a connector's
 * ids and OAuth client id. A check never gets the OAuth client secret or a member's token; those
 * stay with the kernel and the connector extension's `auth()` (decided 2026-11-09).
 */
import type { SetupGuidePlace } from "./setup-guide.js";

/**
 * `ok`: verified now. `failing`: verified wrong (needs a reason; should have a fix). `unknown`:
 * could not tell (third party down, rate limited, the check does not apply yet); never a failure
 * the person must act on.
 */
export type SetupCheckStatus = "ok" | "failing" | "unknown";

/** Plain text in English (required) and optionally Chinese; rendered as text, never Markdown. */
export interface SetupCheckText {
  readonly en: string;
  readonly zh?: string;
}

/**
 * The answer of a check. There is deliberately no structured details field: a result has nowhere
 * for a token to hide. {@link validateSetupCheckResult} refuses any other key.
 */
export interface SetupCheckResult {
  readonly status: SetupCheckStatus;
  /** Why, in a sentence. At most `reasonChars` per language. Required when `failing`. */
  readonly reason?: SetupCheckText;
  /** What to do when failing. At most `fixChars` per language. */
  readonly fix?: SetupCheckText;
}

/**
 * What a check is about. The kernel builds it field by field; it only ever names targets of the
 * check's own plugin (a channel connection on the plugin, a connector made from one of its
 * templates).
 */
export type SetupCheckTarget =
  | {
      readonly kind: "channel-connection";
      readonly connectionId: string;
      /** The connection config as `channel@1` `verify` and `connect` receive it, secrets included. */
      readonly config: unknown;
    }
  | {
      readonly kind: "connector";
      readonly connectorId: string;
      readonly templateId: string;
      /** The OAuth client id when the template uses a manual client; never the client secret. */
      readonly clientId: string | null;
      /** The viewing member's account, for member-audience checks; never their token. */
      readonly accountId: string | null;
    };

/** What `run` receives. */
export interface SetupCheckArgs {
  readonly orgId: string;
  /** The extension's effective config for the org (platform config plus the org's copy). */
  readonly config: unknown;
  readonly locale: "en" | "zh";
  /** The guide's mode (`long_connection`, `webhook`), or null when the place has none. */
  readonly mode: string | null;
  readonly target: SetupCheckTarget;
  /** Aborted at the kernel's timeout or when the extension is disposed. Pass it to every request. */
  readonly signal: AbortSignal;
}

/** A check registered with `ctx.setup.check`. */
export interface SetupCheckDefinition {
  /** The place whose guides may use the check; the kernel runs it only for targets of that place. */
  place: SetupGuidePlace;
  /** Never writes, passes `signal` on, does not retry, never puts a secret in the result. */
  run(args: SetupCheckArgs): Promise<SetupCheckResult>;
}

/**
 * A check id an extension declares and registers. Ids with `:` belong to the kernel
 * (`capybara:*`), so an extension cannot shadow a kernel check.
 */
export const SETUP_CHECK_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Limits of setup checks (spec §10.5). Characters are UTF-16 code units. */
export const SETUP_CHECK_LIMITS = Object.freeze({
  /** Per run; the kernel aborts `signal` and records `unknown`. */
  timeoutMs: 10_000,
  /** Characters of `reason`, per language. */
  reasonChars: 300,
  /** Characters of `fix`, per language. */
  fixChars: 500,
  /** A cached result stays fresh this long (and for the same input fingerprint). */
  freshMs: 300_000,
  /** A forced rerun of one check and target at most this often. */
  cooldownMs: 10_000,
  /** Concurrent runs per org across all replicas. */
  orgConcurrency: 8,
  /** Run requests per account per minute. */
  perAccountPerMinute: 30,
  /** Ids in `permissions.setupChecks`. */
  idsPerExtension: 32,
} as const);

const STATUSES: readonly unknown[] = ["ok", "failing", "unknown"];
const RESULT_KEYS: ReadonlySet<PropertyKey> = new Set(["status", "reason", "fix"]);
const TEXT_KEYS: ReadonlySet<PropertyKey> = new Set(["en", "zh"]);
// C0 controls except tab, LF, CR; DEL; C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

type Problem = { problem: string };

/**
 * Copies the own data properties of a plain object, or explains why it is not one. Accessors,
 * symbol keys, non-enumerable keys and keys outside `allowed` are refused, so nothing runs while
 * reading and nothing unlisted survives.
 */
function plainCopy(
  label: string,
  x: unknown,
  allowed: ReadonlySet<PropertyKey>,
): Record<string, unknown> | Problem {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    return { problem: `${label} must be an object` };
  }
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) {
    return { problem: `${label} must be a plain object` };
  }
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(x)) {
    if (!allowed.has(key)) {
      return { problem: `${label} has unknown key "${String(key)}"` };
    }
    const d = Object.getOwnPropertyDescriptor(x, key);
    if (!d || !("value" in d) || !d.enumerable) {
      return { problem: `${label}.${String(key)} must be a plain data property` };
    }
    out[key as string] = d.value;
  }
  return out;
}

function text(label: string, x: unknown, max: number): SetupCheckText | Problem {
  const o = plainCopy(label, x, TEXT_KEYS);
  if ("problem" in o) return o as Problem;
  const out: { en: string; zh?: string } = { en: "" };
  for (const lang of ["en", "zh"] as const) {
    const v = o[lang];
    if (v === undefined && lang === "zh") continue;
    if (typeof v !== "string" || v === "") {
      return { problem: `${label}.${lang} must be a non-empty string` };
    }
    if (v.length > max) {
      return { problem: `${label}.${lang} is longer than ${max} characters` };
    }
    if (CONTROL_RE.test(v)) {
      return { problem: `${label}.${lang} contains control characters` };
    }
    out[lang] = v;
  }
  return out;
}

/**
 * The result as a fresh plain object holding only `status`, `reason` and `fix`, or why it is
 * invalid (English). The kernel treats an invalid result as `unknown` and logs the problem. Run
 * kernel redaction on the returned copy, then validate again (redaction can change the length).
 */
export function validateSetupCheckResult(x: unknown): SetupCheckResult | Problem {
  const o = plainCopy("result", x, RESULT_KEYS);
  if ("problem" in o) return o as Problem;
  if (!STATUSES.includes(o.status)) {
    return { problem: `result.status must be one of ${STATUSES.join(", ")}` };
  }
  const out: { status: SetupCheckStatus; reason?: SetupCheckText; fix?: SetupCheckText } = {
    status: o.status as SetupCheckStatus,
  };
  if (o.reason !== undefined) {
    const r = text("result.reason", o.reason, SETUP_CHECK_LIMITS.reasonChars);
    if ("problem" in r) return r;
    out.reason = r;
  }
  if (o.fix !== undefined) {
    const f = text("result.fix", o.fix, SETUP_CHECK_LIMITS.fixChars);
    if ("problem" in f) return f;
    out.fix = f;
  }
  if (out.status === "failing" && !out.reason) {
    return { problem: "result.reason is required when status is failing" };
  }
  return out;
}
