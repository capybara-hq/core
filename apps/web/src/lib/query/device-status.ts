import type { DeviceCapabilityV1, ThisMachineStatus } from "../shell";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * This machine's status for the deployment (`device@1` `status()`). Only the client runs it, and
 * only while the shell offers the capability (the caller sets `enabled`); the shell's `onStatus`
 * invalidates it.
 */
export const deviceStatusQuery = (cap: Pick<DeviceCapabilityV1, "status">) =>
  defineQuery<ThisMachineStatus>({
    key: keys.shell().deviceStatus(),
    fn: () => cap.status(),
    freshness: "live",
  });
