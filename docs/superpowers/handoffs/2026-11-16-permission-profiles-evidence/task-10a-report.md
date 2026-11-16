# Task 10A — frozen HTTP/query foundation

Status: DONE WITH CONCERNS, ready for independent owner/cache authorization review. This is the
bounded dormant data foundation, not delivered permission UI or permission-runtime activation.

## Source and ownership

- Worktree: `/Users/grant/Capybara/core/.claude/worktrees/fix-project-context-notice`.
- Branch: `codex/permission-web-data`.
- Exact source base: `55979ebb89fe1a7bd730e5f5c854d0b6e9b1af1f` (accepted 6c+7 merge).
- Frozen source: the nine paths below, including three new files. No Git index mutation, commit,
  push, PR, branch switch, kernel/device build, interactive server, credential use or subagent.
- The controller granted one bounded extra path: `apps/web/test/conversation-project.test.tsx`.
  Its independent home `newRoutes` helper required an explicit preview stub. The grant followed
  the actual 451-pass/6-failure consumer run; only its fixture import and real e1 preview route changed.
  Strict unexpected-request detection remains intact; no transport fallback/wildcard was introduced.

- `apps/web/src/lib/permissions.ts`
- `apps/web/src/lib/query/permissions.ts`
- `apps/web/src/lib/query/keys.ts`
- `apps/web/src/lib/query/routes.ts`
- `apps/web/src/lib/query/conversation.ts`
- `apps/web/test/conversation-permissions.test.tsx`
- `apps/web/test/conversation-cache.test.tsx`
- `apps/web/test/support/conversation.ts`
- `apps/web/test/conversation-project.test.tsx`

## Implemented contract

Read the Task 10A brief, Slice A preflight/plan, builder review/amendment and accepted Task 7 wire
handoff from the named PRIMARY SDD artifacts. Read the complete writing-web-ui skill,
apps/web/AGENTS.md and installed Next server/client and useRouter docs. Actual source authority is
this base's permission schemas/controller/service/facts and existing query/cache implementation;
Task 8/9 proposals are not API authority.

- `lib/permissions.ts` mirrors only the existing direct owner GET view, direct device/project
  preview and revision-only PATCH response. Identifiers are encoded, project uses URLSearchParams,
  optional consent is sent only when supplied, AbortSignal reaches all three HTTP operations.
  PATCH keeps the shared apiFetch CSRF/JSON/session transport. It returns `{revision}` and never
  fabricates profile, availability, consent or a complete view.
- `permissionsQuery` and `permissionPreviewQuery` are hook-free defineQuery entries with `live`
  freshness and AbortSignal forwarding. The conversation key is
  `["org",orgId,"conversation",id,"permissions"]`; the preview key is
  `["org",orgId,"device",deviceId,"permissionPreview",project ?? null]`. The explicit
  `permissionPreviewAll(deviceId)` prefix supports all project previews below the device scope.
- Conversation follow-ups schedule the new owner GET only when accountId is known and equals the
  authoritative row.accountId. Unknown row or session ownership never authorizes it. The unrelated
  legacy skill fallback is unchanged. Child GETs use the viewed child's existing endpoint and keep
  the root ID returned by that authoritative view. Scheduled owner reads remain permitted facts;
  this slice adds no scheduled editor or PATCH path.
- Home prefetch uses the same chosenDeviceId resolution as the existing picker, after the real
  devices/projects reads. The initial project is free mode, matching current source. A missing or
  unusable device returns before preview; no device is provisioned or implicitly created. Query
  callers for later selection changes must pass the actual selected device/project; no selection
  controls or client preview hook are activated here.
- New direct-view factories separate supported/unprobed/unsupported reports, scope/consent and
  independent ceiling facts. No-device effective view has null device/scope/consent and false
  ceiling. Revision zero remains real data. Tests cover restricted:null/fullAccess:false,
  ceiling:false, no device, inherited child, viewer, unknown identities and scheduled reads.
  No reviewer configuration flag is inferred. First-send seed continues to leave permissions absent.
- Existing session reset clears both new cache families before navigation. Existing hydration
  machinery preserves successes and errors. Query-only test observers show fresh hydrated reads
  issue no browser fetch, uncached reads remain pending, failed initial reads retain no fabricated
  data, failed refreshes retain only the previous authoritative view, and cancelled obsolete first
  reads cannot replace the newer response.

The product mounts no new permission query observer or controls in this slice. Owner prefetch and
home preview prefetch are real changes. Observer lifecycle tests intentionally mount query-only
probes beside the real route with the same QueryClient. They do not claim permission controls,
watermark confirmation, editor disabling or client-side selection integration has shipped. Those
later clients must retain strict ownership/device enablement and existing hydrated-error conventions.

## RED and recovery evidence

1. Before production edits:

   `pnpm exec vitest run apps/web/test/conversation-cache.test.tsx -t 'owner permission prefetch'`

   Exit 1: 1 failed, 4 passed, 28 skipped. `hydrates the authoritative owner view before first paint`
   failed with `expected [] to have a length of 1 but got +0`. This was the actual absent prefetch,
   not a mocked implementation assertion. The initial HTTP test file also failed module resolution
   before the new permissions modules existed; that setup failure is not represented as behavioral RED.
2. Initial combined run after loaders: 43 passed/3 failed because my new home test used the wrong
   groups fixture URL. Corrected that test-only path to `/conversations/groups`; no product workaround.
