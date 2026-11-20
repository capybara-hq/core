---
"@capybara-hq/kernel": patch
---

A local device whose program was upgraded (or replaced by a rebuilt package) is rebound without
logging out: when the machine its instance was installed for no longer attests that binding (the
restarted program's runtime hash changed, so it starts unbound), the kernel replaces the instance,
revokes the old generation's work through the device epoch, and the next call creates and binds a
new generation under the new runtime evidence. Before, every call failed with "Device context
changed before this operation" and availability stayed unprobed until a new login.
