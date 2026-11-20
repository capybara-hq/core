import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";

/**
 * A staged request refused because the machine's connection changed before it was sent: the frame
 * never reached the machine, so this request ran nothing. Typed as a scope refusal, a pre-effect
 * failure the operation path records as definite (`not_sent`), never as an unknown outcome. It
 * says nothing about an earlier request of the same operation, so a recovery tells it apart
 * ({@link isDeviceRequestNotSent}). The relay throws it (`local-devices/relay.ts` re-exports it).
 */
export class DeviceRequestNotSentError extends SandboxScopeDeniedError {
  readonly notSent = true as const;
}

/** Recognizes {@link DeviceRequestNotSentError} by its tag. */
export const isDeviceRequestNotSent = (e: unknown): e is DeviceRequestNotSentError =>
  e instanceof SandboxScopeDeniedError && (e as { notSent?: unknown }).notSent === true;

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
