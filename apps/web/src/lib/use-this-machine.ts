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

export type Connected = Extract<ThisMachineStatus, { state: "connected" }>;

/**
 * The shell's status when this machine is the device `deviceId` of the org `orgId` (the device
 * page and the list mark it 本机), else `undefined`: a browser, another device, another org.
 */
export function useIsThisMachine(
  orgId: string,
  deviceId: string,
): { cap: DeviceCapabilityV1; status: Connected } | undefined {
  const { cap, status } = useThisMachine();
  if (
    cap === undefined ||
    status?.state !== "connected" ||
    status.orgId !== orgId ||
    status.deviceId !== deviceId
  ) {
    return undefined;
  }
  return { cap, status };
}

/** The id of this machine's device in the org `orgId`, when the shell says it is connected there. */
export function useThisMachineDeviceId(orgId: string): string | undefined {
  const { status } = useThisMachine();
  return status?.state === "connected" && status.orgId === orgId ? status.deviceId : undefined;
}
