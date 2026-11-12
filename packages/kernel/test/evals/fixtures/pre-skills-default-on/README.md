# pre-skills-default-on

`conversation.json` is a genuine recording made by the code before skills were on by default
(commit `3217c4f8d`, spec `docs/superpowers/specs/2026-11-12-skills-default-on-design.md` §9): the
runtime still pinned skills (`skills.pinned`, a template's `skills` pinned in its child). Shape:
`{ model, parent: { snapshot, requests }, child: { snapshot, requests } }`, where each `requests`
lists the requests the model provider actually received for that side, in order (compaction and
title requests left out). It is never edited and never regenerated: after the change no code
writes pins any more.

What it holds, on `model-fake` / `fake-small` (context window 1500):

- `parent`: an agent selecting three org skills, `pinned-rules` pinned and `brainstorming` a Claude
  Code skill of the plugin `superpowers` (so every `skills_catalog` snapshot carries `toolMap`),
  with an inline sub-agent template `scout` whose `skills` names `scout-rules`. Turns: `echo:first`;
  a `Skill` load of `superpowers:brainstorming`; an `Agent` call dispatching `scout` (background,
  `wakeOnBackgroundTask: false`, so its `subagent_delivery` reaches the next run); a new version of
  `pinned-rules` (the next run writes a second snapshot with version 2); five `long:` turns that
  force compactions. 8 runs, 10 `model_call`s, 2 `skills_catalog` (pinned v1, then v2), 2
  `compaction_summary`, `subagent_dispatched` / `subagent_finished` / `subagent_delivery`.
- `child`: the `scout` child's snapshot: `subagent_started` whose definition has
  `skills.pinned: [<scout-rules>]`, a `skills_catalog` with `pinned` (`scout-rules` v1) and the tool
  map, 1 `model_call`.

## Recipe

Do not regenerate it with current code. At a scratch `git worktree add --detach <dir> 3217c4f8d`
(`pnpm install` there), copy the kernel setup and helpers of
`packages/kernel/test/evals/reconstruct.test.ts` (without `model-looper`, `tools-probe`,
`hooks-probe`, without `tools.searchThresholdTools`, with `runtime.wakeOnBackgroundTask: false`)
into a throwaway test. Seed `pinned-rules` ("Always answer in haiku."), `brainstorming`
(claude-code, plugin `superpowers`) and `scout-rules`; create the agent with the builtin `Agent`,
`skills: { orgSkills: [all three], pinned: [pinned-rules] }` and
`subagents: { general: false, inline: [{ name: "scout", model: "inherit", skills: [scout-rules], … }] }`;
post the turns above (the dispatch is
`tool:Agent:{"description":"Scout","prompt":"echo:scouted","subagent_type":"scout"}`, then wait for
the finished delivery; the new version is "Always answer in limericks."). Take the parent's
snapshot at its last run and the child's at its run, split the captured requests by the sub-agent
preamble in the system text, check every `model_call` with `reconstructRequest` (drift `[]`, equal
to the request), then write `{ model: <ModelInfo of fake-small>, parent, child }` as JSON. Remove
the worktree afterwards.
