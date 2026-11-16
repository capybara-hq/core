"use client";

import { Button, Dialog, type IconName, type PickerProps, Stack, Text } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { canUpdateOrg } from "../../lib/org-settings";
import type {
  PermissionPreview,
  PermissionProfile,
  PermissionSelection,
} from "../../lib/permissions";
import { retryOnMountOf } from "../../lib/query/client";
import { permissionPreviewQuery } from "../../lib/query/permissions";
import { useSession } from "../shell/session";

/**
 * The conversation permission profiles (permission profiles spec, "UI outline"): three rows with
 * an icon, an explanation and the checkmark, all in the same neutral colors (Full access has no
 * accent of its own), in this order; Approve for me is the default.
 */
export const PERMISSION_PROFILES: readonly PermissionProfile[] = [
  "request-approval",
  "approve-for-me",
  "full-access",
];
export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "approve-for-me";

const ICON: Record<PermissionProfile, IconName> = {
  "request-approval": "hand",
  "approve-for-me": "shield-check",
  "full-access": "lock-open",
};
const KEY: Record<PermissionProfile, "requestApproval" | "approveForMe" | "fullAccess"> = {
  "request-approval": "requestApproval",
  "approve-for-me": "approveForMe",
  "full-access": "fullAccess",
};

/** The model-purposes settings where an org admin sets the review model. */
export const REVIEW_MODEL_SETTINGS = "/settings/models?tab=purposes";

type Reason =
  | "noDevice"
  | "checking"
  | "checkFailed"
  | "ceiling"
  | "unsupported"
  | "restrictedUnsupported";

/**
 * Why each profile cannot be chosen for this device (undefined: it can). Only known states map
 * to a reason; a provider's raw reason text is never shown here.
 */
export function unavailableReasons(
  deviceId: string | undefined,
  preview: { data: PermissionPreview | undefined; failed: boolean },
): Record<PermissionProfile, Reason | undefined> {
  if (deviceId === undefined)
    // no device: nothing to restrict, nothing to grant Full access on
    return {
      "request-approval": undefined,
      "approve-for-me": undefined,
      "full-access": "noDevice",
    };
  const p = preview.data;
  if (p === undefined || p.deviceId !== deviceId) {
    const full = preview.failed ? "checkFailed" : "checking";
    return { "request-approval": undefined, "approve-for-me": undefined, "full-access": full };
  }
  const a = p.availability;
  const restricted: Reason | undefined =
    a.state === "unsupported"
      ? "unsupported"
      : a.state === "supported" && a.report.restricted === null
        ? "restrictedUnsupported"
        : undefined;
  const full: Reason | undefined = !p.fullAccessCeiling
    ? "ceiling"
    : a.state === "unsupported" || (a.state === "supported" && !a.report.fullAccess)
      ? "unsupported"
      : undefined;
  return { "request-approval": restricted, "approve-for-me": restricted, "full-access": full };
}

type Consent = { deviceId: string; project: string | null; scopeRevision: string };
type Choice = { profile: PermissionProfile; consent?: Consent };

export type PermissionChoiceInput = {
  orgId: string;
  /** The selected device (undefined: none; no preview is read, Full needs one). */
  deviceId: string | undefined;
  /** The selected project on that device (undefined: free mode). */
  project: string | undefined;
  /** The device's display name, for the Full access confirmation. */
  deviceLabel: string;
  /** A new conversation's choice governs its first operation; an existing one's new operations. */
  context: "new" | "existing";
  /** The starting choice (an existing conversation's recorded profile). */
  initial?: PermissionProfile;
};

/**
 * The permission choice of a composer: the picker for the existing generic slot (desktop menu and
 * phone sheet), the Full access confirmation dialog, and the current selection. Full access is
 * chosen only through the dialog, for the device and scope revision on display, and is cleared
 * back to Approve for me when the device or its scope changes; any other choice stays.
 * Sending the selection is the caller's.
 */
