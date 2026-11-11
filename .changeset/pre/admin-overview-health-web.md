---
"@capybara-hq/web": patch
---

The admin console overview shows 运行状况 between 待处理 and the recent platform actions: the
kernel version and live replicas by role (a role with none says what stops, mixed versions warn,
the replicas folded in a table), the kernel queues with failures in the last 24 hours, and channel,
device and sandbox counts; read every 30 s while the page is visible, and a source the kernel
cannot read says so without blanking the rest.
