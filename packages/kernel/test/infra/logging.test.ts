import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { NestLogAdapter } from "../../src/http/nest-logger.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { KERNEL_LOGGER, KERNEL_ROOT_LOGGER } from "../../src/infra/tokens.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

function capture(level = "debug") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(level, { write: (l) => lines.push(JSON.parse(l)) });
  return { logger, lines };
}

@Injectable()
class RunWorker {
  constructor(@Inject(KERNEL_LOGGER) readonly log: KernelLogger) {}
}

@Injectable()
class ChannelSupervisor {
  constructor(@Inject(KERNEL_LOGGER) readonly log: KernelLogger) {}
}

const FACTORY_LOGGER = Symbol("FACTORY_LOGGER");

describe("LoggingModule", () => {
  it("gives each injecting class a logger whose context is the class name", async () => {
    const { logger, lines } = capture();
    @Module({
      imports: [LoggingModule.forLogger(logger)],
      providers: [
        RunWorker,
        ChannelSupervisor,
        { provide: FACTORY_LOGGER, inject: [KERNEL_LOGGER], useFactory: (l: KernelLogger) => l },
      ],
    })
    class AppModule {}
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      app.get(RunWorker).log.info("run finished", { context: "spoofed" });
      app.get(ChannelSupervisor).log.warn("reconnecting");
      app.get<KernelLogger>(FACTORY_LOGGER).info("from a factory");
      app.get<KernelLogger>(KERNEL_ROOT_LOGGER).info("from the root");
      expect(lines.map((l) => [l.msg, l.context])).toEqual([
        ["run finished", "RunWorker"],
        ["reconnecting", "ChannelSupervisor"],
        ["from a factory", undefined],
        ["from the root", undefined],
      ]);
      // one process logger: a level change through any child applies to all
      app.get(RunWorker).log.setLevel("warn");
      expect(app.get<KernelLogger>(KERNEL_ROOT_LOGGER).level).toBe("warn");
      expect(app.get(ChannelSupervisor).log.level).toBe("warn");
    } finally {
      await app.close();
    }
  });
});

describe("NestLogAdapter", () => {
  it("forwards log at info with Nest's context name as context, like octok", () => {
    const { logger, lines } = capture();
    const nest = new NestLogAdapter(logger);
    nest.log("Mapped {/api/v1/me, GET} route", "RouterExplorer");
    nest.error("boom", "Error: boom\n    at x", "ExceptionHandler");
    nest.verbose("details", "InstanceLoader");
    nest.debug("more");
    expect(lines).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "Mapped {/api/v1/me, GET} route",
        context: "RouterExplorer",
      }),
      expect.objectContaining({
        level: "error",
        msg: "boom",
        context: "ExceptionHandler",
        nest: "Error: boom\n    at x",
      }),
      expect.objectContaining({ level: "debug", msg: "details", context: "InstanceLoader" }),
      expect.objectContaining({ level: "debug", msg: "more" }),
    ]);
    expect(lines[3]).not.toHaveProperty("context");
  });
});
