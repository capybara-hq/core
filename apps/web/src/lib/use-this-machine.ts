"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { deviceStatusQuery } from "./query/device-status";
import { keys } from "./query/keys";
import { type DeviceCapabilityV1, type ThisMachineStatus, useDeviceCapability } from "./shell";

/**
 * `device@1` and this machine's status: `cap` is `undefined` in a browser (then `status` stays
 * `undefined` and nothing is read). The status follows the shell's `onStatus` through the query
 * cache.
 */
export function useThisMachine(): {
  cap: DeviceCapabilityV1 | undefined;
  status: ThisMachineStatus | undefined;
} {
  const cap = useDeviceCapability();
  const qc = useQueryClient();
  const q = useQuery({
    // a placeholder function while the capability is absent; `enabled` keeps it from running
    ...deviceStatusQuery(cap ?? { status: () => Promise.reject(new Error("no device@1")) }),
    enabled: cap !== undefined,
    retry: false,
  });
  useEffect(() => {
    if (cap === undefined) return;
    return cap.onStatus(() => {
      void qc.invalidateQueries({ queryKey: keys.shell().deviceStatus() });
    });
  }, [cap, qc]);
  return { cap, status: cap === undefined ? undefined : q.data };
}
