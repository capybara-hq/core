# 会话发送体验（conversation send spec 2026-11-04）实现报告

分支 `fix/rc2-acceptance`，已推送到 origin（30ab5159..b39bfbe3）。

## 提交

| 提交 | 步骤 |
|---|---|
| 1ea1c638 feat(design): the working line walks the capybara until the first output | 1 |
| 3b22c033 feat(web): ↵ queues while a run is going, ⌘↵ sends now; the queue shows at once | 2 |
| d25d9a5a feat(web): a follow-up shows at once as a pending bubble | 3 |
| 8d5bb231 feat(web): the first message from /chat switches the view at once and seeds the cache | 4 |
| 7aac5b84 feat(web): the working line shows from the send until the run's first output | 5（含 changeset） |
| b39bfbe3 test(web): e2e for the send from /chat | §4 的 e2e（未在本机运行） |

## 每一步做了什么

1. **WorkingLine（design）**：`packages/design/src/conversation/working-line.tsx`。tool line（`cb-tool-line`）+ 14×10 像素水豚（单位 1，`accent`，`crispEdges`，16 px 盒子：`space.4`）+ 四条字幕叠在同一个 grid 单元里（行宽取最宽的一条）。动效全是 CSS（`conversation.css` 的 "Working line" 段）：腿部两帧，相隔 400ms（800ms 一个周期），字幕每 2.4s 切换（9.6s 周期），都放在 `@media (prefers-reduced-motion: no-preference)` 里，`data-still="true"` 也不动；所以减弱动效时停在第 1 帧和第一条字幕。A11y：`role="status"`，唯一可读的是一个 `cb-sr-only` 副本，内容是第一条字幕；会轮换的字幕带 `aria-hidden`。轮换是 CSS，DOM 不变，所以只播报一次。新增 design i18n `working.plan|act|ponder|compose`（zh/en）。`ConversationPage` 新增 `working?: boolean`（画在 thread 之后）和 `queue?: ReactNode`（画在工作行之后）。spec 新增 §6.16.24，含状态列表（`default`、`reduced-motion`）和尺寸表；新增 `/dev/ui/reference/working-line` 区块（`routes.tsx`、`conversation-blocks.tsx`）、`docs/design/reference/src/working-line.html`（以及 `reference.css` 的 `.r-working-mark`、`index.html` 的链接）、`reference/render.spec.ts` 和 `review-page.mjs` 里的条目，并加入 `accepted.ts`。
2. **按键**：运行中（或等人处理时）↵ 加入队列，⌘↵ / Ctrl+↵ 立即发送（插话）；空闲时两者都是发送。占位文案（zh/en）、design fixture 的 `queueHint`、composer 的文档注释以及 spec §6.16.2 / §6.11 / §6.16.14 / §9 的示例都已更新。**乐观队列**：`useQueue` 维护本视图的 `pending` 列表（按 `clientMessageId`），立即显示为操作禁用的 `QueuedMessage`；队列读取结果里已有它时（mutation 会等 invalidation 完成），或 POST 失败时，从列表移除。**Composer 立即清空**（作用于发送和入队两条路径）：文本、技能 chip、`@` 资源、文件（`useDraftFiles.take` / `restore`）立刻离开草稿；失败时放回，`clientMessageId` 保持不变；发送按钮不再显示 busy，也不再等待 POST。
3. **后续消息的即时发送**：`PendingBubbles.tsx`（`usePendingSends` + `PendingBubbles`），挂在 thread 之后。气泡是 `UserBubble queued`（沿用排队消息的外观），外包 `data-pending=<cmid>`。只要日志里出现同一 `clientMessageId` 的 `user_message`（来自 POST 的返回或流，以先到者为准），它在同一次渲染里就被过滤掉，文本不会出现两次。失败时移除气泡，composer 恢复内容。队列移到模板的 `queue` 插槽。
4. **从 `/chat` 发第一条消息**：`NewConversation` 发出后立即切换为会话布局（`thread` = 待发气泡，`working: true`，标题用 `untitledLabel(now)`）。create 的 mutation 在 `fn` 里调用 `seedNewConversation`（`lib/query/conversation.ts`）：写入 row；先放一个空日志，再通过 `appendEvents` 加入 `[event]`；queue `{items:[],paused:false}`、files `[]`、sandbox `null` 作为已知答案写入，只在缓存里没有时才写。`invalidates: []`，然后 `router.replace`，再用 `void` 方式 invalidate groups，不等待。`/chat/<id>` 从种好的缓存绘制；`useConversation` 已经会在缓存有日志时立刻从缓存的最后一个 seq 开流（§2.4）。失败时回到新会话布局，composer 通过 `initialDraft` 恢复文本、chip、资源、文件和 `clientMessageId`（见"我的决定" 3）。查询缓存 spec §6 补了一条说明。
5. **工作行的可见性**：`workingLineVisible(entries, { running, waiting, pending })` 放在 `lib/timeline.ts` 的 builder 旁边。规则：在等人处理 → 否；有待发气泡 → 是；最后一条是 `user` / `task`（还没有 run 回答它）→ 是；不在运行 → 否；最后一条是 `tools` 且没有 running / pending 的行 → 是；`files` / `card` / `divider` / `skill-report` → 是；其余（thinking、prose、运行中的工具、子 agent、审批、提问、连接、run 行）→ 否。`ConversationView` 把结果传给 `working`。新增 changeset `.changeset/web-conversation-send.md`（`@capybara-hq/web` patch）。`web-query-cache.md` 讲的是缓存读取，不覆盖本次改动，所以单独新建。

