import { posix } from "node:path";
import {
  DeviceProtocolError,
  isDeviceProjectName,
  isFileSystemGoneError,
  isSandboxGoneError,
  MAX_DEVICE_SCAN_RESULTS,
  type SandboxHandle,
  type SandboxProvider,
  ToolError,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost, withOrderedLocks } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { projectsUnsupported } from "../local-devices/local-device-provider.js";
import { POLICY_REFUSAL_PREFIX } from "../local-devices/relay.js";
import type { SandboxMode } from "../sandbox/modes.js";
import { PermissionCeilingWrites } from "../sandbox/permission-ceiling-writes.js";
import { PermissionFacts } from "../sandbox/permission-facts.js";
import { deviceNotFound, type HeldProvider, SandboxService } from "../sandbox/sandbox.service.js";
import { SandboxProviderUnreachableError } from "../sandbox/unreachable.js";
import { DeviceAccess } from "./access.js";
import {
  baseOf,
  clipped,
  type DeviceProjectScope,
  homeUnknown,
  nameInvalid,
  nameTaken,
  outsideMode,
  readModeOf,
  tooBroad,
  withinMode,
} from "./project-rules.js";
// a path above the owner's home is never stored as a project: the working root would fall back for
// it anyway (project root §4.3), so both use the one rule; the home itself may be one
import { aboveHome } from "./working-root.js";

export { type DeviceProjectScope, readModeOf, withinMode } from "./project-rules.js";

/** The most projects one device keeps (project root §4.1). */
export const MAX_DEVICE_PROJECTS = 100;

/**
 * The holder name the projects service enters a device's sandbox under (`SandboxService`
 * `withSandbox`): it only lists directories, never runs a command, so no conversation holds it.
 */
const PROJECTS_HOLDER = "device-projects";

/** A project as the web and the Platform tool see it. */
export interface DeviceProjectView {
  name: string;
  /** The absolute path on the device. */
  path: string;
  createdAt: string;
}

/** `GET /devices/:id/projects`. */
export interface DeviceProjectList {
  /** The projects the device's current mode can read (the others are kept, only hidden). */
  projects: DeviceProjectView[];
  /** How many stored projects the current mode hides. */
  hidden: number;
  /** The mode the device runs at now. */
  mode: SandboxMode;
  /**
   * The base a relative path is resolved against: the workspace in sandbox mode and on a cloud
   * device, the owner's home in auto mode; null when that home is not known.
   */
  base: string | null;
  /** The device offers projects (a machine announcing `projects`, a provider with list / scan). */
  supported: boolean;
}

/** One suggestion of `GET /devices/:id/projects/candidates`. */
export interface DeviceProjectCandidateView {
  /** The absolute path on the device. */
  path: string;
  /** `path` relative to `base` (empty for the base itself), what the add form takes. */
  relativePath: string;
  suggestedName: string;
}

/** `GET /devices/:id/projects/candidates`. */
export interface DeviceProjectCandidates {
  candidates: DeviceProjectCandidateView[];
  mode: SandboxMode;
  base: string | null;
  supported: boolean;
}

type Scope = DeviceProjectScope;
/**
 * A device's projects (project root design §4.1, §4.2, §6): kept in `device_projects`, keyed by the
 * device's id, written only here. Only the device's owner reads or changes them (anyone else gets
 * `device.not_found`). Every project is scoped by the device's current effective mode
 * (`SandboxService.devicePolicy`, what the command review's mode derives from): sandbox mode and a cloud device
 * offer only the workspace, auto mode on a machine whatever its owner can read; a project outside
 * the mode is hidden, never deleted. The device stays the authority on what it can read: adding asks
 * it with `list`, the suggestions with `scan`, both carrying the current mode, both outside any
 * transaction; the insert then runs in its own, with uniqueness from the primary key.
 */
