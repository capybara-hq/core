---
"@capybara-hq/kernel": patch
---

Replay on the activated tree: the recorded permission context, never the live gate, decides what a rebuilt request
renders; zero-drift cases cover activated runs and logs written before the activation.
