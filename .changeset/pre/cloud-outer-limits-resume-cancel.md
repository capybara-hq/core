---
"@capybara-hq/kernel": patch
---

Cloud permission limits and retirement (B-12, B-22): reconciling a cloud device that must have its
sandbox limits established again keeps any stricter boundary its instance is known to run (the
owner Full ceiling and outer network are narrowed to it, never the instance widened), and a new
every-minute worker sweep applies the remaining target through the provider's `update` under the
lifecycle lease, which clears the marker without a file reset. A cloud instance applied in the
OS sandbox mode reads Full access as unsupported. A suspended cloud instance whose retirement
obligation holds only revoked managed starts is resumed and those starts are cancelled by their
exact references instead of destroying the instance with its other tasks (migration 0159); a cancel
that cannot be confirmed falls back to the destroy.

Trusted attachment preparation accepts exactly the directory FetchAttachment writes for the call's
root conversation (the shortened `attachmentsDir`), and a managed request refused before it was
sent (its device connection changed) is recorded as a distinct `not_sent` failure: definite, never
an unknown outcome, and replayed as the same typed refusal.

The lifecycle reconcile never resumes an instance under an open retirement obligation and visits
marked devices round-robin; an exact cancel resolves only the refs it stopped (a member added
meanwhile, or by an older replica, reopens the obligation), a failed pre-resume cancel destroys the
instance while still suspended, and only limits in force narrow a device's authority.
