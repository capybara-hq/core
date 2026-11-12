import { MAINTENANCE, WAKE_JOB } from "./wake.processor.js";

export async function owe(outbox: Outbox, kind: string, ids: string[]) {
  // on a queue of its entry: fine
  await outbox.add({ queue: MAINTENANCE, name: WAKE_JOB, jobId: "a", data: {} });
  await outbox.add({ queue: "cap-kernel-subagent-runs", name: "run", jobId: "b", data: {} });
  // a queue computed at run time is not checked
  await outbox.add({ queue: queueFor(kind), name: "run", jobId: "c", data: {} });
  await outbox.add({ queue: "cap-kernel-runs", name: WAKE_JOB, jobId: "d", data: {} }); // expect: outbox-registry
  await outbox.addMany( // expect: outbox-registry
    ids.map((id) => ({ queue: MAINTENANCE, name: "run", jobId: id, data: {} })),
  );
}