## TDD 证据

- 步骤 1：先写 `packages/design/test/working-line.test.tsx` → RED（6 个里 5 个失败：组件和 prop 都不存在）→ GREEN 6/6。`spec-tables.test.ts` 16/16 通过（新尺寸表合法）。
- 步骤 2：先改 `conversation-page.test.tsx` 和 `composer-skills.test.tsx` 的按键测试，再加 idle 按键测试和占位文案测试 → RED（5 个失败）→ GREEN。乐观队列测试 `queue.test.tsx` 中"before the POST answers" → RED（1 个失败）→ GREEN；失败恢复的那个测试在改动前已经通过（旧 composer 本来就不清空），改成立即清空之后它守住恢复逻辑。
- 步骤 3：`conversation-page.test.tsx` 新增 "instant send" 4 个测试 → RED（同一 tick 显示 pending、失败恢复，这 2 个失败；另 2 个在没有 pending 时空过）→ GREEN 4/4。
- 步骤 4："the first message from /chat" 3 个测试 → RED（切布局、种缓存 + 不等 groups + `/chat/c9` 零读取 + 流从 after=1 开始，这 2 个失败）→ GREEN 3/3。
- 步骤 5：`timeline.test.ts` 新增 `workingLineVisible` 5 个测试 → RED（函数不存在）→ GREEN（其中一个是我自己的 fixture 写错了 `run_failed` 的 payload，修正后通过）。页面集成测试（发送后显示 → 工具运行中消失 → 工具结果后再次出现 → run 结束消失，且恰好一个）→ RED → GREEN。
- 最终：`pnpm exec vitest run apps/web/test packages/design/test` 128 个文件、2504 个测试全部通过；`pnpm --filter @capybara-hq/web typecheck` 0 个错误；`pnpm exec biome check apps/web packages/design` 无错误（2 个 warning 是已有的 `noDescendingSpecificity`）；`pnpm check` 全部通过。
- 在临时 worktree `chore/send-visual`（基于 7aac5b84，未提交的 `channel: "chrome"` 覆盖）里跑了 `visual/fidelity.spec.ts`（全部）、`visual/conversation.interaction.spec.ts`、`visual/skeleton-alignment.spec.ts`：153 个全部通过，包括 `working-line` 暗色/亮色和完整性用例。worktree 和分支已删除。

