"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deviceStatusQuery } from "./query/device-status";
import { keys } from "./query/keys";
import { useAppMutation } from "./query/mutation";
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

/**
 * The shell's 「connect this machine」 into the org `orgId` (`device@2.connect`). `connect()` runs the
 * call inside the click's mutation so the shell sees the person's activation. `cancelled` shows
 * nothing; an `{ error }` answer or a rejection other than `{ code: "cancelled" }` sets `failed`
 * (the shell's own text is never kept or shown). A connection that was added shows up through the
 * shell status and the org's device list.
 */
export function useConnectThisMachine(orgId: string): {
  offered: boolean;
  pending: boolean;
  failed: boolean;
  connect: () => void;
} {
  const cap = useDeviceCapability();
  const [failed, setFailed] = useState(false);
  const mutation = useAppMutation({
    fn: () => {
      if (cap === undefined) return Promise.resolve("cancelled" as const);
      return cap.connect({ orgId });
    },
    invalidates: () => [keys.shell().deviceStatus(), keys.org(orgId).devices()],
  });
  const { mutateAsync, isPending } = mutation;
  const connect = useCallback(() => {
    if (isPending) return;
    setFailed(false);
    mutateAsync(undefined).then(
      (result) => {
        if (typeof result === "object") setFailed(true);
      },
      (e: unknown) => {
        const code = (e as { code?: unknown } | null)?.code;
        if (code !== "cancelled") setFailed(true);
      },
    );
  }, [isPending, mutateAsync]);
  return { offered: cap !== undefined, pending: isPending, failed, connect };
}