3. First owned-fixture consumer run: 422 passed/35 failed, exact unexpected server preview reads
   missing from home fixtures. Extended only owned shared noProjects fixtures with explicit
   unprobed direct previews. Next run: 451 passed/6 failed, all independent conversation-project
   home cases. Requested and received controller ownership, added that helper's explicit e1 preview
   route, then all 27 files passed. No failure was hidden by retries or permissive transports.
4. Deliberate regression mutations after GREEN, each restored in a finally block without index use:

   - Removed only the home preview prefetch line, ran
     `pnpm exec vitest run apps/web/test/conversation-permissions.test.tsx -t 'prefetches only the selected usable device'`.
     Exit 1: 1 failed/21 skipped; actual preview URL list was `[]` instead of the e2 URL.
   - Replaced strict owner gating with the legacy undefined-owner fallback, ran
     `pnpm exec vitest run apps/web/test/conversation-cache.test.tsx -t 'unknown owner makes zero owner permission requests'`.
     Exit 1: 1 failed/37 skipped; the forbidden owner handler was reached. Source was restored.

## Final verification

All commands ran from the isolated worktree above. No fixed sleeps, per-test timeouts or test retries
were added; existing unrelated tests retain their prior timing behavior.

```text
pnpm exec vitest run apps/web/test/conversation-cache.test.tsx apps/web/test/conversation-permissions.test.tsx
Test Files  2 passed (2)
Tests       61 passed (61)
Exit        0

pnpm exec vitest run apps/web/test/conversation-interjections.test.tsx apps/web/test/conversation-permissions.test.tsx apps/web/test/compact-command.test.tsx apps/web/test/subagents.test.tsx apps/web/test/extension-slots.test.tsx apps/web/test/agents-summary.test.tsx apps/web/test/file-panel.test.tsx apps/web/test/ui-slot-arrangement.test.tsx apps/web/test/conversation-history.test.tsx apps/web/test/agent-tree-refresh.test.tsx apps/web/test/stop-under-way.test.tsx apps/web/test/conversation-cache.test.tsx apps/web/test/chat-files.test.tsx apps/web/test/conversation-project.test.tsx apps/web/test/agent-map.test.tsx apps/web/test/background-section.test.tsx apps/web/test/ui-slot-render.test.tsx apps/web/test/plugin-page-hidden.test.tsx apps/web/test/ui-slot-platform.test.tsx apps/web/test/right-area.test.tsx apps/web/test/ui-slot-org-settings.test.tsx apps/web/test/conversation-page.test.tsx apps/web/test/subagents-reads.test.tsx apps/web/test/new-conversation-page.test.tsx apps/web/test/queue-leftovers.test.tsx apps/web/test/ui-slot-components.test.tsx apps/web/test/composer-skills.test.tsx
Owned fixture consumer files: 27
Test Files  27 passed (27)
Tests       459 passed (459)
Exit        0

pnpm exec biome check apps/web/src/lib/permissions.ts apps/web/src/lib/query/permissions.ts apps/web/src/lib/query/keys.ts apps/web/src/lib/query/routes.ts apps/web/src/lib/query/conversation.ts apps/web/test/conversation-permissions.test.tsx apps/web/test/conversation-cache.test.tsx apps/web/test/support/conversation.ts apps/web/test/conversation-project.test.tsx
Checked 9 files in 17ms. No fixes applied.
Exit 0

pnpm check:web-ui
Web UI rules check passed
Exit 0

git diff --check
(no output), exit 0

git diff --cached --name-only
(no output), exit 0
```

### Normal typecheck remains blocked by the inherited reviewed #318 mismatch

```text
pnpm --filter @capybara-hq/web typecheck
next typegen && tsc --noEmit -p .
Generating route types...
✓ Types generated successfully
.next/dev/types/app/(app)/agents/page.ts(42,29): error TS2344:
Type '{ searchParams?: Promise<{ tab?: string | string[]; }>; } | undefined'
does not satisfy the constraint 'PageProps'.
Type 'undefined' is not assignable to type 'PageProps'.
Exit 1
```

This exact generated guard mismatch also appeared in the first direct
`pnpm exec tsc --noEmit -p apps/web` attempt, along with two new test fixture inference errors.
The test inference errors were corrected; the normal script above then reported only the inherited
agents error. An attempted in-memory diagnostic check using the installed TypeScript JS API failed
with `TypeError: Cannot read properties of undefined (reading 'readFile')` because that package did
not expose the expected ts.sys API. No configuration, source or generated guard was changed to
bypass this. No excluded-guard check is claimed as PASS.

The controller confirmed this is the already reviewed/merged #318 agents/setup required-props fix,
which is outside this isolated source base and will be integrated after this freeze. Rerun the
normal unweakened web typecheck then. This foundation is not a full-green typecheck gate today.

## Scope limits and follow-up gates

No permission control/picker, new first-send path or serialization, revision watermark, root SSE,
approval rendering, design/i18n change, mode/ceiling control, config/kernel/event producer, runtime
activation, actual-provider proof, Linux visual proof or broad full suite was performed. No SDK or
kernel imports were added to web. Child live inheritance and successful-PATCH confirmation remain
later-slice work; cached data is not advertised as confirmed after writes in this slice.

Artifacts in this isolated SDD:

- `task-10a-exact-base.diff`: complete base-relative patch including every new source/test file.
- `task-10a-owned-files.json`: exact base, per-file status/base SHA256/current SHA256/size,
  and patch/report hashes. Root owns integration/index/commits.
- `task-10a-report.md`: this evidence and limitations.

Ready for the controller's independent owner/cache authorization review. No integrated permission UI
or staged runtime acceptance is claimed.
