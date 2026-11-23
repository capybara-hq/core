---
"@capybara-hq/device": patch
---

A relative `XDG_CONFIG_HOME` is ignored (the XDG Base Directory spec calls it invalid): the state
stays under `~/.config/capybara-device` and the login service gets no relative value. `login`
refuses a new connection's working directory that contains or lies inside another connection's
working directory or the machine directory (`work_dir_overlap`). In Docker mode an idle operation
checks the container is still there and running, so a `docker rm` or a daemon restart no longer
fails every operation until the program restarts.