## 改动的已有测试及原因

- `conversation-page.test.tsx`："↵ while running interjects… ⌘↵ queue" → "↵ while running queues; ⌘↵ / Ctrl+↵ send now"，占位文案的断言也改了（D1 改变了按键）。"⌘↵ queues with the pending model / effort pick" → 改为 ↵ 入队，后一次发送用 ⌘↵（同样是按键调换）。
- `composer-skills.test.tsx`：两个"⌘↵ while running queues…"的测试改成 ↵（按键调换）。"text typed while a send is pending is kept…only what was sent is cleared" → "the composer clears at once; text typed while the send is pending is kept"（§2.1：发送时立即清空，不再在返回时只清掉已发送的部分）。
- `chat-files.test.tsx`："发送时内核说附件不存在…"：发送后文件立即离开草稿，失败后放回，所以附件条是新挂载的元素；测试改为发送后重新查询 group（§2.1 的失败恢复）。
- `packages/design/test/conversation-shell.test.tsx`：hint 示例字符串换成新文案（只是传入的字符串，跟随 spec 文案）。
- `apps/web/e2e/conversation-capabilities.spec.ts`：队列/插话的 e2e 测试换成新按键（未运行）。

## 我的决定

1. 腿部第 2 帧：第 9–10 行改为 `...XX.X.XX....`（每对腿向内移 1 px）。
2. 动效完全用 CSS（visibility 的 step 关键帧加 delay），不用 JS 计时器：减弱动效、Playwright 的 `animations: "disabled"`、SSR 下都稳定落在第 1 帧和第一条字幕；`still` prop 用于参考集里的 `reduced-motion` 状态。尺寸表里 mark 的颜色测 `color`（`fill: currentColor`），没有测 `fill`。
3. 新会话的布局切换会让 `ComposerBar` 重新挂载（模板里新/旧布局的父节点不同）。为了不改模板结构（避免影响已验收的 new 状态和截图基线），由 composer 把发出时的草稿（`ComposerMessage.draft`：文本、chip、资源、文件、`clientMessageId`）交给视图；create 失败时，新挂载的 composer 用 `initialDraft` 起步。`useDraftFiles` 为此接受初始文件，新 key 从最大的 `f<n>` 往后编号；ComposerBar 里"换 agent 清掉 chip"的 effect 改成只在变化时清，挂载时不清。
4. 种日志只在答案的 event 是 seq 1 时进行；带模型切换的首条消息，前面还有一个 `model_switched`，这时不种日志，`/chat/<id>` 会读一次完整日志，其余照样种好。
5. 没有 run 回答的最后一条用户消息，即使 `running` 为假也显示工作行。这样 POST 返回、`run_started` 还没到的这段时间不会闪烁，`/chat` 跳转到 `/chat/<id>` 时也能接上（待发气泡是每个视图自己的，跨视图会丢）。
6. 待发气泡用 `UserBubble queued` 的外观（虚线、半透明），没有新增样式或 prop；附件按名字显示为 chip，不显示缩略图。
7. 入队的乐观条目在 mutation 结束时移除：`useAppMutation` 会等 invalidation 完成，那时读到的列表已经包含它；另外按 `clientMessageId` 去重，保证只显示一次。
8. 失败恢复时，如果用户在等待期间又输入了内容，恢复成"原文本 + 换行 + 新输入"；没有新输入时恢复原文本。
9. 发送按钮不再 busy，POST 进行中允许再次发送（composer 已清空，不会重复提交同一草稿）。
10. 新 changeset 单独建文件（`web-query-cache.md` 不覆盖这次改动）；`@capybara-hq/design` 是 private，不需要 changeset。

## 没能运行的

