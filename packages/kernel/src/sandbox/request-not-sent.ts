/**
 * `DeviceRequestNotSentError` lives in the SDK (a provider's dial-in relay throws it too); the
 * relay (`local-devices/relay.ts`) re-exports it.
 */
export { DeviceRequestNotSentError, isDeviceRequestNotSent } from "@capybara-hq/plugin-sdk";

/**
 * A staged request whose machine reconnected as a new run of the program (a different
 * `programRunId` in its hello) before answering: the results a program keeps for a reconnect live
 * in its memory, so this request's result can never arrive. Whether the request ran, and how far,
 * is unknown; the operation path records it as an unknown outcome, never as a definite failure.
 * The relay throws it as soon as it sees the new run, instead of waiting for the deadline.
 */
export class DeviceProgramRestartedError extends Error {
  readonly programRestarted = true as const;
  constructor(op: string) {
    super(
      `The connected machine's program restarted before answering ${op}; its result is lost and its outcome is unknown`,
    );
    this.name = "DeviceProgramRestartedError";
  }
}

/** Recognizes {@link DeviceProgramRestartedError}, also as the cause of an unknown outcome. */
export const isDeviceProgramRestarted = (e: unknown): boolean =>
  e instanceof Error &&
  ((e as { programRestarted?: unknown }).programRestarted === true ||
    isDeviceProgramRestarted((e as { cause?: unknown }).cause));
