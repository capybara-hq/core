# Project skills before a conversation's first run

Status: approved by the maintainer in chat on 2026-11-28 (the "light" option: no device read for
the menu). Amends §4.6 of [the project root design](2026-11-14-project-root-design.md).

## 1. Why

A conversation bound to a project lists the project's skills in the `/` menu only after its first
run recorded a `project_root` event (§4.6: the menu shows what the model saw). Until then:

- the new conversation page lists no project skill, even with a device and a project picked;
- a first message `/project:<name> …` is refused (`skill.not_invocable`, `not_found`): the send
  renders the invocation from the conversation's latest `project_root`, and there is none yet.

Starting a conversation with a project skill (`/reviewing-prs 1063`) is the natural first message,
and the only path today is to send something else first. People read the empty menu as the
feature being broken.

## 2. Goals and non-goals

- The `/` menu of a new conversation with a device and a project picked lists that project's
  skills, and a first message can invoke one.
- The same holds for a conversation bound to a project whose first run has not recorded a
  `project_root` yet (created empty, or its first run start could not read the device).
- **No device read** for the menu or the send: opening the menu never starts or wakes a device.
- Non-goal: a fresh listing of the project. The entries can be stale; the run start reads the
  project as today and the agent loads the skill from it.

## 3. Design

### 3.1 The last known snapshot

`latestKnownProjectRoot(db, { orgId, accountId, deviceId, project: { name, path } })`: the newest
`project_root` payload without `unavailable` among **the caller's own chat conversations** bound
to the same device, project name and path (`conversations.device_id`, `project_name`,
`project_path`), by event time. It is what a run of the same person really read from that
project; nothing is read from the device. Only the caller's own conversations are searched, so it
reveals nothing they could not already read in their history.

### 3.2 The menu

`GET …/agents/:agentId/invocable-skills` gains `deviceId` and `project` (the device project's
name), used only without `conversationId`:

- with `conversationId`: the conversation's latest `project_root` as today; when it has none and
  the conversation is bound, the last known snapshot of its binding;
- without it, with `deviceId` and `project`: the device project named so (`device_projects`, by
  device and name; none → no project entries), then its last known snapshot.

A latest own `project_root` that is `unavailable` keeps listing no project skill (§4.7 unchanged).
The entries are the same `project:<name>` items, under the project heading. The Platform operation
`agents.invocable-skills` takes the two fields from the shared schema (parity).

The web composer passes the new conversation's picked project (`ComposerBar.project`) when it has
no conversation; the query key carries it, so a different pick lists again.

### 3.3 The send

`SkillInvoker.prepareProject` uses the conversation's latest `project_root` as today. When there
is none, it takes the last known snapshot of the binding: the conversation's, or, for the first
message of a conversation not created yet, the picked device project (resolved as the creation
binds it). No snapshot → `not_found` as today. An `unavailable` latest own snapshot refuses as
today.

The stub then names the digest as "last recorded for this project" instead of "recorded at the
run start", since that run has not happened. The stub stays a stub: the agent loads the skill with
`Skill`, which reads it under the run's admission after the run start recorded the conversation's
own `project_root`. A skill the project no longer has is refused there with the existing
model-visible text. `Skill` is offered because the log holds an invocation (`skillLoadOffered`).

A queued invocation's dispatch check (`recordedSkillBlocked`) takes the same fallback.

### 3.4 What does not change

The run start's read, the `project_root` event, the request building, replay (the stub is logged
text), the `project:` prefix and the device protocol.

## 4. Tests

- kernel: the last known snapshot (own conversations only, same device + name + path, newest,
  `unavailable` skipped); the menu with `deviceId` + `project`, with a bound conversation that has
  no `project_root`, and unchanged with an `unavailable` latest one; a first message
  `/project:<name>` creates the conversation with the stub; a skill not in the snapshot is still
  `not_found`.
- web: the new conversation's `/` menu lists the picked project's skills and sends
  `project:<name>`.

## AGENTS.md rules touched

- **Runtime and replay.** No model-visible input is added to request building; the stub text is a
  logged `user_message`, rebuilt from the log. No `DriftReason`.
- **Platform tool.** The route's input changes through its shared schema
  (`InvocableSkillsQuerySchema`); the operation takes the new fields from it.
- **Multi-replica discipline.** Reads only; nothing in process memory.
- **Web UI.** One `defineQuery` key gains the picked project.
