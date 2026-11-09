import type { SetupCheckArgs, SetupCheckDefinition } from "@capybara-hq/plugin-sdk";
import { FakeImConnection } from "./channel.js";

/**
 * The setup checks of `fake-im` (setup guides v2 §10), one per behavior the kernel's runner must
 * handle. Each is registered in `index.ts` with a literal id (the `perm-setup-check` rule):
 *
 * - `pass` / `fail`: ok, and failing with a reason and a fix (no third-party call);
 * - `proxy`: one `POST <platformUrl>/checks` per run (counted by `FakeChannelServer.checks`, held
 *   by `holdChecks`), then ok: what a real check's third-party call looks like;
 * - `throw`: throws an error whose message carries the connection's `appSecret`;
 * - `hang`: waits for `signal` and rejects when it aborts (a well-behaved slow check);
 * - `ignore-signal`: never settles, whatever `signal` does;
 * - `long`: a reason over the 300-character limit (an invalid result);
 * - `echo-secret`: puts the connection's `appSecret` into the reason and the fix, and the
 *   deployment config's `clientSecret` (from `args.config`) into the fix;
 * - `pad-to-limit`: a reason of exactly 300 characters that contains the connection's
 *   `webhookToken` (set it to 8 or 9 characters): valid as returned, too long once redacted.
 */

const conn = (args: SetupCheckArgs) => {
  if (args.target.kind !== "channel-connection") throw new Error("not a channel connection");
  return FakeImConnection.parse(args.target.config);
};

const channelCheck = (run: SetupCheckDefinition["run"]): SetupCheckDefinition => ({
  place: "channel-connection",
  run,
});

export const passCheck = channelCheck(async () => ({
  status: "ok",
  reason: { en: "The fake platform accepted the app.", zh: "fake 平台接受了这个应用。" },
}));

export const failCheck = channelCheck(async () => ({
  status: "failing",
  reason: { en: "The fake platform refused the app." },
  fix: { en: "Create the app again and copy the new secret." },
}));

export const proxyCheck = channelCheck(async (args) => {
  const c = conn(args);
  const res = await fetch(`${c.platformUrl}/checks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pid": String(process.pid) },
    body: JSON.stringify({
      check: "proxy",
      connectionId: args.target.kind === "channel-connection" ? args.target.connectionId : "",
    }),
    signal: args.signal,
  });
  await res.body?.cancel();
  return res.status === 200
    ? { status: "ok", reason: { en: "The fake platform answered." } }
    : { status: "unknown", reason: { en: "The fake platform did not answer; retry later." } };
});

export const throwCheck = channelCheck(async (args) => {
  throw new Error(`the platform refused ${conn(args).appSecret}`);
});

export const hangCheck = channelCheck(
  (args) =>
    new Promise((_, reject) => {
      const stop = () => reject(new Error("aborted"));
      if (args.signal.aborted) stop();
      else args.signal.addEventListener("abort", stop, { once: true });
    }),
);

export const ignoreSignalCheck = channelCheck(() => new Promise(() => {}));

export const longCheck = channelCheck(async () => ({
  status: "ok",
  reason: { en: "x".repeat(301) },
}));

export const echoSecretCheck = channelCheck(async (args) => {
  const secret = conn(args).appSecret;
  const client = (args.config as { clientSecret?: string } | null)?.clientSecret ?? "";
  return {
    status: "failing",
    reason: { en: `The platform refused ${secret}.`, zh: `平台拒绝了 ${secret}。` },
    fix: { en: `Replace ${secret} with a new secret (login client ${client}).` },
  };
});

export const padToLimitCheck = channelCheck(async (args) => {
  const c = conn(args);
  const secret = c.webhookToken ?? c.appSecret;
  const head = `Token ${secret} `;
  return { status: "ok", reason: { en: head + "x".repeat(300 - head.length) } };
});
