---
"@capybara-hq/device": patch
---

Docker mode runs the sandbox image by a pinned digest instead of a tag and attests the device
container's image against the pin at every bind (fail closed). `CAPYBARA_DEVICE_IMAGE_REPOSITORY`
points the repository at a digest-preserving mirror. An architecture without a pinned image
platform is refused at login and start (`docker_unsupported_architecture`).
