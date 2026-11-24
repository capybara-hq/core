---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The gateway role serves the device stream viewer `GET /device/stream?ticket=`: it takes the
single-use viewer ticket, checks its record again, holds the device for the viewer's life and pipes
the device service's stream to the browser (close codes 4401, 4404, 4409, 1001, 1012). A local
device's viewer that reaches another gateway replica hops once to the replica holding the machine
(`/internal/device-stream/<ticketId>`, authenticated with an HMAC under the master key). Opens and
closes are audited (`browser.view`, `browser.view_closed`). Stream holds move the device's last use
when taken, and a hold ending for a lifecycle change logs at debug.
Viewer messages over 256 KiB, or ones the device stream cannot carry, close the viewer (1009);
sockets are pinged and a socket paused for 30 s closes (1013); viewer upgrades are limited per
client address (`device-stream-ip`, 120 a minute).
