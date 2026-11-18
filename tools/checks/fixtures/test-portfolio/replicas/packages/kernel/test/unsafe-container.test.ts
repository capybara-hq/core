const first = await startKernel({});
const second = await startKernel({});
it("unsafe wait", async () => { await sleep(50); }, 1000);
