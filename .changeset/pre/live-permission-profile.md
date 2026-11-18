---
"@capybara-hq/web": patch
---

The owner of an interactive conversation changes its permission profile in place: the choice is
saved with the revision on display (Full access only after its confirmation for the conversation's
own device and scope), and the profile stays marked as last confirmed, without a second change,
until a read reaches the saved revision, even when that read fails; Refresh only reads. A 409 reads
the state again and asks for a new choice, never resending. An owner's sub-agent conversation
follows its main conversation's profile live through the main conversation's stream; viewers read
and open nothing. Approval cards in the conversation and the inbox show every directory, host and
the target file of a permission request in full, and a request a permission change superseded is
final, without actions. Running background work says it keeps the permissions it started with.