@Injectable()
export class DeviceProjectsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "withSandbox">,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    @Inject(PermissionFacts)
    private readonly facts: Pick<
      PermissionFacts,
      "resolveProjectForBinding" | "projectMatches" | "projectScope"
    >,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}

  /** The projects the device's current mode can read; see {@link DeviceProjectList}. */
  async list(orgId: string, accountId: string, deviceId: string): Promise<DeviceProjectList> {
    const scope = await this.scope(orgId, accountId, deviceId);
    const rows = await this.db
      .selectFrom("device_projects")
      .select(["name", "path", "created_at"])
      .where("device_id", "=", deviceId)
      .orderBy("name")
      .execute();
    // a device that offers no projects offers none of the stored ones either
    const visible = scope.supported ? rows.filter((r) => withinMode(scope, r.path)) : [];
    return {
      projects: visible.map((r) => ({
        name: r.name,
        path: r.path,
        createdAt: r.created_at.toISOString(),
      })),
      hidden: rows.length - visible.length,
      mode: scope.mode,
      base: baseOf(scope),
      supported: scope.supported,
    };
  }

  /**
   * The picker's suggestions: one `scan` of the base in the current mode (never file contents).
   * A device that offers no projects suggests none; auto mode without a known home is refused.
   */
  async candidates(
    orgId: string,
    accountId: string,
    deviceId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceProjectCandidates> {
    // ownership is the scope's; whether the provider can serve the device is withSandbox's
    const scope = await this.scope(orgId, accountId, deviceId);
    if (!scope.supported) {
      return { candidates: [], mode: scope.mode, base: baseOf(scope), supported: false };
    }
    if (baseOf(scope) === null) throw homeUnknown();
    return this.onDevice(orgId, accountId, deviceId, signal, async (h, p, workspace, sig) => {
      const base = baseOf(scope, workspace) as string;
      const scan = p.scan;
      if (scan === undefined) throw projectsUnsupported(false);
      let found: { path: string; suggestedName: string }[];
      try {
        found = await scan.call(p, h, base, { limits: { mode: readModeOf(scope) }, signal: sig });
      } catch (e) {
        // the base is the device's own workspace or home: a refusal there is not the person's path
        throw passThrough(e) ?? unavailable(e);
      }
      // the device's answer is checked again: inside the base and the mode, a valid name, bounded
      const candidates = found
        .filter(
          (c) =>
            validateSandboxPathShape(c.path).length === 0 &&
            (c.path === base || c.path.startsWith(base === "/" ? "/" : `${base}/`)) &&
            withinMode(scope, c.path, workspace) &&
            isDeviceProjectName(c.suggestedName),
        )
        .slice(0, MAX_DEVICE_SCAN_RESULTS)
        .map((c) => ({
          path: c.path,
          relativePath: relativeTo(base, c.path),
          suggestedName: c.suggestedName,
        }));
      return { candidates, mode: scope.mode, base, supported: true };
    });
  }

  /**
   * The read-only preconditions of {@link add} known before the device is asked (the Platform
   * operation's precheck): the owner, a device that offers projects, a valid and free name when
   * one is given, room for one more.
   */
  async checkAdd(
    orgId: string,
    accountId: string,
    deviceId: string,
    name: string | undefined,
  ): Promise<void> {
    await this.precheck(orgId, accountId, deviceId, name);
  }

  /** {@link checkAdd}, answering the scope it read. */
  private async precheck(
    orgId: string,
    accountId: string,
    deviceId: string,
    name: string | undefined,
  ): Promise<Scope> {
    await this.access.usable(orgId, accountId, deviceId);
    const scope = await this.scope(orgId, accountId, deviceId);
    if (!scope.supported) throw projectsUnsupported(scope.source === "local");
    if (baseOf(scope) === null) throw homeUnknown();
    if (name !== undefined && !isDeviceProjectName(name)) throw nameInvalid(name);
    const rows = await this.db
      .selectFrom("device_projects")
      .select("name")
      .where("device_id", "=", deviceId)
      .execute();
    if (name !== undefined && rows.some((r) => r.name === name)) throw nameTaken(name);
    if (rows.length >= MAX_DEVICE_PROJECTS) throw limitReached();
    return scope;
  }

  /**
   * Adds a project: `path` is resolved against the base of the device's current mode and must
   * stay inside what that mode reads and not lie above the owner's home ({@link aboveHome},
   * `device.project_path_too_broad`); `name` defaults to the directory's basename. The device is
   * asked `list(path, { limit: 1 })` first, outside any transaction: an answer (even no entries)
   * is a readable directory, null a missing one, an error a file, an unreadable path or one the
   * device refused in its mode; each is a readable refusal. Then the insert, serialized per device.
   */
  async add(
    orgId: string,
    accountId: string,
    deviceId: string,
    input: { path: string; name?: string },
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceProjectView> {
    const scope = await this.precheck(orgId, accountId, deviceId, input.name);
    // a path too broad for any project is refused before the device is leased (a cloud device
    // started): against the last known base; the held instance's base is checked again inside
    const early = baseOf(scope);
    if (early !== null) {
      const path = trimSlash(
        posix.normalize(posix.join(early, input.path === "" ? "." : input.path)),
      );
      // outside the mode stays the device-side refusal it is (the held workspace decides it)
      if (withinMode(scope, path) && aboveHome(path, scope.home)) throw tooBroad(path);
    }
    const resolved = await this.onDevice(
      orgId,
      accountId,
      deviceId,
      signal,
      async (h, p, workspace, sig) => {
        const path = resolve(scope, workspace, input.path);
        const name = input.name ?? posix.basename(path);
        if (!isDeviceProjectName(name)) throw nameInvalid(name);
        const list = p.list;
        if (list === undefined) throw projectsUnsupported(false);
        let answer: Awaited<ReturnType<NonNullable<SandboxProvider["list"]>>>;
        try {
          answer = await list.call(p, h, path, {
            limit: 1,
            limits: { mode: readModeOf(scope) },
            signal: sig,
          });
        } catch (e) {
          throw await listFailure(e, p, h, path, scope.mode, sig);
        }
        if (answer === null) throw pathMissing(path);
        return { path, name };
      },
    );
    return withOrderedLocks(
      () => this.lockSubject(orgId, accountId, deviceId),
      () => this.insert(orgId, accountId, deviceId, resolved, actorTokenId, auditDetail),
    );
  }

  /**
   * The owner's live device row, then its permission authority lock: the ordered prelude of the
   * project writes (`withOrderedLocks`), so inside a run's fence (the Platform tool's
   * `devices.add-project` / `devices.remove-project`) they follow the org row and precede the
   * conversation rows. The writes name both again (already held: a re-check).
   */
  @Transactional({ propagation: "mandatory" })
  private async lockSubject(orgId: string, accountId: string, deviceId: string): Promise<void> {
    await this.lockOwn(orgId, accountId, deviceId);
    await this.ceilings.lock({ orgId, deviceId }, "device");
  }

  /** The insert of {@link add}: the owner's live device locked, the count and the name checked. */
  @Transactional()
  private async insert(
    orgId: string,
    accountId: string,
    deviceId: string,
    p: { path: string; name: string },
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<DeviceProjectView> {
    await this.lockOwn(orgId, accountId, deviceId);
    await this.ceilings.lock({ orgId, deviceId }, "device");
    const count = await this.db
      .selectFrom("device_projects")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("device_id", "=", deviceId)
      .executeTakeFirstOrThrow();
    if (count.n >= MAX_DEVICE_PROJECTS) throw limitReached();
    const row = await this.db
      .insertInto("device_projects")
      .values({ device_id: deviceId, name: p.name, path: p.path, created_by: accountId })
      .onConflict((c) => c.columns(["device_id", "name"]).doNothing())
      .returning(["name", "path", "created_at"])
      .executeTakeFirst();
    if (row === undefined) throw nameTaken(p.name);
    await this.ceilings.publishLocked({ orgId, deviceId }, "device", false);
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.project_added",
      target: deviceId,
      detail: { name: p.name, path: p.path, ...auditDetail },
    });
    return { name: row.name, path: row.path, createdAt: row.created_at.toISOString() };
  }

  /** Removes a project of the owner's device; removing one that is not there succeeds. */
  async remove(
    orgId: string,
    accountId: string,
    deviceId: string,
    name: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    await withOrderedLocks(
      () => this.lockSubject(orgId, accountId, deviceId),
      () => this.removeIn(orgId, accountId, deviceId, name, actorTokenId, auditDetail),
    );
  }

  @Transactional()
  private async removeIn(
    orgId: string,
    accountId: string,
    deviceId: string,
    name: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<void> {
    await this.lockOwn(orgId, accountId, deviceId);
    await this.ceilings.lock({ orgId, deviceId }, "device");
    const gone = await this.db
      .deleteFrom("device_projects")
      .where("device_id", "=", deviceId)
      .where("name", "=", name)
      .returning("path")
      .executeTakeFirst();
    if (gone === undefined) return;
    const roots = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("project_name", "=", name)
      .where("project_path", "=", gone.path)
      .execute();
    const affected = new Set(roots.map((r) => r.id));
    await this.ceilings.publishLocked(
      { orgId, deviceId },
      "device",
      (_scope, row) => row.root_conversation_id !== null && affected.has(row.root_conversation_id),
    );
    if (affected.size)
      await this.db
        .updateTable("conversations")
        .set((eb) => ({
          permission_profile: "approve-for-me",
          permission_consent: null,
          permission_revision: eb("permission_revision", "+", 1),
        }))
        .where("id", "in", [...affected])
        .where("permission_profile", "=", "full-access")
        .execute();
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "device.project_removed",
      target: deviceId,
      detail: { name, path: gone.path, ...auditDetail },
    });
  }

  /**
   * The project a new conversation of `accountId` binds to (project root §4.3): one of the
   * owner's device's projects that its current mode can read. Refused with `device.not_found`
   * (not the caller's device), `device.projects_unsupported`, `device.project_not_found` or
   * `device.project_outside_mode` or `device.project_path_too_broad`. Reads only (the caller's transaction, if any); the device is
   * not asked: it enforces its mode on every access anyway.
   */
  async resolveForBinding(
    orgId: string,
    deviceId: string,
    accountId: string,
    name: string,
  ): Promise<{ name: string; path: string }> {
    return this.facts.resolveProjectForBinding(orgId, deviceId, accountId, name);
  }

  /**
   * Whether the device still keeps the project `name` at `path` (project root §4.3): a binding is
   * the name and the path, so a project removed, or re-added under that name with another path, no
   * longer serves the conversations bound to it. Reads only.
   */
  async keeps(deviceId: string, name: string, path: string): Promise<boolean> {
    return this.facts.projectMatches(deviceId, name, path);
  }

  /**
   * The owner's live device's scope now ({@link scope}), for a run start's read of its bound
   * project (project root §4.4): the mode to read in and whether the device offers projects.
   * Reads only; anyone else's device (or a missing one) → `device.not_found`.
   */
  async scopeFor(orgId: string, accountId: string, deviceId: string): Promise<DeviceProjectScope> {
    return this.scope(orgId, accountId, deviceId);
  }

  /**
   * The owner's live device's scope now: its source, its effective mode
   * (`SandboxService.devicePolicy`: the platform, the org and the device's own choice; for a cloud
   * device never the wider mode an instance awaiting a files reset still runs at), the workspace and home as last reported, and whether it
   * offers projects. Anyone else's device (or a missing one) → `device.not_found`.
   */
  private async scope(orgId: string, accountId: string, deviceId: string): Promise<Scope> {
    return this.facts.projectScope(orgId, accountId, deviceId);
  }

  /**
   * Runs `fn` on the device (`SandboxService.withSandbox`: its instance made or resumed as for a
   * tool call) with the workspace root its instance reports. Kernel refusals (offline, files lost,
   * busy, unavailable) stay as they are; anything else becomes a readable
   * `device.projects_unavailable`, never a 500.
   */
  private async onDevice<T>(
    orgId: string,
    accountId: string,
    deviceId: string,
    signal: AbortSignal,
    fn: (h: SandboxHandle, p: HeldProvider, workspace: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sandbox.withSandbox(
        {
          orgId,
          deviceId,
          holderConversationId: PROJECTS_HOLDER,
          actor: { accountId, conversationId: PROJECTS_HOLDER },
        },
        (h, p, info, sig) => fn(h, p, info.roots.workspace, sig),
        signal,
      );
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof SandboxProviderUnreachableError) throw providerUnreachable();
      throw unavailable(e);
    }
  }

  /** Locks the owner's live device row (serializes its project writes); else `not_found`. */
  private async lockOwn(orgId: string, accountId: string, deviceId: string): Promise<void> {
    const row = await this.db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (row === undefined) throw deviceNotFound();
  }
}

