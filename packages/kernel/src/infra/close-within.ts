/**
 * Waits for an infra resource to close at shutdown (the bus subscriber, Redis, the pool) at most
 * `budgetMs`, the share of the total stop budget left (`GracefulShutdown.remainingMs()`): a close
 * that does not finish in time (Redis unreachable, a client never released) is abandoned with a
 * warning, so the shutdown never hangs on it. Resolves true when `p` settled successfully in time.
 */
export async function closeWithin(
  label: string,
  p: Promise<unknown>,
  budgetMs: number,
  log: { warn(msg: string, fields?: Record<string, unknown>): void },
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, budgetMs));
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
