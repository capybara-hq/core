---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/capybara": minor
---

Local device semantics leave the kernel: the kernel-internal `@local` provider, its machine
reports, owner reports, instance bindings and boot history are gone; the kernel knows only
generic dial-in devices (a provider implementing `DeviceProvider.dialIn` and declaring
`permissions.dialIn`), and the `device-local` plugin takes local devices over. Until it is
installed, a deployment has no local device provider. Local devices registered before the upgrade stay
bound to the removed `@local` provider and are unavailable (`device.unavailable`; their files stay
on the machine); their owners delete them on the devices page and connect the machine again with a
`capybara-device` that signs in to the `device-local` provider. Migration 0177 drops `device_machines`'
`features`, `local_policy`, `owner_report`, `pending_policy_ops`, `home`, `roots`, `mode` and
`session_isolation`, the tables `device_machine_boots` and `device_instance_bindings`, and
`devices.source`; a machine credential is accepted for any device a machine signed in to, and the
connection's provider check decides the rest. The error codes `device.policy_refused`,
`device.policy_unsupported` and `device.owner_report_stale` are removed. The dial-in config moves from
`devices.local.*` to `devices.dialIn.*` (`CAPYBARA_DEVICES__LOCAL__*` becomes
`CAPYBARA_DEVICES__DIAL_IN__*`); rename any value you set.

The SDK's `device-protocol` subpath drops the protocol 4 surface: `LEGACY_DEVICE_PROTOCOL_VERSION`,
`LegacyDeviceHello`, `LegacyDeviceFrame`, `parseLegacyDeviceFrame`, `KernelReq`, `KernelCancel`,
`DeviceRes`, the policy op types and constants (`LegacyDevicePolicyArgs`,
`LegacyDevicePolicyResult`, `LegacyDevicePolicyStatus`, `DevicePolicyStatusArgs`,
`DevicePolicyOpReport`, `DevicePolicyOpOutcome`, `isPolicyOpId`, `POLICY_ADD_REFUSED`,
`MAX_POLICY_OP_ID_LENGTH`, `MAX_RECENT_POLICY_OPS`) and the `policyOp` / `policyOpId` features;
`DeviceOp` no longer lists `policy` / `policyStatus`.
