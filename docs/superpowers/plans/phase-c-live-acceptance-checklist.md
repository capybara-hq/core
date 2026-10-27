# Phase C (sub-agents) live acceptance checklist

Spec: `docs/superpowers/specs/2026-10-26-subagents-design.md` §21 ("Live"); ecosystem spec
`2026-10-22-package-ecosystem-design.md` §12 phase C acceptance: superpowers' `subagent-driven-development`
runs a small plan in Capybara.

Phase C acceptance has two parts:

1. **Automatic** (runs in `pnpm test`, no network): `packages/kernel/test/subagents/superpowers-sdd.e2e.test.ts`
   runs the superpowers fixture (7.0.1, with `subagent-driven-development`, `requesting-code-review` and
   `dispatching-parallel-agents`) on `model-script` and `sandbox-fake`: task brief, implementer, review package,
   reviewer, resumed fix, scoped re-review, task 2, and the final review in parallel with a file check, then zero
   drift for every child step and a parent full-run replay. The other phase C tests (dispatch, limits,
   cancellation, dual replica, concurrent sandbox, org agents, replay) are listed in spec §21.
2. **Live** (this checklist, manual, run before the release that ships phase C): the real `obra/superpowers`
   from git, a real model provider and a real sandbox.

## 0. Credentials

Credentials live in `~/.capybara-test.env` (outside the repository) and are injected into the environment of
one command only. **Never print, `cat` or paste the values**; never commit them.

```bash
( set -a; . ~/.capybara-test.env; set +a; <command> )   # only injects the environment
```

| Variable | Used by |
|---|---|
| `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1` | step 1 (imports the real superpowers from GitHub) |
| `CAPYBARA_TEST_HTTPS_PROXY` | optional, step 1 behind a proxy (`net.httpsProxy`) |
| `CAPYBARA_TEST_E2B_API_KEY`, `CAPYBARA_TEST_E2B_TEMPLATE` | step 2 (E2B concurrent processes) |
| `CAPYBARA_TEST_ANTHROPIC_API_KEY`, or `CAPYBARA_TEST_OPENAI_API_KEY` + `CAPYBARA_TEST_OPENAI_MODEL`, or the `CAPYBARA_TEST_OAICOMPAT_*` set | step 3 (the model provider configured in the kernel) |

A transient network error (for example `ECONNRESET`) is rerun once before it counts as a failure.

## 1. The real superpowers imports with its SDD skills and agent

- [ ] `( set -a; . ~/.capybara-test.env; set +a; CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1 pnpm exec vitest run packages/kernel/test/catalog/claude-live.test.ts )`
  passes. Then, in the import review of step 3, check by hand: `subagent-driven-development`,
  `requesting-code-review` and `dispatching-parallel-agents` are imported skills (the SDD skill with its
  `scripts/` and `references/`), and `code-reviewer` (if the release still ships agents) is an imported agent
  template `superpowers:code-reviewer`.

## 2. Concurrent commands in real sandboxes

- [ ] Docker: `pnpm exec vitest run plugins/sandbox-docker/test/concurrent.test.ts` with Docker running (it skips
  without Docker or with `CAPYBARA_TEST_NO_DOCKER=1`): overlapping commands, `killTagged`, per-command timeout,
  concurrent auto-start.
- [ ] E2B: `( set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/sandbox-e2b/test/live )`:
  "concurrent processes and uploads" passes.

## 3. superpowers' subagent-driven-development on a real model (the gate)

Setup (local kernel and web from a checkout, as in `m5-live-acceptance-checklist.md` §4; one worktree at a
time runs the dev stack):

- [ ] Start `docker/compose.dev.yaml` with the `sandbox` profile, the kernel (`pnpm capybara migrate`,
  `pnpm capybara start`) and the web (`pnpm dev:web`), with the key file injected into the kernel's
  environment only.
- [ ] Install and enable `sandbox-docker` (endpoint `tcp://127.0.0.1:2375`) and a real model provider plugin
  (Anthropic, OpenAI or openai-compatible) whose key comes from the environment.
- [ ] As enterprise admin, add `https://github.com/obra/superpowers` as a git marketplace, import superpowers
  through the review and install it in the org.
- [ ] Map the purposes: `subagent_fast` to a small model, leave `subagent_capable` unmapped (it must fall back to
  the agent's model) or map it to a large one.
- [ ] Create an agent on a capable model with the builtin `agent`, `sandbox_bash`, `sandbox_read`,
  `sandbox_write`, `sandbox_edit`, `sandbox_glob` and `sandbox_grep`; select the skills
  `subagent-driven-development`, `requesting-code-review`, `dispatching-parallel-agents` (and
  `using-superpowers` pinned); in Sub-agents keep general-purpose on and select `superpowers:code-reviewer` if
  it was imported.

Run:

- [ ] In a conversation, have the agent create a small git repository in `/workspace` with a two-task plan
  (for example two small functions with tests), then ask it to execute the plan with
  subagent-driven-development.
- [ ] Expect, in the conversation page: the skill is loaded; `scripts/task-brief` and `scripts/review-package` run
  in the sandbox; one implementer sub-agent per task (fast tier) commits in the shared workspace; a task
  reviewer per task; any fix goes to the same implementer through `resume`; the final whole-branch review
  ends clean (or with findings the agent then fixes). The sub-agent group rows show status, calls and
  duration; opening a row shows the read-only child with its own messages.
- [ ] `git log` in the sandbox shows the tasks' commits; the Context tab's total with sub-agents is higher than
  the parent's own usage; no `sandbox.busy` and no "Sandbox was recreated" notice appear.
- [ ] Add the parent's run to an eval set and run a full-run replay with no candidate: drift `[]`, zero
  `tool_unmatched`, and no new sub-agent conversation.

## 4. Record results

| Step | Date | Environment (model, sandbox) | Result / notes |
|---|---|---|---|
| 1 Import | | | |
| 2 Docker / E2B concurrent | | | |
| 3 SDD on a real model | | | |
| 3 Replay | | | |
