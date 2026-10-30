/**
 * Waits for `p` at most `ms`: resolves true when it resolved in time, false when the time ran out
 * (`p` keeps running; nothing is aborted). A rejection of `p` in time is thrown. The one "wait at
 * most N ms" of the kernel's stop path.
 */
export async function waitWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
    timer.unref();
  });
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
  try {
    const done = await waitWithin(p, budgetMs);
    if (!done) log.warn("shutdown step timed out", { step: label });
    return done;
  } catch (err) {
    log.warn("shutdown step failed", { step: label, err });
    return false;
  }
}
