"use client";

import {
  Button,
  Dialog,
  type IconName,
  type PickerProps,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { useRouter } from "../../i18n/navigation";
import type { Conversation, ConversationEvent } from "../../lib/conversations";
import { canUpdateOrg } from "../../lib/org-settings";
import {
  type PermissionPreview,
  type PermissionProfile,
  type PermissionSelection,
  setConversationPermissions,
} from "../../lib/permissions";
import { retryOnMountOf } from "../../lib/query/client";
import { inboxChangeKeys } from "../../lib/query/inbox";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import {
  permissionKeysOfRoot,
  permissionsConfirmed,
  permissionWatermark,
  raisePermissionWatermark,
  refreshPermissionViews,
  subscribePermissionWatermarks,
} from "../../lib/query/permission-state";
import { permissionPreviewQuery, permissionsQuery } from "../../lib/query/permissions";
import { ApiErrorDetail } from "../ApiErrorDetail";
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
/** A profile's message key under `chat.permission.profile` / `.description`. */
export const PROFILE_KEY: Record<
  PermissionProfile,
  "requestApproval" | "approveForMe" | "fullAccess"
> = {
  "request-approval": "requestApproval",
  "approve-for-me": "approveForMe",
  "full-access": "fullAccess",
};

/**
 * The profile the log last recorded (`permission_profile_changed`; revision 0 is the first
 * message's choice), for the owner while the authoritative read loads. Undefined: none in the log.
 */
export function recordedProfile(
  events: readonly ConversationEvent[] | undefined,
): PermissionProfile | undefined {
  let found: PermissionProfile | undefined;
  for (const e of events ?? [])
    if (e.type === "permission_profile_changed") found = e.payload.newProfile;
  return found;
}

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
  /**
   * The starting choice (an existing conversation's recorded profile). A recorded Full access is
   * the current state only: it carries no consent, so it yields no selection until the person
   * chooses again (Full only through the dialog).
   */
  initial?: PermissionProfile;
  /**
   * The scope facts the choice is about, when the caller already holds them (an existing
   * conversation's authoritative view): no preview is read then.
   */
  preview?: { data: PermissionPreview | undefined; failed: boolean };
  /**
   * An existing conversation's edit: each new choice (Full only after its confirmation) goes here
   * instead of into local state; the shown value stays `initial` until the authoritative read.
   */
  onChange?(selection: PermissionSelection): void;
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
  /**
   * What a send carries; null for a recorded Full access nobody consented to here (the current
   * state, unchanged): a Full selection is never synthesized without consent.
   */
  selection: PermissionSelection | null;
  /**
   * Drops a Full access consent back to Approve for me (the kernel refused the displayed scope);
   * any other choice stays. Consent is only ever given again through the dialog.
   */
  clearFullAccess(): void;
} {
  const t = useTranslations("chat.permission");
  const router = useRouter();
  const session = useSession();
  const { orgId, deviceId, project } = input;
  const previewQ = permissionPreviewQuery(orgId, deviceId ?? "", project);
  const read = useQuery({
    ...previewQ,
    enabled: deviceId !== undefined && input.preview === undefined,
    retryOnMount: retryOnMountOf(previewQ.queryKey),
  });
  const preview = input.preview ?? { data: read.data, failed: read.isError };
  const shown = deviceId !== undefined ? preview.data : undefined;
  const [choice, setChoice] = useState<Choice>({
    profile: input.initial ?? DEFAULT_PERMISSION_PROFILE,
  });
  // A starting choice that arrives or changes after mount (a recorded profile read later) is
  // taken over, adjusted during render as the consent reset below.
  const [initial, setInitial] = useState(input.initial);
  if (input.initial !== initial) {
    setInitial(input.initial);
    setChoice({ profile: input.initial ?? DEFAULT_PERMISSION_PROFILE });
  }
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
    failed: deviceId !== undefined && preview.failed,
  });
  const choose = (next: Choice) => {
    if (input.onChange === undefined) return setChoice(next);
    input.onChange(
      next.consent !== undefined
        ? { profile: next.profile, consentScopeRevision: next.consent.scopeRevision }
        : { profile: next.profile },
    );
  };
  const pick = (id: string) => {
    const profile = PERMISSION_PROFILES.find((p) => p === id);
    if (profile === undefined || reasons[profile] !== undefined || profile === choice.profile)
      return;
    if (profile !== "full-access") choose({ profile });
    else if (shown !== undefined) setAsking(shown);
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
    choose({
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
    value: t(`profile.${PROFILE_KEY[choice.profile]}`),
    groups: [
      {
        items: PERMISSION_PROFILES.map((p) => {
          const reason = reasons[p];
          return {
            id: p,
            label: t(`profile.${PROFILE_KEY[p]}`),
            icon: ICON[p],
            description: t(`description.${PROFILE_KEY[p]}`),
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
  const selection: PermissionSelection | null =
    choice.profile !== "full-access"
      ? { profile: choice.profile }
      : choice.consent !== undefined
        ? { profile: "full-access", consentScopeRevision: choice.consent.scopeRevision }
        : null;
  const clearFullAccess = () =>
    setChoice((cur) =>
      cur.profile === "full-access" ? { profile: DEFAULT_PERMISSION_PROFILE } : cur,
    );
  return { picker, dialog, selection, clearFullAccess };
}

/**
 * A profile shown read-only (a recorded or inherited one): the locked picker, its hint saying why.
 */
export function useLockedPermissionPicker(
  profile: PermissionProfile | undefined,
  why: "profile" | "inherited" | "scheduled" | "unconfirmed" = "profile",
): PickerProps | undefined {
  const t = useTranslations("chat.permission");
  if (profile === undefined) return undefined;
  return {
    label: t("label"),
    value: t(`profile.${PROFILE_KEY[profile]}`),
    locked: {
      hint:
        why === "inherited"
          ? t("locked.inherited")
          : why === "scheduled"
            ? t("locked.scheduled")
            : why === "unconfirmed"
              ? t("unconfirmed")
              : t(`description.${PROFILE_KEY[profile]}`),
    },
    groups: [],
    onPick: () => {},
  };
}

/** The approvals the log shows pending (requested, not yet decided). */
function pendingApprovalIds(events: readonly ConversationEvent[] | undefined): string[] {
  const open = new Set<string>();
  for (const e of events ?? []) {
    if (e.type === "approval_requested") open.add(e.payload.approvalId);
    else if (e.type === "approval_decided") open.delete(e.payload.approvalId);
  }
  return [...open];
}

/**
 * An existing conversation's permission profile for its owner (permission profiles Task 10D):
 *
 * - Read: the owner-only authoritative view (`enabled` only for the owner; a viewer reads nothing
 *   and gets no picker). Until it lands, the profile the log recorded is shown, locked.
 * - Edit: only an interactive root (no parent, no scheduled task) whose view is confirmed. A new
 *   choice is a PATCH with the view's `expectedRevision` (Full only after the dialog for the
 *   view's own device, project and scope revision). The answer's revision raises the root's
 *   watermark inside the mutation, before the views are read again.
 * - Confirmation: below the watermark (a PATCH or a root profile event this view has not read
 *   yet) the last confirmed profile is shown locked and marked unconfirmed; a failed read shows
 *   its error with a Refresh that only reads. Nothing is rolled back or sent again.
 * - A failed PATCH (409: revision, binding or consent changed meanwhile; or no answer) reads the
 *   state again and needs a new choice: never resent.
 * - A child shows its root's profile as inherited, a scheduled task's as its own rules, locked.
 */
export function useConversationPermission(o: {
  orgId: string;
  conversationId: string;
  row: Conversation | undefined;
  events: readonly ConversationEvent[] | undefined;
  /** The bound device's display name, for the Full access confirmation. */
  deviceLabel: string;
}): {
  picker: PickerProps | undefined;
  dialog: ReactNode;
  /** The unconfirmed read's error and Refresh, or the last change's failure; null: nothing. */
  notice: ReactNode;
  /** The root an owner's child inherits from (its subscription's), else undefined. */
  inheritedRootId: string | undefined;
} {
  const { orgId, conversationId, row } = o;
  const t = useTranslations("chat.permission");
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const accountId = session.me.account.id;
  // an unknown owner never authorizes the owner read (as in the route's prefetch)
  const owner = row !== undefined && row.accountId === accountId;
  const q = permissionsQuery(orgId, conversationId);
  const read = useQuery({ ...q, enabled: owner, retryOnMount: retryOnMountOf(q.queryKey) });
  const view = owner ? read.data : undefined;
  const rootId = view?.rootConversationId;
  const required = useSyncExternalStore(
    (fn) => subscribePermissionWatermarks(qc, fn),
    () =>
      rootId === undefined ? undefined : permissionWatermark(qc, { accountId, orgId, rootId }),
    () => undefined,
  );
  const confirmed = permissionsConfirmed(view, required);
  const child = view !== undefined && rootId !== conversationId;
  const scheduled = Boolean(row?.scheduledTaskId);
  const interactiveRoot =
    owner && !child && !scheduled && row !== undefined && !row.parentConversationId;
  const [failure, setFailure] = useState<unknown>(null);
  const patch = useAppMutation({
    fn: async (v: PermissionSelection & { expectedRevision: number }) => {
      const r = await setConversationPermissions(orgId, conversationId, v);
      // the barrier first: the reads below may fail, and a cached older view must not unlock
      raisePermissionWatermark(qc, { accountId, orgId, rootId: conversationId }, r.revision);
      return r;
    },
    invalidates: () => [
      ...permissionKeysOfRoot(qc, orgId, conversationId),
      ...pendingApprovalIds(o.events).map((id) => keys.org(orgId).approval(id)),
      ...inboxChangeKeys(orgId),
    ],
    onSuccess: () => toast.success(t("changed")),
    onError: (e) => {
      setFailure(e);
      // the state may have moved (or the change may have landed without an answer): read it
      refreshPermissionViews(qc, orgId, conversationId);
    },
  });
  const deviceId = view?.deviceId ?? undefined;
  const project = row?.project?.name;
  const choice = usePermissionChoice({
    orgId,
    deviceId,
    project,
    deviceLabel: o.deviceLabel,
    context: "existing",
    ...(view !== undefined ? { initial: view.profile } : {}),
    // the view is the scope the kernel checks a Full consent against: no preview is read
    preview: {
      data:
        view?.deviceId != null && view.scopeRevision !== null
          ? {
              deviceId: view.deviceId,
              project: project ?? null,
              scopeRevision: view.scopeRevision,
              availability: view.availability,
              fullAccessCeiling: view.fullAccessCeiling,
            }
          : undefined,
      failed: view?.deviceId != null && view.scopeRevision === null,
    },
    onChange: (selection) => {
      if (view === undefined || !confirmed || patch.isPending) return;
      setFailure(null);
      patch.mutate({ ...selection, expectedRevision: view.revision });
    },
  });
  const recorded = owner ? recordedProfile(o.events) : undefined;
  const editable = interactiveRoot && view !== undefined && confirmed && !patch.isPending;
  const locked = useLockedPermissionPicker(
    owner ? (view?.profile ?? recorded) : undefined,
    view !== undefined && !confirmed
      ? "unconfirmed"
      : child
        ? "inherited"
        : scheduled
          ? "scheduled"
          : "profile",
  );
  const notice =
    view !== undefined && !confirmed && read.isError ? (
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {t("unconfirmedFailed")}
        </Text>
        <ApiErrorDetail error={read.error} />
        <Stack direction="row">
          <Button density="dense" disabled={read.isFetching} onClick={() => void read.refetch()}>
            {t("refresh")}
          </Button>
        </Stack>
      </Stack>
    ) : failure !== null ? (
      <ApiErrorDetail error={failure} summaries={{ conflict: t("conflict") }} />
    ) : null;
  return {
    picker: editable ? choice.picker : locked,
    dialog: editable ? choice.dialog : null,
    notice,
    inheritedRootId: owner && child ? rootId : undefined,
  };
}
