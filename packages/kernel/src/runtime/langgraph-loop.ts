import type { StopReason } from "@capybara-hq/plugin-sdk";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { KyselyCheckpointSaver } from "./checkpointer.js";
import type { AgentLoop, LoopContext, LoopOutcome } from "./loop.js";
import {
  type ModelStepDeps,
  type ModelStepInput,
  type ModelStepResult,
  runFinalWrapUp,
  runModelStep,
} from "./model-call.js";

/** M2 没有工具：模型请求工具时写入的提醒（模型可见，英文）。 */
export const TOOLS_UNAVAILABLE_REMINDER = "Tools are not available yet.";

/** 测试钩子。 */
export interface LangGraphLoopHooks {
  /**
   * `model` / `wrapUp` 节点里 `runModelStep` / `runFinalWrapUp` 返回之后、节点返回之前调用：
   * 抛错即模拟「回复已写入日志、checkpoint 尚未保存」时进程崩溃。
   */
  afterModelStep?(runId: string, step: number, result: ModelStepResult): Promise<void>;
}

type EndKind = Exclude<LoopOutcome["kind"], "interrupted">;

/**
 * 图状态：只记录进度，消息每步从事件日志重建（runModelStep 自己读日志），checkpoint 很小。
 * - `step`：当前（最近一次进入的）步骤编号，prepare 节点 +1；
 * - `consumedUpToSeq`：已吸收的最大 user_message seq；
 * - `lastStopReason`：最近一步模型调用的停止原因；
 * - `outcome`：图的结束方式（在决定结束的节点里写入，续跑已结束的图时直接读出，不依赖当前时间）。
 *
 * 所有 channel 都是默认的 LastValue（不用实验性的 DeltaChannel，也没有子图）：
 * 每个 checkpoint 自带完整状态，`pruneToLatest` 之后仍能独立还原（R19）。
 */
const LoopState = Annotation.Root({
  step: Annotation<number>(),
  consumedUpToSeq: Annotation<number>(),
  lastStopReason: Annotation<StopReason | "aborted" | null>(),
  outcome: Annotation<EndKind | null>(),
});

type State = typeof LoopState.State;

const INITIAL: State = { step: 0, consumedUpToSeq: 0, lastStopReason: null, outcome: null };

/**
 * prepare 节点在停机信号下抛出：本次 invoke 以它结束，checkpoint 停在 prepare 之前
 * （LangGraph 把出错的任务记为该 checkpoint 上的 pending error，`invoke(null)` 续跑时重新执行它）。
 *
 * 选它而不是 `interrupt()` / `GraphInterrupt`：`interrupt()` 是「等待人类输入」语义，续跑需要
 * `Command({ resume })`，且节点会从头重放；停机只是「换个进程从同一位置继续」，用普通异常即可，
 * 续跑时 prepare 正常重新执行，语义更直接。
 */
class LoopInterrupted extends Error {
  constructor() {
    super("agent loop interrupted at a step boundary");
    this.name = "LoopInterrupted";
  }
}

/**
 * 默认 AgentLoop：LangGraph 状态图，checkpoint 存在内核的 `KyselyCheckpointSaver`（thread_id = runId），
 * worker 崩溃后由其他副本从最近的 checkpoint 续跑（spec 4.4、Review Focus 1）。
 *
 * 图：`prepare → model →（tool_use）tools → prepare …`；prepare 发现步数超过上限 → `wrapUp` → 结束；
 * 模型中止或正常结束 → 结束。`durability: "sync"`：每个节点的 checkpoint 在下一个节点开始前落库。
 *
 * 幂等：`runModelStep` / `runFinalWrapUp` 按 (runId, step) 幂等，续跑重新执行 model 节点时若回复已在日志里，
 * 直接复用（不再调用模型）；tools 节点写的提醒按 (runId, step) 带幂等键。
 */
export class LangGraphLoop implements AgentLoop {
  constructor(
    private readonly saver: KyselyCheckpointSaver,
    private readonly stepDeps: ModelStepDeps,
    private readonly hooks: LangGraphLoopHooks = {},
  ) {}

