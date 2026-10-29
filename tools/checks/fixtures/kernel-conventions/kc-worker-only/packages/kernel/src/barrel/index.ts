// a barrel that re-exports a worker-only module under another name
export { NestedModule as Nested } from "../jobs/jobs.module.js";
export * as jobsNs from "../jobs/jobs.js"; // expect: kc-worker-only
