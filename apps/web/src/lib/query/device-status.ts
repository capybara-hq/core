import type { DeviceCapabilityV2, ThisMachineConnection } from "../shell";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * This machine's connections into the deployment (`device@2` `status()`). Only the client runs it,
 * and only while the shell offers the capability (the caller sets `enabled`); the shell's
 * `onStatus` invalidates it.
 */
export const deviceStatusQuery = (cap: Pick<DeviceCapabilityV2, "status">) =>
  defineQuery<{ connections: ThisMachineConnection[] }>({
    key: keys.shell().deviceStatus(),
    fn: () => cap.status(),
    freshness: "live",
  });