/**
 * A project read on a device whose sandbox provider cannot be reached (the projects routes, a
 * person's project skill invocation).
 */
export const providerUnreachable = (): ApiError =>
  new ApiError(
    "device.projects_unavailable",
    "The device's sandbox provider cannot be reached now; try again shortly",
  );

const limitReached = (): ApiError =>
  new ApiError(
    "device.project_limit_reached",
    `This device already has ${MAX_DEVICE_PROJECTS} projects, the most allowed; remove one first`,
  );

/** `path` without a trailing `/` (except `/` itself). */
const trimSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * The absolute path of `relative` against the scope's base (the instance's `workspace` in sandbox
 * mode and on a cloud device, the owner's home in auto mode), normalized; refused when the base is
 * unknown, the result is not a valid path, or it leaves what the mode reads.
 */
function resolve(scope: Scope, workspace: string, relative: string): string {
  const base = baseOf(scope, workspace);
  if (base === null) throw homeUnknown();
  const path = trimSlash(posix.normalize(posix.join(base, relative === "" ? "." : relative)));
  if (validateSandboxPathShape(path).length > 0 || !withinMode(scope, path, workspace)) {
    throw outsideMode(path, scope.mode);
  }
  if (aboveHome(path, scope.home)) throw tooBroad(path);
  return path;
}

