"use client";

import {
  Button,
  Dialog,
  Field,
  FormSection,
  Input,
  ItemList,
  Stack,
  Subsection,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  addDeviceProject,
  type Device,
  type DeviceProjectList,
  type DeviceText,
  defaultProjectName,
  deviceText,
  normalizeProjectPath,
  projectBasePrefix,
  removeDeviceProject,
} from "../lib/devices";
import { labelLocale } from "../lib/extension-label";
import { retryOnMountOf } from "../lib/query/client";
import { deviceProjectCandidatesQuery, deviceProjectsQuery } from "../lib/query/devices";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** The project instruction file's name, a placeholder in the copy (never translated). */
const FILE = "AGENTS.md";

/**
 * The device's projects (project root design §4.1): the owner's only. A read the kernel refuses
 * (anyone else: `device.not_found`) draws nothing; another failure draws the error and 重试.
 */
function useDeviceProjects(orgId: string, deviceId: string) {
  const q = deviceProjectsQuery(orgId, deviceId);
  return useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
}

const refused = (error: unknown): boolean =>
  error instanceof ApiClientError && (error.status === 404 || error.status === 403);

function LoadFailed({ onRetry }: { onRetry(): void }) {
  const t = useTranslations("devices.projects");
  return (
    <Stack gap={8}>
      <FormError message={t("loadFailed")} />
      <div>
        <Button density="dense" onClick={onRetry}>
          {t("retry")}
        </Button>
      </div>
    </Stack>
  );
}

/** Why a device offers no projects: its provider does not list them. */
function UnsupportedNote() {
  const t = useTranslations("devices.projects");
  return (
    <Text variant="prose" tone="muted">
      {t("unsupported")}
    </Text>
  );
}

/**
 * 项目 (device provider design §6.6), the same for every provider: the list with Remove each
 * (after a confirmation), and 添加项目 in a dialog taking the path relative to the base the kernel
 * returns (the provider's home, else the workspace; project root §4.2), the base drawn as a fixed
 * prefix. A device without project support says so and offers no form; a refusal of the
 * provider's (`device.project_refused`) shows its reason in the page language.
 */
export function DeviceProjectsSection({ orgId, device }: { orgId: string; device: Device }) {
  const t = useTranslations("devices.projects");
  const toast = useToast();
  const read = useDeviceProjects(orgId, device.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  if (read.isError && refused(read.error)) return null;
  const list = read.data;
  return (
    <FormSection
      id="projects"
      title={t("title")}
      description={t("description", { file: FILE })}
      {...(list === undefined && !read.isError
        ? { loading: { items: [{ lines: 2, buttons: 1 }] } }
        : {})}
    >
      {read.isError && list === undefined ? (
        <LoadFailed onRetry={() => void read.refetch()} />
      ) : list === undefined ? null : !list.supported ? (
        <UnsupportedNote />
      ) : (
        <Stack gap={12}>
          <ItemList
            label={t("title")}
            rows={list.projects.map((p) => ({
              id: p.name,
              title: p.name,
              meta: p.path,
              actions: (
                <Button
                  density="dense"
                  aria-label={t("removeLabel", { name: p.name })}
                  onClick={() => setRemoving(p.name)}
                >
                  {t("remove")}
                </Button>
              ),
            }))}
            empty={t("empty")}
          />
          {list.base === null ? (
            <Text variant="prose" tone="warn">
              {t("baseUnknown")}
            </Text>
          ) : (
            <div>
              <Button density="dense" onClick={() => setAdding(true)}>
                {t("add")}
              </Button>
            </div>
          )}
        </Stack>
      )}
      {adding && list?.base != null && (
        <AddProjectDialog
          orgId={orgId}
          device={device}
          list={list}
          base={list.base}
          onClose={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            toast.success(t("added", { name }));
          }}
        />
      )}
      {removing !== null && (
        <RemoveProjectDialog
          orgId={orgId}
          deviceId={device.id}
          name={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            toast.success(t("removed", { name: removing }));
            setRemoving(null);
          }}
        />
      )}
    </FormSection>
  );
}

/** The first segment of a validation detail's `path` (`"name"`, `["name"]`), if any. */
function detailPath(d: unknown): string | undefined {
  const p = (d as { path?: unknown } | null)?.path;
  const first = Array.isArray(p) ? p[0] : p;
  return typeof first === "string" ? first.split(".")[0] : undefined;
}

/** The provider's reason in a `device.project_refused` refusal (its first detail's `reason`). */
function refusalReason(e: ApiClientError): DeviceText | undefined {
  const reason = (e.rawDetails[0] as { reason?: unknown } | undefined)?.reason;
  return typeof (reason as { en?: unknown } | undefined)?.en === "string"
    ? (reason as DeviceText)
    : undefined;
}

/**
 * 添加项目: the path relative to the base (a fixed prefix, never typed) and an optional name
 * defaulting to the path's last segment. The suggestions are read only while this dialog is open
 * (asking the device starts or resumes it); picking one fills the form. A refusal is drawn under
 * the field it concerns, in the reader's language: mapped from its code, or the provider's own
 * reason for `device.project_refused`.
 */
