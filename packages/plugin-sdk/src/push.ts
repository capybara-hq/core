/** Push provider extension point ref (`push-provider@1`): delivers push notifications to mobile apps. */
export const PUSH_PROVIDER_EXTENSION_POINT = "push-provider@1";

/** Limits the kernel enforces on push registrations and messages. */
export const PUSH_LIMITS = {
  titleChars: 100,
  bodyChars: 240,
  pathChars: 512,
  tokenChars: 4096,
  appIdChars: 255,
  deviceNameChars: 64,
  sendTimeoutMs: 15_000,
  registrationsPerAccount: 20,
} as const;

export type PushPlatform = "ios" | "android";

export interface PushMessage {
  title: string;
  body: string;
  /** In-app path opened on tap; starts with `/`. */
  path: string;
  threadId: string;
  badge?: number;
  /** The deployment origin (scheme://host[:port]); the shell matches it to a profile. */
  origin: string;
}

/** One device registration a message is sent to. */
export interface PushTarget {
  id: string;
  platform: PushPlatform;
  appId: string;
  token: string;
}

export type PushErrorKind = "auth" | "rate_limited" | "transient";

/** Thrown by a provider; applies to every registration of the call. */
export class PushError extends Error {
  readonly kind: PushErrorKind;
  readonly retryAfterMs?: number;
  constructor(message: string, opts: { kind: PushErrorKind; retryAfterMs?: number }) {
    super(message);
    this.name = "PushError";
    this.kind = opts.kind;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export type PushResult =
  | { registrationId: string; status: "delivered" }
  | { registrationId: string; status: "unregistered" }
  | {
      registrationId: string;
      status: "failed";
      kind: PushErrorKind;
      message: string;
      retryAfterMs?: number;
    };

/** No retries inside; a thrown PushError applies to every registration of the call, any other throw is transient. */
export interface PushProvider {
  /** App ids (bundle / application ids) the configured credentials cover; synchronous, from config. */
  apps(): readonly string[];
  send(args: {
    registrations: readonly PushTarget[];
    message: PushMessage;
    signal: AbortSignal;
  }): Promise<PushResult[]>;
}

const KINDS: readonly string[] = ["auth", "rate_limited", "transient"];

/** null when `results` answers every registration exactly once, else the problem (no token in it). */
export function checkPushResults(
  registrations: readonly PushTarget[],
  results: unknown,
): string | null {
  if (!Array.isArray(results)) return "push provider returned a non-array result";
  const known = new Set(registrations.map((r) => r.id));
  const seen = new Set<string>();
  for (const r of results as unknown[]) {
    if (typeof r !== "object" || r === null) return "push provider returned a non-object result";
    const o = r as Record<string, unknown>;
    const id = o.registrationId;
    if (typeof id !== "string" || !known.has(id)) {
      return "push provider answered an unknown registration id";
    }
    if (seen.has(id)) return `push provider answered registration ${id} more than once`;
    seen.add(id);
    if (o.status === "failed") {
      if (typeof o.kind !== "string" || !KINDS.includes(o.kind)) {
        return `push provider returned a failed result without a known kind for ${id}`;
      }
    } else if (o.status !== "delivered" && o.status !== "unregistered") {
      return `push provider returned an unknown status for ${id}`;
    }
  }
  if (seen.size !== known.size) return "push provider left a registration unanswered";
  return null;
}

/** null when the message is within PUSH_LIMITS and well formed, else the problem. */
export function validatePushMessage(m: PushMessage): string | null {
  if (m.title.length > PUSH_LIMITS.titleChars) {
    return `title exceeds ${PUSH_LIMITS.titleChars} characters`;
  }
  if (m.body.length > PUSH_LIMITS.bodyChars) {
    return `body exceeds ${PUSH_LIMITS.bodyChars} characters`;
  }
  if (!m.path.startsWith("/") || m.path.length > PUSH_LIMITS.pathChars) {
    return `path must start with "/" and be at most ${PUSH_LIMITS.pathChars} characters`;
  }
  let url: URL;
  try {
    url = new URL(m.origin);
  } catch {
    return "origin must be scheme://host[:port]";
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.origin !== m.origin ||
    m.origin.endsWith("/")
  ) {
    return "origin must be scheme://host[:port] with no path";
  }
  return null;
}
