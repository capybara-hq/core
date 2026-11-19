import type { DeviceCapabilityV1, RunningOperationView } from "../shell";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * What runs on this machine now (`device@1` `running()`). Only the client runs it, while the shell
 * offers the capability and this machine is the page's device; the shell's `onStatus` invalidates
 * it and the section polls it too (an operation starting or ending is no status change).
 */
export const deviceRunningQuery = (cap: Pick<DeviceCapabilityV1, "running">) =>
  defineQuery<RunningOperationView[]>({
    key: keys.shell().running(),
    fn: () => cap.running(),
    freshness: "live",
  });