- e2e（`apps/web/e2e`，包括新的 `conversation-send.spec.ts` 和改过的 `conversation-capabilities.spec.ts`）：本机没有安装 Playwright 浏览器，已知还有 `register()` 环境问题；跑 e2e 需要起完整的 kernel 栈，会和用户在本 worktree 的 dev 服务冲突，所以没有尝试。
- 截图回归（`catalog.spec.ts`）：基准只有 Linux 版；参考 PNG（`reference-update`）和截图基线（`visual-update`）都要靠 workflow 生成。

## 风险与疑虑

- 带 `retryOf` 的重试消息会折叠进失败 run 的行里，最后一条仍是 run 行，所以点 Retry 后看不到工作行（Retry 不经过 composer，也没有待发气泡）。
- 工作行会在"最后一条是用户消息且没有 run"的旧会话上一直显示（例如 kernel 从未启动 run）。按 §2.2 这可以理解为"在工作中"，但这类会话上会一直显示。
- 参考 PNG 和截图基线需要跑 `reference-update` / `visual-update`。composer 运行中的占位文案改了，参考集里 composer `running` 状态的 PNG 会和新文案不一致，直到 workflow 重新渲染。
- `ConversationPage` 新增 `queue` 插槽；队列 DOM 仍在 thread 列内（`data-part="thread"` 里），只是在工作行之后。
- 子 agent 面板等其他用到 `ConversationPage` 的地方，如果还把队列塞进 `thread`，行为不变，但工作行不会出现在它们前面（目前只有会话页用了队列）。

## Controller: review + live acceptance findings (2026-11-04), fix round 1 input
Review (aac3d5d1): Important #1 visibility rule keyed on last entry kind (timeline.ts:391-392); minors 2-12 (see review).
Live (Chrome, dev stack):
- L1 a second message sent while the first follow-up's POST is still in flight (run not started yet) is sent, not queued: the kernel then folds both into one turn (seen twice).
- L2 for >4 s after a send the status bar says 空闲 and the composer is in idle mode (send arrow, idle placeholder) while the working line shows 执行中… — the running state lags (row/log based) and disagrees with the line.
- L3 sending a second message in a running conversation scrolls the DOCUMENT by ~258 px (document.scrollingElement.scrollTop 0 → 258.5, the whole app shifts up: aside top -258) for a few seconds, then recovers; html/body overflow is visible. Repro: in a conversation with a long thread, send one message, then immediately type and send another.

## Fix round 1 报告（2026-11-04）

提交：6bdc83f0（第 1–3 项）· 20e50e41（第 4 项，L3）· 1d586db4（第 5 项）。已推送 b39bfbe3..1d586db4。

### 第 1 项：可见性规则（review #1）
- `workingLineVisible(events, drafts, { waiting, pending, sentHere })`，位于 `apps/web/src/lib/timeline.ts`：
  - 等待有人处理时 → 不显示；
  - 本视图有 pending 的发送 → 显示；
  - 日志里有进行中的 run（已 `run_started`、尚无终止事件）→ 当没有工具在运行，并且该 run 自 `run_started` 或自最后一个已结束的 `tool_result` 以来没有任何输出时，显示。输出包括：assistant_message、tool_call_started、approval_requested、question_asked、connection_required、subagent_dispatched/started，以及该 run 中非空的 draft；
  - 否则看 `awaitingRun(events, sentHere)`：最新一条 user_message 是本 tab 发的，它之后没有 run_started / run_failed / run_aborted，也没有 consumedUpToSeq ≥ 它的 run_finished。
- 新增 `sentHereOf(qc, orgId, id)`（`lib/query/conversation.ts`）：一个 `WeakMap<QueryClient, Map<scope, Set<cmid>>>`，只在浏览器中存在。写入方：
  - 发送、重试、入队时加入，被内核拒绝后移除；
  - `seedNewConversation` 加入首条消息，因此跨过 `/chat` → `/chat/<id>` 的切换后仍然保留。
