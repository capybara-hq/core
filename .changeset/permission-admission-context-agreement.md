---
"@capybara-hq/kernel": patch
---

Permission admission on a local device now reads the same runtime report and applied environment
verdict as the recorded permission context: whenever the context withholds its scope (unprobed or
unsupported runtime, no installed binding, a stale identity, machine or roots), admission refuses
with the same reason. Cloud admission keeps its rule until installed cloud evidence exists. The
managed device context writer refuses an actor who is no longer an active member, with the
recorded context's predicate. An ordered authority prelude now runs inside the run fence, after
the org row and before the conversation rows, so a tool call's permission locks can no longer
deadlock with offboarding, org deletion or org settings writes, which hold the org row before
taking the org permission lock. The permission activation gate stays off.

Permission configuration publication locks the org rows its key conversion writes before the
platform permission lock. The permission context and managed device context writers refuse
without the run's inherited fence, and permission read locks inside a fenced transaction are taken
only in its ordered prelude. Admission refuses an inactive actor like the context. Conversation
deletion takes its root permission lock as an ordered prelude.
