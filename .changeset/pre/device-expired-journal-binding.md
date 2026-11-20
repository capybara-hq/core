---
"@capybara-hq/device": patch
---

A completed operation whose retention expired stays settled: the retention sweep drops its retained
payload but no longer marks it unknown, which refused every later `bindInstance` ("Earlier work on
this device is not settled") and left the device unusable after an upgrade. Journals already on
disk recover: an earlier generation's entry past its retention with no launch identity and no
uncleaned output is no retirement obligation. Work of a lost process keeps its launch identity past
retention and still blocks.
