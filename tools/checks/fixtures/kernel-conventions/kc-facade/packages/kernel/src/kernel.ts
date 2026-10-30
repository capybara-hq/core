export async function createKernel(): Promise<void> {} // expect: kc-facade
export interface Kernel { // expect: kc-facade
  stop(): Promise<void>;
}
