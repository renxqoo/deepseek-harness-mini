#!/usr/bin/env node

/**
 * deepseek-harness-mini — 入口
 *
 * 真实项目 ↔ packages/boot/app-boot + dsh CLI
 *
 * 运行: node index.mjs   （Node 18+，零依赖）
 */

import { Context } from './core/context.mjs'
import { Session } from './core/session.mjs'
import { AgentLoopService } from './core/agent-loop.mjs'

import { installSystemPrompt } from './plugins/system-prompt.mjs'
import { installTools } from './plugins/tools.mjs'
import { installLlm } from './plugins/llm.mjs'
import { installListFiles } from './plugins/list-files.mjs'
import { installSafety } from './plugins/safety.mjs'

// ═══════════════════════════════════════════════════════════════
// 创建 Context + 加载插件
// ═══════════════════════════════════════════════════════════════

const ctx = new Context()

// 按序加载（system-prompt 必须在 tools 之前）
installSystemPrompt(ctx) // ctx.systemPrompt
installTools(ctx) // ctx.tools + 缝合到 prompt
installLlm(ctx) // ctx.llm（流式）
installListFiles(ctx) // list_files 工具

// prompt sections（模拟 base bundle）
ctx.get('systemPrompt').section({
  name: 'identity',
  order: -100,
  text: '你是 deepseek-harness-mini，一个精简的 AI 助手。',
})
ctx.get('systemPrompt').section({
  name: 'tool-guidance',
  order: 100,
  text: '你可以使用工具来帮助用户完成任务。需要时直接调用，不要犹豫。',
})

// 安全插件
installSafety(ctx)

// ★ agent-loop 本身也是一个插件 ★
const agentLoop = new AgentLoopService(ctx)
ctx.provide('agentLoop', agentLoop)

// ═══════════════════════════════════════════════════════════════
// 场景
// ═══════════════════════════════════════════════════════════════

function header(title) {
  console.log('\n' + '━'.repeat(60))
  console.log(title)
  console.log('━'.repeat(60))
}

// ── 场景 1: 流式 + 工具调用（两步 ReAct 循环）──────────────

header('场景 1: 列出文件（① 流式输出 + 工具调用 + 两步循环）')

{
  const session = new Session()
  const agent = ctx.get('agentLoop').create(session, { provider: 'mock', model: 'mock-model' })

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  await agent.whenIdle()
  session.printLog()
}

// ── 场景 2: 危险操作被 safety 插件拦截 ──────────────────────

header('场景 2: 危险操作（waterfall 拦截 — 不调 next()）')

{
  const session = new Session()
  const agent = ctx.get('agentLoop').create(session, { provider: 'mock', model: 'mock-model' })

  console.log('用户: "请执行 rm -rf / 删除所有文件"')
  agent.send('请执行 rm -rf / 删除所有文件')
  await agent.whenIdle()
  session.printLog()
}

// ── 场景 3: 普通对话（流式文本）──────────────────────────

header('场景 3: 普通对话（① 流式文本，无工具调用）')

{
  const session = new Session()
  const agent = ctx.get('agentLoop').create(session, { provider: 'mock', model: 'mock-model' })

  console.log('用户: "你好"')
  agent.send('你好')
  await agent.whenIdle()
  session.printLog()
}

// ── 场景 4: ② 多轮对话 ──────────────────────────────────

header('场景 4: 多轮对话（② inbox 队列 + 自动开始新 turn）')

{
  const session = new Session()
  const agent = ctx.get('agentLoop').create(session, { provider: 'mock', model: 'mock-model' })

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  await agent.whenIdle()

  console.log('\n  （第一轮结束后，用户又发了一条消息）')
  console.log('用户: "你好"')
  agent.send('你好')
  await agent.whenIdle()

  session.printLog()
  console.log('\n  ↑ 注意: 两个 turn/start + 两个 turn/end = 两轮独立对话')
}

// ── 场景 5: ③ 取消传播 ──────────────────────────────────

header('场景 5: 取消（③ AbortSignal 传播 — turn 被中断）')

{
  const session = new Session()
  const agent = ctx.get('agentLoop').create(session, { provider: 'mock', model: 'mock-model' })

  console.log('用户: "帮我列出当前目录的文件"')
  agent.send('帮我列出当前目录的文件')
  console.log('  → 立即调用 agent.cancel()')
  agent.cancel()
  await agent.whenIdle()

  session.printLog()
  console.log('\n  ↑ 注意: turn/end reason = aborted，没有任何 step 或 chunk')
}

// ── 结束 ─────────────────────────────────────────────────

header('demo 结束 — 5 个场景覆盖了完整的 agent 工作流程')