- 测试（`timeline.test.ts`）覆盖：
  - 空闲旧会话：不显示；
  - 投递失败：不显示；
  - 子会话不在运行：不显示；
  - 重试的 run：显示到第一个输出为止；
  - 最后一次模型调用之后的插话：下一轮显示；
  - 另外保留了原有用例。
- RED：把同一组测试套到旧规则上，正好这 5 个失败；GREEN：31/31 通过。
- 页面测试：
  - 投递失败：报错之后不显示工作行，也没有 Stop；
  - `/chat/c9` 切换之后工作行仍在。

### 第 2、3 项（L1、L2）
- ConversationView 中 `busy = conv.running || pending 发送 || awaitingRun`，`active = busy || waiting`。composer 的 `running`（↵ 入队、Stop）、状态栏的"运行中"和工作行用的是同一来源。
- 新会话在会话创建出来之前禁止第二次发送（那时还没有队列）。
- 测试：
  - 连续两次 ↵ → 一次 POST messages、一次 POST queue；
  - 发送后立刻：Stop、运行中的占位文案、状态"运行中"、工作行都出现；日志写入消息但 run 还没开始时，三者仍一致。
- RED：旧代码上 4 个失败；GREEN：63/63 通过。

### 第 4 项（L3）根因与修复
- 根因：工作行里的 `.cb-sr-only` 副本是 `position: absolute`，位于工作行（一个 flex 行，处在 thread 末尾）内部，没有任何定位祖先，containing block 是初始包含块。因此 thread 的滚动容器不会裁剪它，它的静态位置（thread 内容里几千 px 处）成了文档的可滚动溢出，浏览器随即滚动了文档。
- 用 Chrome 加上真实的 design CSS 做的探针：
  - 修复前 `document.scrollingElement.scrollHeight` 为 11631（窗口 900），`scrollTop` 能被设为 500；
  - 修复后为 900，无法滚动；
  - 对照组：sr-only 直接放在 thread（flex 容器）下时，静态位置落在 thread 顶部，不产生溢出。这说明问题来自"放在末尾 flex 行内"这个具体位置。
- 修复（design CSS）：
  - `.cb-conv-scroll { position: relative }`，滚动容器裁剪自己的内容；
  - `.cb-shell { position: relative; overflow: clip }`；
  - `:root:has(.cb-shell:not(.cb-ref-block .cb-shell)) { overflow: hidden }`，只作用于 App Shell。
- 测试：`packages/design/test/document-scroll.test.tsx`，3 条 CSS 规则测试（RED 3 个失败 → GREEN），外加一个渲染测试：sr-only 位于滚动容器内。
- 临时 worktree 中实测：
  - `/dev/ui/components` 和 `/dev/ui/reference/*` 的文档仍然可以滚动；
  - `/dev/ui/templates/conversation`（App Shell）被锁定（scrollHeight = 窗口高度，`scrollTop` 保持 0）；
  - auth 页面不含 `.cb-shell`，不受影响。

### 第 5 项（minor）
- #4：typed `/name` 先解析（读 skills），再清空 composer，与 pending 气泡在同一次渲染中出现，并带 chip；解析期间第二次 ↵ 会等待。测试：RED 1 个失败 → GREEN。
- #6：WorkingLine 新增 `active`。polite 的 status 区域一直挂载，空状态下 line 启动后再填入第一条字幕；可见行设为 `aria-hidden`。ConversationPage 只要收到 `working` prop（true 或 false）就一直挂载该区域。spec §6.16.24 的 A11y 已更新；参考页加了 `r-sr-only` 的 status 副本。测试：同一个区域先空、再填入、再清空。
- #7：`display/logo.tsx` 导出 `bitmapCells(rows, scale, top)`，Logo 和 WorkingLine 共用。

