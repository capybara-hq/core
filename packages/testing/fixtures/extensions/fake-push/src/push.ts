import {
  PushError,
  type PushMessage,
  type PushProvider,
  type PushResult,
  type PushTarget,
} from "@capybara-hq/plugin-sdk";

/** One send attempt as the probe records it. */
export interface FakePushSend {
  registrationId: string;
  token: string;
  message: PushMessage;
}

/** The probe tests read: every send attempt of this process (extension instances share it). */
export function fakePushProbe(): { sends: FakePushSend[] } {
  const g = globalThis as { __fakePush?: { sends: FakePushSend[] } };
  g.__fakePush ??= { sends: [] };
  return g.__fakePush;
}

/** Rejects with the signal's reason once it aborts. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const failed = (
  registrationId: string,
  kind: "auth" | "rate_limited" | "transient",
  message: string,
  retryAfterMs?: number,
): PushResult => ({
  registrationId,
  status: "failed",
  kind,
  message,
  ...(retryAfterMs !== undefined && { retryAfterMs }),
});

export interface FakePushOptions {
  /** The app ids `apps()` lists (default `["com.example.app"]`). */
  apps?: readonly string[];
  /** Called once per registration per `send` (the extension writes `plugin_fake_push.sends`). */
  onSend?: (send: FakePushSend) => Promise<void> | void;
  /** The probe to record on (default: the process probe). */
  probe?: { sends: FakePushSend[] };
}

/**
 * The scripted provider, by token prefix: `dead:` unregistered; `auth:` failed auth; `rate:`
 * failed rate_limited (`retryAfterMs` 1000); `flaky:<n>:` transient for the first n calls of that
 * token, then delivered; `throw:` a plain Error; `net:` a thrown transient PushError; `hang:` waits for the signal; anything else
 * delivered. Result messages never contain the token. Usable without a kernel.
 */
export function makeFakePush(opts: FakePushOptions = {}): {
  provider: PushProvider;
  sends: FakePushSend[];
} {
  const apps = Object.freeze([...(opts.apps ?? ["com.example.app"])]);
  const probe = opts.probe ?? { sends: [] };
  const flakyCalls = new Map<string, number>();

  async function one(
    r: PushTarget,
    message: PushMessage,
    signal: AbortSignal,
  ): Promise<PushResult> {
    const send: FakePushSend = { registrationId: r.id, token: r.token, message };
    probe.sends.push(send);
    await opts.onSend?.(send);
    const t = r.token;
    if (t.startsWith("dead:")) return { registrationId: r.id, status: "unregistered" };
    if (t.startsWith("auth:")) return failed(r.id, "auth", "fake-push: credentials rejected");
    if (t.startsWith("rate:")) {
      return failed(r.id, "rate_limited", "fake-push: rate limited", 1000);
    }
    const flaky = /^flaky:(\d+):/.exec(t);
    if (flaky) {
      const n = Number(flaky[1]);
      const seen = flakyCalls.get(t) ?? 0;
      flakyCalls.set(t, seen + 1);
      if (seen < n) return failed(r.id, "transient", "fake-push: temporary failure");
    }
    if (t.startsWith("throw:")) throw new Error("fake-push: scripted failure");
    if (t.startsWith("net:")) {
      throw new PushError("fake-push: network error", { kind: "transient" });
    }
    if (t.startsWith("hang:")) await hang(signal);
    return { registrationId: r.id, status: "delivered" };
  }

  const provider: PushProvider = {
    apps: () => apps,
    send: ({ registrations, message, signal }) =>
      Promise.all(registrations.map((r) => one(r, message, signal))),
  };
  return { provider, sends: probe.sends };
}
