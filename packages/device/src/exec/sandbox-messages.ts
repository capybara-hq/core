/**
 * The texts of an unavailable OS sandbox (spec 2026-11-14 direction): sandbox mode must refuse a
 * command with a clear, actionable reason while auto mode keeps working. Pure strings, so the
 * `mode` command can use them without loading the sandbox runtime.
 */

/** How to fix an unavailable OS sandbox (shared by the command refusal and the mode switch). */
export const SANDBOX_INSTALL_HINT =
  "install the sandbox dependencies (bubblewrap and socat on Linux) and restart capybara-device";

/**
 * The refusal of every sandbox-mode operation when the OS sandbox is unavailable (device protocol
 * error kind `error`): actionable, and never a silent fallback to running unsandboxed.
 */
export function sandboxUnavailableMessage(reason: string): string {
  return (
    `The OS sandbox is unavailable on this machine (${reason}), so commands cannot run in sandbox ` +
    "mode. Run `capybara-device mode auto` on this machine to use auto mode, or " +
    `${SANDBOX_INSTALL_HINT}.`
  );
}

/** The refusal of `capybara-device mode sandbox` when the OS sandbox is unavailable. */
export function sandboxUnavailableSwitchRefusal(reason: string): string {
  return (
    `Nothing changed: the OS sandbox is unavailable on this machine (${reason}), so sandbox mode ` +
    `could not run commands. Stay in auto mode, or ${SANDBOX_INSTALL_HINT} and try again.`
  );
}
