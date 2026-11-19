---
"@capybara-hq/kernel": patch
---

Approval-only profiles: review, grants and the Full access auto-grant audit.

- A profile only chooses who approves a crossing (`approverForCrossing`): Request approval asks the
  person, Approve for me the review model (the person when it is missing, unsure or failing), Full
  access nobody. Under Full access an escalation a sub-agent asks for, or one carrying a
  credential consent (`ask.credential-*`, `ask.ssh`, `ask.secret-file`), goes to the review model;
  its input says neutrally why.
- Candidate building runs for every profile. A Full access crossing (a directory, a host on an
  allowlist, running one call outside the sandbox) is granted within the device's ceilings and
  recorded exactly once: a grant with source `full-access`, a `permission_reviewed` event and the
  audit row `permission.crossing_auto_granted` with its kind, in one fenced transaction (migration
  `0166`), and announced after the commit. Sensitive consents an auto-grant skipped are recorded
  on it (`sensitive`); a skipped consent without a crossing is recorded as crossing `sensitive`.
  An escalated call without its matching grant is refused at admission under every profile.
- The fixed denies stay before the review model under every profile. A directory proposal at a
  protected location (credentials, the device state, the sandbox's write denies) is refused before
  review with the outside-sandbox escalation named; the review rules ask about the X session files,
  `environment.d`, user systemd data, KDE autostart and every zsh and bash login file.
- A host is a crossing only while the sandbox network is an allowlist; IP literals and loopback
  names are never proposed.
- A network ask offers a run grant only: "always allow" is refused, and the device-op paths, notes
  and outcomes that could only follow it are removed. The `Bash` description explains proxy-aware traffic and the
  escalation under every profile.
