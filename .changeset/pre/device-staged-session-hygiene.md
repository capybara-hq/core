---
"@capybara-hq/device": patch
---

The dormant protocol 3 session keeps one state per machine credential (a credential change drops
the old state and its held answers), requires the reconnect grace explicitly, holds at most 64
answers while no socket is ready (expired ones are swept on each hold), and refuses `bindInstance`
while draining; status, reads, tails and stops are still served. Protocol 2 stays the live wire.
