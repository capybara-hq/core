/** 插件经 ctx 做的一项登记的种类（C17）。 */
export type RegistrationKind =
  | "tool"
  | "route"
  | "queue"
  | "bus"
  | "lease"
  | "ui.view"
  | "ui.action"
  | "provide"
  | "hook";

/** 账上的一项：撤销时调用 `dispose()`。 */
export interface Registration {
  kind: RegistrationKind;
  key: string;
  dispose(): Promise<void>;
}

/**
 * 一个插件实例的登记账（每个 ctx 一本）：ctx 的每次登记都记一笔，撤销实例时逐项（倒序）撤销。
 * 封账（`seal()`，实例开始撤销 / ctx 关闭）之后再登记：立即撤销这一项并抛错，不留下无人管的资源。
 */
export class RegistrationLedger {
  private items: Registration[] = [];
  private closed = false;

  constructor(private readonly plugin: string) {}

  /**
   * 记一笔，返回「销账」函数（插件自己撤销时调用，如退订、释放锁；只从账上拿掉，不再调用 dispose）。
   * 已封账时先撤销这一项再抛错。
   */
  add(r: Registration): () => void {
    if (this.closed) {
      void r.dispose().catch(() => {});
      throw new Error(
        `plugin ${this.plugin}: the plugin instance is unloaded; ${r.kind} "${r.key}" cannot be registered`,
      );
    }
    this.items.push(r);
    return () => {
      this.items = this.items.filter((x) => x !== r);
    };
  }

  /** 当前账上的登记（按登记顺序，副本）。 */
  list(): Registration[] {
    return [...this.items];
  }

  get sealed(): boolean {
    return this.closed;
  }

  /** 封账：此后的登记立即撤销并抛错。 */
  seal(): void {
    this.closed = true;
  }

  /** 封账并按登记的倒序逐项撤销；单项失败交给 `onError`，继续其余各项。 */
  async disposeAll(onError: (r: Registration, e: unknown) => void): Promise<void> {
    this.seal();
    while (this.items.length > 0) {
      const r = this.items.pop() as Registration;
      try {
        await r.dispose();
      } catch (e) {
        onError(r, e);
      }
    }
  }
}
