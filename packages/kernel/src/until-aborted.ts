/**
 * `p`, or a rejection with `signal.reason` once `signal` aborts, whatever `p` does: an extension
 * call that ignores its signal never holds the caller past it (a late settle of `p` is dropped).
 */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      p.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
