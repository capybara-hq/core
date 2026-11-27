"use client";

import { ProjectFilePicker } from "@capybara-hq/design";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { deviceProjectFilesQuery } from "../../lib/query/devices";
import { ApiErrorDetail } from "../ApiErrorDetail";

/** How long the filter rests before the device is asked (each text is its own cache entry). */
const FILTER_DELAY_MS = 200;

/** The kernel's cap on project files per message. */
export const MAX_PROJECT_FILES = 10;

/**
 * The project file picker's container (composer menus §5): lists one directory of the device
 * project at a time through the kernel (only while open), keeps the path, the filter and the
 * selection, and hands the chosen paths back on 「引用」. It opens on the project root with the
 * files already referenced selected, so 「引用」 replaces the draft's list.
 *
 * A device that cannot list (`device.list_unsupported`) closes the picker and tells the caller,
 * which shows its + row disabled with the reason; any other failure is drawn in place of the rows.
 */
export function ProjectFilesPicker({
  orgId,
  deviceId,
  project,
  open,
  initial,
  onClose,
  onConfirm,
  onUnsupported,
}: {
  orgId: string;
  deviceId: string;
  /** The project's name on the device. */
  project: string;
  open: boolean;
  /** The paths the draft references now (selected when the picker opens). */
  initial: string[];
  onClose(): void;
  onConfirm(paths: string[]): void;
  onUnsupported(error: unknown): void;
}) {
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [settled, setSettled] = useState("");
  const [selected, setSelected] = useState<string[]>(initial);
  // each opening starts on the root with the draft's references
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the picker opens
  useEffect(() => {
    if (!open) return;
    setPath("");
    setFilter("");
    setSettled("");
    setSelected(initial);
  }, [open]);
  useEffect(() => {
    const id = setTimeout(() => setSettled(filter.trim()), FILTER_DELAY_MS);
    return () => clearTimeout(id);
  }, [filter]);
  const listing = useQuery({
    ...deviceProjectFilesQuery(orgId, deviceId, project, path, settled),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const unsupported =
    listing.error instanceof ApiClientError && listing.error.code === "device.list_unsupported";
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per failed listing
  useEffect(() => {
    if (open && unsupported) {
      onUnsupported(listing.error);
      onClose();
    }
  }, [open, unsupported]);
  return (
    <ProjectFilePicker
      open={open && !unsupported}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      project={project}
      path={path}
      onPathChange={setPath}
      entries={listing.data?.entries ?? []}
      truncated={listing.data?.truncated === true}
      filter={filter}
      onFilterChange={setFilter}
      loading={listing.isPending || (listing.isPlaceholderData && listing.isFetching)}
      {...(listing.isError ? { error: <ApiErrorDetail error={listing.error} /> } : {})}
      selected={selected}
      onSelectedChange={setSelected}
      max={MAX_PROJECT_FILES}
      onConfirm={(paths) => {
        onConfirm(paths);
        onClose();
      }}
    />
  );
}
