export class GracefulShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}
  find() {
    return this.moduleRef.get(Other);
  }
}
