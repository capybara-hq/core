import type { Logger } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";

/**
 * Calls an extension with a time limit and an abort signal (plugin views, actions and file
 * previewers): over the limit the signal aborts and the call is 504 `ui.timeout`; a throw is
 * `failCode` (502) without echoing the extension's message. An `ApiError` thrown by `fn` passes.
 */
export async function callExtension<T>(o: {
  log: Pick<Logger, "warn">;
  plugin: string;
  what: string;
  fields: Record<string, unknown>;
  timeoutMs: number;
  failCode: "ui.render_failed" | "ui.action_failed";
  failMessage: string;
  fn: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error(`plugin ui ${o.what} timed out`));
      resolve("timeout");
    }, o.timeoutMs);
  });
  try {
    const r = await Promise.race([
      Promise.resolve()
        .then(() => o.fn(ac.signal))
        .then((value) => ({ value })),
      timeout,
    ]);
    if (r === "timeout") {
      o.log.warn(`plugin ui ${o.what} timed out`, { ...o.fields, timeoutMs: o.timeoutMs });
      throw new ApiError(
        "ui.timeout",
        `Plugin ${o.plugin} did not respond within ${o.timeoutMs / 1000}s`,
      );
    }
    return r.value;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    o.log.warn(`plugin ui ${o.what} failed`, { ...o.fields, err: e });
    throw new ApiError(o.failCode, o.failMessage);
  } finally {
    clearTimeout(timer);
  }
}
