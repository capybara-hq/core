---
"@capybara-hq/device": minor
"@capybara-hq/plugin-sdk": minor
---

`capybara-device` speaks protocol 5 over the dial-in envelope: it sends
`X-Capybara-Device-Protocol: capybara-device/5` (`DEVICE_DIAL_IN_PROTOCOL`), names that protocol
when it signs in, and wraps every frame in the envelope (`hello` with the program facts and the
frame capacity, `req` / `res` / `event` with a device protocol body, the kernel's `ready`,
`cancel` and `stop`). The kernel's `ready` names the connection's effective frame capacity
(`maxFrameBytes`, at most what the machine announced); the program sends no larger frame on that
connection. A kernel `stop` with reason `drain` drains the program and exits it; reason `stop`
stops the owned work at once and exits with the reason the kernel's close names. The hello body (`DeviceHello`) no longer carries the program facts, the
recent policy ops or the `policyOp` / `policyOpId` features. The deployment can no longer change
a machine's policy: the `policy` and `policyStatus` operations, `DevicePolicyArgs`,
`DevicePolicyResult` and `DevicePolicyStatus` are removed, and the device keeps no policy op log;
a change the owner makes on the machine is still pushed as an event. `parseDeviceFrame(body, kind)`
parses one body; `parseDialInKernelFrame` parses a kernel frame on the machine. A 426 names the
protocol the deployment serves the device with, and the program says which side to update.