/**
 * An error the projects service passes on as it is: a lost instance or file system (for
 * `withSandbox` to handle), a kernel refusal (offline, busy, unavailable), an unreachable provider;
 * a malformed device answer becomes `device.projects_unavailable` (the program's fault). Undefined
 * for anything else.
 */
function passThrough(e: unknown): unknown {
  if (isSandboxGoneError(e) || isFileSystemGoneError(e) || e instanceof ApiError) return e;
  if (e instanceof SandboxProviderUnreachableError) return e;
  if (e instanceof DeviceProtocolError) {
    return new ApiError(
      "device.projects_unavailable",
      "The device answered in a form this kernel does not accept; update capybara-device on that machine",
    );
  }
  return undefined;
}

/**
 * The device could not be asked now (a failure on the machine or at the provider, an abort, a lost
 * lease): 503 `device.projects_unavailable`. Only a `ToolError`'s message (the relay's, written for
 * people) is passed on; a provider's own error text is not.
 */
function unavailable(e: unknown): ApiError {
  return new ApiError(
    "device.projects_unavailable",
    e instanceof ToolError
      ? `The device could not be asked now: ${clipped(e.message)}`
      : "The device could not be asked now; try again shortly",
  );
}

const pathMissing = (path: string): ApiError =>
  new ApiError(
    "device.project_path_missing",
    `${clipped(path)} does not exist on the device; check the path`,
  );

