// The crash budget of client extensions (client extensions spec §10.3): at three errors in one
// document a plugin's build is switched off for the browser session. Browser-only state: the
// session store and the counts of this document; nothing is shared with other tabs or replicas.

/** `CLIENT_LIMITS.crashBudget`: errors in one document before the build is switched off. */
export const CRASH_BUDGET = 3;

/** The session-storage key holding the switched-off builds, a JSON list of `<plugin>/<build>`. */
export const DISABLED_KEY = "cap-client-disabled";

const buildKey = (plugin: string, build: string) => `${plugin}/${build}`;

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The builds switched off in this browser session (a blocked store reads as none). */
export function disabledBuilds(): Set<string> {
  try {
    const raw = session()?.getItem(DISABLED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** Whether this build of the plugin is switched off for the session (a new build is not). */
export function isDisabledForSession(plugin: string, build: string): boolean {
  return disabledBuilds().has(buildKey(plugin, build));
}

/** Switches the build off for the session; a blocked store keeps it off for this document only. */
export function disableForSession(plugin: string, build: string): void {
  const all = disabledBuilds();
  all.add(buildKey(plugin, build));
  try {
    session()?.setItem(DISABLED_KEY, JSON.stringify([...all]));
  } catch {
    // a blocked or full store: the caller still stops the plugin in this document
  }
}

/** Counts each plugin's errors in this document; `hit` says when the budget is spent. */
export function createCrashCounter(budget = CRASH_BUDGET) {
  const counts = new Map<string, number>();
  return {
    /** Records one error; true exactly when this error spends the budget. */
    hit(plugin: string, build: string): boolean {
      const k = buildKey(plugin, build);
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n === budget;
    },
  };
}
