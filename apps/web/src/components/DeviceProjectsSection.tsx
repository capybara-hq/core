"use client";

import {
  Button,
  ContentSection,
  Dialog,
  Field,
  FormSection,
  Input,
  ItemList,
  SkeletonText,
  Stack,
  Subsection,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  addDeviceProject,
  type Device,
  type DeviceProject,
  type DeviceProjectList,
  defaultProjectName,
  normalizeProjectPath,
  projectBasePrefix,
  removeDeviceProject,
} from "../lib/devices";
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

/** The muted line under the list when the current mode hides stored projects. */
function HiddenNote({ count }: { count: number }) {
  const t = useTranslations("devices.projects");
  if (count === 0) return null;
  return (
    <Text variant="prose" tone="muted">
      {t("hidden", { count })}
    </Text>
  );
}

/** Why a device offers no projects: its program is old, or its cloud provider lacks them. */
function UnsupportedNote({ device }: { device: Device }) {
  const t = useTranslations("devices.projects");
  return (
    <Text variant="prose" tone="muted">
      {t(device.source === "local" ? "unsupportedLocal" : "unsupportedCloud")}
    </Text>
  );
}

const rowsOf = (projects: DeviceProject[]) =>
  projects.map((p) => ({ id: p.name, title: p.name, meta: p.path }));

/**
 * 概览's projects: the ones the device's current mode can read, read only, with a link to 设置
 * where they are managed.
 */
export function DeviceProjectsOverview({
  orgId,
  device,
  onOpenSettings,
}: {
  orgId: string;
  device: Device;
  onOpenSettings(): void;
}) {
  const t = useTranslations("devices.projects");
  const read = useDeviceProjects(orgId, device.id);
  if (read.isError && refused(read.error)) return null;
  const list = read.data;
  return (
    <ContentSection
      title={t("title")}
      {...(list !== undefined && list.projects.length > 0 ? { count: list.projects.length } : {})}
      {...(list?.supported
        ? {
            actions: (
              <Button density="dense" onClick={onOpenSettings}>
                {t("manage")}
              </Button>
            ),
          }
        : {})}
    >
      {read.isError && list === undefined ? (
        <LoadFailed onRetry={() => void read.refetch()} />
      ) : list === undefined ? (
        <Stack gap={8}>
          <SkeletonText width="45%" />
          <SkeletonText width="70%" size="small" />
        </Stack>
      ) : !list.supported ? (
        <UnsupportedNote device={device} />
      ) : (
        <Stack gap={8}>
          <ItemList label={t("title")} rows={rowsOf(list.projects)} empty={t("overviewEmpty")} />
          <HiddenNote count={list.hidden} />
        </Stack>
      )}
    </ContentSection>
  );
}

/**
 * The Settings tab's projects, beside the access ceiling and the allowlist: the list with Remove each (after a
 * confirmation), and 添加项目 in a dialog taking the path relative to the base of the device's
 * current mode (§4.2), the base drawn as a fixed prefix. A device without project support says
 * why and offers no form.
 */
export function DeviceProjectsSettings({ orgId, device }: { orgId: string; device: Device }) {
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
        <UnsupportedNote device={device} />
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
          <HiddenNote count={list.hidden} />
          {list.base === null ? (
            <Text variant="prose" tone="warn">
              {t("homeUnknown")}
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
      {adding && list !== undefined && (
        <AddProjectDialog
          orgId={orgId}
          device={device}
          list={list}
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

/**
 * 添加项目: the path relative to the base (a fixed prefix, never typed) and an optional name
 * defaulting to the path's last segment. The suggestions are read only while this dialog is open
 * (asking the device starts or resumes it); picking one fills the form. A refusal is drawn under
 * the field it concerns, in the reader's language mapped from its code.
 */
function AddProjectDialog({
  orgId,
  device,
  list,
  onClose,
  onAdded,
}: {
  orgId: string;
  device: Device;
  list: DeviceProjectList;
  onClose(): void;
  onAdded(name: string): void;
}) {
  const t = useTranslations("devices.projects");
  // a schema refusal of the name reads as the service's own name refusal (the same rules)
  const te = useTranslations("errors");
  const errorMessage = useErrorMessage();
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
  const prefix = projectBasePrefix(device.source, list.mode);
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
        <Field
          label={t("pathLabel")}
          help={t(prefix === "~/" ? "pathHelpHome" : "pathHelpWorkspace")}
          {...pathError}
        >
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
