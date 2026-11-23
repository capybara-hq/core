---
"@capybara-hq/device": patch
---

Linux: every operation start reads `/proc/self/mountinfo` and denies each path where another mount
shows a denied directory or something inside it (a bind mount, a mount of an ancestor's subtree,
covered content, a file system mounted inside it and elsewhere, an overlay layer, a loop image),
under every project reach, so the carve no longer leaves a bind mount of `~/.ssh` readable. Mounts of
unknown content (an automount point with nothing on it, an unresolvable overlay layer, an unreadable
loop image) are denied wholesale. A mount table it cannot read or decide refuses machine project
reach with the cause (fixing it restores machine reach); `ceiling` shows the cause.
