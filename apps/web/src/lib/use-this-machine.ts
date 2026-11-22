"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { deviceStatusQuery } from "./query/device-status";
import { keys } from "./query/keys";
import { type DeviceCapabilityV2, type ThisMachineConnection, useDeviceCapability } from "./shell";

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * `device@2` and this machine's connections into the deployment: `cap` is `undefined` in a browser
 * (then `connections` stays `undefined` and nothing is read). The connections follow the shell's
 * `onStatus` through the query cache.
 */
export function useThisMachine(): {
  cap: DeviceCapabilityV2 | undefined;
  connections: ThisMachineConnection[] | undefined;
} {
  const cap = useDeviceCapability();
  const qc = useQueryClient();
  const q = useQuery({
    // a placeholder function while the capability is absent; `enabled` keeps it from running
    ...deviceStatusQuery(cap ?? { status: () => Promise.reject(new Error("no device@2")) }),
    enabled: cap !== undefined,
    retry: false,
  });
  useEffect(() => {
    if (cap === undefined) return;
    const off = cap.onStatus(() => {
      void qc.invalidateQueries({ queryKey: keys.shell().deviceStatus() });
    });
    // a shell that returns no unsubscribe must not break the effect's cleanup
    return typeof off === "function" ? off : undefined;
  }, [cap, qc]);
  return { cap, connections: cap === undefined ? undefined : q.data?.connections };
}

/**
 * This machine's connection to the device `deviceId` of the org `orgId` (the device page marks it
 * "this machine" and acts on it), else `undefined`: a browser, another device, another org.
 */
export function useIsThisMachine(
  orgId: string,
  deviceId: string,
): { cap: DeviceCapabilityV2; connection: ThisMachineConnection } | undefined {
  const { cap, connections } = useThisMachine();
  if (cap === undefined) return undefined;
  const connection = connections?.find((c) => c.orgId === orgId && c.deviceId === deviceId);
  return connection === undefined ? undefined : { cap, connection };
}

/**
 * This machine's device ids in the org `orgId` (empty in a browser): a machine may hold several
 * connections into one org, and the list and the picker mark each of them.
 */
export function useThisMachineDeviceIds(orgId: string): ReadonlySet<string> {
  const { connections } = useThisMachine();
  return useMemo(() => {
    const ids = (connections ?? []).filter((c) => c.orgId === orgId).map((c) => c.deviceId);
    return ids.length === 0 ? NO_IDS : new Set(ids);
  }, [connections, orgId]);
}
