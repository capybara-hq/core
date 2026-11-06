# pre-background-subagents

`conversation.json` is a genuine recording made by the code before background sub-agents (commit
`285c1d8b`, agent map spec `docs/superpowers/specs/2026-11-06-agent-map-design.md`): the foreground
`Agent` tool with `resume`, the parent suspended on a `subagents` wait until its children finished.
Shape: `{ model, parent: { snapshot, requests }, child: { snapshot, requests } }`, where each
`requests` lists the requests the model provider actually received for that side, in order. It is
never edited.

What it holds: the `SCENARIO combo` conversation of `test/evals/subagents-replay.test.ts` at that
commit, on the `model-script` fixture provider.

- `parent`: the parent run's snapshot: three parallel `Agent` calls in one step, then a fourth with
  `resume` (a follow-up of one child), each result written after the wait resumed, then the reply;
  `subagent_dispatched` / `subagent_finished` events, no `subagent_delivery`;
- `child`: the resumed child's snapshot at its second run: `subagent_started` with the definition
  phase C froze (no `subagents` block), the task, the first reply, the follow-up message and the
  second reply.

## Recipe

Do not regenerate it with current code. At a scratch `git worktree add --detach <dir> 285c1d8b`
(`pnpm install` there), copy the first 341 lines of `packages/kernel/test/evals/subagents-replay.test.ts`
(the kernel, the script rules, the scenario in `beforeAll`, `snapshotOf`, `resumedChild`) into a
throwaway test that takes the parent run's snapshot with the requests that are not a child's, and
the resumed child's snapshot with the child requests whose first user message carries its task,
checks every `model_call` with `reconstructRequest` (drift `[]`, equal to the request), then writes
`{ model: <ModelInfo of script-1>, parent, child }` as JSON. Remove the worktree afterwards.
