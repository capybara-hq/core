import { Queue } from "bullmq";

export const make = (name: string) => new Queue(name);
