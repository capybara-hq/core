---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

A provider whose `update` cannot honor the fence token (E2B) no longer leaves the instance wider than
the kernel's record until the limits change again (#766). The SDK adds the optional
`DeviceProvider.appliedNetwork(h, signal)`: the network the instance enforces now, as the provider's
backend reports it. Under the exclusive lease, on a resumed instance, a running one the use holds
exclusively, and a new instance of a provider whose limits are fixed at its file system, the kernel
compares it with the recorded limits; a wider network (the open public network over a list, or a host
the record does not cover), an unknown one or a failed read applies the desired limits again through
`update` with the holder's token. Equal or narrower changes nothing.
