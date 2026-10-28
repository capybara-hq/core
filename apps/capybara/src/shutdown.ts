/** Work to finish before the process exits (flushing traces); each hook is bounded in time. */
const hooks: Array<() => Promise<void>> = [];

/** How long one hook may take before the exit goes ahead without it. */
const HOOK_TIMEOUT_MS = 5_000;

/** Registers a hook run by {@link runShutdownHooks}. */
export function addShutdownHook(hook: () => Promise<void>): void {
  hooks.push(hook);
}

/** Runs every hook once, swallowing errors and giving up on a hook after five seconds. */
export async function runShutdownHooks(): Promise<void> {
  const pending = hooks.splice(0);
  await Promise.all(
    pending.map((hook) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => {
        timer = setTimeout(r, HOOK_TIMEOUT_MS);
        timer.unref();
      });
      return Promise.race([hook().catch(() => {}), timeout]).finally(() => clearTimeout(timer));
    }),
  );
}

/** Exits after the shutdown hooks ran. */
export function exitAfterShutdown(code: number): void {
  void runShutdownHooks().finally(() => process.exit(code));
}
