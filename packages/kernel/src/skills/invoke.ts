import {
  escapeSkillInvocationTags,
  hasShellInjection,
  parseSkillMd,
  renderSkillBody,
  renderSkillInvocation,
  SKILL_ENTRY_FILE,
  SKILL_INVOCATION_LIMITS,
  skillDigest,
  skillSandboxDir,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { AgentLookup } from "../agents/agent-lookup.js";
import { type AgentDefinition, builtinDisabled } from "../agents/definition.js";
import { EventLog } from "../conversations/event-log.js";
import type { EventPayload } from "../conversations/events.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
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
import { SandboxService } from "../sandbox/sandbox.service.js";
import { StorageService } from "../storage/storage.service.js";
import { BUILTIN } from "../tools/builtin-names.js";
import {
  findSkillVersion,
  PROJECT_DIR_DIGEST,
  type ProjectSkillProblem,
  ProjectSkillReadError,
  readProjectSkill,
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

/** A project skill the project lists but cannot be used now (`reason: project_unavailable`). */
const projectUnavailable = (message: string) =>
  new ApiError("skill.not_invocable", message, [{ reason: "project_unavailable" }]);

/** The person's text for a {@link ProjectSkillProblem}. */
function projectProblemMessage(name: string, p: ProjectSkillProblem): string {
  switch (p.kind) {
    case "outside_mode":
      return `Skill "${name}" cannot be invoked: ${p.path} is outside what the device can read in ${p.mode} mode now`;
    case "gone":
      return `Skill "${name}" cannot be invoked: ${p.path} is no longer on the device`;
    case "read_failed":
      return `Skill "${name}" cannot be invoked: reading ${p.path} on the device failed (${p.why.slice(0, 300)})`;
    case "invalid":
      return `Skill "${name}" cannot be invoked: ${p.path} is not a valid SKILL.md (${p.why.slice(0, 300)})`;
  }
}

/** The longest a person's invocation waits for its project skill's SKILL.md on the device. */
const PROJECT_SKILL_READ_TIMEOUT_MS = 30_000;

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
    return projectSkillBlocked(await latestProjectRoot(db, a.conversationId), a.skillId);
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
    /** A project skill's SKILL.md is read through the conversation's device. */
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "withSandbox">,
    @Inject(ConversationDevices)
    private readonly devices: Pick<ConversationDevices, "forTool" | "modeLevel">,
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
    if (conversationId === undefined) return skills;
    const latest = await this.eventLog.latestOfType(conversationId, "project_root");
    return [...skills, ...projectInvocables(latest?.payload)];
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
   * conversation's latest `project_root` (what the model saw), then its SKILL.md is read through
   * the conversation's device as `Skill` reads it ({@link readProjectSkill}) and rendered like any
   * invocation, `${CLAUDE_SKILL_DIR}` being the skill's directory in the project. Always inline
   * (`context: fork` is not honoured for project skills, as in `Skill`). Refusals:
   * `skill.not_invocable` `not_found` (no conversation yet, no project, a name it does not list),
   * `project_unavailable` (the latest project is unavailable, or its file cannot be used), the
   * device's own refusals as they are (`device.offline`, ...), `device.projects_unavailable` when
   * the device cannot be asked.
   */
  private async prepareProject(
    a: {
      orgId: string;
      accountId: string;
      conversationId?: string;
      agent: AgentDefinition;
      name: string;
      args: string;
    },
    bare: string,
  ): Promise<RenderedInvocation> {
    const { conversationId } = a;
    if (conversationId === undefined) throw notInvocable("not_found", a.name);
    const latest = (await this.eventLog.latestOfType(conversationId, "project_root"))?.payload;
    if (latest?.unavailable !== undefined) {
      throw projectUnavailable(
        `Skill "${a.name}" cannot be invoked: the project "${latest.project}" is not available (${latest.unavailable.message})`,
      );
    }
    if (projectSkillBlocked(latest, a.name) !== null || latest === undefined) {
      throw notInvocable("not_found", a.name);
    }
    const file = await this.readProjectFile({ ...a, conversationId }, latest.root, bare);
    const args = a.args.trim();
    // the renderer's skills-root directory becomes the skill's directory in the project (a closing
    // tag in the path stays inert, as in the body)
    const dir = file.dir.replace(/<\//g, "<\\/");
    const text = rendered(() =>
      renderSkillInvocation({
        name: a.name,
        skillName: bare,
        digest: PROJECT_DIR_DIGEST,
        version: 0,
        body: file.body,
        invocation: file.invocation,
        args: a.args,
        lines: {
          ...(hasShellInjection(file.body) &&
            hasBuiltin(a.agent, BUILTIN.Bash) && { shellHint: true as const }),
        },
      }),
    ).replaceAll(skillSandboxDir(bare, PROJECT_DIR_DIGEST), dir);
    return {
      text: `${text}\n\nIts other files, if any, are in ${dir}/ on the device; use them there.`,
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

  /** {@link readProjectSkill} in a silent use of the conversation's device, as its owner. */
  private async readProjectFile(
    a: { orgId: string; accountId: string; conversationId: string; name: string },
    root: string,
    bare: string,
  ) {
    try {
      const deviceId = await this.devices.forTool(a.orgId, a.conversationId);
      // unknown mode: the strict (sandbox) path checks stay (fail closed), as in a tool call
      const mode = (await this.devices.modeLevel(a.orgId, deviceId))?.mode ?? "sandbox";
      return await this.sandbox.withSandbox(
        {
          orgId: a.orgId,
          deviceId,
          holderConversationId: a.conversationId,
          // tells the model nothing: its next tool call still learns what the device did
          silent: true,
          actor: { accountId: a.accountId, conversationId: a.conversationId },
        },
        (h, p, info, signal) =>
          readProjectSkill({ deviceId, mode, h, roots: info.roots, p, signal }, root, bare),
        AbortSignal.timeout(PROJECT_SKILL_READ_TIMEOUT_MS),
      );
    } catch (e) {
      if (e instanceof ProjectSkillReadError) {
        throw projectUnavailable(projectProblemMessage(a.name, e.problem));
      }
      if (e instanceof ApiError) throw e;
      this.log.warn("project skill unreadable: the device could not be asked", {
        orgId: a.orgId,
        conversationId: a.conversationId,
        skill: a.name,
        err: e,
      });
      throw new ApiError(
        "device.projects_unavailable",
        "The device could not be reached to read the project skill; retry later",
      );
    }
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
  async renderTask(a: { orgId: string; conversationId: string; skill: InvocationRecord }): Promise<{
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
