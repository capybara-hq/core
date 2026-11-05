# @capybara-hq/design

## 0.1.1-rc.0

### Patch Changes

- 15af7fd: Server-rendered times no longer break hydration. Until a page has hydrated it writes relative ages
  ("现在", "1 分钟前"), running durations and local dates with the clock and time zone of the server
  render, then switches to the browser's: an age that crossed a minute between the server render
  and the hydration, or a viewer in another time zone, used to fail hydration (Next's error overlay
  in development) or keep the server's times. The browser's time zone is saved in the `cb-tz`
  cookie, so later server renders write dates in the viewer's zone.