/**
 * What a failed `list(path)` becomes. A machine's policy refusal is the device refusing the path
 * in its mode (`device.project_outside_mode`). Any other error alone cannot tell a file or an
 * unreadable directory from a failure on the device, so the device is asked `stat(path)`: a file
 * or a directory it cannot list is the path's problem (422 `device.project_path_unreadable`), a
 * missing path `device.project_path_missing`, and a `stat` that fails too means the device could
 * not be asked (503 `device.projects_unavailable`).
 */
async function listFailure(
  e: unknown,
  p: HeldProvider,
  h: SandboxHandle,
  path: string,
  mode: SandboxMode,
  signal: AbortSignal,
): Promise<unknown> {
  const passed = passThrough(e);
  if (passed !== undefined) return passed;
  const why = e instanceof ToolError ? ` (${clipped(e.message)})` : "";
  if (e instanceof ToolError && e.message.startsWith(POLICY_REFUSAL_PREFIX)) {
    return new ApiError(
      "device.project_outside_mode",
      `The device refused ${clipped(path)} in ${mode} mode${why}`,
    );
  }
  let st: { size: number; isDir: boolean } | null;
  try {
    st = await p.stat(h, path, signal);
  } catch (e2) {
    return passThrough(e2) ?? unavailable(e);
  }
  if (st === null) return pathMissing(path);
  return new ApiError(
    "device.project_path_unreadable",
    st.isDir
      ? `${clipped(path)} is a directory the device cannot read${why}`
      : `${clipped(path)} is a file, not a directory`,
  );
}

const relativeTo = (base: string, path: string): string =>
  path === base ? "" : posix.relative(base, path);
