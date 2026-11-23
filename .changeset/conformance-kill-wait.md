---
"@capybara-hq/testing": patch
---

The sandbox permission conformance harness waits for killed processes to end after a cancel or a
timeout (polling `inspect.alive`, failing with the survivors after 10 s) instead of checking once
right after the operation returned: a kill is asynchronous, and a killed descendant may still be
delivered its signal or wait for its reaper.
