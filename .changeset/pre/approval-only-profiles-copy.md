---
"@capybara-hq/kernel": patch
---

Copy for approval-only profiles. The picker's Full access row and its confirmation say that
credential reads outside the sandbox and sub-agents' requests to run outside it still go to the
review model; the cloud host list's help says a host outside the organization's list is refused.
A new permission context records `sandbox.perCallHosts` (false on an instance boundary), and under
Full access on an instance-boundary allowlist the model text says hosts cannot be granted per call
there; a stored context without the field renders the text it rendered (zero drift).
