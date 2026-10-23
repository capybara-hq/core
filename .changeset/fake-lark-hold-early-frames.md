---
"@capybara-hq/testing": patch
---

`startFakeLark`：`pushEvent` 推给还没收到客户端第一个 ping 的连接时先暂存、收到后再发。SDK 在 `open` 之后才挂上
message 监听，与握手响应一起到达的帧会被丢掉，测试在负载下偶发「frame not acknowledged」。