export function usePermissionChoice(input: PermissionChoiceInput): {
  picker: PickerProps;
  dialog: ReactNode;
  selection: PermissionSelection;
} {
  const t = useTranslations("chat.permission");
  const router = useRouter();
  const session = useSession();
  const { orgId, deviceId, project } = input;
  const previewQ = permissionPreviewQuery(orgId, deviceId ?? "", project);
  const preview = useQuery({
    ...previewQ,
    enabled: deviceId !== undefined,
    retryOnMount: retryOnMountOf(previewQ.queryKey),
  });
  const shown = deviceId !== undefined ? preview.data : undefined;
  const [choice, setChoice] = useState<Choice>({
    profile: input.initial ?? DEFAULT_PERMISSION_PROFILE,
  });
  // Full access consent belongs to one device and scope revision: another device, project or
  // revision clears it (adjusted during render, so no frame shows a stale Full access).
  const c = choice.consent;
  if (
    choice.profile === "full-access" &&
    c !== undefined &&
    (c.deviceId !== deviceId ||
      c.project !== (project ?? null) ||
      (shown !== undefined && shown.scopeRevision !== c.scopeRevision))
  )
    setChoice({ profile: DEFAULT_PERMISSION_PROFILE });
  /** The preview the confirmation is about, frozen when it opened. */
  const [asking, setAsking] = useState<PermissionPreview | null>(null);
  const reasons = unavailableReasons(deviceId, {
    data: shown,
    failed: deviceId !== undefined && preview.isError,
  });
  const pick = (id: string) => {
    const profile = PERMISSION_PROFILES.find((p) => p === id);
    if (profile === undefined || reasons[profile] !== undefined) return;
    if (profile !== "full-access") setChoice({ profile });
    else if (shown !== undefined && choice.profile !== "full-access") setAsking(shown);
  };
  const confirm = () => {
    const p = asking;
    setAsking(null);
    // the device or its scope changed while the dialog was open: nothing is granted
    if (
      p === null ||
      p.deviceId !== deviceId ||
      p.project !== (project ?? null) ||
      shown?.scopeRevision !== p.scopeRevision
    )
      return;
    setChoice({
      profile: "full-access",
      consent: { deviceId: p.deviceId, project: p.project, scopeRevision: p.scopeRevision },
    });
  };
  const unprobed = shown?.availability.state === "unprobed";
  const note = [
    ...(unprobed ? [t("note.unprobed")] : []),
    t("note.review"),
    t(input.context === "new" ? "note.new" : "note.existing"),
  ].join(" ");
  const picker: PickerProps = {
    label: t("label"),
    value: t(`profile.${KEY[choice.profile]}`),
    groups: [
      {
        items: PERMISSION_PROFILES.map((p) => {
          const reason = reasons[p];
          return {
            id: p,
            label: t(`profile.${KEY[p]}`),
            icon: ICON[p],
            description: t(`description.${KEY[p]}`),
            checked: choice.profile === p,
            ...(reason !== undefined ? { disabled: true, tag: t(`reason.${reason}`) } : {}),
          };
        }),
      },
    ],
    note,
    ...(canUpdateOrg(session.me)
      ? {
          action: {
            label: t("configureReview"),
            icon: "settings" as const,
            onSelect: () => router.push(REVIEW_MODEL_SETTINGS),
          },
        }
      : {}),
    onPick: pick,
  };
  const dialog =
    asking === null ? null : (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={t("full.title", { device: input.deviceLabel })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              {t("full.cancel")}
            </Button>
            <Button variant="primary" onClick={confirm}>
              {t("full.confirm")}
            </Button>
          </>
        }
      >
        <Stack gap={8}>
          <Text variant="prose">
            {asking.project === null
              ? t("full.body")
              : t("full.bodyProject", { project: asking.project })}
          </Text>
          <Text variant="prose" tone="muted">
            {t("full.limits")}
          </Text>
        </Stack>
      </Dialog>
    );
  const selection: PermissionSelection =
    choice.profile === "full-access" && choice.consent !== undefined
      ? { profile: "full-access", consentScopeRevision: choice.consent.scopeRevision }
      : { profile: choice.profile };
  return { picker, dialog, selection };
}

/**
 * A profile shown read-only (a recorded or inherited one, or the new conversation's default
 * until the first send carries a choice): the locked picker, its hint saying why.
 */
export function useLockedPermissionPicker(
  profile: PermissionProfile | undefined,
  why: "profile" | "inherited" | "scheduled" = "profile",
): PickerProps | undefined {
  const t = useTranslations("chat.permission");
  if (profile === undefined) return undefined;
  return {
    label: t("label"),
    value: t(`profile.${KEY[profile]}`),
    locked: {
      hint:
        why === "inherited"
          ? t("locked.inherited")
          : why === "scheduled"
            ? t("locked.scheduled")
            : t(`description.${KEY[profile]}`),
    },
    groups: [],
    onPick: () => {},
  };
}
