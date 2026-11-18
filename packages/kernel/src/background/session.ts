/**
 * What a background task's finish keeps of its output (spec 2026-11-05-background-bash-design
 * §2.4). A task is reached only by its exact execution ref (permission runtime cutover phase 8.3):
 * no session id, process group or shell script identifies it.
 */

/** The longest `lastLines` of a finished task (spec §2.4). */
export const LAST_LINES_MAX_CHARS = 4000;
