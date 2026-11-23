---
"@capybara-hq/device": patch
---

Docker mode no longer needs the host's `/usr/bin/python3`: the trusted helpers (background output
spool, recovered-output finalization, skills preparation, the interpreter probe of the environment
fingerprint) run in short-lived helper containers of the pinned sandbox image with no network, a
read-only root, no capabilities and only the step's host paths mounted. The environment
fingerprint moves to version 2 (docker mode fingerprints the image's interpreter and shell), so
every docker device re-binds once after the upgrade; retained output of background tasks started
before the upgrade reads as lost (spools now live in the connection's `output` directory). The
`host_python_missing` login error is gone.
