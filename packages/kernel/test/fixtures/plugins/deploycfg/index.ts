import { definePlugin, type PluginContext, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 测试观察点（同进程读）：setup 次数与最近一次的 ctx。 */
export interface DeploycfgProbe {
  setups: number;
  ctx?: PluginContext;
}

export const deploycfgProbe = (): DeploycfgProbe => {
  const g = globalThis as { __deploycfg?: DeploycfgProbe };
  g.__deploycfg ??= { setups: 0 };
  return g.__deploycfg;
};

export const DeploycfgSchema = z.object({
  /** 必填：没配时插件待配置。 */
  endpoint: z.string().min(1),
  region: z.string().default("us"),
  greeting: z.string().default("hi").meta({ hot: true }),
  poolSize: z.number().int().positive().default(1),
  token: secret(z.string()).optional(),
  limits: z
    .object({ burst: z.number().int().default(5).meta({ hot: true }) })
    .default({ burst: 5 }),
  mode: z.string().default("auto"),
  tags: z.array(z.string()).default([]),
  headers: z.record(z.string(), z.string()).default({}),
  /** 为 true 时 setup 抛错（测试非 hot 改动重新加载失败）。 */
  failSetup: z.boolean().default(false),
});

/**
 * 部署级配置的测试插件（T15）：`greeting`、`limits.burst` 是 hot 字段（就地替换，`ctx.config` 读到新值），
 * 其余改动重新加载实例。路由 `GET /state` 报告本副本的 setup 次数与此刻 `ctx.config`（密钥只报是否已设置）。
 */
export default definePlugin({
  name: "deploycfg",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { http: [{ method: "GET", path: "/state" }] },
  config: { deployment: DeploycfgSchema },
  setup(ctx) {
    if ((ctx.config as { failSetup?: boolean }).failSetup) throw new Error("failSetup is set");
    const probe = deploycfgProbe();
    probe.setups += 1;
    probe.ctx = ctx;
    const setupsAtLoad = probe.setups;
    // 密钥只用于打码测试：日志里出现的值必须被打码
    ctx.log.info("deploycfg setup", { token: (ctx.config as { token?: string }).token });
    ctx.http.route("GET", "/state", async () => {
      const { token, ...rest } = ctx.config as z.infer<typeof DeploycfgSchema>;
      return Response.json({
        setups: probe.setups,
        generation: setupsAtLoad,
        config: rest,
        tokenSet: token !== undefined,
      });
    });
  },
});
