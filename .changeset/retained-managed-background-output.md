---
"@capybara-hq/device": patch
---

Retain managed macOS background output in an exact-reference private spool and a separate ordinary artifact, with bounded positional reads, durable checkpoints, explicit output credit, and sticky collector-failure cancellation.

Preserve immutable read snapshots, exact cancellation ownership, conservative journal recovery after failed publication, and the restricted worker's artifact write exclusions.

Require durable final journal decisions before acknowledgment and independently validate and finalize indeterminate commits during recovery, preserving sticky faults and cancellation tombstones.

Merge cancellation evidence monotonically and keep owned stop/revocation and failure-credit release independent of blocked journal and deferred fault-control writes.
