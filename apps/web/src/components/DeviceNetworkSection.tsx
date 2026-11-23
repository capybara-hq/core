"use client";

import {
  Button,
  Field,
  FormSection,
  Input,
  ItemList,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Device,
  type DeviceNetworkMode,
  type DeviceSandboxView,
  setDeviceNetwork,
} from "../lib/devices";
import { allowHostProblem } from "../lib/network-hosts";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { ApiErrorDetail } from "./ApiErrorDetail";

/** Networks from the narrowest to the widest. */
const NETWORK_ORDER: readonly DeviceNetworkMode[] = ["none", "allowlist", "open"];
const wider = (a: DeviceNetworkMode, b: DeviceNetworkMode) =>
  NETWORK_ORDER.indexOf(a) > NETWORK_ORDER.indexOf(b);

/** A network choice: the device's own network, or `follow` (its org's, `mode: null`). */
type Choice = DeviceNetworkMode | "follow";

/**
 * Network (device provider design §6.3, §6.6): one section of the device's overview, identical
 * for every provider. The device's owner follows the organization (`mode: null`), opens it to the internet (private
 * networks blocked), keeps it to an allowlist whose own hosts only narrow the organization's list
 * (none of its own follows the org's hosts), or closes it, saved with `PATCH { network }`. An
 * option above `sandbox.networkCeiling` is disabled and names the layer that set it; the kernel
 * refuses it too (`device.network_not_allowed`). A saved network the instance does not run yet
 * says when it applies (the next use, or a file rebuild).
 */
export function DeviceNetworkSection({ orgId, device: e }: { orgId: string; device: Device }) {
  const t = useTranslations("devices.network");
  const toast = useToast();
  const [failure, setFailure] = useState<unknown>(null);
  // a network change can change what a conversation may do: the device's key holds its
  // permission previews too, so invalidating it reads them again
  const change = useAppMutation({
    fn: (network: { mode: DeviceNetworkMode | null; hosts?: string[] }) =>
      setDeviceNetwork(orgId, e.id, network),
    invalidates: () => [keys.org(orgId).devices(), keys.org(orgId).device(e.id)],
  });
  const save = async (network: { mode: DeviceNetworkMode | null; hosts?: string[] }) => {
    setFailure(null);
    try {
      await change.mutateAsync(network);
      toast.success(t("saved"));
    } catch (err) {
      setFailure(err);
    }
  };
  const s = e.sandbox;
  return (
    <FormSection id="network" title={t("title")} description={t("description")}>
      <Stack gap={16}>
        {s.pendingNextUse && (
          <Text variant="prose" tone="muted">
            {t("pendingNextUse")}
          </Text>
        )}
        {s.pendingFilesReset && (
          <Text variant="prose" tone="warn">
            {t("pendingFilesReset")}
          </Text>
        )}
        <NetworkForm
          // a saved network starts the draft again from what the kernel answers
          key={`${s.ownNetwork}:${s.allowedDomains.join(",")}`}
          sandbox={s}
          pending={change.isPending}
          onSave={save}
        />
        {failure !== null && <ApiErrorDetail error={failure} open />}
      </Stack>
    </FormSection>
  );
}

function NetworkForm({
  sandbox: s,
  pending,
  onSave,
}: {
  sandbox: DeviceSandboxView;
  pending: boolean;
  onSave(network: { mode: DeviceNetworkMode | null; hosts?: string[] }): Promise<void>;
}) {
  const t = useTranslations("devices.network");
  const initial: Choice = s.ownNetwork ?? "follow";
  const [choice, setChoice] = useState<Choice>(initial);
  const [hosts, setHosts] = useState<string[]>(s.allowedDomains);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const changed =
    choice !== initial ||
    (choice === "allowlist" && hosts.join("\n") !== s.allowedDomains.join("\n"));
  // the layer that set the ceiling: the device's own layer no longer limits it, so anything but
  // the platform or the org is the provider
  const layer =
    s.layer.network === "platform" || s.layer.network === "org" ? s.layer.network : "provider";
  const limit = (n: DeviceNetworkMode) =>
    wider(n, s.networkCeiling)
      ? {
          disabled: true,
          description: t(`${s.networkCeiling === "none" ? "closed" : "limited"}.${layer}`),
        }
      : {};
  const addHost = () => {
    const host = draft.trim().toLowerCase();
    if (host === "") return;
    if (allowHostProblem(host, { wildcard: true }) !== null) {
      setBad(host);
      return;
    }
    setBad(null);
    setDraft("");
    if (!hosts.includes(host)) setHosts([...hosts, host]);
  };
  const save = () =>
    void onSave(
      choice === "follow"
        ? { mode: null }
        : choice === "allowlist"
          ? { mode: "allowlist", hosts }
          : { mode: choice },
    );
  return (
    <Stack gap={12}>
      <RadioGroup
        label={t("title")}
        value={choice}
        disabled={pending}
        onChange={(v) => {
          const next = (["follow", ...NETWORK_ORDER] as const).find((x) => x === v);
          if (next !== undefined) setChoice(next);
        }}
        options={[
          {
            value: "follow",
            label: t("follow"),
            ...(s.ownNetwork === null
              ? { description: t("followNow", { value: t(s.network) }) }
              : {}),
          },
          { value: "open", label: t("open"), ...limit("open") },
          { value: "allowlist", label: t("allowlist"), ...limit("allowlist") },
          { value: "none", label: t("none") },
        ]}
      />
      {choice === "allowlist" && (
        <Stack gap={8}>
          <ItemList
            label={t("hosts")}
            rows={hosts.map((host) => ({
              id: host,
              title: host,
              actions: (
                <Button
                  density="dense"
                  aria-label={t("removeHost", { host })}
                  disabled={pending}
                  onClick={() => setHosts(hosts.filter((h) => h !== host))}
                >
                  {t("remove")}
                </Button>
              ),
            }))}
            empty={t("hostsEmpty")}
          />
          <Field
            label={t("hostInput")}
            help={t("hostsHelp")}
            {...(bad !== null ? { error: t("invalidHost", { host: bad }) } : {})}
          >
            <Input
              value={draft}
              disabled={pending}
              placeholder="files.example.com"
              onChange={(ev) => {
                setDraft(ev.target.value);
                setBad(null);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") addHost();
              }}
            />
          </Field>
          <div>
            <Button density="dense" disabled={pending || draft.trim() === ""} onClick={addHost}>
              {t("addHost")}
            </Button>
          </div>
        </Stack>
      )}
      <div>
        <Button
          density="dense"
          variant="primary"
          loading={pending}
          disabled={!changed || pending}
          onClick={save}
        >
          {t("save")}
        </Button>
      </div>
    </Stack>
  );
}
