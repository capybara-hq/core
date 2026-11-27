import {
  isDeviceOfflineError,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  MAX_DEVICE_LIST_ENTRIES,
  type SandboxBrowse,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { deviceOffline } from "../dial-in/relay.js";
import { ApiError } from "../errors.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { SandboxProviderUnreachableError } from "../sandbox/unreachable.js";
import {
  browseReader,
  DeviceProjectsService,
  listFailure,
  passThrough,
  providerUnreachable,
  unavailable,
} from "./device-projects.service.js";
import { joinProjectPath, projectRelativePath } from "./project-paths.js";
import { clipped } from "./project-rules.js";

/** The most entries one listing answers (composer menus §5). */
export const MAX_PROJECT_FILE_ENTRIES = 200;

/** One entry of a project directory: `path` is relative to the project root. */
export interface ProjectFileEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  /** The file's size in bytes, when the device reports it (a directory listing does not). */
  size?: number;
}

/** `GET /devices/:id/projects/:name/files`. */
export interface ProjectFileList {
  entries: ProjectFileEntry[];
  /** More entries matched than {@link MAX_PROJECT_FILE_ENTRIES} (or than the device listed). */
  truncated: boolean;
}

/** The device cannot list its directories for its owner (409 `device.list_unsupported`). */
export const listUnsupported = (): ApiError =>
  new ApiError(
    "device.list_unsupported",
    "This device's provider cannot list its directories, so its project files cannot be browsed",
  );

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it drops
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A name the device answered that the kernel passes on: one plain path segment. */
const plainName = (name: string): boolean =>
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  name.length <= 255 &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !CONTROL.test(name);

