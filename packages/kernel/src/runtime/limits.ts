/**
 * Run limits where 0 means "no limit" (`runtime.maxSteps`, `runtime.maxRunSeconds`, a sub-agent's
 * logged `maxSteps`): like Claude Code, a run without limits goes on until the model stops calling
 * tools or someone stops it.
 */

/**
 * The tightest of the given limits, ignoring absent and non-positive ones (0 = no limit);
 * `undefined` when none of them limits anything.
 */
export function tightestLimit(...limits: (number | undefined)[]): number | undefined {
  let out: number | undefined;
  for (const l of limits) {
    if (l === undefined || !(l > 0)) continue;
    out = out === undefined ? l : Math.min(out, l);
  }
  return out;
}

/**
 * The run's deadline (epoch ms) for `runtime.maxRunSeconds` counted from `startMs`; `undefined`
 * when the run has no duration limit (0).
 */
export function runDeadline(startMs: number, maxRunSeconds: number): number | undefined {
  return maxRunSeconds > 0 ? startMs + maxRunSeconds * 1000 : undefined;
}
