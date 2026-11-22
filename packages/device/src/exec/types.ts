import type {
  DeviceErrorKind,
  DeviceProjectRefusal,
} from "@capybara-hq/plugin-sdk/device-protocol";

/** A device failure with a protocol error kind (default `error`). */
export class DeviceOpError extends Error {
  constructor(
    readonly kind: DeviceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DeviceOpError";
  }
}

/**
 * A project path the owner ceiling refuses: crosses the wire as `project_refused` with its code,
 * so the deployment can tell the person why (the message is the device's English text).
 */
export class DeviceProjectRefusedError extends Error {
  constructor(
    readonly refusal: DeviceProjectRefusal,
    message: string,
  ) {
    super(message);
    this.name = "DeviceProjectRefusedError";
  }
}
