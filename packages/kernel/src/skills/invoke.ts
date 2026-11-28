import {
  escapeSkillInvocationTags,
  hasShellInjection,
  parseSkillMd,
  renderSkillBody,
  renderSkillInvocation,
  rootsOf,
  type SandboxHandle,
  SKILL_ENTRY_FILE,
  SKILL_INVOCATION_LIMITS,
  SKILLS_SANDBOX_ROOT,
  skillDigest,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { AgentLookup } from "../agents/agent-lookup.js";
import { type AgentDefinition, builtinDisabled } from "../agents/definition.js";
import { EventLog } from "../conversations/event-log.js";
import type { EventPayload } from "../conversations/events.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  callableProjectSkills,
  type ProjectRootPayload,
  projectSkillName,
  projectSkillOf,
} from "../runtime/context/project-root.js";
import { isGeneralAlias, resolveSkillForkType } from "../runtime/subagents/roster.js";
import { PROJECT_SKILLS_DIR } from "../sandbox/kernel-read.js";
import { StorageService } from "../storage/storage.service.js";
import { BUILTIN } from "../tools/builtin-names.js";
import {
  findSkillVersion,
  readSkillFile,
  SkillIntegrityError,
} from "../tools/builtins/skill-load.js";
import { invocationOf, type ResolvedSkill, resolveSkills } from "./catalog.js";
import { skillFileStore } from "./usable.js";

/**
 * A person's skill invocation (phase D spec §3, §4): the `/` menu's list of the agent's invocable
 * skills, and the rendering of `/name args` into the model-visible text of their message. The skill
 * is resolved among the agent's effective skills **at send time** (its current version, the
 * conversation's trial drafts), its SKILL.md is read from object storage and checked against the
 * manifest, and it is rendered by the SDK; nothing is executed (A1). The caller appends the text as
 * `content[0]` of the `user_message` together with {@link RenderedInvocation.skill}.
 */

/**
 * Where a `/` menu entry comes from (project root spec §4.6; the palette groups by it): the agent's
 * own skill, a plugin's, the org library or the platform (`platform`), or the conversation's
 * project.
 */
export type InvocableSource = "platform" | "plugin" | "agent" | "project";

/** One skill of the `/` menu (`GET …/agents/:agentId/invocable-skills`). */
export interface InvocableSkill {
  /** A project skill's is its callable name, `project:<name>` (it has no row). */
  id: string;
  /** The bare name; a project skill's callable name `project:<name>`. */
  name: string;
  source: InvocableSource;
  /** The plugin (catalog item) it came from. */
  plugin?: string;
  description: string;
  version: number;
  argumentHint?: string;
  arguments?: string[];
  /** Manual-only: not in the model's catalog. */
  manual: boolean;
  /** Runs as a sub-agent when a person invokes it. */
  fork: boolean;
}

/**
 * The skills root of device `deviceId` as last known (#904): its instance's handle
 * (`rootsOf`, e.g. a connected machine's `<home>/<device>/skills`), else `/skills`. Read from the
 * database only: no device call, no binding. An invocation renders `${CLAUDE_SKILL_DIR}` and its
 * files line under it, so the path the model reads is the one `Skill` copies the files to.
 */
