export class KernelConfigService {
  private readonly current: () => KernelConfig = () => this.value;
}
