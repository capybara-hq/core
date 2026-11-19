---
"@capybara-hq/device": patch
---

File transfers no longer slow down or fail as reads accumulate. The operation journal keeps a
native read's outcome without its bytes (a retry after a restart reports an unknown outcome); the
read bytes held in memory for retries are bounded at 64 MiB, the oldest given up first; and a
write's admission hash takes its bytes as one sha256. `CAPYBARA_DEVICE_DEBUG_TIMINGS=1` prints
per-stage transfer timings to stderr.
