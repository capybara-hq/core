/**
 * The legacy (SID) process lookup fragment, kept only because `SandboxService` still kills the
 * `kill_pending` sessions of a resumed legacy instance with it. No background code builds a SID
 * script any more (permission activation W5-P2); W5-P3a removes that last user, and this file
 * with it. Defines `tk_alive <sid>` and `tk_kill <SIGNAL> <sid>` (0: sent, 1: no process left).
 */
export const SESSION_MODE_SCRIPT = [
  'if pgrep -s 0 >/dev/null 2>&1 || [ "$?" -eq 1 ]; then pg=-s',
  'tk_alive() { pgrep -s "$1" >/dev/null 2>&1; }',
  'tk_kill() { pkill -"$1" -s "$2"; }',
  "else pg=-g",
  `tk_alive() { perl -e 'exit((kill(0, -$ARGV[0]) || $!{EPERM}) ? 0 : 1)' "$1"; }`,
  `tk_kill() { tk_alive "$2" || return 1; echo "$1" >> .capybara/tasks/g"$2".ctl || return 2; }`,
  "fi",
].join("\n");