function AddProjectDialog({
  orgId,
  device,
  list,
  base,
  onClose,
  onAdded,
}: {
  orgId: string;
  device: Device;
  list: DeviceProjectList;
  base: string;
  onClose(): void;
  onAdded(name: string): void;
}) {
  const t = useTranslations("devices.projects");
  // a schema refusal of the name reads as the service's own name refusal (the same rules)
  const te = useTranslations("errors");
  const errorMessage = useErrorMessage();
  const lang = labelLocale(useLocale());
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<{ field: "path" | "name" | "form"; message: string }>();
  const candidates = useQuery(deviceProjectCandidatesQuery(orgId, device.id));
  const add = useAppMutation({
    fn: (input: { path: string; name?: string }) => addDeviceProject(orgId, device.id, input),
    // a project's roots decide a conversation's permission preview there: read those again too
    // (never the suggestions, which would ask the device again)
    invalidates: () => [
      keys.org(orgId).deviceProjects(device.id),
      keys.org(orgId).permissionPreviewAll(device.id),
    ],
  });
  const prefix = projectBasePrefix(base);
  const relative = normalizeProjectPath(path);
  const typedName = name.trim();
  const pending = add.isPending;
  // the kernel takes a path relative to the base only: an absolute one is hinted before sending
  const absolute = relative.startsWith("/");
  const submit = async () => {
    if (pending || absolute) return;
    setFailure(undefined);
    try {
      const r = await add.mutateAsync({
        path: relative,
        ...(typedName !== "" ? { name: typedName } : {}),
      });
      onAdded(r.project.name);
    } catch (e) {
      const code = e instanceof ApiClientError ? e.code : "";
      const reason =
        code === "device.project_refused" ? refusalReason(e as ApiClientError) : undefined;
      if (reason !== undefined) {
        setFailure({ field: "path", message: deviceText(reason, lang) });
        return;
      }
      if (code === "validation_failed") {
        // the route's schema names the field; its text is the kernel's English, so the reader
        // gets the field's own copy instead
        const field = (e as ApiClientError).rawDetails.map(detailPath)[0];
        if (field === "name") {
          setFailure({ field: "name", message: te("device.project_name_invalid") });
          return;
        }
        if (field === "path") {
          setFailure({ field: "path", message: t("pathInvalid", { prefix }) });
          return;
        }
        setFailure({ field: "form", message: errorMessage(e) });
        return;
      }
      const field = code.startsWith("device.project_name_")
        ? "name"
        : code.startsWith("device.project")
          ? "path"
          : "form";
      setFailure({ field, message: errorMessage(e) });
    }
  };
  const pathError = absolute
    ? { error: t("pathAbsolute", { prefix }) }
    : failure?.field === "path"
      ? { error: failure.message }
      : {};
  const nameError = failure?.field === "name" ? { error: failure.message } : {};
  const found = candidates.data?.candidates ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("addTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("addSubmit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field label={t("pathLabel")} help={t("pathHelp", { base })} {...pathError}>
          <Input
            value={path}
            prefix={prefix}
            maxLength={4096}
            onChange={(ev) => {
              setPath(ev.target.value);
              setFailure(undefined);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") void submit();
            }}
          />
        </Field>
        <Field label={t("nameLabel")} optional help={t("nameHelp")} {...nameError}>
          <Input
            value={name}
            maxLength={64}
            placeholder={defaultProjectName(path, list.base)}
            onChange={(ev) => {
              setName(ev.target.value);
              setFailure(undefined);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") void submit();
            }}
          />
        </Field>
        {failure?.field === "form" && <FormError message={failure.message} />}
        <Subsection
          variant="divided"
          title={t("candidates")}
          description={t("candidatesHelp", { file: FILE })}
        >
          {candidates.isPending ? (
            <Text variant="prose" tone="muted">
              {t("candidatesLoading")}
            </Text>
          ) : candidates.isError ? (
            <Text variant="prose" tone="muted">
              {t("candidatesFailed")}
            </Text>
          ) : (
            <ItemList
              label={t("candidates")}
              rows={found.map((c) => {
                const shown = `${prefix}${c.relativePath}`;
                return {
                  id: c.path,
                  title: shown,
                  meta: c.suggestedName,
                  actions: (
                    <Button
                      density="dense"
                      aria-label={t("pickLabel", { path: shown })}
                      onClick={() => {
                        setPath(c.relativePath);
                        setName(c.suggestedName);
                        setFailure(undefined);
                      }}
                    >
                      {t("pick")}
                    </Button>
                  ),
                };
              })}
              empty={t("candidatesEmpty", { file: FILE })}
            />
          )}
        </Subsection>
      </Stack>
    </Dialog>
  );
}

/** 移除: only the device's list loses it (the directory stays), so a plain confirmation. */
function RemoveProjectDialog({
  orgId,
  deviceId,
  name,
  onClose,
  onRemoved,
}: {
  orgId: string;
  deviceId: string;
  name: string;
  onClose(): void;
  onRemoved(): void;
}) {
  const t = useTranslations("devices.projects");
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string>();
  const remove = useAppMutation({
    fn: () => removeDeviceProject(orgId, deviceId, name),
    invalidates: () => [
      keys.org(orgId).deviceProjects(deviceId),
      keys.org(orgId).permissionPreviewAll(deviceId),
    ],
  });
  const pending = remove.isPending;
  const submit = async () => {
    setError(undefined);
    try {
      await remove.mutateAsync(undefined);
      onRemoved();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("removeTitle", { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("removeSubmit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("removeHint")}</Text>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