export async function knownSkillsRoot(
  db: KernelSchemaDb,
  orgId: string,
  deviceId: string | null | undefined,
): Promise<string> {
  if (deviceId === null || deviceId === undefined) return SKILLS_SANDBOX_ROOT;
  const row = await db
    .selectFrom("device_instances")
    .select("handle")
    .where("device_id", "=", deviceId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  const handle = row?.handle as SandboxHandle | null | undefined;
  return handle ? rootsOf(handle).skills : SKILLS_SANDBOX_ROOT;
}

/** {@link knownSkillsRoot} of the device conversation `conversationId` is bound to. */
export async function conversationSkillsRoot(
  db: KernelSchemaDb,
  orgId: string,
  conversationId: string,
): Promise<string> {
  const conv = await db
    .selectFrom("conversations")
    .select("device_id")
    .where("id", "=", conversationId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return knownSkillsRoot(db, orgId, conv?.device_id);
}

/** The `skill` field of a `user_message`. */
export type InvocationRecord = NonNullable<EventPayload<"user_message">["skill"]>;

/** The result of {@link SkillInvoker.prepare}. */
export interface RenderedInvocation {
  /** The model-visible text of the person's message (`content[0]`). */
  text: string;
  skill: InvocationRecord;
  /**
   * Fork only: the rendered skill without the lead sentence (the sub-agent's task). Checks the
   * size at send time; the dispatch renders it again from the record ({@link SkillInvoker.renderTask}).
   */
  task?: string;
  /** Fork only: the requested sub-agent type did not resolve (recorded at dispatch, §6.2). */
  warning?: string;
}

/** A leading `/<name>` or `/<plugin>:<name>`, then whitespace or the end (spec §3.2). */
const SLASH_COMMAND_RE = /^\/([a-z0-9-]+(?::[a-z0-9-]+)?)(?:\s|$)/;

/** `/name args` at the very start of a message, or null (`/etc/hosts`, ` /x`, `/Upper`). */
export const parseSlashCommand = (text: string): { name: string; args: string } | null => {
  const m = SLASH_COMMAND_RE.exec(text);
  if (!m) return null;
  return { name: m[1] as string, args: text.slice(m[0].length).trim() };
};

/** A Claude Code style qualified name `<plugin>:<skill>`. */
const QUALIFIED_RE = /^([a-z0-9][a-z0-9-]{0,63}):(.+)$/;

/** The effective skill `name` names: exactly, or `<plugin>:<name>` for a plugin's skill. */
function findSkill(all: readonly ResolvedSkill[], name: string): ResolvedSkill | undefined {
  const exact = all.find((r) => r.skill.name === name);
  if (exact) return exact;
  const m = QUALIFIED_RE.exec(name);
  if (!m) return undefined;
  return all.find((r) => r.skill.name === m[2] && r.skill.plugin === m[1]);
}

/** Why a person cannot invoke a skill (`skill.not_invocable` details). */
export type NotInvocableReason = "not_found" | "not_user_invocable";

export const notInvocable = (reason: NotInvocableReason, name: string) =>
  new ApiError(
    "skill.not_invocable",
    reason === "not_found"
      ? `Skill "${name}" is not one of this agent's skills`
      : `Skill "${name}" cannot be invoked by a person`,
    [{ reason }],
  );

/** Why a listed project skill cannot be used now (`skill.project_unavailable` details). */
export type ProjectUnavailableReason =
  | "gone"
  | "outside_mode"
  | "unreadable"
  | "unparsable"
  | "unsupported"
  | "removed"
  | "skill_tool_off";

/** A project skill the project lists but cannot be used now: the person is told why. */
const projectUnavailable = (reason: ProjectUnavailableReason, message: string) =>
  new ApiError("skill.project_unavailable", message, [{ reason }]);

/** Where an effective skill comes from, for the `/` menu ({@link InvocableSource}). */
export const invocableSource = (r: {
  scope: ResolvedSkill["scope"];
  skill: { plugin?: string | undefined };
}): InvocableSource =>
  r.scope === "agent" ? "agent" : r.skill.plugin !== undefined ? "plugin" : "platform";

/**
 * The `/` menu entries of a conversation's latest `project_root` (project root spec §4.6: what the
 * model saw, never a fresh read of the device): its skills as `project:<name>`, sorted, none for an
 * unavailable project or none. A skill whose callable name `Skill` cannot take is left out, as in
 * the model's list.
 */
export function projectInvocables(p: ProjectRootPayload | undefined): InvocableSkill[] {
  if (p === undefined || p.unavailable !== undefined) return [];
  return callableProjectSkills(p)
    .map((s) => ({
      id: projectSkillName(s.name),
      name: projectSkillName(s.name),
      source: "project" as const,
      description: s.description,
      version: 0,
      manual: false,
      fork: false,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether a recorded project skill invocation (`project:<name>`) is still one of the latest usable
 * `project_root`'s skills; null when it is.
 */
export function projectSkillBlocked(
  p: ProjectRootPayload | undefined,
  name: string,
): NotInvocableReason | null {
  return projectInvocables(p).some((s) => s.name === name) ? null : "not_found";
}

/** The payload of the conversation's latest `project_root`, read with `db`. */
async function latestProjectRoot(
  db: KernelSchemaDb,
  conversationId: string,
): Promise<ProjectRootPayload | undefined> {
  const row = await db
    .selectFrom("conversation_events")
    .select("payload")
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "project_root")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.payload as ProjectRootPayload | undefined;
}

/** A conversation's project binding: the device and the project's name and root. */
export interface ProjectBinding {
  deviceId: string;
  name: string;
  path: string;
}

/** How many of the caller's bound conversations {@link latestKnownProjectRoot} looks through. */
const KNOWN_SNAPSHOT_CONVERSATIONS = 20;

/**
 * The last known snapshot of a project (project skills before the first run, design §3.1): the
 * newest usable `project_root` among the caller's own chat conversations bound to the same device,
 * project name and root (each conversation's latest one). What a run of the same person read from
 * that project; the device is never asked. Undefined when none is known.
 */
export async function latestKnownProjectRoot(
  db: KernelSchemaDb,
  a: { orgId: string; accountId: string; binding: ProjectBinding },
): Promise<ProjectRootPayload | undefined> {
  const rows = await db
    .selectFrom("conversations as c")
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom("conversation_events as e")
          .select(["e.payload", "e.created_at"])
          .whereRef("e.conversation_id", "=", "c.id")
          .where("e.type", "=", "project_root")
          .orderBy("e.seq", "desc")
          .limit(1)
          .as("p"),
      (join) => join.onTrue(),
    )
    .select("p.payload")
    .where("c.org_id", "=", a.orgId)
    .where("c.account_id", "=", a.accountId)
    .where("c.kind", "=", "chat")
    .where("c.deleted_at", "is", null)
    .where("c.device_id", "=", a.binding.deviceId)
    .where("c.project_name", "=", a.binding.name)
    .where("c.project_path", "=", a.binding.path)
    .orderBy("p.created_at", "desc")
    .limit(KNOWN_SNAPSHOT_CONVERSATIONS)
    .execute();
  return rows.map((r) => r.payload as ProjectRootPayload).find((p) => p.unavailable === undefined);
}

/**
 * The snapshot a conversation's project skills come from: its own latest `project_root`, or, when
 * its runs never recorded one, the last known snapshot of its binding among its owner's
 * conversations ({@link latestKnownProjectRoot}). `own` says which. Undefined when neither exists.
 */
export async function projectSnapshotOf(
  db: KernelSchemaDb,
  a: { orgId: string; conversationId: string },
  /** The conversation's own latest `project_root` (default: read with `db`). */
  ownLatest: () => Promise<ProjectRootPayload | undefined> = () =>
    latestProjectRoot(db, a.conversationId),
): Promise<{ payload: ProjectRootPayload; own: boolean } | undefined> {
  const own = await ownLatest();
  if (own !== undefined) return { payload: own, own: true };
  const bound = await bindingOf(db, a);
  if (bound === undefined) return undefined;
  const known = await latestKnownProjectRoot(db, { orgId: a.orgId, ...bound });
  return known === undefined ? undefined : { payload: known, own: false };
}

/** The conversation's owner and project binding, or undefined for a free conversation. */
async function bindingOf(
  db: KernelSchemaDb,
  a: { orgId: string; conversationId: string },
): Promise<{ accountId: string; binding: ProjectBinding } | undefined> {
  const row = await db
    .selectFrom("conversations")
    .select(["account_id", "device_id", "project_name", "project_path"])
    .where("id", "=", a.conversationId)
    .where("org_id", "=", a.orgId)
    .executeTakeFirst();
  if (!row || row.device_id === null || row.project_name === null || row.project_path === null)
    return undefined;
  return {
    accountId: row.account_id,
    binding: { deviceId: row.device_id, name: row.project_name, path: row.project_path },
  };
}

/**
 * Whether the skill a queued invocation recorded is still one a person can invoke in this
 * conversation (phase D Task 9, checked again at dispatch): the same skill (by id) among the
 * agent's effective skills now, with `user` not false. Its version may have changed: the queued
 * text stays as rendered when queued. Null when it is, else the reason.
 */
export async function recordedSkillBlocked(
  db: KernelSchemaDb,
  a: {
    orgId: string;
    agentId: string;
    agent: Pick<AgentDefinition, "disabledSkills">;
    conversationId: string;
    skillId: string;
  },
): Promise<NotInvocableReason | null> {
  if (projectSkillOf(a.skillId) !== undefined) {
    const snapshot = await projectSnapshotOf(db, a);
    return projectSkillBlocked(snapshot?.payload, a.skillId);
  }
  const found = (await resolveSkills(db, a)).find((r) => r.skill.id === a.skillId);
  if (!found) return "not_found";
  return invocationOf(found.manifest).user ? null : "not_user_invocable";
}

/** The model-visible text of a fork invocation in the parent's log (spec §6.3, frozen). */
export const forkLeadText = (name: string, agentType: string, args: string): string =>
  escapeSkillInvocationTags(
    `The user ran the skill "${name}" in a sub-agent (${agentType}) with /${name}${args === "" ? "" : ` ${args}`}. The sub-agent gets the skill's instructions as its task; its report follows. Do not do the task yourself.`,
  );

/**
 * A person's `/project:<name>` invocation (permission activation L2, Hook 2): no device read at
 * send time (a person's send has no run, so nothing could admit it). The message is a stub
 * rendered from the conversation's latest `project_root` (the skill's name, its recorded digest,
 * its directory in the project and the person's arguments) telling the agent to load
 * `project:<name>` with its `Skill` tool, which reads it under the run's admission. Model-visible,
 * so English; tags in the arguments stay inert. Always inline, as before.
 */
export function projectSkillStub(
  a: { name: string; args: string },
  latest: ProjectRootPayload,
  bare: string,
  /**
   * Where `latest` comes from: `run`, this conversation's run start; `known`, the last known
   * snapshot of the project from another conversation (no run of this one read it yet).
   */
  from: "run" | "known" = "run",
): RenderedInvocation {
  const skill = latest.skills.find((s) => s.name === bare);
  if (skill === undefined) throw notInvocable("not_found", a.name);
  const args = a.args.trim();
  if ([...args].length > SKILL_INVOCATION_LIMITS.argumentsMaxChars) {
    throw new ApiError("validation_failed", "Request validation failed", [
      {
        path: "text",
        message: `skill arguments must be at most ${SKILL_INVOCATION_LIMITS.argumentsMaxChars} characters; shorten the arguments`,
      },
    ]);
  }
  const root =
    latest.root.length > 1 && latest.root.endsWith("/") ? latest.root.slice(0, -1) : latest.root;
  const dir = `${root === "/" ? "" : root}/${PROJECT_SKILLS_DIR}/${bare}`;
  const text = escapeSkillInvocationTags(
    [
      `The user invoked the project skill "${a.name}" with /${a.name}${args === "" ? "" : ` ${args}`}.`,
      `Its instructions are not included in this message: call ${BUILTIN.Skill} with the name "${a.name}" to load them from the project (its directory is ${dir}; the SKILL.md ${from === "run" ? "recorded at the run start" : "last recorded for this project"} has the digest ${skill.digest}), then follow them${args === "" ? "." : " with the user's arguments:"}`,
      ...(args === "" ? [] : [args]),
    ].join("\n\n"),
  );
  return {
    text,
    skill: {
      id: a.name,
      version: 0,
      source: "project",
      name: a.name,
      arguments: args,
      mode: "inline",
    },
  };
}

/** The warning recorded when a forked skill's `agent` does not resolve (spec §6.2). */
export const forkAgentUnknownText = (name: string, agent: string): string =>
  `Skill "${name}" asked for sub-agent type "${agent}", which this agent does not have; it ran as general-purpose.`;

/**
 * Skill invocations by a person (one provider: the HTTP routes, IM channels and fork dispatch all
 * use it). Unreadable SKILL.md files are logged at `error` (skill id, version, source), as pinned
 * skills; the agent access check of {@link SkillInvoker.listFor} is `AgentLookup.get`.
 */
@Injectable()
export class SkillInvoker {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    /** A bound conversation's latest `project_root` (its project skills). */
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "latestOfType">,
  ) {}

  /**
   * The `/` menu for `accountId`: the agent must be usable by them (`agent.not_found`), and with
   * `conversationId` the conversation must be theirs and the agent's (`conversation.not_found`);
   * then its trial drafts apply, and its latest usable `project_root` adds the project's skills
   * after the agent's ({@link projectInvocables}).
   */
  async listFor(
    orgId: string,
    agentId: string,
    accountId: string,
    conversationId?: string,
    /**
     * Without `conversationId`: the new conversation's picked device project (design §3.2), whose
     * last known snapshot adds the project's skills.
     */
    pick?: { deviceId: string; project: string },
  ): Promise<InvocableSkill[]> {
    const agent = await this.agents.get(orgId, agentId, accountId);
    if (conversationId !== undefined) {
      const row = await this.db
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", conversationId)
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("agent_id", "=", agentId)
        .where("kind", "=", "chat")
        .executeTakeFirst();
      if (!row) throw new ApiError("conversation.not_found", "Conversation not found");
    }
    const skills = await this.list({
      orgId,
      agentId,
      agent: agent.definition,
      ...(conversationId !== undefined && { conversationId }),
    });
    // a project skill is loaded by the agent's Skill tool: none without it
    if (!hasBuiltin(agent.definition, BUILTIN.Skill)) return skills;
    if (conversationId !== undefined) {
      const snapshot = await this.conversationSnapshot(orgId, conversationId);
      return [...skills, ...projectInvocables(snapshot?.payload)];
    }
    if (pick === undefined) return skills;
    const binding = await this.pickedBinding(pick.deviceId, pick.project);
    if (binding === undefined) return skills;
    const known = await latestKnownProjectRoot(this.db.db, { orgId, accountId, binding });
    return [...skills, ...projectInvocables(known)];
  }

  /**
   * The device project a new conversation picked, by device and name, or undefined when the device
   * has no project of that name. Only its last known snapshot among the caller's own conversations
   * is used, so nothing of someone else's device can be read through it.
   */
  private async pickedBinding(deviceId: string, name: string): Promise<ProjectBinding | undefined> {
    const row = await this.db.db
      .selectFrom("device_projects")
      .select("path")
      .where("device_id", "=", deviceId)
      .where("name", "=", name)
      .executeTakeFirst();
    return row === undefined ? undefined : { deviceId, name, path: row.path };
  }

  /**
   * The agent's effective skills a person can invoke (`user` not false), sorted by name (code
   * point order), model-invocable and manual-only alike (spec §3.1).
   */
  async list(a: {
    orgId: string;
    agentId: string;
    agent: Pick<AgentDefinition, "disabledSkills">;
    conversationId?: string;
  }): Promise<InvocableSkill[]> {
    const all = await resolveSkills(this.db.db, a);
    const out: InvocableSkill[] = [];
    for (const r of all) {
      const inv = invocationOf(r.manifest);
      if (!inv.user) continue;
      out.push({
        id: r.skill.id,
        name: r.skill.name,
        source: invocableSource(r),
        ...(r.skill.plugin !== undefined && { plugin: r.skill.plugin }),
        description: r.skill.description,
        version: r.skill.version,
        ...(inv.argumentHint !== undefined && { argumentHint: inv.argumentHint }),
        ...(inv.arguments !== undefined && { arguments: inv.arguments }),
        manual: !inv.model,
        fork: inv.fork !== undefined,
      });
    }
    return out;
  }

  /**
   * Resolves `name` among the agent's effective skills now, reads its SKILL.md and renders the
   * invocation (spec §4.2, §4.3, §6.3). Refusals: `skill.not_invocable` (400); arguments or a
   * rendered text over the limits → `validation_failed` (400); a storage failure or a SKILL.md
   * that fails its integrity check → `storage.unavailable` (503). Nothing is written here.
   * `project:<name>` is the conversation's project skill ({@link prepareProject}).
   */
  async prepare(a: {
    orgId: string;
    agentId: string;
    /** The person sending (a project skill is read on the device as them). */
    accountId: string;
    /** Absent for the first message of a conversation not created yet. */
    conversationId?: string;
    /**
     * The conversation's device (the one a new conversation is created with); its skills root
     * names the skill's directory ({@link knownSkillsRoot}). Null or absent: `/skills`.
     */
    deviceId?: string | null;
    /**
     * The first message of a conversation not created yet: the project it is created bound to, as
     * the creation resolves it (its last known snapshot renders a project skill, design §3.3).
     */
    project?: { name: string; path: string };
    agent: AgentDefinition;
    name: string;
    args: string;
  }): Promise<RenderedInvocation> {
    // project root spec §4.6: the prefix is the project's, never a plugin's qualified name
    const bare = projectSkillOf(a.name);
    if (bare !== undefined) return this.prepareProject(a, bare);
    const all = await resolveSkills(this.db.db, a);
    const found = findSkill(all, a.name);
    if (!found) throw notInvocable("not_found", a.name);
    const inv = invocationOf(found.manifest);
    if (!inv.user) throw notInvocable("not_user_invocable", a.name);
    const body = await this.readBody(a.orgId, found);
    const others = found.manifest.files.some((f) => f.path !== SKILL_ENTRY_FILE);
    const lines = {
      // the invocation itself makes the conversation's next run offer Skill (skillLoadOffered)
      ...(others && { files: "load" as const }),
      ...(hasShellInjection(body) &&
        hasBuiltin(a.agent, BUILTIN.Bash) && { shellHint: true as const }),
    };
    const input = {
      name: a.name,
      skillName: found.skill.name,
      digest: skillDigest(found.manifest.files),
      version: found.skill.version,
      body,
      invocation: inv,
      args: a.args,
      lines,
      skillsRoot: await knownSkillsRoot(this.db.db, a.orgId, a.deviceId),
    };
    // a SKILL.md whose body alone renders over the limit can never be invoked: say so, rather than
    // "shorten the arguments"
    tooLarge(found.skill.name, () =>
      renderSkillBody(body, inv, "", found.skill.name, input.digest),
    );
    const args = a.args.trim();
    const record: InvocationRecord = {
      id: found.skill.id,
      version: found.skill.version,
      source: found.skill.source,
      name: found.skill.name,
      ...(found.skill.plugin !== undefined && { plugin: found.skill.plugin }),
      arguments: args,
      mode: inv.fork ? "fork" : "inline",
    };
    if (!inv.fork) return { text: rendered(() => renderSkillInvocation(input)), skill: record };
    const task = rendered(() => renderSkillInvocation({ ...input, lead: false }));
    const type = await resolveSkillForkType(
      this.db.db,
      a.orgId,
      a.agent,
      inv.fork.agent,
      found.skill.plugin,
    );
    return {
      text: forkLeadText(a.name, type.agentType, args),
      skill: { ...record, agentType: type.agentType },
      task,
      ...(type.unknown !== undefined && {
        warning: forkAgentUnknownText(a.name, type.unknown),
      }),
    };
  }

  /**
   * A person's invocation of `project:<name>` (project root spec §4.6): resolved from the
   * conversation's latest `project_root` (what the model saw). The device is not read at send
   * time: the invocation is the recorded stub ({@link projectSkillStub}), which the agent's
   * `Skill` tool loads. Refusals: `skill.not_invocable` `not_found` (no conversation yet, no
   * project, a name it does not list), `skill.project_unavailable` with its reason (the latest
   * project is unavailable), and `skill.project_unavailable` `skill_tool_off` for an agent without
   * the `Skill` tool.
   */
  private async prepareProject(
    a: {
      orgId: string;
      accountId: string;
      conversationId?: string;
      deviceId?: string | null;
      project?: { name: string; path: string };
      agent: AgentDefinition;
      name: string;
      args: string;
    },
    bare: string,
  ): Promise<RenderedInvocation> {
    const snapshot = await this.projectSnapshot(a);
    const latest = snapshot?.payload;
    if (latest?.unavailable !== undefined) {
      throw projectUnavailable(
        latest.unavailable.reason,
        `Skill "${a.name}" cannot be invoked: the project "${latest.project}" is not available (${latest.unavailable.message})`,
      );
    }
    if (projectSkillBlocked(latest, a.name) !== null || latest === undefined) {
      throw notInvocable("not_found", a.name);
    }
    // no device read at send time: the agent loads the skill with Skill
    if (!hasBuiltin(a.agent, BUILTIN.Skill))
      throw projectUnavailable(
        "skill_tool_off",
        `Skill "${a.name}" cannot be invoked: this agent cannot load project skills; turn on its ${BUILTIN.Skill} tool`,
      );
    return projectSkillStub(a, latest, bare, snapshot?.own === false ? "known" : "run");
  }

  /** {@link projectSnapshotOf}, the conversation's own latest read through the event log. */
  private conversationSnapshot(
    orgId: string,
    conversationId: string,
  ): Promise<{ payload: ProjectRootPayload; own: boolean } | undefined> {
    return projectSnapshotOf(
      this.db.db,
      { orgId, conversationId },
      async () => (await this.eventLog.latestOfType(conversationId, "project_root"))?.payload,
    );
  }

  /**
   * Where a send's project skill is rendered from (design §3.3): the conversation's own latest
   * `project_root`, else the last known snapshot of its binding; for a conversation not created
   * yet, the last known snapshot of the project it is created bound to.
   */
  private async projectSnapshot(a: {
    orgId: string;
    accountId: string;
    conversationId?: string;
    deviceId?: string | null;
    project?: { name: string; path: string };
  }): Promise<{ payload: ProjectRootPayload; own: boolean } | undefined> {
    if (a.conversationId !== undefined) return this.conversationSnapshot(a.orgId, a.conversationId);
    if (a.project === undefined || a.deviceId === undefined || a.deviceId === null)
      return undefined;
    const known = await latestKnownProjectRoot(this.db.db, {
      orgId: a.orgId,
      accountId: a.accountId,
      binding: { deviceId: a.deviceId, ...a.project },
    });
    return known === undefined ? undefined : { payload: known, own: false };
  }

  /**
   * The task of a fork invocation's sub-agent (spec §6.2), rendered at dispatch from the version
   * the person's message recorded (`skill.{id, source, version, arguments}`), never by name, so a
   * skill changed since the send cannot run another version than the frozen lead names (batch 2
   * review m4). The same `<skill_invocation>` text as the inline form without the lead sentence.
   * `warning`: the skill asked for a sub-agent type that did not resolve (the recorded `agentType`
   * is `general-purpose` for an `agent` other than Claude's built-in types). Throws
   * `storage.unavailable` (`skill_unreadable`) when the version is gone or its SKILL.md cannot be
   * read, plain `storage.unavailable` when storage is down. `task` renders the text for the
   * sub-agent's effective definition: the shell-injection line only when the sub-agent has
   * `Bash` (batch 3 review m1).
   */
  async renderTask(a: {
    orgId: string;
    conversationId: string;
    /**
     * The root conversation of the tree, whose device the sub-agent uses (its skills root names
     * the skill's directory, {@link conversationSkillsRoot}). Default `conversationId`.
     */
    deviceConversationId?: string;
    skill: InvocationRecord;
  }): Promise<{
    task: (child: Pick<AgentDefinition, "disabledTools" | "subagentTools">) => string;
    warning?: string;
  }> {
    const { skill } = a;
    const found = await findSkillVersion(this.db.db, a, { id: skill.id, source: skill.source });
    if (!found) {
      this.log.error("invoked skill unreadable", {
        orgId: a.orgId,
        skillId: skill.id,
        version: skill.version,
        source: skill.source,
        problem: "is gone",
      });
      throw new ApiError("storage.unavailable", `Skill ${skill.name} is gone`, [
        { reason: "skill_unreadable", skillId: skill.id, name: skill.name },
      ]);
    }
    const body = await this.readBody(a.orgId, {
      skill: { id: skill.id, name: skill.name, version: skill.version, source: skill.source },
      manifest: found.manifest,
    });
    const inv = invocationOf(found.manifest);
    const others = found.manifest.files.some((f) => f.path !== SKILL_ENTRY_FILE);
    const skillsRoot = await conversationSkillsRoot(
      this.db.db,
      a.orgId,
      a.deviceConversationId ?? a.conversationId,
    );
    const task = (child: Pick<AgentDefinition, "disabledTools" | "subagentTools">) =>
      renderSkillInvocation({
        name: skill.name,
        skillName: skill.name,
        digest: skillDigest(found.manifest.files),
        version: skill.version,
        body,
        invocation: inv,
        args: skill.arguments,
        lines: {
          ...(others && { files: "load" as const }),
          ...(hasShellInjection(body) &&
            hasBuiltin(child, BUILTIN.Bash) && { shellHint: true as const }),
        },
        lead: false,
        skillsRoot,
      });
    const asked = inv.fork?.agent;
    const unknown =
      asked !== undefined && !isGeneralAlias(asked) && skill.agentType === "general-purpose";
    return { task, ...(unknown && { warning: forkAgentUnknownText(skill.name, asked) }) };
  }

  /** Reads and parses the version's SKILL.md (checked against the manifest), returns the body. */
  private async readBody(
    orgId: string,
    r: {
      skill: Pick<ResolvedSkill["skill"], "id" | "name" | "version" | "source">;
      manifest: Pick<ResolvedSkill["manifest"], "files">;
    },
  ): Promise<string> {
    const unreadable = (problem: string) => {
      this.log.error("invoked skill unreadable", {
        orgId,
        skillId: r.skill.id,
        version: r.skill.version,
        source: r.skill.source,
        problem,
      });
      return new ApiError("storage.unavailable", `Skill ${r.skill.name} ${problem}`, [
        { reason: "skill_unreadable", skillId: r.skill.id, name: r.skill.name },
      ]);
    };
    const md = r.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE);
    if (!md) throw unreadable(`has no ${SKILL_ENTRY_FILE}`);
    this.storage.assertAvailable();
    let bytes: Uint8Array;
    try {
      // a platform version (`platform:<prefix>`) is read from deployment/ (ruling D2)
      const { store, prefix } = skillFileStore(this.storage, orgId, r.skill.source);
      bytes = await readSkillFile(store, `${prefix}${SKILL_ENTRY_FILE}`, md);
    } catch (e) {
      if (e instanceof SkillIntegrityError) throw unreadable("failed its integrity check");
      if (e instanceof ApiError) throw e;
      throw new ApiError("storage.unavailable", "File storage is temporarily unavailable");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unreadable("is not UTF-8");
    }
    const parsed = parseSkillMd(text, { invocationKeys: false });
    if ("errors" in parsed) throw unreadable("cannot be parsed");
    return parsed.body;
  }
}

/**
 * Does the definition leave builtin `name` on (tools default-on spec §4): not turned off and not
 * removed by a sub-agent's key filter. Whether it can run now (a sandbox) is not checked.
 */
const hasBuiltin = (
  agent: Pick<AgentDefinition, "disabledTools" | "subagentTools">,
  name: string,
): boolean =>
  !builtinDisabled(agent.disabledTools, name) &&
  !(agent.subagentTools?.deny ?? []).includes(name) &&
  (agent.subagentTools?.allow === undefined || agent.subagentTools.allow.includes(name));

/** The skill's own body over the rendered limit: a 400 on `skill` naming the skill. */
function tooLarge(name: string, render: () => string): void {
  try {
    render();
  } catch (e) {
    if (e instanceof RangeError) {
      throw new ApiError("validation_failed", "Request validation failed", [
        {
          path: "skill",
          message: `the skill "${name}" is too large to invoke (its rendered text must be at most ${SKILL_INVOCATION_LIMITS.renderedMaxChars} characters)`,
        },
      ]);
    }
    throw e;
  }
}

/** Runs an SDK render; its `RangeError` (a size limit) becomes a 400 on `text`. */
function rendered(render: () => string): string {
  try {
    return render();
  } catch (e) {
    if (e instanceof RangeError) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "text", message: `${e.message}; shorten the arguments` },
      ]);
    }
    throw e;
  }
}
