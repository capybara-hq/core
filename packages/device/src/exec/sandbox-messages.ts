/**
 * The texts of an unavailable OS sandbox: restricted work must refuse a command with a clear,
 * actionable reason. Pure strings, so `login` can use them without loading the sandbox runtime.
 */

/** How to fix an unavailable OS sandbox. */
export const SANDBOX_INSTALL_HINT =
  "install the sandbox dependencies (bubblewrap and socat on Linux) and restart capybara-device";

/**
 * The refusal of every sandboxed operation when the OS sandbox is unavailable (device protocol
 * error kind `error`): actionable, and never a silent fallback to running unsandboxed.
 */
export function sandboxUnavailableMessage(reason: string): string {
  return (
    `The OS sandbox is unavailable on this machine (${reason}), so restricted commands cannot ` +
    `run here: ${SANDBOX_INSTALL_HINT}.`
  );
}
