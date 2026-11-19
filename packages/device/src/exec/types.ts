import type { DeviceErrorKind } from "@capybara-hq/plugin-sdk";

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
