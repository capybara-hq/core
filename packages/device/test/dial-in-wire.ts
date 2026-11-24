import { parseDialInMachineFrame } from "@capybara-hq/plugin-sdk";
import {
  type DeviceHello,
  type DevicePolicyChanged,
  type DeviceResponse,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk/device-protocol";
import type { StagedHello } from "../src/staged-session.js";

/** The kernel's side of the dial-in envelope, for tests that hold the server end of a socket. */

/** A machine frame as the kernel reads it: the envelope, then its device protocol body. */
export type MachineFrame =
  | { type: "hello"; hello: DeviceHello; program: StagedHello["envelope"]["program"] }
  | { type: "res"; res: DeviceResponse }
  | { type: "event"; event: DevicePolicyChanged };

export function readMachineFrame(raw: string, maxBytes: number): MachineFrame {
  const frame = parseDialInMachineFrame(raw, maxBytes);
  if (frame.type === "hello")
    return { type: "hello", hello: parseDeviceFrame(frame.body, "hello"), program: frame.program };
  if (frame.type === "res")
    return {
      type: "res",
      res: { type: "res", id: frame.id, ...parseDeviceFrame(frame.body, "res") },
    };
  if (frame.type !== "event") throw new Error(`unexpected ${frame.type} frame`);
  return { type: "event", event: parseDeviceFrame(frame.body, "event") };
}

export const readyFrame = (connectionId: string, maxFrameBytes = 69632) =>
  JSON.stringify({ type: "ready", connectionId, maxFrameBytes });

export const requestFrame = (id: string, op: string, args: unknown, deadlineMs: number) =>
  JSON.stringify({ type: "req", id, deadlineMs, body: { op, args } });

export const cancelFrame = (id: string) => JSON.stringify({ type: "cancel", id });

/** What `serveStagedSession` sends a hello with: fixture program facts around `body`. */
export const stagedHello = (body: DeviceHello): StagedHello => ({
  envelope: { program: { version: "fixture", os: "darwin", arch: "arm64" } },
  body,
});
