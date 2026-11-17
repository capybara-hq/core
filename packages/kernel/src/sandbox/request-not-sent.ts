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
