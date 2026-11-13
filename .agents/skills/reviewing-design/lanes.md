# Lanes and baseline numbers

## Baseline numbers (collect before fanning out)

Run from the core checkout; repeat the relevant ones in the plugins checkout.

| Number | How |
|---|---|
| Non-test lines per kernel module | `for d in packages/kernel/src/*/; do echo "$(find $d -name '*.ts' ! -name '*.test.ts' \| xargs cat \| wc -l) $d"; done \| sort -rn` |
| Churn hot spots since the last review | `git log <last-head>..HEAD --format= --name-only \| sort \| uniq -c \| sort -rn \| head -40` |
| fix vs feat commits since the last review | `git log <last-head>..HEAD --format=%s \| grep -cE '^fix'` and `'^feat'` |
| Compatibility code | `grep -rniE 'legacy\|compat\|deprecated' packages/*/src apps/*/src --include='*.ts' --include='*.tsx' -l \| grep -v test` |
| Outdated npm dependencies | `pnpm outdated -r` (both repositories) |
| Plan and ruling ids in source comments | `grep -rnoE '(ruling\|Ruling) [A-Z]?[0-9-]+\|\bP[0-9]-[0-9]+\b' packages apps --include='*.ts' \| wc -l` |

Use "since the last review" ranges only when a previous report exists; otherwise the whole history.
Give each lane the numbers for its own area: add `-- <paths>` to the git commands and narrow the
`find` / `grep` roots.

## Lanes

Each lane is one subagent. Paths are starting points, not limits: a lane follows a fact wherever it
is stored.

| Lane | Area (core unless noted) | Lane-specific questions |
|---|---|---|
| runtime | `kernel/src/runtime`, `conversations`, `background`, `evals`, `agents`, `inbox`; skill replay-evals | Does the event log stay the single source of truth? Run lifecycle across replicas: start, abort, resume, lock loss. Context and compaction. Cost and rate controls. |
| extensions-catalog | `kernel/src/extensions`, `catalog`, `packages`, `setup`, `platform`, `bootstrap.json`; `packages/plugin-sdk`, `plugin-tools`; skills writing-extensions, writing-plugins | How many places decide "is X on for this org"? Concept count for admins and plugin authors. Extension trust and the no-restart lifecycle. Config layering. |
| tools-environments | `kernel/src/tools`, `skills`, `sandbox`, `devices`, `local-devices`, `files`, `storage`, `net`; `packages/device`; plugins: connectors, sandboxes | Where is allow / ask / deny finally decided? Can an org admin enforce it for every tool kind? Every outbound URL through `src/net`? Sandbox and device isolation. |
| tenancy-infra | `kernel/src/orgs`, `identity`, `roles`, `admin`, `http`, `infra`, `db`, `migrations`, `config`, `channels`, `models`, logging | How is org scoping enforced on every query? Roles, audit, retention and deletion, secrets and key rotation, usage and cost, metrics, rate limits. |
| web-ux | `apps/web`, `packages/design`, `packages/plugin-client`, `kernel/src/ui`, `client`, `themes` | Can each of the three audiences do their first task without knowing internal terms? Duplicate entry points. Client-side heuristics compensating for missing server state. Extension UI surface versus real consumers. |
| process | git history, `tools/checks`, `tools/ci`, `AGENTS.md`, `.agents/skills`, `docs/` | Thrash (built, renamed, reverted). Tests shaping production code. Governance load versus product. Five AGENTS.md / architecture.md claims checked against code. Effort spent versus core gaps. |
| cross-module | everything changed since the last review's HEAD (`git diff --stat <last-head>..HEAD`, both repositories) | For each changed area: who consumes it, and which older invariant or module did the change touch without updating? A new concept that duplicates an old one? A rule in AGENTS.md the change quietly broke? |

With no previous review, the cross-module lane uses the last 300 commits.