### 命令与结果
- `pnpm exec vitest run apps/web/test packages/design/test`：129 个文件、2519 个测试全部通过。
- `pnpm --filter @capybara-hq/web typecheck`：0 个错误。
- `pnpm exec biome check apps/web packages/design`：无错误，2 个已有 warning。
- `pnpm check`：All checks passed。
- 临时 worktree `chore/send-visual`（基于 1d586db4，未提交的 `channel: "chrome"`）：fidelity、conversation/sidebar/repeater 交互、skeleton-alignment 共 183 个全部通过；文档滚动探针结果同上。worktree 和分支已删除。
- e2e 仍未运行，原因同前。

### 变更的已有测试
- `conversation-page.test.tsx` 的工作行集成测试：起始状态（一条没有 run、也不是本 tab 发的旧消息）改为断言不显示（规则改变）。
- `working-line.test.tsx` 的"announced once"：status 现在是独立挂载的区域，不再是可见行本身（#6）。

## Controller: fix round 1 re-review clean; live check (2026-11-04) and fix round 2 input
Live, after 1d586db4: two quick ↵ → one send + one queue ✓; status/composer/line agree ✓; docScroll 0 throughout ✓; the queued message ran as its own next turn ✓.
- L4 when the queued message is sent, the queue item and the logged user bubble show together for ~1.2 s (bubbles 9→10→9 at 22.8 s→24.0 s): the queue item stays until the queue re-read answers.
- Re-review notes: (a) a second ↵ in a new conversation before it exists is silently ignored (text kept, no hint); (b) a message this tab sent whose run never starts (e.g. a paused queue) keeps the line and running mode until reload.

## Fix round 2 报告（2026-11-04）

提交：7c82e8af，已推送（1d586db4..7c82e8af）。

### 第 1 项（L4）：排队消息发出后，队列条目立即消失
- 按哪个字段匹配：kernel 的队列条目本身就带 `clientMessageId`（`QueueItem.clientMessageId`，`packages/kernel/src/conversations/queue.ts`），排队消息发出时写入的 `user_message` 也带同一个值（`queuedUserMessage`：`clientMessageId: r.client_message_id`，idemKey 为 `userMessageIdemKey(r.client_message_id)`）。所以用的是第一种方案：按队列条目的 `clientMessageId` 匹配。没有用 item id（日志里没有记录它），也不依赖乐观条目。
- `useQueue(orgId, id, merge, events)`：日志中已有对应 `user_message` 的条目，在同一次渲染里从列表去掉，不等队列重新读取；乐观条目也做同样的过滤。共用 `PendingBubbles.loggedIds`。
- 测试 `queue.test.tsx`：流送来 `user_message {clientMessageId: "cm-q1"}` 时，在同一个 tick 内 `q1` 消失，文本只出现一次（作为用户气泡），`q2` 不受影响。RED：旧代码下失败；GREEN：通过。

### 第 2 项：新会话创建前的第二次 ↵
- ComposerBar 新增 `onBlocked()`。`sendDisabled` 时按 ↵ 且草稿非空，会调用它，草稿保留。
- NewConversation 在 sent 状态下收到 `onBlocked` 时，在 composer 上方显示一行安静的 `Text small muted`："会话创建后即可继续发送" / "You can send again once the conversation is created"（i18n 键 `chat.sendAfterCreate`）。create 返回成功或失败时清除。
- 关于放在哪里：design 的 `hint` 会替换 placeholder，但这时 composer 里有文本，placeholder 看不到，所以用了 composer 区域里已有的 Stack 行，也就是 FormError 所在的位置。
- 测试：第二次 ↵ 后文本保留、提示出现、只发出一次 POST；create 返回后提示消失；文案在 zh 和 en 中各断言一次。RED 失败 → GREEN 通过。

### 第 3 项：永远不会开始的 run
- `awaitedMessage(events, sentHere)` 返回本 tab 发出、还在等 run 的那条消息。
- `awaitingRun(events, sentHere, { paused, now })` 在以下情况返回 false：
  - 队列处于暂停状态；
  - 距该消息 `createdAt` 已超过 `AWAIT_RUN_MS`（60 s）且没有 `run_started`（兜底）。
