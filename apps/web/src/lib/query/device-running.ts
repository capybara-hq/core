import type { DeviceCapabilityV2, DeviceRunningOp } from "../shell";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * What runs on this machine now for the device `deviceId` (`device@2` `running({ deviceId })`).
 * Only the client runs it, while the shell offers the capability and this machine holds the page's
 * device; the shell's `onStatus` invalidates it and the section polls it too (an operation starting
 * or ending is no status change).
 */
export const deviceRunningQuery = (cap: Pick<DeviceCapabilityV2, "running">, deviceId: string) =>
  defineQuery<DeviceRunningOp[]>({
    key: keys.shell().running(deviceId),
    fn: () => cap.running({ deviceId }),
    freshness: "live",
  });
