/**
 * The time each infra resource gets to close at shutdown (the bus subscriber, the pool): a close
 * that does not finish in time (Redis unreachable, a client never released) is abandoned with a
 * warning, so the shutdown never hangs on it.
 */
export const INFRA_CLOSE_BUDGET_MS = 3_000;

/**
 * Waits for `p` at most {@link INFRA_CLOSE_BUDGET_MS}; a failure or a timeout is only logged.
 * Resolves true when `p` settled successfully in time.
 */
export async function closeWithin(
  label: string,
  p: Promise<unknown>,
  log: { warn(msg: string, fields?: Record<string, unknown>): void },
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), INFRA_CLOSE_BUDGET_MS);
    timer.unref();
  });
  try {
    const r = await Promise.race([p.then(() => "done" as const), timeout]);
    if (r === "timeout") log.warn("shutdown step timed out", { step: label });
    return r === "done";
  } catch (err) {
    log.warn("shutdown step failed", { step: label, err });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
