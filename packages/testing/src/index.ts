export { startTestPostgres, startTestRedis, type TestContainer } from "./containers.js";
export {
  createDualReplicaHarness,
  type DualReplicaOptions,
  type Harness,
  type ReplicaHandle,
} from "./dual-replica.js";
