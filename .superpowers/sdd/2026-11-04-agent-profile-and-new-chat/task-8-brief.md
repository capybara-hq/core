### Task 8: Create flow and greeting logic

**Files:**
- Modify:
  - `apps/web/src/app/(app)/agents/new/view.tsx`
  - `apps/web/src/components/AgentForm.tsx` (or its replacement)
- Create: `apps/web/src/lib/greeting.ts`.
- Modify: the messages (greeting copy and create-form strings).
- Test:
  - `apps/web/test/agent-create.test.tsx`
  - `apps/web/test/greeting.test.ts`

**Interfaces:**
- Produces:
  - The create form has:
    - `AvatarPicker`, with a random preset preselected via a client `randomPreset` mirror (the presets list comes from the design package);
    - the name (required);
    - the model (defaults to the org default);
    - visibility, shown as `private` and changeable.
    - Creating answers with a redirect to `/agents/<id>?s=prompt`.
  - `type GreetingBucket = "morning" | "noon" | "afternoon" | "evening" | "night"`.
  - `greetingBucket(hour: number): GreetingBucket`. Bounds: 5–10 morning, 11–12 noon, 13–17 afternoon, 18–22 evening, 23–4 night.
  - `pickGreeting(bucket, name, random = Math.random): string`. It picks from the i18n arrays `chat.greeting.<bucket>`. The zh entries are the spec §4.1 table, verbatim, with `{name}`.

- [ ] **Step 1: Write failing tests.**
  - `"create sends the preset, name, model and private, then lands on ?s=prompt"`.
  - `"create without a name is refused"`.
  - `"greetingBucket bounds"`: assert 4→night, 5→morning, 10→morning, 11→noon, 12→noon, 13→afternoon, 17→afternoon, 18→evening, 22→evening, 23→night and 0→night.
  - `"pickGreeting fills {name} and stays in the bucket"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them, then `pnpm check:i18n`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): a short agent create form and time-of-day greetings`.

