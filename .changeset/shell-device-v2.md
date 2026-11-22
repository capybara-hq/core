---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/web": patch
---

The desktop shell capability `device@2` replaces `device@1`: a machine may hold several
connections into a deployment. `DeviceCapabilityV2.status()` returns
`{ connections: ThisMachineConnection[] }`; `running`, `pause`, `resume`, `disconnect`,
`requestCeiling` and `setKeepAwake` name the connection by `deviceId`; `connect({ orgId })` adds a
connection and may answer `{ error }`; `onStatus` passes nothing (read `status()` again).
`RunningOperationView` is renamed `DeviceRunningOp`; `ThisMachineStatus` and `DeviceCapabilityV1`
are removed. `DeviceCeilingRequest.projectReach` takes `machine | paths | workspace`. The web marks
every device of this machine 本机 (device list, new-conversation picker) and acts on the device of
the page; 连接本机 is offered whenever the shell offers `device@2`.
