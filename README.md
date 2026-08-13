# deepseek-harness-mini

deepseek-harness 的最精简完整实现。用 ~600 行代码展示整个 agent 框架的核心架构。

**运行:** `node index.mjs`（Node 18+，零依赖）

## 文件 ↔ 真实项目对照

```
mini 文件                        真实 deepseek-harness 包
──────────────────────────────  ──────────────────────────────────
core/context.mjs                vendor/ Cordis（插件框架）
core/session.mjs                packages/core/session
core/agent-loop.mjs             packages/core/agent-loop + agent/inbox

plugins/system-prompt.mjs       packages/core/system-prompt
plugins/tools.mjs               packages/core/tools
plugins/llm.mjs                 packages/llm/llm-deepseek
plugins/list-files.mjs          packages/fs 里的文件工具
plugins/safety.mjs              packages/guard

index.mjs                       packages/boot/app-boot + dsh CLI
```

## 12 个核心设计点

| # | 设计点 | 代码位置 | 含义 |
|---|--------|---------|------|
| 1 | **agent loop 是插件** | index.mjs: `ctx.provide('agentLoop')` | 和 system-prompt、tools 没本质区别，可替换 |
| 2 | **能力通过插件注册** | 每个 `installXxx(ctx)` | ctx.tools / ctx.systemPrompt / ctx.llm 都是插件 |
| 3 | **三种事件分发** | context.mjs | emit=观察 serial=终止 waterfall=包裹 |
| 4 | **session 日志是唯一真相** | session.mjs: `deriveMessages()` | 模型历史从日志派生 |
| 5 | **tools↔prompt 缝合** | tools.mjs: `systemPrompt.tools(provider)` | 工具 schema 通过回调注入 prompt |
| 6 | **schema 白名单投影** | tools.mjs: `schemas()` | 只发 name/description/parameters 给模型 |
| 7 | **工具三段式管道** | tools.mjs: `execute()` | pre-execute → execute → post-execute |
| 8 | **流式输出** | llm.mjs: `async *stream()` + agent-loop `for await` | 逐 chunk 产出→追加日志→组装成 message |
| 9 | **Inbox 队列** | agent-loop.mjs: `Inbox` | next-turn 开始新轮 / next-step 注入当前轮 |
| 10 | **取消传播** | agent-loop.mjs: `AbortController` | signal 传到 LLM + 工具，throwIfAborted 在扩展点检查 |
| 11 | **Phase 状态机** | agent-loop.mjs: `#phase` | idle ↔ running，防止并发驱动 |
| 12 | **注册即 disposer** | context.mjs: `effect()` | 所有注册返回卸载函数 |

## 核心循环

```
send() → inbox 队列 → wake() → kick()
                                   │
                          ┌────────┴────────┐
                          │   turn (一轮)    │
                          │  turn/start      │
                          │  ┌────────────┐  │
                          │  │ step (一步) │  │
                          │  │  preStep    │  │  ← ★ agent/pre-step waterfall
                          │  │  buildReq   │  │  ← ★ agent/request waterfall
                          │  │  ① stream   │  │  ← 逐 chunk → assistant/chunk
                          │  │  组装 msg   │  │  ← assistant/message
                          │  │  工具?      │  │
                          │  │   Y→execute │  │  ← ★ tools 三段式管道
                          │  │   →回 step  │  │
                          │  │   N→done    │  │
                          │  └────────────┘  │
                          │  inbox有next-step?│ → 继续 step
                          │  否 → turn/end   │
                          └────────┬────────┘
                                   │
                          inbox 有 next-turn? → 新 turn
                          否 → idle
```

## 5 个运行场景

```
node index.mjs
```

| 场景 | 展示 |
|------|------|
| 1. 列出文件 | ① 流式 + 工具调用 + 两步 ReAct 循环 |
| 2. 危险操作 | waterfall 拦截（safety 不调 next()） |
| 3. 普通对话 | ① 流式文本（无工具） |
| 4. 多轮对话 | ② inbox 队列 + 自动开始新 turn |
| 5. 取消 | ③ AbortSignal 传播 — turn 被中断（reason: aborted） |

## 扩展点（插件介入位置）

```
agent/pre-step      waterfall  改写消息 / 注入上下文 / 拒绝
agent/request       waterfall  改 provider / model / 参数
agent/turn-stopping serial     决定是否提前结束一轮
tools/pre-execute   waterfall  守卫: allow / deny
tools/post-execute  waterfall  后处理: accept / block
```
