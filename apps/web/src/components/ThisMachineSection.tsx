"use client";

import {
  Button,
  ContentSection,
  ItemList,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Device } from "../lib/devices";
import { deviceRunningQuery } from "../lib/query/device-running";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import type { DeviceCapabilityV1, DeviceCeilingRequest, KeepAwakeMode } from "../lib/shell";
import { type Connected, useIsThisMachine } from "../lib/use-this-machine";

/** How often the running list is read again (an operation starting or ending is no status change). */
const RUNNING_POLL_MS = 5000;

const lastViewKey = (deviceId: string) => `capybara.device.lastView.${deviceId}`;

/**
 * The time the person last viewed this device's page, read once when the section appears and
 * replaced by now. A per-viewer convenience: storage may be blocked, then there is no previous
 * view and no note.
 */
function useLastView(deviceId: string): string | null {
  const [before] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(lastViewKey(deviceId));
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(lastViewKey(deviceId), new Date().toISOString());
    } catch {
      // storage blocked: the note simply does not show
    }
  }, [deviceId]);
  return before;
}

/** A shell call's rejection code; "cancelled" is the person's own answer and shows nothing. */
const isCancelled = (e: unknown) => (e as { code?: unknown } | null)?.code === "cancelled";

/**
 * "This machine" on the device page of the device the shell says is this machine (desktop client spec §9.6):
 * the live running list (`device@1.running`, no command text), pause / disconnect or resume when stopped, the
 * keep-awake choice with what it cannot prevent (§9.7), and the "computer was asleep" note when the machine woke
 * since the person last looked. Every action is a mutation that invalidates the shell status;
 * a native confirmation the person declines (`cancelled`) shows nothing. Nothing renders in a
 * browser or on another device.
 */
export function ThisMachineSection({ orgId, device }: { orgId: string; device: Device }) {
  const here = useIsThisMachine(orgId, device.id);
  if (here === undefined) return null;
  return <Section cap={here.cap} status={here.status} />;
}

function Section({ cap, status }: { cap: DeviceCapabilityV1; status: Connected }) {
  const t = useTranslations("devices.thisMachine");
  const toast = useToast();
  const qc = useQueryClient();
  const lastView = useLastView(status.deviceId);
  const running = useQuery({
    ...deviceRunningQuery(cap),
    refetchInterval: RUNNING_POLL_MS,
    retry: false,
  });
  useEffect(() => {
    const off = cap.onStatus(() => {
      void qc.invalidateQueries({ queryKey: keys.shell().running() });
    });
    // a shell that returns no unsubscribe must not break the effect's cleanup
    return typeof off === "function" ? off : undefined;
  }, [cap, qc]);
  const invalidates = () => [keys.shell().deviceStatus(), keys.shell().running()];
  const run = useAppMutation({
    fn: (call: (c: DeviceCapabilityV1) => Promise<unknown>) => call(cap),
    invalidates,
  });
  const act = async (call: (c: DeviceCapabilityV1) => Promise<unknown>) => {
    if (run.isPending) return;
    try {
      await run.mutateAsync(call);
    } catch (e) {
      if (!isCancelled(e)) toast.error(t("failed"));
    }
  };
  const stopped = status.connection === "stopped";
  const draining = status.connection === "draining";
  const woke =
    status.lastWakeAt !== undefined &&
    lastView !== null &&
    Date.parse(status.lastWakeAt) > Date.parse(lastView);
  const ka = status.keepAwake;
  return (
    <ContentSection title={t("title")}>
      <Stack gap={12}>
        {woke && (
          <Text variant="prose" tone="muted">
            {t("wakeNote")}
          </Text>
        )}
        <ItemList
          label={t("running")}
          empty={t("runningEmpty")}
          rows={(running.data ?? []).map((r) => ({
            id: `${r.tag}:${r.startedAt}`,
            title: r.tag,
            description: t(`isolation.${r.isolation}`),
          }))}
        />
        <Stack direction="row" gap={8} wrap>
          {stopped ? (
            <Button
              density="dense"
              disabled={run.isPending}
              onClick={() => void act((c) => c.resume())}
            >
              {t("resume")}
            </Button>
          ) : (
            <>
              {!draining && (
                <Button
                  density="dense"
                  disabled={run.isPending}
                  onClick={() => void act((c) => c.pause())}
                >
                  {t("pause")}
                </Button>
              )}
              <Button
                density="dense"
                disabled={run.isPending}
                onClick={() => void act((c) => c.disconnect())}
              >
                {t("disconnect")}
              </Button>
            </>
          )}
        </Stack>
        <Stack gap={8}>
          <RadioGroup
            label={t("keepAwake.title")}
            value={ka.mode}
            disabled={run.isPending}
            onChange={(v) => void act((c) => c.setKeepAwake(v as KeepAwakeMode))}
            options={[
              { value: "off", label: t("keepAwake.off") },
              { value: "while-busy", label: t("keepAwake.whileBusy") },
              { value: "connected", label: t("keepAwake.connected") },
            ]}
          />
          {ka.unavailable !== undefined ? (
            <Text variant="prose" tone="warn">
              {t("keepAwake.unavailable", { reason: ka.unavailable })}
            </Text>
          ) : (
            ka.held && (
              <Text variant="prose" tone="muted">
                {t("keepAwake.held")}
              </Text>
            )
          )}
          <Text variant="prose" tone="muted">
            {t("keepAwake.cannot")}
          </Text>
        </Stack>
      </Stack>
    </ContentSection>
  );
}

/**
 * The owner ceiling widenings the shell can ask this machine for (`device@1.requestCeiling`), by
 * the device page's command key: each request names its one field, so the fields the person did
 * not touch are never sent and a stale value on the page can never narrow them.
 */
export const SHELL_WIDENINGS = {
  network: { network: "open" },
  outside: { outsideSandbox: true },
  reach: { projectReach: "os-user" },
} as const satisfies Record<string, DeviceCeilingRequest>;

export type ShellWidening = keyof typeof SHELL_WIDENINGS;

/**
 * Widening on this machine from its device page (desktop client spec §9.5): `request` asks the
 * shell for one field (a native confirmation with the device program's risk text; applied only on
 * yes), toasts when applied, says nothing when the person declines. `undefined` in a browser, on
 * another device, and in a shell whose `device@1` has no `requestCeiling`: the page then shows the
 * `capybara-device ceiling set` lines.
 */
export function useShellWidening(
  orgId: string,
  deviceId: string,
  invalidates: () => (readonly unknown[])[],
): { request(key: ShellWidening): void; pending: boolean } | undefined {
  const t = useTranslations("devices.thisMachine");
  const toast = useToast();
  const here = useIsThisMachine(orgId, deviceId);
  const cap = here?.cap;
  const offered = cap !== undefined && typeof cap.requestCeiling === "function";
  const widen = useAppMutation({
    fn: (req: DeviceCeilingRequest) =>
      offered ? cap.requestCeiling(req) : Promise.resolve("cancelled" as const),
    invalidates: () => [keys.shell().deviceStatus(), ...invalidates()],
  });
  if (!offered) return undefined;
  return {
    pending: widen.isPending,
    request: (key) => {
      if (widen.isPending) return;
      void widen.mutateAsync(SHELL_WIDENINGS[key]).then(
        (r) => {
          if (r === "applied") toast.success(t("widened"));
        },
        (e: unknown) => {
          if (!isCancelled(e)) toast.error(t("failed"));
        },
      );
    },
  };
}
