import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/**
 * Whether the OS sandbox's dependencies are present here, and why not (`login` says what to
 * install). Loaded on demand: only `login` asks.
 */
export function sandboxAvailability(): { ok: true } | { ok: false; reason: string } {
  if (!SandboxManager.isSupportedPlatform()) {
    return { ok: false, reason: `the OS sandbox does not support ${process.platform}` };
  }
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    return {
      ok: false,
      reason: `the OS sandbox is missing dependencies: ${deps.errors.join("; ")}`,
    };
  }
  return { ok: true };
}