- 日志里出现 run_failed / run_aborted 的情况，第 1 轮已经处理。
- `workingLineVisible` 接收同样的 `paused` 和 `now`。
- ConversationView 用 `useAwaitBackstop` 在截止时间安排一次重渲染，之后 composer 模式和状态栏回到以日志为准。
- 测试：
  - `timeline.test.ts`：59 s 内仍在等待；超过 60 s 不再等待；队列暂停时不等待；
  - 页面测试：队列暂停时发送后没有工作行、没有 Stop；一条在兜底前 150 ms 写入的消息，工作行先出现，约 150 ms 后消失，Stop 也随之消失。RED：5 个失败；GREEN：全部通过。

### 改动的已有测试
- 改了 `conversation-page.test.tsx` 中 3 处 POST 返回的 event（L1、L2 测试和 `/chat` 预填缓存的测试）：现在用 `now(...)` 把 createdAt 设成当前时间，和 kernel 写入时打的时间戳一致。原来的 fixture 时间在 2026-10-26，会立刻触发 60 s 兜底。

### 命令与结果
- `pnpm exec vitest run apps/web/test packages/design/test`：129 个文件、2526 个测试全部通过。
- `pnpm --filter @capybara-hq/web typecheck`：0 个错误。
- `biome check`：无错误。
- `pnpm check`：All checks passed。
- e2e 未运行。

### 疑虑
- 兜底比较的是服务器的 `createdAt` 和客户端的 `Date.now()`。如果客户端时钟比服务器快 60 s 以上，工作行会立刻消失（回落为以日志为准），这是可以接受的降级。

## Controller 裁定：兜底计时从本 tab 的发送时刻开始（2026-11-04）

提交 025b717a，已推送（7c82e8af..025b717a）。

- `sentHereOf` 从 `Set<cmid>` 改为 `Map<cmid, 本 tab 发送时的 Date.now()>`。
  - 写入时机：发送、重试、入队时写入；`/chat` 的预填缓存使用 create 发送时记下的 `sentAt`（新增参数 `seedNewConversation(…, sentAt)`）。
  - 内核拒绝的发送仍会从中删除。
  - 我的决定：用 `Date.now()` 而不是 `performance.now()`，因为 fake timers 可以控制它，而且两个时间都只在本 tab 内比较。
- `awaitingRun` 改为用 `now - sentHere.get(cmid)` 和 60 s 比较，服务器的 `createdAt` 不再参与；`useAwaitBackstop` 的截止时间也改为发送时刻 + 60 s。不在记录里的消息本来就不会显示工作行。
- 第 2 轮改过的 3 处 fixture 时间已撤回；同时撤回的还有第 2 轮新测试里两处 `now(...)`，以及 `now` helper 本身。
- 新测试：
  - 单元测试 `timeline.test.ts`：服务器 `createdAt` 在 10 分钟前、本地刚发送 → 仍在等待；本地发送后超过 60 s → 不再等待；队列暂停 → 不等待。
  - 页面测试：服务器时间在 10 分钟前、本地刚发送 → 工作行和 Stop 都在；兜底测试改用本 tab 的 fake clock（`setTimeout` / `Date`），59 s 时工作行还在，60.1 s 时工作行和 Stop 都消失。
- RED：撤回 fixture 并改好测试后，旧实现下有 5 个页面测试和 2 个单元测试失败；GREEN：全部通过。
- 验证结果：
  - 覆盖相关的测试文件：134 个全部通过；
  - `pnpm exec vitest run apps/web/test packages/design/test`：129 个文件、2528 个测试全部通过；
  - web typecheck：0 个错误；
  - biome：无错误；
  - `pnpm check`：All checks passed。

## 用户实测问题：骨架闪烁、标记尺寸（2026-11-04）

提交：9a7d4a70、92ac336d，已推送（origin 上 a2377a44..92ac336d；我的两个提交已 rebase 到另一台机器推送的两个 docs 提交 3b8a3896、a2377a44 之上）。

