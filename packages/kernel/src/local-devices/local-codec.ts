import {
  FileSystemGoneError,
  isDeviceOfflineError,
  SandboxGoneError,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  SandboxScopeValidationError,
  SandboxWorkUnsettledError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import {
  type BindInstanceRequest,
  type DeviceOperation,
  DeviceProtocolError,
  type DeviceResponseBody,
  parseDeviceFrame,
  parseOperationResult,
} from "@capybara-hq/plugin-sdk/device-protocol";
import {
  DialInConnectionChangedError,
  DialInFrameTooLargeError,
  type DialInRelay,
  deviceOffline,
} from "../dial-in/relay.js";
import {
  DeviceProgramRestartedError,
  DeviceRequestNotSentError,
  isDeviceProgramRestarted,
  isDeviceRequestNotSent,
} from "../sandbox/request-not-sent.js";

/**
 * The `capybara-device` bodies of the kernel's own `@local` provider (interim: they leave the
 * kernel with the `device-local` plugin) over the generic dial-in relay: a request body is
 * `{ op, args }` and a response body the operation's result or its typed failure (protocol 5,
 * `@capybara-hq/plugin-sdk/device-protocol`). The relay never reads them; this codec validates
 * both sides and maps the relay's generic errors to the ones the local provider's callers know.
 */

/** The text a machine's `policy` refusal reaches the model with. */
export const POLICY_REFUSAL_PREFIX = "Refused by the machine's local policy: ";

/** The text a machine's `error` result reaches the model with (ruling R28). */
export const ON_MACHINE_PREFIX = "On the connected machine: ";

/**
 * The text of a request refused because the machine's connection changed. Only an output read has
 * an offset to retry from; every other operation is simply retried.
 */
export const connectionChangedMessage = (op: string): string =>
  op === "backgroundReadOutput"
    ? "The machine's connection changed during the read; retry the read from the same offset"
    : `The machine's connection changed before ${op} was sent; retry the operation`;

/**
 * The operations held under a stable operation identity (native, preparation and browsing
 * operations, execution, a background start and an operation revoke): their not-sent refusal is
 * typed ({@link DeviceRequestNotSentError}) so the operation path records it as definite. Exact
 * status, tail, stop and reads and binding keep their plain errors.
 */
const heldOperation = (op: string): boolean =>
  op === "backgroundStart" ||
  op === "revokeOperation" ||
  /^(?:exec|readFile|writeFile|stat|list|scan|prepare(?:ReadFile|WriteFile|Stat)|browse(?:Stat|List|Scan))$/.test(
    op,
  );

/**
 * Whether an operation's result is fenced to the connection its request was sent on: only an
 * output read, whose range was sized for the old connection's capacity (an in-flight read that
 * meets a reconnect fails so the reader retries from the same offset). Every other operation keeps
 * the grace semantics: the machine keeps it running across a socket blip and its result is
 * accepted after a reconnect within the grace.
 */
const connectionFenced = (op: string): boolean => op === "backgroundReadOutput";

/**
 * A request refused because it was not sent, outside the operations held under an operation
 * identity (a status read, a binding): a protocol error that also says nothing ran, so a caller can
 * record it as never received instead of unknown ({@link wasDeviceRequestNotSent}).
 */
export class DeviceRequestNotSentProtocolError extends DeviceProtocolError {
  readonly notSent = true as const;
}

/** Any request the kernel knows was never sent to the machine (held or not). */
export const wasDeviceRequestNotSent = (e: unknown): boolean =>
  e instanceof Error && (e as { notSent?: unknown }).notSent === true;

/** What the local provider sends through: one operation, its validated result. */
export type LocalCall = (
  deviceId: string,
  op: DeviceOperation,
  args: Record<string, unknown>,
  opts: {
    deadlineMs: number;
    signal: AbortSignal;
    /** The connection the request was sized for (a changed one refuses it as not sent). */
    connection?: { connectionId: string; maxFrameBytes: number };
  },
) => Promise<unknown>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs one protocol 5 operation on the device's machine through the relay and returns its
 * validated result. The request body is checked first (an invalid one is never queued). The
 * machine's failures map to the SDK's typed errors (`denied`, `unsupported`, `unsettled`,
 * `unknown`, `invalid`), `SandboxGoneError` (`gone`), `FileSystemGoneError` (`fs_gone`) or a
 * `ToolError` (`policy` prefixed {@link POLICY_REFUSAL_PREFIX}, `error` prefixed
 * {@link ON_MACHINE_PREFIX}); an invalid answer throws a `DeviceProtocolError`. The relay's
 * errors keep the local provider's meaning: offline is `device.offline`, a request never sent is
 * typed per {@link heldOperation}, a changed connection under an output read is a protocol error.
 */
export function localCall(relay: Pick<DialInRelay, "request">): LocalCall {
  return async (deviceId, op, args, opts) => {
    const body = parseDeviceFrame({ op, args }, "req");
    let raw: unknown;
    try {
      raw = await relay.request(deviceId, body, {
        timeoutMs: opts.deadlineMs,
        signal: opts.signal,
        ...(opts.connection && { connection: opts.connection }),
        fenced: connectionFenced(op),
      });
    } catch (e) {
      throw localError(op, e);
    }
    let res: DeviceResponseBody;
    try {
      res = parseDeviceFrame(raw, "res");
    } catch (e) {
      throw new DeviceProtocolError(`the connected machine sent an invalid frame: ${errMsg(e)}`);
    }
    if (!res.ok) throw failureOf(res.error);
    return parseOperationResult(
      op,
      res.result,
      op === "backgroundReadOutput"
        ? (args as { offset: number; maxBytes: number })
        : op === "bindInstance"
          ? (args as unknown as BindInstanceRequest)
          : undefined,
    );
  };
}

/** The relay's generic error as the local provider's callers know it. */
function localError(op: string, e: unknown): unknown {
  if (isDeviceRequestNotSent(e))
    return heldOperation(op)
      ? new DeviceRequestNotSentError(connectionChangedMessage(op))
      : new DeviceRequestNotSentProtocolError(connectionChangedMessage(op));
  if (e instanceof DialInConnectionChangedError)
    return new DeviceProtocolError(connectionChangedMessage(op));
  if (e instanceof DialInFrameTooLargeError)
    return new DeviceProtocolError(
      "Frame exceeds negotiated capacity; check device and deployment frame limits",
    );
  if (isDeviceOfflineError(e)) return deviceOffline();
  if (isDeviceProgramRestarted(e)) return new DeviceProgramRestartedError(op);
  return e;
}

/** A machine's typed failure as the SDK error the kernel's callers know. */
function failureOf(error: Extract<DeviceResponseBody, { ok: false }>["error"]): Error {
  const { kind, message } = error;
  switch (kind) {
    case "denied":
      return new SandboxScopeDeniedError(message);
    case "unsupported":
      return new SandboxPermissionUnsupportedError(message);
    case "unsettled":
      return new SandboxWorkUnsettledError(message);
    case "unknown":
      return new SandboxOperationOutcomeUnknownError(message);
    case "invalid":
      return new SandboxScopeValidationError(message);
    case "gone":
      return new SandboxGoneError(message);
    case "fs_gone":
      return new FileSystemGoneError(message);
    case "policy":
      return new ToolError(`${POLICY_REFUSAL_PREFIX}${message}`);
    default:
      return new ToolError(`${ON_MACHINE_PREFIX}${message}`);
  }
}