  async run(ctx: LoopContext): Promise<LoopOutcome> {
    const graph = this.build(ctx);
    const config = {
      configurable: { thread_id: ctx.runId },
      // 每步最多 3 个超步（prepare、model、tools），再加 wrapUp 与余量。
      recursionLimit: ctx.limits.maxSteps * 3 + 10,
      durability: "sync" as const,
    };
    const existing = await this.saver.getTuple({ configurable: { thread_id: ctx.runId } });
    let final: State;
    try {
      if (existing) {
        const snapshot = await graph.getState(config);
        // 续跑 model / wrapUp 节点：此前进程可能已流出半截内容，先让订阅方丢弃。
        if (snapshot.next.includes("model") || snapshot.next.includes("wrapUp")) {
          ctx.sink({ kind: "step_reset", runId: ctx.runId, step: (snapshot.values as State).step });
        }
        final = (await graph.invoke(null, config)) as State;
      } else {
        final = (await graph.invoke(INITIAL, config)) as State;
      }
    } catch (e) {
      if (e instanceof LoopInterrupted) return { kind: "interrupted" };
      throw e;
    }
    const outcome = final.outcome ?? "completed";
    return outcome === "aborted"
      ? { kind: "aborted" }
      : { kind: outcome, consumedUpToSeq: final.consumedUpToSeq };
  }

  private build(ctx: LoopContext) {
    const timedOut = () => Date.now() >= ctx.limits.deadline;
    const input = (step: number): ModelStepInput => ({
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      step,
      agent: ctx.agent,
      agentVersion: ctx.agentVersion,
      signal: ctx.signal,
      sink: ctx.sink,
    });
    const deps = this.stepDeps;
    const hooks = this.hooks;

    const prepare = async (s: State): Promise<Partial<State>> => {
      if (ctx.shutdown.aborted) throw new LoopInterrupted();
      let consumed = s.consumedUpToSeq;
      for (const m of await ctx.pendingUserMessages(consumed)) consumed = Math.max(consumed, m.seq);
      return {
        step: s.step + 1,
        consumedUpToSeq: consumed,
        outcome: timedOut() ? "max_duration" : null,
      };
    };

    const model = async (s: State): Promise<Partial<State>> => {
      const r = await runModelStep(deps, input(s.step));
      await hooks.afterModelStep?.(ctx.runId, s.step, r);
      if (r.aborted) {
        return { lastStopReason: "aborted", outcome: timedOut() ? "max_duration" : "aborted" };
      }
      return {
        lastStopReason: r.stopReason,
        outcome: r.stopReason === "tool_use" ? null : "completed",
      };
    };

    const tools = async (s: State): Promise<Partial<State>> => {
      await deps.eventLog.append(ctx.conversationId, [
        {
          type: "reminder",
          runId: ctx.runId,
          idemKey: `tools_unavailable:${ctx.runId}:${s.step}`,
          payload: { step: s.step, text: TOOLS_UNAVAILABLE_REMINDER },
        },
      ]);
      return {};
    };

    const wrapUp = async (s: State): Promise<Partial<State>> => {
      const r = await runFinalWrapUp(deps, input(s.step));
      await hooks.afterModelStep?.(ctx.runId, s.step, r);
      return {
        lastStopReason: r.aborted ? "aborted" : r.stopReason,
        outcome: r.aborted && !timedOut() ? "aborted" : "max_steps",
      };
    };

    return new StateGraph(LoopState)
      .addNode("prepare", prepare)
      .addNode("model", model)
      .addNode("tools", tools)
      .addNode("wrapUp", wrapUp)
      .addEdge(START, "prepare")
      .addConditionalEdges(
        "prepare",
        (s: State) => {
          if (s.outcome === "max_duration") return END;
          return s.step > ctx.limits.maxSteps ? "wrapUp" : "model";
        },
        ["model", "wrapUp", END],
      )
      .addConditionalEdges("model", (s: State) => (s.outcome === null ? "tools" : END), [
        "tools",
        END,
      ])
      .addEdge("tools", "prepare")
      .addEdge("wrapUp", END)
      .compile({ checkpointer: this.saver });
  }
}