const byKindThenName = (a: ProjectFileEntry, b: ProjectFileEntry): number => {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/**
 * The files of a device's project (composer menus §5): one directory per call, read through the
 * owner browse scope (`SandboxService.ensureRunningForOwner`, then `SandboxService.withBrowse` as
 * the device's owner: metadata only, never file contents, never a write). Every path is relative
 * to the project root and normalized by {@link projectRelativePath} before the device is asked,
 * so the kernel never names a path outside the root; what lies behind a symlink below it is the
 * provider's and its browse scope's to judge. Only the device's owner reads it (anyone else gets
 * `device.not_found`, from the project lookup).
 */
@Injectable()
export class DeviceProjectFilesService {
  constructor(
    @Inject(DeviceProjectsService)
    private readonly projects: Pick<DeviceProjectsService, "resolveForBinding">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "withBrowse" | "ensureRunningForOwner">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Lists the directory `opts.path` (relative to the project `projectName`, the root when absent)
   * of the owner's device: directories first, then files, each group by name; `opts.q` keeps the
   * names that contain it (case-insensitive). At most {@link MAX_PROJECT_FILE_ENTRIES} entries.
   * Refused with `device.path_outside_project` (before anything is read), `device.not_found`,
   * `device.project_not_found`, `device.list_unsupported`, the device codes of the projects
   * routes (`device.offline`, `device.not_running`, `device.projects_unavailable`) and the
   * `list` refusals of adding a project (`device.project_path_missing`, `…_unreadable`,
   * `…_outside_mode`, `device.project_refused`).
   */
  async list(
    orgId: string,
    accountId: string,
    deviceId: string,
    projectName: string,
    opts: { path?: string; q?: string },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProjectFileList> {
    const rel = projectRelativePath(opts.path ?? "");
    const q = (opts.q ?? "").trim().toLowerCase();
    const project = await this.project(orgId, accountId, deviceId, projectName);
    const abs = joinProjectPath(project.path, rel);
    // a filter reads as much of the directory as the device answers, the plain listing one page
    const limit = q === "" ? MAX_PROJECT_FILE_ENTRIES : MAX_DEVICE_LIST_ENTRIES;
    const answer = await this.onDevice(orgId, accountId, deviceId, signal, async (b, sig) => {
      try {
        return await b.list(abs, { limit, signal: sig });
      } catch (e) {
        throw await listFailure(e, browseReader(b, project.path), abs, sig, (err, statErr) =>
          this.log.warn("device project files: the device could not list", {
            deviceId,
            err,
            statErr,
          }),
        );
      }
    });
    if (answer === null) {
      throw new ApiError(
        "device.project_path_missing",
        `${clipped(rel === "" ? "The project root" : rel)} does not exist on the device`,
      );
    }
    const matched = answer.entries
      .filter((e) => plainName(e.name) && (q === "" || e.name.toLowerCase().includes(q)))
      .map(
        (e): ProjectFileEntry => ({
          name: e.name,
          path: rel === "" ? e.name : `${rel}/${e.name}`,
          kind: e.isDir ? "dir" : "file",
        }),
      )
      .sort(byKindThenName);
    return {
      entries: matched.slice(0, MAX_PROJECT_FILE_ENTRIES),
      truncated: answer.truncated || matched.length > MAX_PROJECT_FILE_ENTRIES,
    };
  }

  /**
   * Which of `paths` (relative to the project rooted at `projectPath`) are not files the device
   * reports, asked with `stat` inside one owner browse of the conversation owner's device: a
   * missing path, a directory or one the browse scope refuses counts as missing. Each path is
   * normalized first ({@link projectRelativePath}; one that leaves the project is refused with
   * `device.path_outside_project` before the device is asked); `missing` holds the normalized
   * paths. The device codes of {@link list} pass on as they are.
   */
  async statAll(
    ctx: { orgId: string; accountId: string; deviceId: string },
    projectPath: string,
    paths: string[],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ missing: string[] }> {
    const rels = paths.map((p) => projectRelativePath(p));
    if (rels.length === 0) return { missing: [] };
    return this.onDevice(ctx.orgId, ctx.accountId, ctx.deviceId, signal, async (b, sig) => {
      const missing: string[] = [];
      for (const rel of rels) {
        let st: { size: number; isDir: boolean } | null;
        try {
          st = await b.stat(joinProjectPath(projectPath, rel), sig);
        } catch (e) {
          // the owner browse scope refusing the path: not a file this person can reference
          if (isSandboxScopeDeniedError(e)) {
            missing.push(rel);
            continue;
          }
          const passed = passThrough(e);
          if (passed !== undefined) throw passed;
          this.log.warn("device project files: the device could not stat", {
            deviceId: ctx.deviceId,
            err: e,
          });
          throw unavailable(e);
        }
        if (st === null || st.isDir) missing.push(rel);
      }
      return { missing };
    });
  }

  /** The owner's project (`resolveForBinding`); a device that offers no listing → `list_unsupported`. */
  private async project(
    orgId: string,
    accountId: string,
    deviceId: string,
    name: string,
  ): Promise<{ name: string; path: string }> {
    try {
      return await this.projects.resolveForBinding(orgId, deviceId, accountId, name);
    } catch (e) {
      if (e instanceof ApiError && e.code === "device.projects_unsupported")
        throw listUnsupported();
      throw e;
    }
  }

  /**
   * Runs `fn` in the owner browse of the device (`ensureRunningForOwner` first, so a stopped device
   * is started for its owner), mapped like the projects routes: kernel refusals stay, a provider
   * without owner browsing is `device.list_unsupported`, an offline machine `device.offline`, an
   * unreachable provider and anything else `device.projects_unavailable`, never a 500.
   */
  private async onDevice<T>(
    orgId: string,
    accountId: string,
    deviceId: string,
    signal: AbortSignal,
    fn: (b: SandboxBrowse, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      await this.sandbox.ensureRunningForOwner({ orgId, deviceId, accountId }, signal);
      return await this.sandbox.withBrowse({ orgId, deviceId, accountId }, fn, signal);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (isSandboxPermissionUnsupportedError(e)) throw listUnsupported();
      if (isDeviceOfflineError(e)) throw deviceOffline();
      if (e instanceof SandboxProviderUnreachableError) throw providerUnreachable();
      this.log.warn("device project files: the device could not be asked", { deviceId, err: e });
      throw unavailable(e);
    }
  }
}