### 1. 从 /chat 发首条消息时骨架屏闪一下
- 根因已确认：`createWithMessage` → `createIn` → `writeMessage` 在用户改过模型或 effort 时，会先写一条 `model_switched`（seq 1），再写 `user_message`（seq 2）。原来的应答只带 `event`，即 seq 2 那条；`seedNewConversation` 检查 `event.seq !== 1` 后就不预填日志，于是 `/chat/<id>` 读 events 时出现骨架屏。kernel 已有测试 `model-switch.test.ts` 证实首条消息是 seq 2。
- kernel 改动：
  - `writeMessage` 返回本次写入的全部事件。
  - `createWithMessage` 和 `findCreated` 新增返回 `events`：新建时直接用写入结果；重试时用 `readAfter(id, 0, event.seq)` 读回同样的那几条。
  - controller 的应答为 `{ conversation, event, events }`，`event` 保留以兼容旧客户端。这个端点没有应答 DTO 或 schema，所以更新的是 TS 返回类型和 controller 上的文档注释。
  - send spec §2.1 和 query-cache spec §6 都已同步。
  - changeset 中加了 `@capybara-hq/kernel: patch` 及一段说明。
- web 改动：
  - `createConversationWithMessage` 的类型加上 `events?`。
  - `seedNewConversation(qc, org, row, { event, events }, sentAt)` 会按 seq 排序。只有当事件从 seq 1 开始且连续时，才通过 `appendEvents` 整列预填；旧 kernel 只回 `event` 时，行为和之前一样。
- 测试：
  - kernel：带模型切换的 create，应答里依次是 `[1 model_switched, 2 user_message]`，`event` 为 seq 2；重试（200）的应答也相同。另外在 conversations.http 中断言无切换时 `events` 等于 `[event]`。先 RED（`events` 为 undefined）→ GREEN。
  - kernel conversations 和 skills 共 145 个测试全部通过。
  - web：create 应答 `model_switched` + `user_message` 后，缓存里是这两条；`/chat/c9` 渲染出气泡，没有 `loading-turn`，没有 GET events，流从 `after=2` 开始。先 RED → GREEN。

### 2. 标记和 spinner 尺寸
- 工作行标记改为像素单位 2（28×20，和侧边栏 logo 一样大），放在 `control.default` × `space.5` 的盒子里。工作行高度不变：临时 worktree 中实测行高 28（`row.dense`），标记 28×20。
- 思考行的 live spinner 从 12 改为 16，`Spinner` 新增 `size` 参数；工具行仍是 12。
- spec §6.16.24 尺寸表：`working-mark` 宽 `control.default`、高 `space.5`。§6.16.5 增加一行 `spinner live width space.4`。
- 参考 HTML（`working-line.html` 的 svg、`reference.css` 的 `.r-working-mark`）和 `conversation.js` 中思考行的 `spin(16)` 都已更新。/dev/ui 区块直接使用组件，无需改动。
- design 测试：svg 为 28×20、`viewBox` 为 `0 0 28 20`、腿部路径按单位 2 绘制；思考行 spinner 为 16，工具行为 12。先 RED → GREEN。
- 临时 worktree `chore/send-visual`（基于 92ac336d，未提交的 `channel: "chrome"`）：fidelity 的 working-line 与 thinking-row（暗色和亮色）以及完整性用例共 5 个全部通过。worktree 和分支已删除。

### 命令
- vitest（apps/web + packages/design）：129 个文件、2530 个测试全部通过。
- 相关 kernel 测试：14 个文件、145 个测试全部通过。
- web typecheck：0 个错误；kernel 的 `tsc -b`：无输出。
- biome（apps/web、packages/design、packages/kernel）：无错误。
- `pnpm check`：All checks passed。
- 参考 PNG 和截图基线仍需重新跑 `reference-update` / `visual-update`。
